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
    author: string;
    sourceLabel: string;   // The human-readable location (e.g. "#general", "DM: Alice")
    sourceType: 'channel' | 'dm' | 'mpdm' | 'project';
    due?: string;
    fileData?: {
      title: string;
      name: string;
      preview: string;
      mimetype: string;
      size: number;
    };
  };
}

export interface SlackContext {
  userMap: Record<string, SlackUser>;
  channelMap: Record<string, SlackChannel>;
  groupMap: Record<string, string>; // NEW: Maps Group ID (S123) -> Name (@devs)
  selfId: string;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  is_bot: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_channel: boolean;
  is_im: boolean;
  is_mpim: boolean;
  user_id?: string;
}

export interface UserProfile {
  name: string;
  title: string;
  roleDescription: string;
  keyPriorities: string[];
  ignoredTopics: string[];
}