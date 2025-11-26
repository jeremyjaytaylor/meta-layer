export type SourceProvider = 'slack' | 'asana' | 'github' | 'notion' | 'gdrive';

export interface UnifiedTask {
  id: string;          // Local UUID (for React keys)
  externalId: string;  // <--- ADD THIS (The Real ID from Asana/Slack)
  provider: SourceProvider;
  title: string;
  url: string;
  status: 'todo' | 'in_progress' | 'done';
  createdAt: string;
  metadata: {
    author?: string;
    channel?: string;
    project?: string;
    due?: string;
    type?: string;
  };
}