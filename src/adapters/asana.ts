import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';
import { v4 as uuidv4 } from 'uuid';

// SECURE: Load from environment variable
const ASANA_TOKEN = import.meta.env.VITE_ASANA_TOKEN;

// Helper: Get Workspace ID
async function getWorkspaceId(): Promise<string | null> {
  try {
    if (!ASANA_TOKEN) throw new Error("Missing VITE_ASANA_TOKEN");
    const userResponse = await fetch('https://app.asana.com/api/1.0/users/me', {
      headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` }
    });
    const userData = await userResponse.json() as any;
    if (userData.data && userData.data.workspaces.length > 0) {
        return userData.data.workspaces[0].gid;
    }
    return null;
  } catch (e) {
    return null;
  }
}

export async function fetchAsanaTasks(): Promise<UnifiedTask[]> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return [];

    const response = await fetch(
      `https://app.asana.com/api/1.0/tasks?assignee=me&workspace=${workspaceId}&completed_since=now&opt_fields=name,permalink_url,due_on,projects.name,assignee_status,created_at`, 
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` }
      }
    );

    const data = await response.json() as any;
    if (!data.data) return [];

    return data.data.map((task: any) => ({
      id: `asana-${task.gid}`, 
      externalId: task.gid, 
      provider: 'asana',
      title: task.name,
      url: task.permalink_url,
      status: task.assignee_status === 'today' ? 'todo' : 'in_progress',
      createdAt: task.created_at || new Date().toISOString(),
      metadata: {
        project: task.projects.length > 0 ? task.projects[0].name : 'My Tasks',
        due: task.due_on
      }
    }));

  } catch (error) {
    console.error("Asana Fetch Error:", error);
    return [];
  }
}

export async function completeAsanaTask(taskId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: { completed: true } })
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

export async function getProjectList(): Promise<string[]> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return [];
    const response = await fetch(
      `https://app.asana.com/api/1.0/projects?workspace=${workspaceId}&archived=false&opt_fields=name`, 
      { headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` } }
    );
    const data = await response.json() as any;
    if (!data.data) return [];
    return data.data.map((p: any) => p.name);
  } catch (error) {
    return ["My Tasks"]; 
  }
}

export async function createAsanaTaskWithProject(title: string, projectName: string, notes: string): Promise<string | null> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return null;

    const projectsResponse = await fetch(
      `https://app.asana.com/api/1.0/projects?workspace=${workspaceId}&archived=false&opt_fields=name,gid`, 
      { headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` } }
    );
    const projectsData = await projectsResponse.json() as any;
    const project = projectsData.data.find((p: any) => p.name === projectName);
    const projectId = project ? project.gid : null;

    const body: any = {
      workspace: workspaceId,
      name: title,
      notes: notes,
      assignee: 'me'
    };

    if (projectId) body.projects = [projectId];

    const response = await fetch(`https://app.asana.com/api/1.0/tasks`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: body })
    });
    
    const json = await response.json() as any;
    return json.data ? json.data.gid : null; 

  } catch (error) {
    console.error("Failed to create task:", error);
    return null;
  }
}

export async function createAsanaSubtask(parentId: string, title: string): Promise<boolean> {
  try {
    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${parentId}/subtasks`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          data: { name: title } 
        })
      });
      return response.ok;
  } catch (e) {
    console.error("Failed to create subtask", e);
    return false;
  }
}