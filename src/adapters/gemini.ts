import { GoogleGenerativeAI } from "@google/generative-ai";
import { UserProfile } from "../types/unified";

// SECURE: Load from environment variable with validation
const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

// Validate API key early
if (!API_KEY) {
  throw new Error("VITE_GEMINI_API_KEY environment variable is not set. Please configure it in your .env file.");
}

// Use GAIA v1 endpoints so the latest 1.5 models resolve instead of 404-ing on v1beta
const genAI = new GoogleGenerativeAI(API_KEY, { apiVersion: "v1" });

export interface ParsedMessage { msgId: string; suggestedProject: string; }
export interface ProposedTask { title: string; description: string; project: string; subtasks: string[]; citations: string[]; sourceLinks: { text: string; url: string; }[]; }
export interface AiSuggestion { title: string; projectName: string; reasoning: string; }

// STRATEGY: Stable Cascade - only use GAIA v1-available model IDs
// Keep fastest first; include 1.0 fallback for older API keys/quotas.
const MODEL_CASCADE = [
  "gemini-1.5-flash-002",
  "gemini-1.5-pro-002",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
  "gemini-1.0-pro",
];

// BUDGETS: stay well under the 1M token cap
const MAX_CHARS_PER_FILE_CONTENT = 4000;
const MAX_CHARS_PER_SIGNAL = 6000;
const MAX_TOTAL_SIGNAL_CHARS = 180000;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// FIX: Extract Email/File Content for AI
function truncateText(text: string, limit: number): string {
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, limit)}... [truncated]`;
}

function enforceTotalBudget(items: any[]): any[] {
  let running = 0;
  return items.map((item) => {
    const remaining = Math.max(MAX_TOTAL_SIGNAL_CHARS - running, 0);
    const clipped = truncateText(item.text, remaining);
    running += clipped.length;
    return { ...item, text: clipped };
  });
}

function minifySignals(signals: any[]): any[] {
  console.log(`🔄 minifySignals processing ${signals.length} signals...`);
  console.log(`📋 First signal structure:`, JSON.stringify(signals[0], null, 2).substring(0, 500));
  
  const mapped = signals.map((s, idx) => {
    let content = s.mainMessage?.text || "";
    
    console.log(`🔍 Signal ${idx} mainMessage structure:`, {
      hasFiles: !!s.mainMessage?.files,
      filesIsArray: Array.isArray(s.mainMessage?.files),
      filesLength: s.mainMessage?.files?.length,
      firstFileKeys: s.mainMessage?.files?.[0] ? Object.keys(s.mainMessage.files[0]) : []
    });
    
    // Append File Preview (Email Body, PDF, Docs, etc.)
    if (s.mainMessage?.files && Array.isArray(s.mainMessage.files) && s.mainMessage.files.length > 0) {
        const f = s.mainMessage.files[0];
        console.log(`📄 Signal ${idx}: Processing file: ${f.title || f.name}`);
        console.log(`   File object:`, JSON.stringify(f, null, 2).substring(0, 300));
        console.log(`   Preview available: ${!!f.preview}, length: ${f.preview?.length || 0}`);
        console.log(`   Full content length from metadata: ${f.fullContentLength || 'unknown'}`);
        
        if (f.title || f.name) {
          content += `\n\n--- ATTACHED FILE ---`;
          content += `\nFile Name: ${f.title || f.name}`;
          if (f.mimetype) content += `\nFile Type: ${f.mimetype}`;
        }
        // Include file preview/content if available
        if (f.preview && f.preview.length > 0) {
          const clippedPreview = truncateText(f.preview, MAX_CHARS_PER_FILE_CONTENT);
          content += `\n\nFILE CONTENTS:\n${clippedPreview}`;
          console.log(`✅ Signal ${idx}: Added ${clippedPreview.length} characters of file content`);
          console.log(`   Content preview: ${clippedPreview.substring(0, 100)}...`);
        } else {
          console.warn(`⚠️ Signal ${idx}: No preview content available for ${f.title || f.name}`);
        }
        content += `\n--- END FILE ---`;
    }
    
    content = truncateText(content, MAX_CHARS_PER_SIGNAL);
    console.log(`📊 Signal ${idx} final content length: ${content.length}`);

    return {
      id: s.id,
      channel: s.channelName, 
      text: content,
      user: s.mainMessage?.username || s.mainMessage?.user,
      url: s.url,
      source: s.source,
      replies: Array.isArray(s.thread) ? s.thread.map((t: any) => ({ user: t.user, text: t.text })) : []
    };
  });

  return enforceTotalBudget(mapped);
}

async function runWithCascade(prompt: string, maxRetriesPerModel: number): Promise<any> {
  let lastError: Error | null = null;

  for (const modelName of MODEL_CASCADE) {
    const model = genAI.getGenerativeModel({ model: modelName });
    
    for (let attempt = 0; attempt <= maxRetriesPerModel; attempt++) {
      try {
        if (attempt > 0) console.log(`🔄 Retry ${attempt} on ${modelName}...`);
        
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const cleanJson = text.replace(/```json|```/g, '').trim();
        
        // Validate JSON before parsing
        if (!cleanJson) {
          throw new Error("Empty response from model");
        }
        
        return JSON.parse(cleanJson);

      } catch (error: any) {
        const msg = error.message || "";
        lastError = error;
        console.error(`Error on ${modelName} attempt ${attempt}:`, msg);

        if ((msg.includes("429") || msg.includes("503")) && attempt < maxRetriesPerModel) {
          const delay = 2000 * Math.pow(2, attempt); 
          console.warn(`⚠️ Rate limit on ${modelName}. Waiting ${delay/1000}s...`);
          await wait(delay);
          continue; 
        }

        if (msg.includes("404") || msg.includes("not found")) {
          console.warn(`Model ${modelName} not available, trying next...`);
          break;
        }
        break;
      }
    }
  }
  
  throw lastError || new Error("All models failed. Check your API key and network connection.");
}

export async function generateFileSummary(fileContent: string, fileName: string): Promise<string> {
  try {
    // Truncate very long content
    const truncated = fileContent.substring(0, 3000);
    const prompt = `Summarize this file in 1-2 concise sentences (max 150 chars total).
    
