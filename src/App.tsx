import { useState, useEffect, useMemo } from "react";
import { UnifiedTask, SlackContext } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals, fetchRichSignals, buildSlackContext } from "./adapters/slack"; 
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
  
  const [slackContext, setSlackContext] = useState<SlackContext | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  const [timeRange, setTimeRange] = useState<TimeRange>('week');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  const [reviewState, setReviewState] = useState<{ sourceTask: UnifiedTask, suggestions: AiSuggestion[], selectedIndices: Set<number> } | null>(null);
  const [synthesisResults, setSynthesisResults] = useState<ProposedTask[] | null>(null);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [processingTaskIdx, setProcessingTaskIdx] = useState<number | null>(null);
  
  const [blockedFilters, setBlockedFilters] = useState<string[]>(() => {
    const stored = localStorage.getItem("meta_blocked_filters");
    return stored ? JSON.parse(stored) : [];
  });

  useEffect(() => { 
    localStorage.setItem("meta_blocked_filters", JSON.stringify(blockedFilters)); 
  }, [blockedFilters]);

  const getArchivedIds = (): string[] => {
    const stored = localStorage.getItem("meta_archived_ids");
    return stored ? JSON.parse(stored) : [];
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

  const sync = async (ctx: SlackContext) => {
    setLoading(true);
    const archivedIds = getArchivedIds();
    const { start, end } = calculateDateRange(); 

    console.log(`🔄 Syncing... Range: ${start.toLocaleDateString()} - ${end.toLocaleDateString()}`);

    const [slackData, asanaData] = await Promise.allSettled([
      fetchSlackSignals(ctx, start, end),
      fetchAsanaTasks()
    ]);
    
    if (slackData.status === 'fulfilled') {
      const active = slackData.value.filter(t => !archivedIds.includes(t.id));
      setSlackTasks(active);
    }
    if (asanaData.status === 'fulfilled') setAsanaTasks(asanaData.value);

    setLoading(false);
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
    if (slackContext) sync(slackContext);
  }, [slackContext, timeRange, customStart, customEnd]);

  const clearArchive = () => {
    if (confirm("Are you sure you want to un-archive all messages?")) {
        localStorage.removeItem("meta_archived_ids");
        if (slackContext) sync(slackContext); 
    }
  };
  
  const clearFilters = () => { setBlockedFilters([]); };

  const handleArchive = (id: string) => {
    const current = getArchivedIds();
    localStorage.setItem("meta_archived_ids", JSON.stringify([...current, id]));
    setSlackTasks(prev => prev.filter(t => t.id !== id));
  };

  const handleArchiveAll = () => {
    if (!visibleSlackTasks.length || !confirm("Archive all visible signals?")) return;
    const current = getArchivedIds();
    const newIds = visibleSlackTasks.map(t => t.id);
    localStorage.setItem("meta_archived_ids", JSON.stringify([...current, ...newIds]));
    setSlackTasks(prev => prev.filter(t => !newIds.includes(t.id)));
  };

  const handleCompleteTask = async (taskId: string) => {
    setAsanaTasks(currentTasks => currentTasks.filter(t => t.externalId !== taskId));
    const success = await completeAsanaTask(taskId);
    if (!success && slackContext) sync(slackContext); 
  };

  const handleAiPromote = async (task: UnifiedTask) => {
    setAnalyzingId(task.id); 
    const projects = await getProjectList();
    const suggestions = await analyzeSignal(task.title, projects);
    setAnalyzingId(null);
    if (suggestions.length === 0) { alert("No tasks found."); return; }
    setReviewState({ sourceTask: task, suggestions, selectedIndices: new Set(suggestions.map((_, i) => i)) });
  };

  const handleApproveSuggestions = async () => {
    if (!reviewState) return;
    setReviewState(null); 
    setLoading(true);
    for (const [i, item] of reviewState.suggestions.entries()) {
      if (reviewState.selectedIndices.has(i)) {
        await createAsanaTaskWithProject(item.title, item.projectName, `Context: ${reviewState.sourceTask.url}\n\nReasoning: ${item.reasoning}`);
      }
    }
    handleArchive(reviewState.sourceTask.id);
    const newAsana = await fetchAsanaTasks();
    setAsanaTasks(newAsana);
    setLoading(false);
  };

  const handleSynthesize = async () => {
    if (!slackContext) return;
    setLoading(true);
    const { start, end } = calculateDateRange();
    const signals = await fetchRichSignals(slackContext, start, end);
    
    const filteredSignals = signals.filter(s => {
        const chKey = `channel:${s.channelName}`;
        const userKey = `author:${s.mainMessage.user}`;
        return !blockedFilters.includes(chKey) && !blockedFilters.includes(userKey);
    });

    if (filteredSignals.length === 0) { alert("No signals to synthesize."); setLoading(false); return; }

    const projects = await getProjectList();
    const plan = await synthesizeWorkload(filteredSignals, [], projects);
    setSynthesisResults(plan);
    setLoading(false);
  };

  const handleApproveSynthesizedTask = async (task: ProposedTask, index: number) => {
    setProcessingTaskIdx(index);
    try {
      const parentId = await createAsanaTaskWithProject(task.title, task.project, `${task.description}\n\nSources:\n${task.citations.join('\n')}`);
      if (parentId) {
          for (const sub of task.subtasks) await createAsanaSubtask(parentId, sub);
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
      tasks.forEach(t => { const p = t.metadata.sourceLabel || "My Tasks"; if (!groups[p]) groups[p] = []; groups[p].push(t); });
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
            
            <button onClick={clearArchive} className="p-2 bg-white border rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition" title="Reset Archive"><Trash2 size={16} /></button>
            {blockedFilters.length > 0 && <button onClick={clearFilters} className="flex items-center gap-2 bg-purple-100 text-purple-700 px-3 py-2 rounded-lg text-sm font-bold"><RotateCcw size={14}/> Clear ({blockedFilters.length})</button>}
            <button onClick={handleSynthesize} disabled={!slackContext} className="flex items-center gap-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition font-bold text-sm disabled:opacity-50"><BrainCircuit size={16} /> {loading ? "..." : "Synthesize"}</button>
            <button onClick={() => setShowFilterModal(true)} className={`flex items-center gap-2 border px-3 py-2 rounded-lg transition font-medium text-sm ${blockedFilters.length ? 'bg-purple-50 border-purple-200 text-purple-700' : 'bg-white'}`}><Filter size={16} /> Filters</button>
            <button onClick={() => slackContext && sync(slackContext)} disabled={!slackContext} className="flex items-center gap-2 bg-white border px-4 py-2 rounded-lg hover:bg-gray-50 transition font-medium text-sm disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""} /> Sync</button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
         <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
                <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">Signals <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{visibleSlackTasks.length}</span></h2>
                {visibleSlackTasks.length > 0 && <button onClick={handleArchiveAll} className="text-xs flex items-center gap-1 text-gray-400 hover:text-gray-600"><Archive size={14} /> Archive All</button>}
            </div>
            {renderFlatList(visibleSlackTasks)}
         </div>

         <div className="flex flex-col gap-4">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">Action Items <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span></h2>
            {renderAsanaList(asanaTasks)}
         </div>
      </div>

      {showFilterModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden p-6 max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-bold">Signal Filters</h3>
                <button onClick={() => setShowFilterModal(false)}><X className="text-gray-400" /></button>
            </div>
            
            <div className="mb-6">
                <div className="flex justify-between mb-2">
                    <h4 className="text-xs font-bold text-gray-400 uppercase">Sources</h4>
                    <div className="text-xs space-x-2 text-blue-600 cursor-pointer">
                        <span onClick={() => toggleAll(availableFilters.channels, 'channel', false)}>All</span>
                        <span onClick={() => toggleAll(availableFilters.channels, 'channel', true)}>None</span>
                    </div>
                </div>
                {availableFilters.channels.map(c => (
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
                {availableFilters.authors.map(a => (
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
                        <div key={i} className="border rounded-xl p-6 hover:shadow-lg transition">
                            <div className="flex justify-between items-start">
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded font-bold uppercase">{task.project}</span>
                                        <h3 className="text-lg font-bold">{task.title}</h3>
                                    </div>
                                    <p className="text-gray-600 mb-4">{task.description}</p>
                                    <ul className="list-disc pl-5 space-y-1 mb-4 text-sm text-gray-700">{task.subtasks.map(s => <li key={s}>{s}</li>)}</ul>
                                    <div className="text-xs text-gray-400">Sources: {task.citations.join(", ")}</div>
                                </div>
                                <div className="flex flex-col gap-2">
                                    <button onClick={() => handleApproveSynthesizedTask(task, i)} disabled={processingTaskIdx === i} className="bg-black text-white px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 hover:bg-gray-800 disabled:opacity-50">
                                        {processingTaskIdx === i ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />} Accept
                                    </button>
                                    <button onClick={() => handleDismissSynthesizedTask(i)} className="text-gray-400 hover:text-red-500 text-sm">Dismiss</button>
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