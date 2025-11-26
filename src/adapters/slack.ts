import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

// ⚠️ PASTE YOUR NEW TOKEN HERE
const SLACK_TOKEN = "xoxp-9898104501-748244888420-10001329191810-c0c49f6cecdcb50074529c60ce59b252"; 

const SEARCH_QUERY = "mention:@me OR to:me"; 

// Helper: Fetch full details for a "broken" message
async function hydrateMessage(channelId: string, ts: string): Promise<any> {
  try {
    const response = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&latest=${ts}&inclusive=true&limit=1`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    // Return the first message (the one we asked for)
    return data.ok && data.messages.length > 0 ? data.messages[0] : null;
  } catch (e) {
    console.warn("Failed to hydrate message:", e);
    return null;
  }
}

export async function fetchSlackSignals(): Promise<UnifiedTask[]> {
  try {
    const encodedQuery = encodeURIComponent(SEARCH_QUERY);
    const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=20`, {
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
    });

    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data.ok || !data.messages) return [];

    // We use Promise.all to handle async hydration in parallel
    const tasks = await Promise.all(data.messages.matches.map(async (match: any) => {
      
      // 1. Check if this is a "Ghost" Google Drive message
      let fullMsg = match;
      const isGhost = (match.username === "google drive" || match.username === "Google Drive") && (!match.text || match.text === "");

      if (isGhost) {
        // console.log("💧 Hydrating Ghost Message:", match.ts);
        const hydrated = await hydrateMessage(match.channel.id, match.ts);
        if (hydrated) {
            fullMsg = { ...match, ...hydrated }; // Merge the new data (blocks/attachments)
        }
      }

      // 2. Standard Parsing Logic
      const channelId = match.channel.id;
      const teamId = match.team; 
      const msgId = match.ts.replace('.', '');
      const isDm = match.channel.is_im === true;
      let channelName = isDm ? "Direct Message" : match.channel.name;
      const stableId = `slack-${msgId}`; 

      let title = fullMsg.text || "";
      let author = fullMsg.username || fullMsg.user || "Unknown";
      let url = `slack://channel?team=${teamId}&id=${channelId}&message=${msgId}`;
      let provider: 'slack' | 'gdrive' = 'slack'; 

      // 3. GDrive Parser (Now running on fully hydrated data)
      const authorName = String(author).toLowerCase();
      if (authorName.includes("drive") || fullMsg.bot_id) {
        
        // A. Extract Real Author
        const authorMatch = fullMsg.text ? fullMsg.text.match(/^(.*?)\s+commented/i) : null;
        if (authorMatch) author = authorMatch[1].trim(); 

        // B. Extract Link
        const linkMatch = fullMsg.text ? fullMsg.text.match(/<(https:\/\/docs\.google\.com\/.*?)(\|.*?)?>/) : null;
        if (linkMatch) {
            url = linkMatch[1]; 
            provider = 'gdrive'; 
            channelName = "Google Drive"; 
        }

        // C. Extract Content (Check Blocks -> Attachments -> Text)
        if (fullMsg.blocks && fullMsg.blocks.length > 0) {
             // Google Drive often puts the comment in a "Section" block or "Context" block
             // We try to find the first piece of text that isn't the generic header
             for (const block of fullMsg.blocks) {
                 if (block.text && block.text.text && !block.text.text.includes("commented on")) {
                     title = block.text.text;
                     break;
                 }
             }
        }
        
        // Fallback to attachments if blocks failed
        if ((!title || title === "") && fullMsg.attachments && fullMsg.attachments.length > 0) {
             const att = fullMsg.attachments[0];
             title = att.text || att.pretext || att.fallback || title;
        }
        
        // Final Fallback
        if (!title || title.trim() === "") title = "[Google Drive Update]";
      }

      return {
        id: stableId,
        externalId: match.ts,  
        provider: provider,
        title: title,
        url: url,
        status: 'todo',
        createdAt: new Date(parseFloat(match.ts) * 1000).toISOString(),
        metadata: {
          author: author,
          channel: channelName,
          type: isDm ? 'dm' : 'mention'
        }
      };
    }));

    return tasks;

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}