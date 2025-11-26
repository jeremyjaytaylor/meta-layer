import { useState, useEffect } from "react";
import { UnifiedTask } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals } from "./adapters/slack";
import { fetchAsanaTasks, completeAsanaTask, getProjectList, createAsanaTaskWithProject } from "./adapters/asana";
import { analyzeSignal, AiSuggestion } from "./adapters/gemini"; 
import { RefreshCw, LayoutTemplate, Sparkles, X, Check } from "lucide-react"; 
import "./App.css";

function App() {
  const [slackTasks, setSlackTasks] = useState<UnifiedTask[]>([]);
  const [asanaTasks, setAsanaTasks] = useState<UnifiedTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  
  // NEW: State to hold AI suggestions for review
  const [reviewQueue, setReviewQueue] = useState<{ sourceTask: UnifiedTask, suggestions: AiSuggestion[] } | null>(null);

  const sync = async () => {
    setLoading(true);
    const [slackData, asanaData] = await Promise.allSettled([
      fetchSlackSignals(),
      fetchAsanaTasks()
    ]);

    if (slackData.status === 'fulfilled') setSlackTasks(slackData.value);
    if (asanaData.status === 'fulfilled') setAsanaTasks(asanaData.value);
    setLoading(false);
  };

  useEffect(() => { sync(); }, []);

  const handleCompleteTask = async (taskId: string) => {
    setAsanaTasks(currentTasks => currentTasks.filter(t => t.externalId !== taskId));
    const success = await completeAsanaTask(taskId);
    if (!success) sync(); 
  };

  // --- STEP 1: AI Analysis ---
  const handleAiPromote = async (task: UnifiedTask) => {
    setAnalyzingId(task.id); 
    const projects = await getProjectList();
    
    console.log("🧠 Sending to AI...");
    const suggestions = await analyzeSignal(task.title, projects);
    
    setAnalyzingId(null);

    if (suggestions.length === 0) {
      alert("AI couldn't find any clear tasks."); // Fallback alert
      return;
    }

    // Instead of confirm(), we open the Modal
    setReviewQueue({ sourceTask: task, suggestions });
  };

  // --- STEP 2: Execute Approved Tasks ---
  const handleApproveSuggestions = async () => {
    if (!reviewQueue) return;

    const { sourceTask, suggestions } = reviewQueue;
    
    // Optimistically close modal
    setReviewQueue(null); 
    setLoading(true);

    let createdCount = 0;
    for (const item of suggestions) {
      await createAsanaTaskWithProject(
        item.title, 
        item.projectName, 
        `Original Context: ${sourceTask.url}\n\nAI Reasoning: ${item.reasoning}`
      );
      createdCount++;
    }

    if (createdCount > 0) {
      const newAsanaTasks = await fetchAsanaTasks();
      setAsanaTasks(newAsanaTasks);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen p-8 text-gray-900 font-sans bg-gray-50 relative">
      
      {/* --- HEADER --- */}
      <div className="max-w-6xl mx-auto flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
            <div className="p-2 bg-black rounded-lg">
                <LayoutTemplate className="text-white" size={24} />
            </div>
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

      {/* --- MAIN GRID --- */}
      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
        
        {/* LEFT COLUMN: Slack */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Incoming Signals
            <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{slackTasks.length}</span>
          </h2>
          <div className="space-y-1">
            {slackTasks.map(t => (
              <div key={t.id} className="relative">
                <TaskCard 
                  task={t} 
                  onPromote={handleAiPromote} 
                />
                {analyzingId === t.id && (
                  <div className="absolute inset-0 bg-white/90 flex items-center justify-center rounded-lg z-10 backdrop-blur-sm border border-purple-200">
                    <div className="flex items-center gap-2 text-purple-700 font-bold animate-pulse">
                      <Sparkles size={20} />
                      Analyzing...
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: Asana */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Action Items
            <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span>
          </h2>
           <div className="space-y-1">
            {asanaTasks
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .map(t => (
                <TaskCard 
                  key={t.id} 
                  task={t} 
                  onComplete={handleCompleteTask}
                />
              ))
            }
          </div>
        </div>
      </div>

      {/* --- REVIEW MODAL (The New UI) --- */}
      {reviewQueue && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden animate-in fade-in zoom-in duration-200">
            
            {/* Modal Header */}
            <div className="bg-purple-600 p-6 text-white flex justify-between items-start">
              <div>
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <Sparkles size={20} className="text-purple-200" />
                  AI Suggested Actions
                </h3>
                <p className="text-purple-100 text-sm mt-1 opacity-90">
                  Gemini identified {reviewQueue.suggestions.length} tasks from this message.
                </p>
              </div>
              <button 
                onClick={() => setReviewQueue(null)}
                className="text-white/60 hover:text-white transition"
              >
                <X size={24} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 bg-gray-50 max-h-[60vh] overflow-y-auto space-y-3">
              {reviewQueue.suggestions.map((item, idx) => (
                <div key={idx} className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
                  <h4 className="font-bold text-gray-900">{item.title}</h4>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Project:</span>
                    <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded text-xs font-medium border border-blue-100">
                      {item.projectName}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-2 border-t border-gray-100 pt-2 italic">
                    " {item.reasoning} "
                  </p>
                </div>
              ))}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-gray-100 bg-white flex justify-end gap-3">
              <button 
                onClick={() => setReviewQueue(null)}
                className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-100 rounded-lg transition"
              >
                Cancel
              </button>
              <button 
                onClick={handleApproveSuggestions}
                className="px-6 py-2 bg-purple-600 text-white font-bold rounded-lg hover:bg-purple-700 transition flex items-center gap-2 shadow-lg shadow-purple-200"
              >
                <Check size={18} />
                Approve & Create
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

export default App;