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
  };
}

export interface SlackContext {
  userMap: Record<string, SlackUser>;
  channelMap: Record<string, SlackChannel>;
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
  keyPriorities: string[];  // e.g. ["Q3 Roadmap", "Hiring", "Fixing Bugs"]
  ignoredTopics: string[];  // e.g. ["Lunch plans", "Fantasy Football"]
}