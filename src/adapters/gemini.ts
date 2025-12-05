import { GoogleGenerativeAI } from "@google/generative-ai";
import { UserProfile } from "../types/unified";

// SECURE: Load from environment variable
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY; 

const genAI = new GoogleGenerativeAI(API_KEY);

export interface ParsedMessage { msgId: string; suggestedProject: string; }
export interface ProposedTask { title: string; description: string; project: string; subtasks: string[]; citations: string[]; }
export interface AiSuggestion { title: string; projectName: string; reasoning: string; }

// STRATEGY: Stable Cascade
const MODEL_CASCADE = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-pro"
];

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// FIX: Extract Email/File Content for AI
function minifySignals(signals: any[]): any[] {
  return signals.map(s => {
    let content = s.mainMessage?.text || "";
    
    // Append File Preview (Email Body)
    if (s.mainMessage?.files && s.mainMessage.files.length > 0) {
        const f = s.mainMessage.files[0];
        if (f.title) content += `\n[File/Email Subject: ${f.title}]`;
        if (f.preview) content += `\n[File/Email Content: ${f.preview}]`;
    }

    return {
      id: s.id,
      channel: s.channelName, 
      text: content,
      user: s.mainMessage?.username || s.mainMessage?.user,
      replies: s.thread ? s.thread.map((t: any) => ({ user: t.user, text: t.text })) : []
    };
  });
}

async function runWithCascade(prompt: string, maxRetriesPerModel: number): Promise<any> {
  let lastError = null;

  for (const modelName of MODEL_CASCADE) {
    const model = genAI.getGenerativeModel({ model: modelName });
    
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        if (attempt > 0) console.log(`🔄 Retry ${attempt} on ${modelName}...`);
        
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const cleanJson = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);

      } catch (error: any) {
        const msg = error.message || "";
        lastError = error;

        if ((msg.includes("429") || msg.includes("503")) && attempt < maxRetriesPerModel) {
          const delay = 2000 * Math.pow(2, attempt); 
          console.warn(`⚠️ Rate limit on ${modelName}. Waiting ${delay/1000}s...`);
          await wait(delay);
          continue; 
        }

        if (msg.includes("404") || msg.includes("not found")) break; 
        break;
      }
    }
  }
  
  throw lastError || new Error("All models failed.");
}

export async function smartParseSlack(
  rawMessages: any[], 
  availableProjects: string[]
): Promise<Record<string, ParsedMessage>> {
  return {};
}

export async function synthesizeWorkload(
  activeSignals: any[], 
  archivedContext: any[],
  availableProjects: string[] | null,
  userProfile: UserProfile | null
): Promise<ProposedTask[]> {

  const cleanSignals = minifySignals(activeSignals);
  const projectList = availableProjects ? JSON.stringify(availableProjects) : "[]";

  let personaContext = "You are a Chief of Staff.";
  let prioritizationInstructions = "Cluster related threads into Major Tasks.";

  if (userProfile) {
    personaContext = `
      You are acting as the personal Executive Assistant for **${userProfile.name}**, who is a **${userProfile.title}**.
      
      USER CONTEXT:
      - **Role Description**: ${userProfile.roleDescription}
      - **Key Priorities**: ${userProfile.keyPriorities.join(", ")}
      - **Topics to IGNORE**: ${userProfile.ignoredTopics.join(", ")}
    `;

    prioritizationInstructions = `
      1. **FILTER**: Strictly ignore signals related to the "Topics to IGNORE" list.
      2. **PRIORITIZE**: Focus on signals that align with the "Key Priorities" and the user's role.
      3. **CLUSTER**: Group related threads into Major Tasks.
    `;
  }

  const prompt = `
    ${personaContext}
    
    Your goal is to synthesize these Slack signals into a Project Plan that is actionable for this specific user.
    
    INPUTS:
    1. SIGNALS: ${JSON.stringify(cleanSignals)}
    2. AVAILABLE ASANA PROJECTS: ${projectList}

    INSTRUCTIONS:
    ${prioritizationInstructions}
    4. Ignore resolved/done items.
    5. Create subtasks for specific actions.
    6. CITE SOURCES (Who said it?).
    
    OUTPUT JSON ARRAY:
    [
      {
        "project": "Project Name (pick best match from INPUT 2, or suggest 'My Tasks')",
        "title": "Major Task Name",
        "description": "Context and why this is relevant to the user...",
        "subtasks": ["Action 1", "Action 2"],
        "citations": ["User said..."]
      }
    ]
  `;

  try {
    return await runWithCascade(prompt, 2);
  } catch (e: any) {
    alert(`Synthesis Failed: ${e.message}`);
    return [];
  }
}

export async function analyzeSignal(
  slackMessage: string, 
  availableProjects: string[]
): Promise<AiSuggestion[]> {
  const prompt = `
    Analyze this message into Asana tasks.
    Message: "${slackMessage}"
    Projects: ${JSON.stringify(availableProjects)}
    Output JSON Array: [{ "title": "...", "projectName": "...", "reasoning": "..." }]
  `;

  try {
    return await runWithCascade(prompt, 1);
  } catch (e) {
    return [];
  }
}