import { GoogleGenerativeAI } from "@google/generative-ai";

// ⚠️ PASTE YOUR KEY HERE
const API_KEY = "AIzaSyARHl3CPNMtwj0JsLZSQrYRBSYrZ8DcuaI"; 

const genAI = new GoogleGenerativeAI(API_KEY);

const CANDIDATE_MODELS = [
  "gemini-2.5-flash", 
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
];

export interface AiSuggestion {
  title: string;
  projectName: string;
  reasoning: string;
}

// NEW: A simple map of Message ID -> Project Name
export interface ProjectMap {
  [messageId: string]: string;
}

// ---------------------------------------------------------
// FEATURE 1: Batch Categorize (Groups Slack by Project)
// ---------------------------------------------------------
export async function batchCategorize(
  messages: { id: string; text: string }[], 
  availableProjects: string[]
): Promise<ProjectMap> {
  if (messages.length === 0) return {};

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      
      const prompt = `
        You are an organizational assistant. 
        I have a list of Slack messages and a list of Projects.
        Match each message to the single most relevant Project.
        
        PROJECTS: ${JSON.stringify(availableProjects)}
        
        MESSAGES: 
        ${JSON.stringify(messages)}

        INSTRUCTIONS:
        1. Use context clues (keywords, channel names implied in text) to pick the best Project.
        2. If unclear, use "Inbox".
        3. Return a JSON Object where keys are Message IDs and values are Project Names.

        OUTPUT FORMAT (JSON ONLY):
        {
          "msg_123": "Engineering",
          "msg_456": "Marketing"
        }
      `;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleanJson = text.replace(/```json|```/g, '').trim();
      return JSON.parse(cleanJson);

    } catch (error) {
      console.warn(`Model ${modelName} failed to batch categorize.`, error);
      continue;
    }
  }
  return {};
}

// ---------------------------------------------------------
// FEATURE 2: Analyze Signal (Breaks 1 Message into Tasks)
// ---------------------------------------------------------
export async function analyzeSignal(
  slackMessage: string, 
  availableProjects: string[]
): Promise<AiSuggestion[]> {
  
  for (const modelName of CANDIDATE_MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const prompt = `
        You are an expert Technical Project Manager. 
        Analyze this Slack message and break it down into actionable Asana tasks.
        
        CONTEXT:
        - Slack Message: "${slackMessage}"
        - Available Projects: ${JSON.stringify(availableProjects)}

        INSTRUCTIONS:
        1. Identify distinct action items.
        2. Assign each task to the MOST relevant project.
        3. Return a valid JSON array.

        OUTPUT FORMAT (JSON ONLY):
        [
          {
            "title": "Task title",
            "projectName": "Project Match",
            "reasoning": "Reason"
          }
        ]
      `;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleanJson = text.replace(/```json|```/g, '').trim();
      return JSON.parse(cleanJson) as AiSuggestion[];

    } catch (error: any) {
      const msg = error.message || "";
      if (msg.includes("404") || msg.includes("429") || msg.includes("503")) {
        continue;
      }
      console.error(`AI Critical Fail: ${msg}`);
      return [];
    }
  }
  return [];
}