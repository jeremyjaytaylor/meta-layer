import { useState, useEffect, useMemo } from "react";
import { UnifiedTask } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals } from "./adapters/slack";
import { fetchAsanaTasks, completeAsanaTask, getProjectList, createAsanaTaskWithProject } from "./adapters/asana";
import { analyzeSignal, batchCategorize, AiSuggestion } from "./adapters/gemini"; 
import { RefreshCw, LayoutTemplate, Sparkles, X, Check, Inbox } from "lucide-react"; 
import "./App.css";

function App() {
  const [slackTasks, setSlackTasks] = useState<UnifiedTask[]>([]);
  const [asanaTasks, setAsanaTasks] = useState<UnifiedTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  
  // Stores "MessageID -> ProjectName" predicted by Gemini
  const [slackProjectMap, setSlackProjectMap] = useState<Record<string, string>>({});

  // Review Queue now needs to track SELECTION
  // We store the suggestions AND a Set of indices that are "checked"
  const [reviewState, setReviewState] = useState<{ 
    sourceTask: UnifiedTask, 
    suggestions: AiSuggestion[],
    selectedIndices: Set<number> 
  } | null>(null);

  // --- HELPERS: Load/Save Archive ---
  const getArchivedIds = (): string[] => {
    const stored = localStorage.getItem("meta_archived_ids");
    return stored ? JSON.parse(stored) : [];
  };

  const archiveId = (id: string) => {
    const current = getArchivedIds();
    localStorage.setItem("meta_archived_ids", JSON.stringify([...current, id]));
  };

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
      // Filter out archived items immediately
      newSlackTasks = slackData.value.filter(t => !archived.includes(t.id));
      setSlackTasks(newSlackTasks);
    }
    
    if (asanaData.status === 'fulfilled') {
      setAsanaTasks(asanaData.value);
    }

    // --- AI BATCH CATEGORIZATION ---
    // We only run this if we have Slack tasks.
    // We fetch projects first to give Gemini context.
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

  // --- HANDLER: Archive Slack ---
  const handleArchive = (id: string) => {
    archiveId(id); // Save to disk
    setSlackTasks(prev => prev.filter(t => t.id !== id)); // Remove from UI
  };

  // --- HANDLER: Complete Asana ---
  const handleCompleteTask = async (taskId: string) => {
    setAsanaTasks(currentTasks => currentTasks.filter(t => t.externalId !== taskId));
    const success = await completeAsanaTask(taskId);
    if (!success) sync(); 
  };

  // --- HANDLER: Promote to AI Review ---
  const handleAiPromote = async (task: UnifiedTask) => {
    setAnalyzingId(task.id); 
    const projects = await getProjectList();
    const suggestions = await analyzeSignal(task.title, projects);
    setAnalyzingId(null);

    if (suggestions.length === 0) {
      alert("AI couldn't find any tasks.");
      return;
    }

    // Initialize modal with ALL items selected by default
    const allIndices = new Set(suggestions.map((_, i) => i));
    setReviewState({ sourceTask: task, suggestions, selectedIndices: allIndices });
  };

  // --- HANDLER: Toggle Checkbox in Modal ---
  const toggleSuggestion = (index: number) => {
    if (!reviewState) return;
    const newSet = new Set(reviewState.selectedIndices);
    if (newSet.has(index)) {
      newSet.delete(index);
    } else {
      newSet.add(index);
    }
    setReviewState({ ...reviewState, selectedIndices: newSet });
  };

  // --- HANDLER: Final Approve ---
  const handleApproveSuggestions = async () => {
    if (!reviewState) return;
    const { sourceTask, suggestions, selectedIndices } = reviewState;
    setReviewState(null); 
    setLoading(true);

    let createdCount = 0;
    // Only create items that are in the selectedIndices set
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
      handleArchive(sourceTask.id); // Auto-archive the signal after processing!
      const newAsanaTasks = await fetchAsanaTasks();
      setAsanaTasks(newAsanaTasks);
    }
    setLoading(false);
  };

  // --- GROUPING HELPER (The UI Logic) ---
  const renderGroupedList = (
    tasks: UnifiedTask[], 
    getProject: (t: UnifiedTask) => string, 
    renderAction: (t: UnifiedTask) => React.ReactNode
  ) => {
    // 1. Group items
    const groups: Record<string, UnifiedTask[]> = {};
    tasks.forEach(t => {
      const p = getProject(t) || "Inbox";
      if (!groups[p]) groups[p] = [];
      groups[p].push(t);
    });

    // 2. Sort items within groups (newest first)
    Object.keys(groups).forEach(key => {
        groups[key].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });

    // 3. Render
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
        <button onClick={sync} className="flex items-center gap-2 bg-white border border-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition shadow-sm font-medium text-sm">
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          Sync
        </button>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
        
        {/* LEFT COLUMN: Slack (Grouped by AI Prediction) */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Incoming Signals
            <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{slackTasks.length}</span>
          </h2>
          
          {renderGroupedList(
            slackTasks,
            // Project Getter: Use AI map, fallback to Channel name
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

        {/* RIGHT COLUMN: Asana (Grouped by Project) */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Action Items
            <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span>
          </h2>
          
          {renderGroupedList(
            asanaTasks,
            // Project Getter: Use Asana Metadata
            (t) => t.metadata.project || "My Tasks",
            (t) => <TaskCard key={t.id} task={t} onComplete={handleCompleteTask} />
          )}
        </div>
      </div>

      {/* --- REVIEW MODAL WITH CHECKBOXES --- */}
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
                  <div 
                    key={idx} 
                    onClick={() => toggleSuggestion(idx)}
                    className={`p-4 rounded-xl border cursor-pointer transition flex gap-3 items-start ${isSelected ? 'bg-white border-purple-300 ring-1 ring-purple-100' : 'bg-gray-100 border-transparent opacity-60'}`}
                  >
                    {/* Checkbox UI */}
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
    </div>
  );
}

export default App;