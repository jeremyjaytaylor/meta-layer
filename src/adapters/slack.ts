import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';
import { smartParseSlack } from './gemini'; 
import { getProjectList } from './asana'; 

// ⚠️ PASTE YOUR SLACK TOKEN HERE
const SLACK_TOKEN = "xoxp-9898104501-748244888420-10001329191810-c0c49f6cecdcb50074529c60ce59b252"; 

const SEARCH_QUERY = "mention:@me OR to:me"; 

function cleanSlackText(text: string): string {
  if (!text) return "";
  return text.replace(/&gt;/g, '').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/<@.*?>/g, '').replace(/_/g, '').trim();
}

async function hydrateMessage(channelId: string, ts: string): Promise<any> {
  try {
    const response = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&latest=${ts}&inclusive=true&limit=1`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    return data.ok && data.messages.length > 0 ? data.messages[0] : null;
  } catch (e) { return null; }
}

async function fetchThread(channelId: string, ts: string): Promise<any[]> {
  try {
    const response = await fetch(`https://slack.com/api/conversations.replies?channel=${channelId}&ts=${ts}&limit=10`, {
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    return data.ok ? data.messages : [];
  } catch (e) { return []; }
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

    // 1. Hydrate "Ghost" messages
    const rawMatches = await Promise.all(data.messages.matches.map(async (match: any) => {
      if (!match.text || match.text === "") {
        const hydrated = await hydrateMessage(match.channel.id, match.ts);
        if (hydrated) return { ...match, ...hydrated };
      }
      return match;
    }));

    // 2. AI Categorization (Non-Blocking Attempt)
    let aiParsedData: any = {};
    try {
        const projects = await getProjectList(); 
        aiParsedData = await smartParseSlack(rawMatches, projects);
    } catch (e) {
        console.warn("Skipping AI categorization due to error/timeout");
    }

    // 3. Map to UnifiedTask
    return rawMatches.map((match: any) => {
      let fullMsg = match;
      const channelId = match.channel.id;
      const teamId = match.team; 
      const msgId = match.ts.replace('.', '');
      const stableId = `slack-${msgId}`;
      const isDm = match.channel.is_im === true;

      let url = `slack://channel?team=${teamId}&id=${channelId}&message=${msgId}`;
      let provider: 'slack' | 'gdrive' = 'slack';
      
      let title = cleanSlackText(fullMsg.text); 
      let author = fullMsg.username || fullMsg.user || "Unknown";
      let channelName = isDm ? "Direct Message" : match.channel.name;

      // PARSER: GOOGLE DRIVE
      const rawUser = String(author).toLowerCase();
      if (rawUser.includes("drive") || match.bot_id || JSON.stringify(match).includes("docs.google.com")) {
          const authorMatch = fullMsg.text ? fullMsg.text.match(/^(.*?)\s+(commented|replied|edited)/i) : null;
          if (authorMatch) author = cleanSlackText(authorMatch[1]);
          
          if (fullMsg.attachments && fullMsg.attachments.length > 0) {
             const att = fullMsg.attachments[0];
             if (att.title_link && att.title_link.includes("docs.google.com")) { url = att.title_link; provider = 'gdrive'; }
             else if (att.from_url && att.from_url.includes("docs.google.com")) { url = att.from_url; provider = 'gdrive'; }
             
             let rawText = att.text || att.pretext || att.fallback || "";
             if (rawText) title = cleanSlackText(rawText);
             if (att.title) channelName = `📄 ${cleanSlackText(att.title)}`;
          }
          // Fallback if still generic
          if (provider === 'slack') {
             const linkMatch = fullMsg.text ? fullMsg.text.match(/<(https:\/\/docs\.google\.com\/.*?)(\|.*?)?>/) : null;
             if (linkMatch) { url = linkMatch[1]; provider = 'gdrive'; channelName = "Google Drive"; }
          }
      }

      // MERGE AI PROJECT
      const aiInfo = aiParsedData[match.ts];
      if (aiInfo && aiInfo.suggestedProject && aiInfo.suggestedProject !== "Inbox") {
          channelName = `📂 ${aiInfo.suggestedProject}`; 
      }

      return {
        id: stableId, externalId: match.ts, provider: provider, title: title || "[Empty Message]", url: url, status: 'todo',
        createdAt: new Date(parseFloat(match.ts) * 1000).toISOString(),
        metadata: { author: author, channel: channelName, type: isDm ? 'dm' : 'mention' }
      };
    });

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}

export async function fetchRichSignals(): Promise<any[]> {
  try {
    const encodedQuery = encodeURIComponent(SEARCH_QUERY);
    const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=15`, {
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
    });
    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data.ok || !data.messages) return [];
    
    // Fetch Threads
    const richData = await Promise.all(data.messages.matches.map(async (match: any) => {
      let thread = [];
      if (match.reply_count && match.reply_count > 0) {
        thread = await fetchThread(match.channel.id, match.ts);
      }
      return { id: `slack-${match.ts}`, mainMessage: match, thread: thread, source: 'slack' };
    }));
    return richData;
  } catch (error) { return []; }
}