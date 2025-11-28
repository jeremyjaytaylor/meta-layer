import { GoogleGenerativeAI } from "@google/generative-ai";

// ⚠️ PASTE YOUR GEMINI KEY HERE
const API_KEY = "AIzaSyARHl3CPNMtwj0JsLZSQrYRBSYrZ8DcuaI"; 

const genAI = new GoogleGenerativeAI(API_KEY);

// --- TYPES ---
export interface ParsedMessage { msgId: string; suggestedProject: string; }
export interface ProposedTask { title: string; description: string; project: string; subtasks: string[]; citations: string[]; }
export interface AiSuggestion { title: string; projectName: string; reasoning: string; }

// STRATEGY: The "Stable 2.5" Hierarchy
// Based on your logs, 2.5-flash was the only one that returned a 200 OK.
const MODEL_CASCADE = [
  "gemini-2.5-flash",  // The one that worked in Turn 19
  "gemini-2.5-pro",    // The reasoning upgrade
  "gemini-2.0-flash"   // Fallback to 2.0 Stable (not experimental)
];

// --- HELPER: Delay for Rate Limits ---
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- HELPER: Minify Data ---
function minifySignals(signals: any[]): any[] {
  return signals.map(s => ({
    id: s.id,
    text: s.mainMessage?.text || "",
    user: s.mainMessage?.username || s.mainMessage?.user,
    replies: s.thread ? s.thread.map((t: any) => t.text) : []
  }));
}

// ---------------------------------------------------------
// CORE RUNNER
// ---------------------------------------------------------
async function runWithCascade(prompt: string, maxRetriesPerModel: number): Promise<any> {
  let lastError = null;

  for (const modelName of MODEL_CASCADE) {
    const model = genAI.getGenerativeModel({ model: modelName });
    
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        if (attempt > 0) console.log(`🔄 Retry ${attempt} on ${modelName}...`);
        
        // console.log(`🧠 Sending to ${modelName}...`);
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const cleanJson = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);

      } catch (error: any) {
        const msg = error.message || "";
        lastError = error;

        // Rate Limit (429) -> Wait and Retry SAME model
        if ((msg.includes("429") || msg.includes("503")) && attempt < maxRetriesPerModel) {
          const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
          console.warn(`⚠️ Rate limit on ${modelName}. Waiting ${delay/1000}s...`);
          await wait(delay);
          continue; 
        }

        // Not Found (404) -> Skip to next model immediately
        if (msg.includes("404") || msg.includes("not found")) {
          console.warn(`⚠️ ${modelName} not found. Skipping...`);
          break; 
        }
        
        console.error(`❌ Error on ${modelName}:`, error);
        break;
      }
    }
  }
  
  throw lastError || new Error("All models failed.");
}

// ---------------------------------------------------------
// BRAIN 1: Batch Project Categorizer
// ---------------------------------------------------------
export async function smartParseSlack(
  rawMessages: any[], 
  availableProjects: string[]
): Promise<Record<string, ParsedMessage>> {
  
  if (rawMessages.length === 0) return {};
  const minified = rawMessages.map(m => ({ id: m.ts, text: m.text }));

  const prompt = `
    You are an Organizational Assistant.
    Assign each Slack message to the most relevant Project.
    PROJECTS: ${JSON.stringify(availableProjects)}
    MESSAGES: ${JSON.stringify(minified)}
    INSTRUCTIONS: 1. Match to Project. 2. Default "Inbox". 3. Return JSON Object mapped by ID.
    OUTPUT JSON: { "170983.123": { "suggestedProject": "Engineering" } }
  `;

  try {
    // 0 Retries for list loading (Fail Fast)
    return await runWithCascade(prompt, 0); 
  } catch (e) {
    console.warn("Categorization skipped.");
    return {};
  }
}

// ---------------------------------------------------------
// BRAIN 2: Synthesize Workload (God Mode)
// ---------------------------------------------------------
export async function synthesizeWorkload(
  activeSignals: any[], 
  archivedContext: any[],
  availableProjects: string[]
): Promise<ProposedTask[]> {

  const cleanSignals = minifySignals(activeSignals);

  const prompt = `
    You are a Chief of Staff. Synthesize these Slack signals into a Project Plan.
    
    INPUTS:
    1. SIGNALS: ${JSON.stringify(cleanSignals)}
    2. PROJECTS: ${JSON.stringify(availableProjects)}

    INSTRUCTIONS:
    1. Cluster related threads into Major Tasks.
    2. Ignore resolved/done items.
    3. Create subtasks for specific actions.
    4. CITE SOURCES (Who said it?).
    
    OUTPUT JSON ARRAY:
    [
      {
        "project": "Project Name",
        "title": "Major Task Name",
        "description": "Context...",
        "subtasks": ["Action 1", "Action 2"],
        "citations": ["User said..."]
      }
    ]
  `;

  try {
    // 3 Retries for Synthesis (Patient)
    return await runWithCascade(prompt, 3);
  } catch (e: any) {
    alert(`Synthesis Failed: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------
// BRAIN 3: Single Signal Analysis
// ---------------------------------------------------------
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