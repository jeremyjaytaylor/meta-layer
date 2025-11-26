import { GoogleGenerativeAI } from "@google/generative-ai";

// ⚠️ PASTE YOUR KEY HERE
const API_KEY = "AIzaSyARHl3CPNMtwj0JsLZSQrYRBSYrZ8DcuaI"; 

const genAI = new GoogleGenerativeAI(API_KEY);

export interface AiSuggestion {
  title: string;
  projectName: string;
  reasoning: string;
}

// STRATEGY: Use the "Stable" production models (Late 2025 Standards)
// 1. gemini-2.5-flash: The current standard workhorse (Fast, High Limits)
// 2. gemini-2.5-pro: The reasoning model
// 3. gemini-2.0-flash: The previous stable fallback
const CANDIDATE_MODELS = [
  "gemini-2.5-flash", 
  "gemini-2.5-pro",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash-002" // Specific version number often outlives the alias
];

export async function analyzeSignal(
  slackMessage: string, 
  availableProjects: string[]
): Promise<AiSuggestion[]> {
  
  // Loop through candidates until one works
  for (const modelName of CANDIDATE_MODELS) {
    try {
      console.log(`🧠 Attempting AI analysis with model: ${modelName}...`);
      
      const model = genAI.getGenerativeModel({ model: modelName });

      const prompt = `
        You are an expert Technical Project Manager. 
        Analyze the following Slack message and break it down into actionable tasks.
        
        CONTEXT:
        - Slack Message: "${slackMessage}"
        - Available Projects: ${JSON.stringify(availableProjects)}

        INSTRUCTIONS:
        1. Identify distinct action items.
        2. Assign each task to the MOST relevant project from the list.
        3. Return a valid JSON array. Do NOT use markdown code blocks.

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
      const response = await result.response;
      const text = response.text();

      console.log(`✅ Success with ${modelName}! Response:`, text);

      const cleanJson = text.replace(/```json|```/g, '').trim();
      return JSON.parse(cleanJson) as AiSuggestion[];

    } catch (error: any) {
      const msg = error.message || "";
      
      // LOGIC: Treat Quota (429), Not Found (404), and Overloaded (503) as "Soft Fails"
      if (
        msg.includes("404") || 
        msg.includes("429") || 
        msg.includes("503") || 
        msg.includes("not found")
      ) {
        console.warn(`⚠️ Model ${modelName} skipped (${msg}). Retrying next candidate...`);
        continue; // SKIP to the next model in the list
      }
      
      // If it's a 403 (Invalid Key), stop immediately.
      console.error(`❌ Critical AI Failure on ${modelName}:`, error);
      alert(`AI Error (${modelName}): ${msg}`);
      return [];
    }
  }

  alert("Error: All Gemini models failed. Please check your API Quota or Key.");
  return [];
}