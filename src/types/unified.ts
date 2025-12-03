export type SourceProvider = 'slack' | 'asana' | 'github' | 'notion' | 'gdrive';

export interface UnifiedTask {
  id: string;          
  externalId: string;  
  provider: SourceProvider;
  title: string;
  url: string;
  status: 'todo' | 'in_progress' | 'done';
  createdAt: string;
  metadata: {
    author: string;        // Explicitly required
    sourceLabel: string;   // e.g. "#general" or "DM: Alice, Bob"
    sourceType: 'channel' | 'dm' | 'mpdm' | 'project';
    due?: string;
  };
}

// THE REFERENCE STORE
export interface SlackContext {
  userMap: Record<string, SlackUser>;
  channelMap: Record<string, SlackChannel>;
  selfId: string;
}

export interface SlackUser {
  id: string;
  name: string;      // The "handle" (e.g., "jeremy")
  real_name: string; // The display name (e.g., "Jeremy Taylor")
  is_bot: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_im: boolean;    // Direct Message
  is_mpim: boolean;  // Multi-Party Direct Message (Group DM)
  user_id?: string;  // If DM, who is it with?
}

// User Profile for the new onboarding feature
export interface UserProfile {
  name: string;
  title: string;
  roleDescription: string;
  monitoredChannels: string[]; // List of Channel IDs to sync
}