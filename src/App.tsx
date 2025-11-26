import { useState, useEffect } from "react";
import { UnifiedTask } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals } from "./adapters/slack";
import { fetchAsanaTasks, completeAsanaTask, createAsanaTaskFromSlack } from "./adapters/asana";
import { RefreshCw, LayoutTemplate } from "lucide-react";
import "./App.css";

function App() {
  const [slackTasks, setSlackTasks] = useState<UnifiedTask[]>([]);
  const [asanaTasks, setAsanaTasks] = useState<UnifiedTask[]>([]);
  const [loading, setLoading] = useState(false);

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

  // --- HANDLER 1: Mark Complete (Optimistic UI) ---
  const handleCompleteTask = async (taskId: string) => {
    // 1. INSTANTLY remove the task from the screen
    setAsanaTasks(currentTasks => currentTasks.filter(t => t.externalId !== taskId));

    // 2. Then call the API in the background
    const success = await completeAsanaTask(taskId);
    
    // 3. If it failed, we should re-sync to show it again
    if (!success) {
      console.error("Task completion failed, restoring...");
      sync(); 
    }
  };

  // --- HANDLER 2: Promote Slack to Asana ---
  const handlePromoteSignal = async (task: UnifiedTask) => {
    // 1. Call API
    const success = await createAsanaTaskFromSlack(task.title, task.url);
    
    if (success) {
      // 2. Refresh Asana to show the new task
      const newAsanaTasks = await fetchAsanaTasks();
      setAsanaTasks(newAsanaTasks);
      
      // 3. Scroll to top so the user sees the new item
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      alert("Failed to promote task.");
    }
  };

  return (
    <div className="min-h-screen p-8 text-gray-900 font-sans bg-gray-50">
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

      <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
        
        {/* LEFT COLUMN: Slack */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Incoming Signals
            <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{slackTasks.length}</span>
          </h2>
          <div className="space-y-1">
            {slackTasks.map(t => (
              <TaskCard 
                key={t.id} 
                task={t} 
                onPromote={handlePromoteSignal}
              />
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
              // SORT LOGIC: Newest items (by creation date) go to the top
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
    </div>
  );
}

export default App;