import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

const ASANA_TOKEN = import.meta.env.VITE_ASANA_TOKEN;

// Validate token early
if (!ASANA_TOKEN) {
  throw new Error("VITE_ASANA_TOKEN environment variable is not set. Please configure it in your .env file.");
}

async function getWorkspaceId(): Promise<string | null> {
  try {
    const userResponse = await fetch('https://app.asana.com/api/1.0/users/me', {
      headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` }
    });

    if (!userResponse.ok) {
      console.error(`Failed to get workspace: ${userResponse.status}`);
      return null;
    }

    const userData = await userResponse.json() as any;
    if (userData.data && Array.isArray(userData.data.workspaces) && userData.data.workspaces.length > 0) {
      return userData.data.workspaces[0].gid;
    }
    return null;
  } catch (e) { 
    console.error("getWorkspaceId error:", e);
    return null;
  }
}

export async function fetchAsanaTasks(): Promise<UnifiedTask[]> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) {
      console.warn("No workspace ID found");
      return [];
    }

    const response = await fetch(
      `https://app.asana.com/api/1.0/tasks?assignee=me&workspace=${workspaceId}&completed_since=now&opt_fields=name,permalink_url,due_on,projects.name,assignee_status,created_at`, 
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` }
      }
    );

    if (!response.ok) {
      console.error(`Asana API error: ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    if (!data.data || !Array.isArray(data.data)) {
      console.warn("No tasks data from Asana");
      return [];
    }

    return data.data.map((task: any) => {
      // FIX: Proper status mapping for assignee_status values
      let status: 'todo' | 'in_progress' | 'done' = 'todo';
      if (task.assignee_status === 'today') {
        status = 'in_progress';
      } else if (task.assignee_status === 'overdue') {
        status = 'in_progress'; // Treat overdue as in_progress
      } else if (task.assignee_status === 'upcoming') {
        status = 'todo';
      }

      return {
        id: `asana-${task.gid}`, 
        externalId: task.gid, 
        provider: 'asana',
        title: task.name || 'Untitled Task',
        url: task.permalink_url || '',
        status: status,
        createdAt: task.created_at || new Date().toISOString(),
        metadata: {
          author: "Asana", 
          sourceLabel: (Array.isArray(task.projects) && task.projects.length > 0) 
            ? task.projects[0].name 
            : 'My Tasks',
          sourceType: 'project' as const,
          due: task.due_on || undefined
        }
      };
    }).filter((task: any): task is UnifiedTask => task !== null);
  } catch (error) {
    console.error("Asana Fetch Error:", error);
    return [];
  }
}

export async function completeAsanaTask(taskId: string): Promise<boolean> {
  try {
    if (!taskId) {
      console.error("completeAsanaTask: No taskId provided");
      return false;
    }

    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { completed: true } })
    });

    if (!response.ok) {
      console.error(`Failed to complete task: ${response.status}`);
      return false;
    }

    return true;
  } catch (error) { 
    console.error("completeAsanaTask error:", error);
    return false;
  }
}

export async function getProjectList(): Promise<string[]> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return ["My Tasks"];

    const response = await fetch(
      `https://app.asana.com/api/1.0/projects?workspace=${workspaceId}&archived=false&opt_fields=name`, 
      { headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` } }
    );

    if (!response.ok) {
      console.error(`Failed to get projects: ${response.status}`);
      return ["My Tasks"];
    }

    const data = await response.json() as any;
    if (!data.data || !Array.isArray(data.data)) {
      return ["My Tasks"];
    }

    return data.data
      .map((p: any) => p.name)
      .filter((name: any): name is string => typeof name === 'string');
  } catch (error) { 
    console.error("getProjectList error:", error);
    return ["My Tasks"];
  }
}

export async function createAsanaTaskWithProject(title: string, projectName: string, notes: string): Promise<string | null> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return null;

    if (!title || typeof title !== 'string') {
      console.error("createAsanaTaskWithProject: Invalid title");
      return null;
    }

    const projectsResponse = await fetch(
      `https://app.asana.com/api/1.0/projects?workspace=${workspaceId}&archived=false&opt_fields=name,gid`, 
      { headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` } }
    );

    if (!projectsResponse.ok) {
      console.error(`Failed to fetch projects: ${projectsResponse.status}`);
      return null;
    }

    const projectsData = await projectsResponse.json() as any;
    const project = projectsData.data?.find((p: any) => p.name === projectName);
    const projectId = project ? project.gid : null;

    const body: any = { workspace: workspaceId, name: title, notes: notes || '', assignee: 'me' };
    if (projectId) body.projects = [projectId];

    const response = await fetch(`https://app.asana.com/api/1.0/tasks`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: body })
    });

    if (!response.ok) {
      console.error(`Failed to create task: ${response.status}`);
      return null;
    }
    
    const json = await response.json() as any;
    return json.data?.gid || null;
  } catch (error) { 
    console.error("createAsanaTaskWithProject error:", error);
    return null;
  }
}

export async function createAsanaSubtask(parentId: string, title: string, notes?: string): Promise<boolean> {
  try {
    if (!parentId || !title) {
      console.error("createAsanaSubtask: Missing parentId or title");
      return false;
    }

    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${parentId}/subtasks`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ data: { name: title, assignee: 'me', notes: notes || '' } })
      });

    if (!response.ok) {
      console.error(`Failed to create subtask: ${response.status}`);
      return false;
    }

    return true;
  } catch (e) { 
    console.error("createAsanaSubtask error:", e);
    return false;
  }
}
