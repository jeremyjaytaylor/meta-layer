import { useState, useEffect, useMemo } from "react";
import { UnifiedTask, SlackContext, UserProfile } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { UserProfileModal } from "./components/UserProfileModal"; 
import { fetchSlackSignals, buildSlackContext } from "./adapters/slack"; 
import { fetchAsanaTasks, completeAsanaTask, getProjectList, createAsanaTaskWithProject, createAsanaSubtask } from "./adapters/asana";
import { analyzeSignal, synthesizeWorkload, ProposedTask, AiSuggestion } from "./adapters/gemini"; 
import { RefreshCw, LayoutTemplate, Sparkles, X, Check, Inbox, Filter, BrainCircuit, Calendar, Trash2, RotateCcw, Archive, Search, User, AlertTriangle } from "lucide-react"; 
import "./App.css";

type TimeRange = 'today' | '3days' | 'week' | '2weeks' | 'month' | 'year' | 'custom';

function App() {
  const [slackTasks, setSlackTasks] = useState<UnifiedTask[]>([]);
  const [asanaTasks, setAsanaTasks] = useState<UnifiedTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false); // FIX: Prevent sync race conditions
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  
  const [slackContext, setSlackContext] = useState<SlackContext | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const [timeRange, setTimeRange] = useState<TimeRange>('3days');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  const [reviewState, setReviewState] = useState<{ sourceTask: UnifiedTask, suggestions: AiSuggestion[], selectedIndices: Set<number> } | null>(null);
  const [synthesisResults, setSynthesisResults] = useState<ProposedTask[] | null>(null);
  const [availableProjects, setAvailableProjects] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<Record<number, string>>({});
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [processingTaskIdx, setProcessingTaskIdx] = useState<number | null>(null);
  
  const [filterSearch, setFilterSearch] = useState("");

  // --- USER PROFILE STATE ---
  const [userProfile, setUserProfile] = useState<UserProfile | null>(() => {
    try {
      const stored = localStorage.getItem("meta_user_profile");
      return stored ? JSON.parse(stored) : null;
    } catch (e) {
      console.error("Failed to load user profile from localStorage:", e);
      return null;
    }
  });

  const handleSaveProfile = (profile: UserProfile) => {
    try {
      setUserProfile(profile);
      localStorage.setItem("meta_user_profile", JSON.stringify(profile));
    } catch (e) {
      console.error("Failed to save user profile:", e);
      alert("Failed to save profile");
    }
  };
  // --------------------------

  const [blockedFilters, setBlockedFilters] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("meta_blocked_filters");
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error("Failed to load blocked filters:", e);
      return [];
    }
  });

  useEffect(() => { 
    try {
      localStorage.setItem("meta_blocked_filters", JSON.stringify(blockedFilters));
    } catch (e) {
      console.error("Failed to save blocked filters:", e);
    }
  }, [blockedFilters]);

  // --- DERIVED STATE ---
  const visibleSlackTasks = slackTasks.filter(t => {
    const chKey = `channel:${t.metadata.sourceLabel}`;
    const userKey = `author:${t.metadata.author}`;
    return !blockedFilters.includes(chKey) && !blockedFilters.includes(userKey);
  });

  const availableFilters = useMemo(() => {
    const channels = new Set<string>();
    const authors = new Set<string>();
    slackTasks.forEach(t => { 
        if(t.metadata.sourceLabel) channels.add(t.metadata.sourceLabel); 
        if(t.metadata.author) authors.add(t.metadata.author); 
    });
    return { channels: Array.from(channels).sort(), authors: Array.from(authors).sort() };
  }, [slackTasks]);
  // --------------------

  const getArchivedIds = (): string[] => {
    try {
      const stored = localStorage.getItem("meta_archived_ids");
      return stored ? JSON.parse(stored) : [];
    } catch (e) {
      console.error("Failed to read archived IDs from localStorage:", e);
      return [];
    }
  };

  const calculateDateRange = () => {
    const now = new Date();
    const end = new Date(); 
    let start = new Date();

    switch (timeRange) {
        case 'today': start.setHours(0,0,0,0); break;
        case '3days': start.setDate(now.getDate() - 3); break;
        case 'week': start.setDate(now.getDate() - 7); break;
        case '2weeks': start.setDate(now.getDate() - 14); break;
        case 'month': start.setMonth(now.getMonth() - 1); break;
        case 'year': start.setFullYear(now.getFullYear() - 1); break;
        case 'custom': 
            start = customStart ? new Date(customStart) : start;
            if (customEnd) end.setTime(new Date(customEnd).setHours(23,59,59));
            break;
    }
    return { start, end };
  };

  // FIX: Prevent race conditions with isSyncing flag
  const sync = async (ctx: SlackContext) => {
    if (isSyncing) {
      console.warn("Sync already in progress");
      return;
    }

    setIsSyncing(true);
    setLoading(true);
    
    try {
      const archivedIds = getArchivedIds();
      const { start, end } = calculateDateRange(); 

      console.log(`🔄 Syncing... Range: ${start.toLocaleDateString()} - ${end.toLocaleDateString()}`);

      const [slackData, asanaData] = await Promise.allSettled([
        fetchSlackSignals(ctx, start, end),
        fetchAsanaTasks()
      ]);
      
      if (slackData.status === 'fulfilled' && Array.isArray(slackData.value)) {
        const active = slackData.value.filter(t => !archivedIds.includes(t.id));
        setSlackTasks(active);
      }
      if (asanaData.status === 'fulfilled' && Array.isArray(asanaData.value)) {
        // Deduplicate Asana tasks by gid (Asana's global ID)
        const uniqueTasks = Array.from(
          new Map(asanaData.value.map(t => [t.externalId || t.id, t])).values()
        );
        setAsanaTasks(uniqueTasks);
      }
    } catch (e) {
      console.error("Sync error:", e);
    } finally {
      setLoading(false);
      setIsSyncing(false);
    }
  };

  // Debounce sync triggers to avoid overlapping calls
  const syncDebounceRef = useRef<number | null>(null);
  const requestSync = (ctx: SlackContext) => {
    if (!ctx) return;
    if (syncDebounceRef.current) {
      clearTimeout(syncDebounceRef.current);
    }
    syncDebounceRef.current = window.setTimeout(() => {
      sync(ctx);
    }, 300);
  };

  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true);
        console.log("🏗️ Building Slack Context...");
        const ctx = await buildSlackContext();
        setSlackContext(ctx);
        setLoading(false);
      } catch (e: any) {
        console.error("Initialization Failed:", e);
        setInitError("Failed to connect to Slack.");
        setLoading(false);
      }
    };
    init();
  }, []);

  useEffect(() => {
    if (slackContext) requestSync(slackContext);
  }, [slackContext, timeRange, customStart, customEnd]);

  const clearArchive = () => {
    if (confirm("Are you sure you want to un-archive all messages?")) {
      try {
        localStorage.removeItem("meta_archived_ids");
        if (slackContext) requestSync(slackContext); 
      } catch (e) {
        console.error("Failed to clear archive:", e);
        alert("Failed to clear archive");
      }
    }
  };
  
  const clearFilters = () => { setBlockedFilters([]); };

  // FIX: Add try-catch for localStorage operations
  const handleArchive = (id: string) => {
    try {
      const current = getArchivedIds();
      localStorage.setItem("meta_archived_ids", JSON.stringify([...current, id]));
      setSlackTasks(prev => prev.filter(t => t.id !== id));
    } catch (e) {
      console.error("Failed to archive task:", e);
      alert("Failed to archive task");
    }
  };

  const requestArchiveAll = () => {
    if (visibleSlackTasks.length === 0) return;
    setShowArchiveConfirm(true);
  };

  // FIX: Add try-catch for localStorage operations
  const executeArchiveAll = () => {
    try {
      const current = getArchivedIds();
      const newIds = visibleSlackTasks.map(t => t.id);
      localStorage.setItem("meta_archived_ids", JSON.stringify([...current, ...newIds]));
      
      setSlackTasks(prev => prev.filter(t => !newIds.includes(t.id)));
      setShowArchiveConfirm(false);
    } catch (e) {
      console.error("Failed to archive all:", e);
      alert("Failed to archive tasks");
      setShowArchiveConfirm(false);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    setAsanaTasks(currentTasks => currentTasks.filter(t => t.externalId !== taskId));
    const success = await completeAsanaTask(taskId);
    if (!success && slackContext) requestSync(slackContext); 
  };

  // FIX: Add null check for task and error handling
  const handleAiPromote = async (task: UnifiedTask) => {
    if (!task || !task.id) {
      console.error("Invalid task for promotion");
      return;
    }

    setAnalyzingId(task.id); 
    try {
      const projects = await getProjectList();
      const suggestions = await analyzeSignal(task.title, projects);
      if (suggestions.length === 0) { 
        alert("No tasks found."); 
        setAnalyzingId(null);
        return; 
      }
      setReviewState({ sourceTask: task, suggestions, selectedIndices: new Set(suggestions.map((_, i) => i)) });
    } catch (e) {
      console.error("AI promotion failed:", e);
      alert("Failed to analyze signal");
    } finally {
      setAnalyzingId(null);
    }
  };

  // FIX: Add null check for reviewState and error handling
  const handleApproveSuggestions = async () => {
    if (!reviewState) {
      console.error("No review state");
      return;
    }

    setReviewState(null); 
    setLoading(true);
    
    try {
      for (const [i, item] of reviewState.suggestions.entries()) {
        if (reviewState.selectedIndices.has(i)) {
          await createAsanaTaskWithProject(
            item.title, 
            item.projectName, 
            `Context: ${reviewState.sourceTask.url}\n\nReasoning: ${item.reasoning}`
          );
        }
      }
      handleArchive(reviewState.sourceTask.id);
      const newAsana = await fetchAsanaTasks();
      setAsanaTasks(newAsana);
    } catch (e) {
      console.error("Failed to approve suggestions:", e);
      alert("Failed to create some tasks");
    } finally {
      setLoading(false);
    }
  };

  const handleSynthesize = async () => {
    if (!slackContext) return;
    setLoading(true);

    if (visibleSlackTasks.length === 0) { alert("No signals to synthesize."); setLoading(false); return; }

    const richSignals = visibleSlackTasks.map(task => ({
        id: task.id, 
        mainMessage: { 
            text: task.title, 
            user: task.metadata.author,
            files: task.metadata.fileData ? [task.metadata.fileData] : []
        }, 
        thread: [], 
        source: 'slack',
        url: task.url,
        channelName: task.metadata.sourceLabel 
    }));

    const projects = await getProjectList();
    setAvailableProjects(projects);
    const plan = await synthesizeWorkload(richSignals, [], projects, userProfile);
    setSynthesisResults(plan);
    
    // Initialize selected projects to "None" by default
    const initialSelections: Record<number, string> = {};
    plan.forEach((_task, idx) => {
      initialSelections[idx] = 'None';
    });
    setSelectedProjects(initialSelections);
    
    setLoading(false);
  };

  const handleApproveSynthesizedTask = async (task: ProposedTask, index: number) => {
    setProcessingTaskIdx(index);
    try {
      // Build description with citations and source links
      let fullDescription = task.description;
      
      // Add citations section
      if (task.citations && task.citations.length > 0) {
        fullDescription += `\n\nCitations:\n${task.citations.map(c => `• ${c}`).join('\n')}`;
      }
      
      // Add source links section
      if (task.sourceLinks && task.sourceLinks.length > 0) {
        fullDescription += `\n\nSource Documents:\n${task.sourceLinks.map(link => `• [${link.text}](${link.url})`).join('\n')}`;
      }
      
      // Use user-selected project instead of AI suggestion
      const selectedProject = selectedProjects[index] === 'None' ? '' : selectedProjects[index];
      const parentId = await createAsanaTaskWithProject(task.title, selectedProject, fullDescription);
        if (parentId) {
          for (const sub of task.subtasks) await createAsanaSubtask(parentId, sub, fullDescription);
          setSynthesisResults(prev => prev ? prev.filter((_, i) => i !== index) : null);
          const newAsana = await fetchAsanaTasks();
          setAsanaTasks(newAsana);
      }
    } catch (e) {
      alert("Failed to create task");
    } finally {
      setProcessingTaskIdx(null);
    }
  };

  const handleDismissSynthesizedTask = (index: number) => {
     if (synthesisResults) {
        const newResults = [...synthesisResults];
        newResults.splice(index, 1);
        setSynthesisResults(newResults);
     }
  };

  const toggleFilter = (key: string) => { setBlockedFilters(prev => prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key]); };
  const toggleAll = (keys: string[], prefix: string, shouldBlock: boolean) => {
    setBlockedFilters(prev => {
        const currentSet = new Set(prev);
        keys.forEach(k => {
            const key = `${prefix}:${k}`;
            shouldBlock ? currentSet.add(key) : currentSet.delete(key);
        });
        return Array.from(currentSet);
    });
  };

  const renderFlatList = (tasks: UnifiedTask[]) => {
      return (
        <div className="space-y-1">
            {tasks
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map((t, idx) => {
                    // Create a stable hash from task properties for truly unique keys
                    const keyData = `${t.externalId || t.id}-${t.title}-${t.createdAt}-${idx}`;
                    const hash = keyData.split('').reduce((acc, char) => ((acc << 5) - acc) + char.charCodeAt(0), 0);
                    const uniqueKey = `task-${Math.abs(hash)}`;
                    return (
                        <div key={uniqueKey} className="relative">
                            <TaskCard task={t} onPromote={handleAiPromote} onArchive={handleArchive} />
                            {analyzingId === t.id && <div className="absolute inset-0 bg-white/90 flex items-center justify-center rounded-lg z-10 backdrop-blur-sm"><Sparkles size={20} className="text-purple-700 animate-pulse" /></div>}
                        </div>
                    );
                })
            }
        </div>
      );
  };

  const renderAsanaList = (tasks: UnifiedTask[]) => {
      const groups: Record<string, UnifiedTask[]> = {};
      tasks.forEach(t => { const p = t.metadata.sourceLabel || "My Tasks"; if (!groups[p]) groups[p] = []; groups[p].push(t); });
      return Object.keys(groups).sort().map(project => (
        <div key={project} className="mb-6">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-2"><Inbox size={12} /> {project}</h3>
          <div className="space-y-1">{groups[project].map((t, idx) => {
            const keyData = `${t.externalId || t.id}-${t.title}-${t.createdAt}-${idx}`;
            const hash = keyData.split('').reduce((acc, char) => ((acc << 5) - acc) + char.charCodeAt(0), 0);
            const uniqueKey = `asana-${Math.abs(hash)}`;
            return <TaskCard key={uniqueKey} task={t} onComplete={handleCompleteTask} />;
          })}</div>
        </div>
      ));
  };

  return (
    <div className="min-h-screen p-8 text-gray-900 font-sans bg-gray-50 relative">
      {slackTasks.length === 0 && (
        <div className="fixed inset-0 bg-black/10 backdrop-blur-sm flex items-center justify-center z-40">
          <div className="bg-white rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 bg-gradient-to-r from-purple-500 to-purple-600 rounded-full animate-spin" style={{clipPath: "polygon(50% 0%, 50% 50%, 100% 50%, 100% 100%, 0% 100%, 0% 50%)"}}></div>
              <div className="absolute inset-1 bg-white rounded-full flex items-center justify-center">
                <Sparkles size={20} className="text-purple-600" />
              </div>
            </div>
            <div className="text-center">
              <p className="font-bold text-gray-900">Loading signals...</p>
              <p className="text-sm text-gray-500 mt-1">Connecting to Slack and Asana</p>
            </div>
          </div>
        </div>
      )}
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
        <div className="flex items-center gap-3">
            <div className="p-2 bg-black rounded-lg"><LayoutTemplate className="text-white" size={24} /></div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-gray-900">Meta-Layer</h1>
              {initError && <span className="text-xs text-red-500 font-bold">{initError}</span>}
            </div>
        </div>
        
        <div className="flex flex-wrap gap-2 items-center">
            <div className="flex items-center gap-2 bg-white border border-gray-200 px-3 py-2 rounded-lg shadow-sm">
                <Calendar size={16} className="text-gray-500" />
                <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)} className="bg-transparent border-none text-sm font-medium text-gray-700 cursor-pointer focus:ring-0">
                    <option value="today">Today</option>
                    <option value="3days">Past 3 Days</option>
                    <option value="week">Past Week</option>
                    <option value="month">Past Month</option>
                    <option value="year">Past Year</option>
                    <option value="custom">Custom...</option>
                </select>
                {timeRange === 'custom' && (
                    <div className="flex gap-1 items-center ml-2">
                        <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="border rounded px-2 py-1 text-xs" />
                        <span className="text-gray-400">-</span>
                        <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="border rounded px-2 py-1 text-xs" />
                    </div>
                )}
            </div>
            
            <button onClick={() => setShowProfileModal(true)} className={`flex items-center gap-2 border px-3 py-2 rounded-lg transition font-medium text-sm ${userProfile ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-white text-gray-700 hover:bg-gray-50'}`} title="User Profile">
                <User size={16} /> Profile
            </button>

            <button onClick={clearArchive} className="flex items-center gap-2 bg-white border px-3 py-2 rounded-lg hover:bg-red-50 text-gray-700 hover:text-red-600 transition font-medium text-sm" title="Reset Archive">
                <Trash2 size={16} /> Reset
            </button>

            {blockedFilters.length > 0 && <button onClick={clearFilters} className="flex items-center gap-2 bg-purple-100 text-purple-700 px-3 py-2 rounded-lg text-sm font-bold"><RotateCcw size={14}/> Clear ({blockedFilters.length})</button>}
            
            <button onClick={handleSynthesize} disabled={!slackContext} className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition font-bold text-sm disabled:opacity-50"><BrainCircuit size={16} /> {loading ? "..." : "Synthesize"}</button>
            
            <button onClick={() => setShowFilterModal(true)} className={`flex items-center gap-2 border px-3 py-2 rounded-lg transition font-medium text-sm ${blockedFilters.length ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white text-gray-700'}`}><Filter size={16} /> Filters</button>
            
            <button onClick={() => slackContext && sync(slackContext)} disabled={!slackContext || isSyncing} className="flex items-center gap-2 bg-white border px-4 py-2 rounded-lg hover:bg-gray-50 text-gray-700 transition font-medium text-sm disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""} /> Sync</button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
         <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
                <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">Signals <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{visibleSlackTasks.length}</span></h2>
                {visibleSlackTasks.length > 0 && <button onClick={requestArchiveAll} className="text-xs flex items-center gap-1 text-gray-400 hover:text-gray-600"><Archive size={14} /> Archive All</button>}
            </div>
            {renderFlatList(visibleSlackTasks)}
         </div>

         <div className="flex flex-col gap-4">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">Action Items <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span></h2>
            {renderAsanaList(asanaTasks)}
         </div>
      </div>

      {showProfileModal && (
        <UserProfileModal 
            initialProfile={userProfile} 
            onSave={handleSaveProfile} 
            onClose={() => setShowProfileModal(false)} 
        />
      )}

      {showArchiveConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="p-3 bg-yellow-100 rounded-full text-yellow-600">
                <AlertTriangle size={32} />
              </div>
              <h3 className="text-lg font-bold text-gray-900">Archive All Signals?</h3>
              <p className="text-sm text-gray-500">
                Are you sure you want to archive <b>{visibleSlackTasks.length}</b> visible signals? 
                This will remove them from your main view.
              </p>
              <div className="flex gap-3 w-full mt-2">
                <button 
                  onClick={() => setShowArchiveConfirm(false)} 
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button 
                  onClick={executeArchiveAll} 
                  className="flex-1 px-4 py-2 bg-black text-white rounded-lg font-bold hover:bg-gray-800"
                >
                  Yes, Archive
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showFilterModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden p-6 max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold">Signal Filters</h3>
                <button onClick={() => setShowFilterModal(false)}><X className="text-gray-400" /></button>
            </div>
            
            <div className="relative mb-6">
                <input 
                    type="text" 
                    placeholder="Search channels & people..." 
                    className="w-full border border-gray-300 rounded-lg pl-10 pr-4 py-2 text-sm focus:border-purple-500 focus:ring-1 focus:ring-purple-500"
                    value={filterSearch}
                    onChange={e => setFilterSearch(e.target.value)}
                />
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            </div>

            <div className="mb-6">
                <div className="flex justify-between mb-2">
                    <h4 className="text-xs font-bold text-gray-400 uppercase">Sources</h4>
                    <div className="text-xs space-x-2 text-blue-600 cursor-pointer">
                        <span onClick={() => toggleAll(availableFilters.channels, 'channel', false)}>All</span>
                        <span onClick={() => toggleAll(availableFilters.channels, 'channel', true)}>None</span>
                    </div>
                </div>
                {availableFilters.channels
                    .filter(c => c.toLowerCase().includes(filterSearch.toLowerCase()))
                    .map(c => (
                    <label key={c} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded cursor-pointer">
                        <span className="text-sm">{c}</span>
                        <input type="checkbox" checked={!blockedFilters.includes(`channel:${c}`)} onChange={() => toggleFilter(`channel:${c}`)} />
                    </label>
                ))}
            </div>

            <div>
                <div className="flex justify-between mb-2">
                    <h4 className="text-xs font-bold text-gray-400 uppercase">Authors</h4>
                    <div className="text-xs space-x-2 text-blue-600 cursor-pointer">
                        <span onClick={() => toggleAll(availableFilters.authors, 'author', false)}>All</span>
                        <span onClick={() => toggleAll(availableFilters.authors, 'author', true)}>None</span>
                    </div>
                </div>
                {availableFilters.authors
                    .filter(a => a.toLowerCase().includes(filterSearch.toLowerCase()))
                    .map(a => (
                    <label key={a} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded cursor-pointer">
                        <span className="text-sm">@{a}</span>
                        <input type="checkbox" checked={!blockedFilters.includes(`author:${a}`)} onChange={() => toggleFilter(`author:${a}`)} />
                    </label>
                ))}
            </div>
          </div>
        </div>
      )}

      {synthesisResults && (
        <div className="fixed inset-0 bg-gray-900/90 backdrop-blur-sm flex items-center justify-center z-50 p-6">
            <div className="bg-white rounded-2xl shadow-xl max-w-4xl w-full h-[85vh] flex flex-col">
                <div className="p-6 border-b flex justify-between items-center">
                    <h2 className="text-2xl font-bold flex items-center gap-2"><Sparkles className="text-purple-600" /> Plan</h2>
                    <button onClick={() => setSynthesisResults(null)}><X /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {synthesisResults.map((task, i) => (
                        <div key={`synthesis-${i}`} className="border rounded-xl p-6 hover:shadow-lg transition">
                            <div className="flex flex-col gap-4">
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <h3 className="text-lg font-bold">{task.title}</h3>
                                    </div>
                                    <p className="text-gray-600 mb-4">{task.description}</p>
                                    <ul className="list-disc pl-5 space-y-1 mb-4 text-sm text-gray-700">{task.subtasks.map((s, sIdx) => <li key={`subtask-${i}-${sIdx}`}>{s}</li>)}</ul>
                                    <div className="text-xs text-gray-400 mb-3">Sources: {task.citations.join(", ")}</div>
                                </div>
                                <div className="flex items-center gap-3 flex-wrap">
                                  <label className="text-xs font-bold text-gray-500 uppercase whitespace-nowrap">Project:</label>
                                  <select 
                                    value={selectedProjects[i] || 'None'} 
                                    onChange={(e) => setSelectedProjects(prev => ({...prev, [i]: e.target.value}))}
                                    className="text-sm border border-gray-300 rounded px-2 py-1 bg-white focus:ring-2 focus:ring-purple-500 focus:border-transparent flex-1 min-w-[150px]"
                                  >
                                    <option value="None">None (My Tasks)</option>
                                    {availableProjects.map(p => (
                                      <option key={p} value={p}>{p}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="flex flex-col gap-2 pt-2 border-t">
                                    <button onClick={() => handleApproveSynthesizedTask(task, i)} disabled={processingTaskIdx === i} className="bg-black text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 hover:bg-gray-800 disabled:opacity-50 w-full justify-center">
                                        {processingTaskIdx === i ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />} Accept
                                    </button>
                                    <button onClick={() => handleDismissSynthesizedTask(i)} className="text-gray-400 hover:text-red-500 text-sm text-center">Dismiss</button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
      )}

      {reviewState && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl max-w-lg w-full overflow-hidden">
                <div className="bg-purple-600 p-6 text-white flex justify-between">
                    <h3 className="font-bold text-lg flex items-center gap-2"><Sparkles size={18} /> Suggestions</h3>
                    <button onClick={() => setReviewState(null)}><X size={20} /></button>
                </div>
                <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                    {reviewState.suggestions.map((s, i) => (
                        <div key={i} onClick={() => {
                            const next = new Set(reviewState.selectedIndices);
                            next.has(i) ? next.delete(i) : next.add(i);
                            setReviewState({...reviewState, selectedIndices: next});
                        }} className={`p-4 border rounded-lg cursor-pointer transition ${reviewState.selectedIndices.has(i) ? 'border-purple-500 bg-purple-50' : 'hover:bg-gray-50'}`}>
                            <div className="flex justify-between items-start mb-2">
                                <h4 className="font-bold text-gray-900">{s.title}</h4>
                                {reviewState.selectedIndices.has(i) && <Check size={16} className="text-purple-600" />}
                            </div>
                            <div className="text-xs text-blue-600 font-medium mb-1 uppercase">{s.projectName}</div>
                            <p className="text-xs text-gray-500">{s.reasoning}</p>
                        </div>
                    ))}
                </div>
                <div className="p-4 border-t flex justify-end gap-2">
                    <button onClick={() => setReviewState(null)} className="px-4 py-2 text-gray-600 text-sm font-medium">Cancel</button>
                    <button onClick={handleApproveSuggestions} className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-bold hover:bg-purple-700">Create Selected</button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
}

export default App;
