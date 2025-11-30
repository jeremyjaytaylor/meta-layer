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
    author?: string;
    channel?: string; // This will now hold the "Project Name"
    project?: string;
    due?: string;
    type?: string;
  };
}