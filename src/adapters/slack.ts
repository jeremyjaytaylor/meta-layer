import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

// ⚠️ PASTE YOUR SLACK TOKEN HERE
const SLACK_TOKEN = "xoxp-9898104501-748244888420-10001329191810-c0c49f6cecdcb50074529c60ce59b252"; 

const SEARCH_QUERY = "mention:@me OR to:me"; 

function cleanSlackText(text: string): string {
  if (!text) return "";
  return text
    .replace(/&gt;/g, '')    
    .replace(/&lt;/g, '<')   
    .replace(/&amp;/g, '&')  
    .replace(/<@.*?>/g, '')  
    .replace(/_/g, '')       
    .trim();
}

async function hydrateMessage(channelId: string, ts: string): Promise<any> {
  try {
    const response = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&latest=${ts}&inclusive=true&limit=1`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    return data.ok && data.messages.length > 0 ? data.messages[0] : null;
  } catch (e) {
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

    const tasks = await Promise.all(data.messages.matches.map(async (match: any) => {
      
      let fullMsg = match;
      
      // Hydrate if missing content
      if (!match.text || match.text === "") {
        const hydrated = await hydrateMessage(match.channel.id, match.ts);
        if (hydrated) fullMsg = { ...match, ...hydrated };
      }

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

      // --- PARSER: GOOGLE DRIVE ---
      const authorName = String(author).toLowerCase();
      if (authorName.includes("drive") || fullMsg.bot_id) {
        
        // 1. Extract Real Author
        const authorMatch = fullMsg.text ? fullMsg.text.match(/^(.*?)\s+(commented|replied|edited)/i) : null;
        if (authorMatch) {
            author = cleanSlackText(authorMatch[1]); 
        }

        // 2. EXTRACT CONTENT & LINKS FROM ATTACHMENTS (Priority)
        if (fullMsg.attachments && fullMsg.attachments.length > 0) {
            const att = fullMsg.attachments[0];

            // A. The Direct Link (title_link is usually the Doc URL)
            if (att.title_link && att.title_link.includes("docs.google.com")) {
                url = att.title_link;
                provider = 'gdrive';
            } else if (att.from_url && att.from_url.includes("docs.google.com")) {
                url = att.from_url;
                provider = 'gdrive';
            }

            // B. The Doc Title (Use as Channel Name)
            if (att.title) {
                channelName = `📄 ${cleanSlackText(att.title)}`;
            }

            // C. The Comment Text
            let rawText = att.text || att.pretext || att.fallback || "";
            if (rawText) title = cleanSlackText(rawText);
        }

        // 3. Fallback: Check text for link if attachment failed
        if (provider === 'slack') {
            const linkMatch = fullMsg.text ? fullMsg.text.match(/<(https:\/\/docs\.google\.com\/.*?)(\|.*?)?>/) : null;
            if (linkMatch) {
                url = linkMatch[1]; 
                provider = 'gdrive'; 
                channelName = "Google Drive"; 
                if (linkMatch[2]) {
                    channelName = `📄 ${linkMatch[2].replace('|', '')}`;
                }
            }
        }
      }

      return {
        id: stableId,
        externalId: match.ts,  
        provider: provider,
        title: cleanSlackText(title) || "[Google Drive Update]",
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