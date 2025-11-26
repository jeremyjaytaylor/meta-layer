import { UnifiedTask } from "../types/unified";
import { MessageSquare, CheckSquare, Github, FileText, HardDrive, Check, ArrowRight, Archive } from "lucide-react";

const Icons = {
  slack: MessageSquare,
  asana: CheckSquare,
  github: Github,
  notion: FileText,
  gdrive: HardDrive
};

const Colors = {
  slack: "border-purple-500 bg-purple-50",
  asana: "border-red-400 bg-red-50",
  github: "border-gray-800 bg-gray-50",
  notion: "border-gray-400 bg-white",
  gdrive: "border-blue-500 bg-blue-50"
};

interface TaskCardProps {
  task: UnifiedTask;
  onComplete?: (id: string) => void;
  onPromote?: (task: UnifiedTask) => void;
  onArchive?: (id: string) => void; // <--- NEW PROP
}

export function TaskCard({ task, onComplete, onPromote, onArchive }: TaskCardProps) {
  const Icon = Icons[task.provider];
  const colorClass = Colors[task.provider] || "border-gray-200 bg-white";

  return (
    <div className={`p-4 rounded-lg shadow-sm border-l-4 transition mb-2 flex gap-3 ${colorClass} group`}>
      
      {/* 1. Main Content Area */}
      <div 
        className="flex-1 cursor-pointer"
        onClick={() => window.open(task.url, '_blank')}
      >
        <div className="flex justify-between items-start mb-1">
          <div className="flex items-center gap-2">
            <Icon size={16} className="text-gray-600" />
            <span className="text-xs font-bold uppercase text-gray-500 tracking-wider">
              {task.provider}
            </span>
          </div>
          <span className="text-xs text-gray-400">
            {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <h3 className="font-medium text-gray-800 leading-snug text-sm">{task.title}</h3>
        
        <div className="mt-2 flex gap-2 flex-wrap">
          {task.metadata.author && (
            <span className="text-xs bg-white/50 border border-gray-200 px-2 py-1 rounded text-gray-600">
              @{task.metadata.author}
            </span>
          )}
           {task.metadata.project && (
            <span className="text-xs bg-white/50 border border-gray-200 px-2 py-1 rounded text-gray-600">
              {task.metadata.project}
            </span>
          )}
        </div>
      </div>

      {/* 2. Action Buttons */}
      <div className="flex flex-col justify-start gap-2 border-l border-gray-200/50 pl-2 opacity-80 group-hover:opacity-100 transition">
        
        {/* Asana: Complete */}
        {task.provider === 'asana' && onComplete && (
          <button 
            onClick={(e) => { e.stopPropagation(); if (task.externalId) onComplete(task.externalId); }}
            className="p-1.5 bg-white rounded hover:bg-green-100 text-gray-400 hover:text-green-600 transition border border-gray-200"
            title="Mark Complete"
          >
            <Check size={16} />
          </button>
        )}

        {/* Slack: Promote */}
        {task.provider === 'slack' && onPromote && (
          <button 
            onClick={(e) => { e.stopPropagation(); onPromote(task); }}
            className="p-1.5 bg-white rounded hover:bg-blue-100 text-gray-400 hover:text-blue-600 transition border border-gray-200"
            title="Turn into Task"
          >
            <ArrowRight size={16} />
          </button>
        )}

        {/* Slack: Archive (NEW) */}
        {task.provider === 'slack' && onArchive && (
          <button 
            onClick={(e) => { e.stopPropagation(); onArchive(task.id); }}
            className="p-1.5 bg-white rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition border border-gray-200"
            title="Archive Signal"
          >
            <Archive size={16} />
          </button>
        )}
      </div>

    </div>
  );
}