import { useState, useEffect, useMemo } from "react";
import { UnifiedTask } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals } from "./adapters/slack";
import { fetchAsanaTasks, completeAsanaTask, getProjectList, createAsanaTaskWithProject } from "./adapters/asana";
import { analyzeSignal, batchCategorize, AiSuggestion } from "./adapters/gemini"; 
import { RefreshCw, LayoutTemplate, Sparkles, X, Check, Inbox, Filter } from "lucide-react"; 
import "./App.css";

function App() {
  const [slackTasks, setSlackTasks] = useState<UnifiedTask[]>([]);
  const [asanaTasks, setAsanaTasks] = useState<UnifiedTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  
  const [slackProjectMap, setSlackProjectMap] = useState<Record<string, string>>({});

  // --- STATE FOR MODALS ---
  const [reviewState, setReviewState] = useState<{ 
    sourceTask: UnifiedTask, 
    suggestions: AiSuggestion[],
    selectedIndices: Set<number> 
  } | null>(null);

  const [showFilterModal, setShowFilterModal] = useState(false);

  // --- PERSISTENCE: Archived IDs & Blocked Filters ---
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

  // Save filters whenever they change
  useEffect(() => {
    localStorage.setItem("meta_blocked_filters", JSON.stringify(blockedFilters));
  }, [blockedFilters]);

  // --- SYNC ENGINE ---
  const sync = async () => {
    setLoading(true);
    const archived = getArchivedIds();

    const [slackData, asanaData] = await Promise.allSettled([
      fetchSlackSignals(),
      fetchAsanaTasks()
    ]);

    let newSlackTasks: UnifiedTask[] = [];

    if (slackData.status === 'fulfilled') {
      // 1. Remove Archived
      // 2. We do NOT remove Blocked Filters here yet, we do it in render so the list of available filters is accurate
      newSlackTasks = slackData.value.filter(t => !archived.includes(t.id));
      setSlackTasks(newSlackTasks);
    }
    
    if (asanaData.status === 'fulfilled') {
      setAsanaTasks(asanaData.value);
    }

    if (newSlackTasks.length > 0) {
      console.log("🧠 Batch categorizing Slack messages...");
      const projects = await getProjectList();
      const simpleMessages = newSlackTasks.map(t => ({ id: t.id, text: t.title }));
      
      const categoryMap = await batchCategorize(simpleMessages, projects);
      setSlackProjectMap(prev => ({ ...prev, ...categoryMap }));
    }

    setLoading(false);
  };

  useEffect(() => { sync(); }, []);

  // --- ACTIONS ---
  const handleArchive = (id: string) => {
    archiveId(id); 
    setSlackTasks(prev => prev.filter(t => t.id !== id));
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

    if (suggestions.length === 0) {
      alert("AI couldn't find any tasks.");
      return;
    }
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
      await createAsanaTaskWithProject(
        item.title, 
        item.projectName, 
        `Context: ${sourceTask.url}\n\nReasoning: ${item.reasoning}`
      );
      createdCount++;
    }

    if (createdCount > 0) {
      handleArchive(sourceTask.id); 
      const newAsanaTasks = await fetchAsanaTasks();
      setAsanaTasks(newAsanaTasks);
    }
    setLoading(false);
  };

  // --- FILTER LOGIC ---
  const toggleFilter = (filterKey: string) => {
    setBlockedFilters(prev => 
      prev.includes(filterKey) ? prev.filter(f => f !== filterKey) : [...prev, filterKey]
    );
  };

  // Get unique channels and authors from the CURRENT Slack list (for the modal)
  const availableFilters = useMemo(() => {
    const channels = new Set<string>();
    const authors = new Set<string>();
    slackTasks.forEach(t => {
      if (t.metadata.channel) channels.add(t.metadata.channel);
      if (t.metadata.author) authors.add(t.metadata.author);
    });
    return { 
      channels: Array.from(channels).sort(), 
      authors: Array.from(authors).sort() 
    };
  }, [slackTasks]);

  // Actually filter the displayed list
  const visibleSlackTasks = slackTasks.filter(t => {
    const channelKey = `channel:${t.metadata.channel}`;
    const authorKey = `author:${t.metadata.author}`;
    return !blockedFilters.includes(channelKey) && !blockedFilters.includes(authorKey);
  });

  // --- GROUPING HELPER ---
  const renderGroupedList = (
    tasks: UnifiedTask[], 
    getProject: (t: UnifiedTask) => string, 
    renderAction: (t: UnifiedTask) => React.ReactNode
  ) => {
    const groups: Record<string, UnifiedTask[]> = {};
    tasks.forEach(t => {
      const p = getProject(t) || "Inbox";
      if (!groups[p]) groups[p] = [];
      groups[p].push(t);
    });

    return Object.keys(groups).sort().map(project => (
      <div key={project} className="mb-6">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-2">
          <Inbox size={12} /> {project}
        </h3>
        <div className="space-y-1">
          {groups[project].map(t => renderAction(t))}
        </div>
      </div>
    ));
  };

  return (
    <div className="min-h-screen p-8 text-gray-900 font-sans bg-gray-50 relative">
      
      {/* HEADER */}
      <div className="max-w-7xl mx-auto flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
            <div className="p-2 bg-black rounded-lg"><LayoutTemplate className="text-white" size={24} /></div>
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-gray-900">Meta-Layer</h1>
                <p className="text-sm text-gray-500 font-medium">Unified Command Center</p>
            </div>
        </div>
        
        <div className="flex gap-2">
          {/* FILTER BUTTON */}
          <button 
            onClick={() => setShowFilterModal(true)}
            className={`flex items-center gap-2 border px-3 py-2 rounded-lg transition shadow-sm font-medium text-sm ${blockedFilters.length > 0 ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
          >
            <Filter size={16} />
            Filters {blockedFilters.length > 0 && `(${blockedFilters.length})`}
          </button>

          {/* SYNC BUTTON */}
          <button onClick={sync} className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition shadow-sm font-medium text-sm">
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Sync
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
        
        {/* LEFT COLUMN: Slack (Filtered & Grouped) */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Incoming Signals
            <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{visibleSlackTasks.length}</span>
          </h2>
          
          {renderGroupedList(
            visibleSlackTasks,
            (t) => slackProjectMap[t.id] || `#${t.metadata.channel}` || "Uncategorized",
            (t) => (
              <div key={t.id} className="relative">
                <TaskCard task={t} onPromote={handleAiPromote} onArchive={handleArchive} />
                {analyzingId === t.id && (
                  <div className="absolute inset-0 bg-white/90 flex items-center justify-center rounded-lg z-10 backdrop-blur-sm border border-purple-200">
                    <div className="flex items-center gap-2 text-purple-700 font-bold animate-pulse"><Sparkles size={20} /> Analyzing...</div>
                  </div>
                )}
              </div>
            )
          )}
        </div>

        {/* RIGHT COLUMN: Asana */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Action Items
            <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span>
          </h2>
          
          {renderGroupedList(
            asanaTasks,
            (t) => t.metadata.project || "My Tasks",
            (t) => <TaskCard key={t.id} task={t} onComplete={handleCompleteTask} />
          )}
        </div>
      </div>

      {/* --- REVIEW MODAL --- */}
      {reviewState && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200">
            {/* ... Same Review Modal UI as before ... */}
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
                  <div 
                    key={idx} 
                    onClick={() => {
                        const newSet = new Set(reviewState.selectedIndices);
                        isSelected ? newSet.delete(idx) : newSet.add(idx);
                        setReviewState({ ...reviewState, selectedIndices: newSet });
                    }}
                    className={`p-4 rounded-xl border cursor-pointer transition flex gap-3 items-start ${isSelected ? 'bg-white border-purple-300 ring-1 ring-purple-100' : 'bg-gray-100 border-transparent opacity-60'}`}
                  >
                    <div className={`mt-1 w-5 h-5 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-purple-600 border-purple-600 text-white' : 'bg-white border-gray-300'}`}>
                      {isSelected && <Check size={12} />}
                    </div>
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
              <button onClick={handleApproveSuggestions} className="px-6 py-2 bg-purple-600 text-white font-bold rounded-lg hover:bg-purple-700 transition flex items-center gap-2 shadow-lg shadow-purple-200">
                <Check size={18} />
                Create {reviewState.selectedIndices.size} Tasks
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- FILTER MODAL (NEW) --- */}
      {showFilterModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="bg-white p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                <Filter size={20} /> Signal Filters
              </h3>
              <button onClick={() => setShowFilterModal(false)} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
            </div>
            
            <div className="p-6 max-h-[60vh] overflow-y-auto">
              <div className="mb-6">
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Channels</h4>
                <div className="space-y-2">
                  {availableFilters.channels.map(channel => {
                    const key = `channel:${channel}`;
                    const isBlocked = blockedFilters.includes(key);
                    return (
                      <label key={key} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
                        <span className="font-medium text-gray-700">#{channel}</span>
                        <input 
                          type="checkbox" 
                          checked={!isBlocked}
                          onChange={() => toggleFilter(key)}
                          className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Authors</h4>
                <div className="space-y-2">
                  {availableFilters.authors.map(author => {
                    const key = `author:${author}`;
                    const isBlocked = blockedFilters.includes(key);
                    return (
                      <label key={key} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
                        <span className="font-medium text-gray-700">@{author}</span>
                        <input 
                          type="checkbox" 
                          checked={!isBlocked}
                          onChange={() => toggleFilter(key)}
                          className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;