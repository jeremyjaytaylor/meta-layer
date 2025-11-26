import { useState, useEffect } from "react";
import { UnifiedTask } from "./types/unified";
import { TaskCard } from "./components/TaskCard";
import { fetchSlackSignals } from "./adapters/slack";
import { fetchAsanaTasks, completeAsanaTask, createAsanaTaskFromSlack } from "./adapters/asana"; // <--- Import Actions
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

  // --- HANDLER 1: Mark Complete ---
  const handleCompleteTask = async (taskId: string) => {
    // 1. Optimistic UI: Remove it from screen immediately
    setAsanaTasks(prev => prev.filter(t => t.id !== taskId));

    // 2. Call API in background
    const success = await completeAsanaTask(taskId);
    if (!success) {
      alert("Failed to complete task. Syncing to reset.");
      sync(); // Revert on failure
    }
  };

  // --- HANDLER 2: Promote Slack to Asana ---
  const handlePromoteSignal = async (task: UnifiedTask) => {
    // 1. Optimistic UI: Remove from Slack list? (Optional, maybe keep it until next sync)
    // For now, let's just trigger the creation.
    
    // 2. Call API
    const success = await createAsanaTaskFromSlack(task.title, task.url);
    
    if (success) {
      // 3. Refresh Asana list to show the new item
      const newAsanaTasks = await fetchAsanaTasks();
      setAsanaTasks(newAsanaTasks);
    } else {
      alert("Failed to create task in Asana");
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
        
        {/* LEFT COLUMN: Slack (Promote) */}
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
                onPromote={handlePromoteSignal} // <--- Pass the Handler
              />
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: Asana (Complete) */}
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            Action Items
            <span className="bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">{asanaTasks.length}</span>
          </h2>
           <div className="space-y-1">
            {asanaTasks.map(t => (
              <TaskCard 
                key={t.id} 
                task={t} 
                onComplete={handleCompleteTask} // <--- Pass the Handler
              />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

export default App;