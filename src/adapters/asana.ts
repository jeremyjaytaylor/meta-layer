import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';
import { v4 as uuidv4 } from 'uuid';

// ⚠️ PASTE YOUR REAL TOKEN HERE
const ASANA_TOKEN = "2/1123680875093244/1212199707443892:fba96ce0086234d19fe9719600931f18"; 

// Helper: Get Workspace ID
async function getWorkspaceId(): Promise<string | null> {
  try {
    const userResponse = await fetch('https://app.asana.com/api/1.0/users/me', {
      headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` }
    });
    const userData = await userResponse.json() as any;
    if (userData.data && userData.data.workspaces.length > 0) {
        return userData.data.workspaces[0].gid;
    }
    return null;
  } catch (e) {
    console.error("Failed to get workspace", e);
    return null;
  }
}

// READ: Fetch My Tasks
export async function fetchAsanaTasks(): Promise<UnifiedTask[]> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return [];

    const response = await fetch(
      `https://app.asana.com/api/1.0/tasks?assignee=me&workspace=${workspaceId}&completed_since=now&opt_fields=name,permalink_url,due_on,projects.name,assignee_status`, 
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${ASANA_TOKEN}` }
      }
    );

    const data = await response.json() as any;
    if (!data.data) return [];

    return data.data.map((task: any) => ({
      id: uuidv4(),
      externalId: task.gid, 
      provider: 'asana',
      title: task.name,
      url: task.permalink_url,
      status: task.assignee_status === 'today' ? 'todo' : 'in_progress',
      createdAt: new Date().toISOString(),
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

// WRITE: Mark as Complete
export async function completeAsanaTask(taskId: string): Promise<boolean> {
  try {
    console.log(`✅ Attempting to complete task: ${taskId}`);
    
    const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      // FIX: Wrapped in "data" object
      body: JSON.stringify({ 
        data: { completed: true } 
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Asana Failure Code:", response.status);
      console.error("❌ Asana Failure Details:", errorText);
      return false;
    }
    
    console.log("🎉 Asana Success! Task completed.");
    return true;

  } catch (error) {
    console.error("💥 Network/Logic Error:", error);
    return false;
  }
}

// WRITE: Create Task from Slack
export async function createAsanaTaskFromSlack(text: string, slackLink: string): Promise<boolean> {
  try {
    const workspaceId = await getWorkspaceId();
    if (!workspaceId) return false;

    console.log(`🚀 Promoting Slack to Asana: ${text}`);
    
    const response = await fetch(`https://app.asana.com/api/1.0/tasks`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${ASANA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      // FIX: Wrapped in "data" object
      body: JSON.stringify({ 
        data: { 
          workspace: workspaceId,
          name: `From Slack: ${text}`,
          notes: `Context: ${slackLink}`,
          assignee: 'me'
        } 
      })
    });
    
    return response.ok;
  } catch (error) {
    console.error("Failed to create task:", error);
    return false;
  }
}