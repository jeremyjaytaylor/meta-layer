import { useState, useEffect, useMemo } from "react";
import { UnifiedTask } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals, fetchRichSignals } from "./adapters/slack"; 
import { fetchAsanaTasks, completeAsanaTask, getProjectList, createAsanaTaskWithProject, createAsanaSubtask } from "./adapters/asana";
import { analyzeSignal, synthesizeWorkload, ProposedTask, AiSuggestion } from "./adapters/gemini"; 
import { RefreshCw, LayoutTemplate, Sparkles, X, Check, Inbox, Filter, BrainCircuit, Calendar, Trash2, RotateCcw, Archive } from "lucide-react"; 
import "./App.css";

type TimeRange = 'today' | '3days' | 'week' | '2weeks' | 'month' | 'year' | 'custom';

function App() {
  const [slackTasks, setSlackTasks] = useState<UnifiedTask[]>([]);
  const [asanaTasks, setAsanaTasks] = useState<UnifiedTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  
  // -- TIME FILTER --
  const [timeRange, setTimeRange] = useState<TimeRange>('week');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  // Modals
  const [reviewState, setReviewState] = useState<{ sourceTask: UnifiedTask, suggestions: AiSuggestion[], selectedIndices: Set<number> } | null>(null);
  const [synthesisResults, setSynthesisResults] = useState<ProposedTask[] | null>(null);
  const [showFilterModal, setShowFilterModal] = useState(false);
  
  // UI State for Synthesis Processing
  const [processingTaskIdx, setProcessingTaskIdx] = useState<number | null>(null);
  
  // Persistence
  const [blockedFilters, setBlockedFilters] = useState<string[]>(() => {
    const stored = localStorage.getItem("meta_blocked_filters");
    return stored ? JSON.parse(stored) : [];
  });
  const getArchivedIds = (): string[] => {
    const stored = localStorage.getItem("meta_archived_ids");
    return stored ? JSON.parse(stored) : [];
  };
  const archiveId = (id: string) => {
    const current = getArchivedIds();
    localStorage.setItem("meta_archived_ids", JSON.stringify([...current, id]));
  };
  
  useEffect(() => { localStorage.setItem("meta_blocked_filters", JSON.stringify(blockedFilters)); }, [blockedFilters]);

  // HELPERS
  const clearArchive = () => {
    if (confirm("Are you sure you want to un-archive all messages?")) {
        localStorage.removeItem("meta_archived_ids");
        sync(); 
    }
  };
  
  const clearFilters = () => {
      setBlockedFilters([]); 
  };

  // UPDATED: Returns a Range { start, end }
  const calculateDateRange = (): { start?: Date, end?: Date } => {
    const now = new Date();
    const end = new Date(); // Default end is "Now"

    switch (timeRange) {
        case 'today': 
            return { start: new Date(now.setHours(0,0,0,0)), end };
        case '3days': 
            return { start: new Date(now.setDate(now.getDate() - 3)), end };
        case 'week': 
            return { start: new Date(now.setDate(now.getDate() - 7)), end };
        case '2weeks': 
            return { start: new Date(now.setDate(now.getDate() - 14)), end };
        case 'month': 
            return { start: new Date(now.setMonth(now.getMonth() - 1)), end };
        case 'year': 
            return { start: new Date(now.setFullYear(now.getFullYear() - 1)), end };
        case 'custom': 
            // For custom, we respect the user's end date (set to end of that day)
            const cEnd = customEnd ? new Date(customEnd) : undefined;
            if (cEnd) cEnd.setHours(23, 59, 59, 999);
            return { 
                start: customStart ? new Date(customStart) : undefined, 
                end: cEnd
            };
        default: 
            return { start: undefined, end: undefined };
    }
  };

  // SYNC ENGINE
  const sync = async () => {
    setLoading(true);
    const archived = getArchivedIds();
    const { start, end } = calculateDateRange(); // Get Range

    console.log(`🔄 Syncing... Range: ${start?.toLocaleDateString()} - ${end?.toLocaleDateString()}`);

    const [slackData, asanaData] = await Promise.allSettled([
      fetchSlackSignals(start, end), // Pass both dates
      fetchAsanaTasks()              // Asana unfiltered (as requested)
    ]);
    
    if (slackData.status === 'fulfilled') {
      const rawCount = slackData.value.length;
      const newSlackTasks = slackData.value.filter(t => !archived.includes(t.id));
      setSlackTasks(newSlackTasks);
    }
    if (asanaData.status === 'fulfilled') setAsanaTasks(asanaData.value);

    setLoading(false);
  };

  useEffect(() => { sync(); }, [timeRange, customStart, customEnd]);

  // ACTIONS
  const handleArchive = (id: string) => { archiveId(id); setSlackTasks(prev => prev.filter(t => t.id !== id)); };
  
  const handleArchiveAll = () => {
    if (slackTasks.length === 0) return;
    if (confirm(`Are you sure you want to archive all ${slackTasks.length} visible signals?`)) {
        const currentArchived = getArchivedIds();
        const newIds = slackTasks.map(t => t.id);
        const merged = Array.from(new Set([...currentArchived, ...newIds]));
        localStorage.setItem("meta_archived_ids", JSON.stringify(merged));
        setSlackTasks([]);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    setAsanaTasks(currentTasks => currentTasks.filter(t => t.externalId !== taskId));
    const success = await completeAsanaTask(taskId);
    if (!success) sync(); 
  };

  const handleAiPromote = async (task: UnifiedTask) => {
    setAnalyzingId(task.id); 
    const projects = await getProjectList();
    const suggestions = await analyzeSignal(task.title, projects);
    setAnalyzingId(null);
    if (suggestions.length === 0) { alert("AI couldn't find any tasks."); return; }
    const allIndices = new Set(suggestions.map((_, i) => i));
    setReviewState({ sourceTask: task, suggestions, selectedIndices: allIndices });
  };

  const handleApproveSuggestions = async () => {
    if (!reviewState) return;
    const { sourceTask, suggestions, selectedIndices } = reviewState;
    setReviewState(null); 
    setLoading(true);

    let createdCount = 0;
    const tasksToCreate = suggestions.filter((_, i) => selectedIndices.has(i));

    for (const item of tasksToCreate) {
      await createAsanaTaskWithProject(item.title, item.projectName, `Context: ${sourceTask.url}\n\nReasoning: ${item.reasoning}`);
      createdCount++;
    }

    if (createdCount > 0) {
      handleArchive(sourceTask.id); 
      const newAsanaTasks = await fetchAsanaTasks();
      setAsanaTasks(newAsanaTasks);
    }
    setLoading(false);
  };

  const handleSynthesize = async () => {
    setLoading(true);
    const { start, end } = calculateDateRange();
    const signals = await fetchRichSignals(start, end);
    
    if (signals.length === 0) { 
        alert("No Slack signals found in this time range."); 
        setLoading(false); 
        return; 
    }

    const filteredSignals = signals.filter(s => {
        const channelKey = `channel:${s.channelName}`;
        const authorKey = `author:${s.mainMessage.username || s.mainMessage.user}`;
        return !blockedFilters.includes(channelKey) && !blockedFilters.includes(authorKey);
    });

    if (filteredSignals.length === 0) {
        alert("All signals were filtered out.");
        setLoading(false);
        return;
    }

    const projects = await getProjectList();
    const plan = await synthesizeWorkload(filteredSignals, [], projects);
    setSynthesisResults(plan);
    setLoading(false);
  };

  const handleApproveSynthesizedTask = async (task: ProposedTask, index: number) => {
    setProcessingTaskIdx(index);

    try {
        const noteBody = `${task.description}\n\n--- SOURCES ---\n${task.citations.join('\n')}`;
        const parentId = await createAsanaTaskWithProject(task.title, task.project, noteBody);

        if (parentId && task.subtasks.length > 0) {
            for (const sub of task.subtasks) {
                await createAsanaSubtask(parentId, sub);
            }
        }
        
        if (synthesisResults) {
            const newResults = [...synthesisResults];
            newResults.splice(index, 1);
            setSynthesisResults(newResults);
        }
        
        const newAsanaTasks = await fetchAsanaTasks();
        setAsanaTasks(newAsanaTasks);

    } catch (error) {
        alert("Failed to create task.");
        console.error(error);
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

  const toggleFilter = (key: string) => {
    setBlockedFilters(prev => prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key]);
  };

  const toggleAll = (keys: string[], shouldBlock: boolean) => {
    setBlockedFilters(prev => {
        const currentSet = new Set(prev);
        keys.forEach(k => shouldBlock ? currentSet.add(k) : currentSet.delete(k));
        return Array.from(currentSet);
    });
  };
  
  const availableFilters = useMemo(() => {
    const channels = new Set<string>();
    const authors = new Set<string>();
    slackTasks.forEach(t => { 
        if(t.metadata.channel) channels.add(t.metadata.channel); 
        if(t.metadata.author) authors.add(t.metadata.author); 
    });
    return { channels: Array.from(channels).sort(), authors: Array.from(authors).sort() };
  }, [slackTasks]);

  const visibleSlackTasks = slackTasks.filter(t => {
    const channelKey = `channel:${t.metadata.channel}`;
    const authorKey = `author:${t.metadata.author}`;
    return !blockedFilters.includes(channelKey) && !blockedFilters.includes(authorKey);
  });

  const renderFlatList = (tasks: UnifiedTask[]) => {
      return (
        <div className="space-y-1">
            {tasks
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .map(t => (
                    <div key={t.id} className="relative">
                        <TaskCard task={t} onPromote={handleAiPromote} onArchive={handleArchive} />
                        {analyzingId === t.id && <div className="absolute inset-0 bg-white/90 flex items-center justify-center rounded-lg z-10 backdrop-blur-sm"><Sparkles size={20} className="text-purple-700 animate-pulse" /></div>}
                    </div>
                ))
            }
        </div>
      );
  };

  const renderAsanaList = (tasks: UnifiedTask[]) => {
      const groups: Record<string, UnifiedTask[]> = {};
      tasks.forEach(t => { const p = t.metadata.project || "My Tasks"; if (!groups[p]) groups[p] = []; groups[p].push(t); });
      return Object.keys(groups).sort().map(project => (
        <div key={project} className="mb-6">
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-2"><Inbox size={12} /> {project}</h3>
          <div className="space-y-1">{groups[project].map(t => <TaskCard key={t.id} task={t} onComplete={handleCompleteTask} />)}</div>
        </div>
      ));
  };

  return (
    <div className="min-h-screen p-8 text-gray-900 font-sans bg-gray-50 relative">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center mb-8 gap-4">
        <div className="flex items-center gap-3">
            <div className="p-2 bg-black rounded-lg"><LayoutTemplate className="text-white" size={24} /></div>
            <div><h1 className="text-2xl font-bold tracking-tight text-gray-900">Meta-Layer</h1></div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
            <div className="flex items-center gap-2 bg-white border border-gray-200 px-3 py-2 rounded-lg shadow-sm">
                <Calendar size={16} className="text-gray-500" />
                <select value={timeRange} onChange={(e) => setTimeRange(e.target.value as TimeRange)} className="bg-transparent border-none text-sm font-medium text-gray-700 focus:ring-0 cursor-pointer">
                    <option value="today">Today</option>
                    <option value="3days">Past 3 Days</option>
                    <option value="week">Past Week</option>
                    <option value="2weeks">Past 2 Weeks</option>
                    <option value="month">Past Month</option>
                    <option value="year">Past Year</option>
                    <option value="custom">Custom Range...</option>
                </select>
                {timeRange === 'custom' && (
                    <div className="flex gap-1 items-center">
                        <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} className="ml-2 border border-gray-300 rounded px-2 py-1 text-xs" />
                        <span className="text-gray-400">-</span>
                        <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-xs" />
                    </div>
                )}
            </div>
            <button onClick={clearArchive} className="flex items-center gap-2 bg-white border border-gray-200 text-gray-500 px-3 py-2 rounded-lg hover:bg-red-50 hover:text-red-600 transition shadow-sm" title="Reset Archive"><Trash2 size={16} /></button>
            {blockedFilters.length > 0 && (<button onClick={clearFilters} className="flex items-center gap-2 bg-purple-100 border border-purple-200 text-purple-700 px-3 py-2 rounded-lg hover:bg-purple-200 transition shadow-sm font-medium text-sm" title="Clear All Filters"><RotateCcw size={16} /> Clear ({blockedFilters.length})</button>)}
            <button onClick={handleSynthesize} className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition shadow-sm font-bold text-sm"><BrainCircuit size={16} />{loading ? "Thinking..." : "Synthesize Plan"}</button>
            <button onClick={() => setShowFilterModal(true)} className={`flex items-center gap-2 border px-3 py-2 rounded-lg transition shadow-sm font-medium text-sm ${blockedFilters.length > 0 ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white border-gray-200'}`}><Filter size={16} /> Filters</button>
            <button onClick={sync} className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition shadow-sm font-medium text-sm"><RefreshCw size={16} className={loading ? "animate-spin" : ""} />Sync</button>
        </div>
      </div>
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
         <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
                <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">Incoming Signals <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{visibleSlackTasks.length}</span></h2>
                {visibleSlackTasks.length > 0 && (
                    <button onClick={handleArchiveAll} className="text-xs flex items-center gap-1 text-gray-400 hover:text-gray-600 transition">
                        <Archive size={14} /> Archive All
                    </button>
                )}
            </div>
            {renderFlatList(visibleSlackTasks)}
         </div>
         <div className="flex flex-col gap-4">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">Action Items <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span></h2>
            {renderAsanaList(asanaTasks)}
         </div>
      </div>
      {/* ... (Keep Modals Logic Same) ... */}
      {showFilterModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-white p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2"><Filter size={20} /> Signal Filters</h3>
              <button onClick={() => setShowFilterModal(false)} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
            </div>
            <div className="p-6 max-h-[60vh] overflow-y-auto">
              <div className="mb-6">
                <div className="flex justify-between items-center mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400">Channels / Projects</h4>
                    <div className="flex gap-2 text-xs text-blue-600">
                        <button onClick={() => toggleAll(availableFilters.channels.map(c => `channel:${c}`), false)}>All</button>
                        <button onClick={() => toggleAll(availableFilters.channels.map(c => `channel:${c}`), true)}>None</button>
                    </div>
                </div>
                <div className="space-y-2">
                  {availableFilters.channels.map(channel => {
                    const key = `channel:${channel}`;
                    const isBlocked = blockedFilters.includes(key);
                    return (
                      <label key={key} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
                        <span className="font-medium text-gray-700">{channel.startsWith('📂') ? channel : `#${channel}`}</span>
                        <input type="checkbox" checked={!isBlocked} onChange={() => toggleFilter(key)} className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
                      </label>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-3">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400">Authors</h4>
                    <div className="flex gap-2 text-xs text-blue-600">
                        <button onClick={() => toggleAll(availableFilters.authors.map(a => `author:${a}`), false)}>All</button>
                        <button onClick={() => toggleAll(availableFilters.authors.map(a => `author:${a}`), true)}>None</button>
                    </div>
                </div>
                <div className="space-y-2">
                  {availableFilters.authors.map(author => {
                    const key = `author:${author}`;
                    const isBlocked = blockedFilters.includes(key);
                    return (
                      <label key={key} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
                        <span className="font-medium text-gray-700">@{author}</span>
                        <input type="checkbox" checked={!isBlocked} onChange={() => toggleFilter(key)} className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500" />
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {synthesisResults && (
        <div className="fixed inset-0 bg-gray-900/90 backdrop-blur-sm flex items-center justify-center z-50 p-6">
          <div className="bg-gray-50 rounded-2xl shadow-2xl max-w-5xl w-full h-[85vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-white p-6 border-b flex justify-between items-center">
              <h2 className="text-2xl font-bold flex items-center gap-2"><Sparkles className="text-purple-600" /> Proposed Project Plan</h2>
              <button onClick={() => setSynthesisResults(null)} className="p-2 hover:bg-gray-100 rounded-full"><X /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {synthesisResults.map((task, idx) => (
                <div key={idx} className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="bg-blue-100 text-blue-800 text-xs font-bold px-2 py-1 rounded uppercase tracking-wide">{task.project}</span>
                        <h3 className="text-xl font-bold text-gray-900">{task.title}</h3>
                      </div>
                      <p className="text-gray-600 mb-4">{task.description}</p>
                      <div className="bg-gray-50 p-4 rounded-lg mb-4">
                        <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">Recommended Subtasks</h4>
                        <ul className="space-y-2">{task.subtasks.map((sub, i) => <li key={i} className="flex items-center gap-2 text-sm text-gray-700"><div className="w-1.5 h-1.5 bg-gray-400 rounded-full"></div>{sub}</li>)}</ul>
                      </div>
                      <div className="text-xs text-gray-400 italic">Sources: {task.citations.join(" • ")}</div>
                    </div>
                    <div className="flex flex-col gap-2 ml-6">
                        <button onClick={() => handleApproveSynthesizedTask(task, idx)} disabled={processingTaskIdx === idx} className={`bg-black text-white px-4 py-2 rounded-lg font-bold hover:bg-gray-800 transition flex items-center gap-2 whitespace-nowrap ${processingTaskIdx === idx ? 'opacity-50 cursor-not-allowed' : ''}`}>{processingTaskIdx === idx ? <RefreshCw size={16} className="animate-spin" /> : <Check size={16} />}{processingTaskIdx === idx ? "Creating..." : "Accept"}</button>
                        <button onClick={() => handleDismissSynthesizedTask(idx)} disabled={processingTaskIdx === idx} className="text-gray-400 hover:text-gray-600 text-sm font-medium py-1 text-center">Dismiss</button>
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
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-purple-600 p-6 text-white flex justify-between items-start">
              <div>
                <h3 className="text-xl font-bold flex items-center gap-2"><Sparkles size={20} className="text-purple-200" /> AI Suggested Actions</h3>
                <p className="text-purple-100 text-sm mt-1 opacity-90">Select the tasks you want to create.</p>
              </div>
              <button onClick={() => setReviewState(null)} className="text-white/60 hover:text-white transition"><X size={24} /></button>
            </div>
            <div className="p-6 bg-gray-50 max-h-[60vh] overflow-y-auto space-y-3">
              {reviewState.suggestions.map((item, idx) => {
                const isSelected = reviewState.selectedIndices.has(idx);
                return (
                  <div key={idx} onClick={() => { const newSet = new Set(reviewState.selectedIndices); isSelected ? newSet.delete(idx) : newSet.add(idx); setReviewState({ ...reviewState, selectedIndices: newSet }); }} className={`p-4 rounded-xl border cursor-pointer transition flex gap-3 items-start ${isSelected ? 'bg-white border-purple-300 ring-1 ring-purple-100' : 'bg-gray-100 border-transparent opacity-60'}`}>
                    <div className={`mt-1 w-5 h-5 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-purple-600 border-purple-600 text-white' : 'bg-white border-gray-300'}`}>{isSelected && <Check size={12} />}</div>
                    <div>
                      <h4 className={`font-bold ${isSelected ? 'text-gray-900' : 'text-gray-500'}`}>{item.title}</h4>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Project:</span>
                        <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded text-xs font-medium border border-blue-100">{item.projectName}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-2 italic">"{item.reasoning}"</p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="p-4 border-t border-gray-100 bg-white flex justify-end gap-3">
              <button onClick={() => setReviewState(null)} className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-100 rounded-lg transition">Cancel</button>
              <button onClick={handleApproveSuggestions} className="px-6 py-2 bg-purple-600 text-white font-bold rounded-lg hover:bg-purple-700 transition flex items-center gap-2 shadow-lg shadow-purple-200"><Check size={18} /> Create {reviewState.selectedIndices.size} Tasks</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