File: ${fileName}
Content: ${truncated}

Output only the summary text, no JSON.`;

    // Try fast model first, then fallback through cascade if it 404s
    const summaryModels = ["gemini-1.5-flash-002", "gemini-1.5-flash", "gemini-1.0-pro"];
    let lastErr: any;
    for (const m of summaryModels) {
      try {
        const model = genAI.getGenerativeModel({ model: m });
        const result = await model.generateContent(prompt);
        const summary = result.response.text().trim();
        const clipped = summary.length > 150 ? summary.substring(0, 147) + "..." : summary;
        return clipped;
      } catch (err: any) {
        lastErr = err;
        const msg = err?.message || "";
        console.warn(`Summary model ${m} failed (${msg}). Trying next...`);
        if (msg.includes("404")) continue;
        // Non-404 errors: break to fallback
        break;
      }
    }

    throw lastErr || new Error("All summary models failed");
  } catch (error) {
    console.error("Failed to generate summary:", error);
    // Fallback to first sentence of content
    const firstSentence = fileContent.split(/[.!?]\s/)[0];
    return firstSentence.length > 150 ? firstSentence.substring(0, 147) + "..." : firstSentence;
  }
}

export async function smartParseSlack(
  rawMessages: any[], 
  availableProjects: string[]
): Promise<Record<string, ParsedMessage>> {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return {};
  }

  const prompt = `
    Parse these Slack messages into structured tasks.
    Messages: ${JSON.stringify(rawMessages.slice(0, 50))}
    Available Projects: ${JSON.stringify(availableProjects)}
    
    Output JSON Object format (map message ID to suggestion):
    {
      "messageId1": { "msgId": "messageId1", "suggestedProject": "Project Name" },
      "messageId2": { "msgId": "messageId2", "suggestedProject": "My Tasks" }
    }
  `;

  try {
    return await runWithCascade(prompt, 1);
  } catch (e) {
    console.error("smartParseSlack failed:", e);
    return {};
  }
}

export async function synthesizeWorkload(
  activeSignals: any[], 
  _archivedContext: any[],
  availableProjects: string[] | null,
  userProfile: UserProfile | null
): Promise<ProposedTask[]> {

  const cleanSignals = minifySignals(activeSignals);
  const projectList = availableProjects && Array.isArray(availableProjects) ? JSON.stringify(availableProjects) : "[]";

  // Create signal index for AI to reference back to sources
  const signalIndex = cleanSignals.map((s, idx) => `[Signal ${idx}] Channel: #${s.channel} | User: ${s.user} | URL: ${s.url || 'N/A'}`).join('\n');

  let personaContext = "You are a Chief of Staff.";
  let prioritizationInstructions = "Cluster related threads into Major Tasks.";

  if (userProfile) {
    personaContext = `
      You are acting as the personal Executive Assistant for **${userProfile.name}**, who is a **${userProfile.title}**.
      
      USER CONTEXT:
      - **Role Description**: ${userProfile.roleDescription}
      - **Key Priorities**: ${userProfile.keyPriorities?.join(", ") || "None specified"}
      - **Topics to IGNORE**: ${userProfile.ignoredTopics?.join(", ") || "None specified"}
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
    
    SIGNAL REFERENCE INDEX (use these signal numbers in sourceSignalIndices):
    ${signalIndex}
    
    INPUTS:
    1. SIGNALS: ${JSON.stringify(cleanSignals)}
    2. AVAILABLE ASANA PROJECTS: ${projectList}

    INSTRUCTIONS:
    ${prioritizationInstructions}
    4. Ignore resolved/done items.
    5. Create subtasks for specific actions.
    6. CITE SOURCES by referencing signal indices and including message URLs.
    7. For each task, list which signals (by index number) contributed to it in "sourceSignalIndices".
    
    OUTPUT JSON ARRAY (strict format):
    [
      {
        "project": "Project Name (pick best match from INPUT 2, or suggest 'My Tasks')",
        "title": "Major Task Name",
        "description": "Context and why this is relevant to the user. Include specific information from the source materials that led to identifying this task.",
        "subtasks": ["Action 1", "Action 2"],
        "citations": ["Who said what and why it matters"],
        "sourceSignalIndices": [0, 2, 5],
        "sourceLinks": [{"text": "Slack message in #channel from User", "url": "https://..."}]
      }
    ]
  `;

  try {
    const result = await runWithCascade(prompt, 2);
    
    // Post-process results to ensure sourceLinks are populated from original signals
    if (Array.isArray(result)) {
      return result.map((task: any) => {
        // If AI provided signal indices, use them to populate sourceLinks
        if (Array.isArray(task.sourceSignalIndices)) {
          const sourceLinks: { text: string; url: string; }[] = [];
          task.sourceSignalIndices.forEach((idx: number) => {
            if (cleanSignals[idx]) {
              const signal = cleanSignals[idx];
              sourceLinks.push({
                text: `Slack message in #${signal.channel} from ${signal.user}`,
                url: signal.url || '#'
              });
            }
          });
          task.sourceLinks = sourceLinks.length > 0 ? sourceLinks : (task.sourceLinks || []);
        }
        
        // Ensure sourceLinks always exists (even if empty)
        if (!Array.isArray(task.sourceLinks)) {
          task.sourceLinks = [];
        }
        
        return task;
      });
    }
    
    return [];
  } catch (e: any) {
    console.error(`Synthesis Failed: ${e.message}`);
    return [];
  }
}

export async function analyzeSignal(
  slackMessage: string, 
  availableProjects: string[]
): Promise<AiSuggestion[]> {
  if (!slackMessage || typeof slackMessage !== 'string') {
    console.warn("analyzeSignal called with invalid message");
    return [];
  }

  const prompt = `
    Analyze this message into Asana tasks.
    Message: "${slackMessage.slice(0, 500)}"
    Projects: ${JSON.stringify(availableProjects)}
    
    Output JSON Array (strict format):
    [{ "title": "...", "projectName": "...", "reasoning": "..." }]
  `;

  try {
    const result = await runWithCascade(prompt, 1);
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.error("analyzeSignal failed:", e);
    return [];
  }
}
