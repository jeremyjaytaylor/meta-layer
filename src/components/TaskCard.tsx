import { UnifiedTask } from "../types/unified";
import { open } from '@tauri-apps/plugin-shell';
import { MessageSquare, CheckSquare, Github, FileText, HardDrive, Check, ArrowRight, Archive, ExternalLink } from "lucide-react";

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
  onArchive?: (id: string) => void;
}

export function TaskCard({ task, onComplete, onPromote, onArchive }: TaskCardProps) {
  const Icon = Icons[task.provider] || MessageSquare;
  const colorClass = Colors[task.provider] || "border-gray-200 bg-white";

  const dateObj = new Date(task.createdAt);
  const dateStr = dateObj.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const handleOpenLink = async () => {
    try {
      await open(task.url);
    } catch (e) {
      console.error("Failed to open link:", e);
    }
  };

  return (
    <div className={`p-4 rounded-lg shadow-sm border-l-4 transition mb-2 flex gap-3 ${colorClass} group max-w-full`}>
      <div className="flex-1 cursor-pointer min-w-0" onClick={handleOpenLink}>
        <div className="flex justify-between items-start mb-1">
          <div className="flex items-center gap-2">
            <Icon size={16} className="text-gray-600 flex-shrink-0" />
            <span className="text-xs font-bold uppercase text-gray-500 tracking-wider truncate">
              {task.provider}
            </span>
          </div>
          <span className="text-xs text-gray-400 flex-shrink-0 ml-2 whitespace-nowrap">
            {dateStr} • {timeStr}
          </span>
        </div>

        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-gray-800 leading-snug text-sm break-all whitespace-normal group-hover:text-blue-700 transition-colors overflow-hidden">
              {task.title}
            </h3>
          </div>
            {(task.provider === 'gdrive' || task.provider === 'notion') && (
                <ExternalLink size={12} className="text-blue-500 mt-1 flex-shrink-0" />
            )}
        </div>
        
        <div className="mt-2 flex gap-2 flex-wrap">
          {task.metadata.author && (
            <span className="text-xs bg-white/50 border border-gray-200 px-2 py-1 rounded text-gray-600 truncate max-w-[150px]">
              @{task.metadata.author}
            </span>
          )}
           {/* FIX: Use sourceLabel here */}
           {task.metadata.sourceLabel && (
            <span className="text-xs bg-white/50 border border-gray-200 px-2 py-1 rounded text-gray-600 truncate max-w-[150px]">
              {task.metadata.sourceLabel}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col justify-start gap-2 border-l border-gray-200/50 pl-2 opacity-80 group-hover:opacity-100 transition flex-shrink-0">
        {task.provider === 'asana' && onComplete && (
          <button onClick={(e) => { e.stopPropagation(); if (task.externalId) onComplete(task.externalId); }} className="p-1.5 bg-white rounded hover:bg-green-100 text-gray-400 hover:text-green-600 transition border border-gray-200">
            <Check size={16} />
          </button>
        )}
        {task.provider !== 'asana' && onPromote && (
          <button onClick={(e) => { e.stopPropagation(); onPromote(task); }} className="p-1.5 bg-white rounded hover:bg-blue-100 text-gray-400 hover:text-blue-600 transition border border-gray-200">
            <ArrowRight size={16} />
          </button>
        )}
        {task.provider !== 'asana' && onArchive && (
          <button onClick={(e) => { e.stopPropagation(); onArchive(task.id); }} className="p-1.5 bg-white rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition border border-gray-200">
            <Archive size={16} />
          </button>
        )}
      </div>
    </div>
  );
}