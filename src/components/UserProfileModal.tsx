import { useState } from "react";
import { X, Save, User } from "lucide-react";
import { UserProfile } from "../types/unified";

interface UserProfileModalProps {
  initialProfile: UserProfile | null;
  onSave: (profile: UserProfile) => void;
  onClose: () => void;
}

export function UserProfileModal({ initialProfile, onSave, onClose }: UserProfileModalProps) {
  const [name, setName] = useState(initialProfile?.name || "");
  const [title, setTitle] = useState(initialProfile?.title || "");
  const [roleDescription, setRoleDescription] = useState(initialProfile?.roleDescription || "");
  const [priorities, setPriorities] = useState(initialProfile?.keyPriorities.join(", ") || "");
  const [ignored, setIgnored] = useState(initialProfile?.ignoredTopics.join(", ") || "");

  const handleSave = () => {
    const profile: UserProfile = {
      name,
      title,
      roleDescription,
      keyPriorities: priorities.split(",").map(s => s.trim()).filter(s => s.length > 0),
      ignoredTopics: ignored.split(",").map(s => s.trim()).filter(s => s.length > 0)
    };
    onSave(profile);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 border-b flex justify-between items-center bg-gray-50">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-purple-100 rounded-lg text-purple-700">
                <User size={20} />
            </div>
            <div>
                <h3 className="text-xl font-bold text-gray-900">User Profile</h3>
                <p className="text-xs text-gray-500">Teach the AI who you are.</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Name</label>
                <input 
                    type="text" 
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Jane Doe"
                />
            </div>
            <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Job Title</label>
                <input 
                    type="text" 
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Senior Engineer"
                />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Role Description</label>
            <textarea 
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none h-24 resize-none"
                value={roleDescription}
                onChange={e => setRoleDescription(e.target.value)}
                placeholder="I lead the frontend team. I care about UI consistency, performance, and unblocking my team. I don't need to know about backend infrastructure maintenance."
            />
            <p className="text-xs text-gray-400 mt-1">This context helps Gemini decide what is actionable for *you*.</p>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Key Priorities (Comma separated)</label>
            <input 
                type="text" 
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                value={priorities}
                onChange={e => setPriorities(e.target.value)}
                placeholder="Q3 Launch, Hiring, Mobile App, Performance"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Ignore Topics (Comma separated)</label>
            <input 
                type="text" 
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-purple-500 outline-none"
                value={ignored}
                onChange={e => setIgnored(e.target.value)}
                placeholder="Lunch, Fantasy Football, Office Temp"
            />
          </div>
        </div>

        <div className="p-4 border-t bg-gray-50 flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-gray-600 text-sm font-medium hover:bg-gray-200 rounded-lg transition">Cancel</button>
            <button onClick={handleSave} className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-bold hover:bg-purple-700 transition shadow-sm">
                <Save size={16} /> Save Profile
            </button>
        </div>
      </div>
    </div>
  );
}