import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';
import { smartParseSlack } from './gemini'; 
import { getProjectList } from './asana'; 

// ⚠️ PASTE YOUR SLACK TOKEN HERE
const SLACK_TOKEN = "xoxp-9898104501-748244888420-10001329191810-c0c49f6cecdcb50074529c60ce59b252"; 

const BASE_QUERY = "mention:@me OR to:me"; 

function cleanSlackText(text: string): string {
  if (!text) return "";
  return text.replace(/&gt;/g, '').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/<@.*?>/g, '').replace(/_/g, '').trim();
}

function formatDateForSlack(date: Date): string {
  return date.toISOString().split('T')[0];
}

// --- HELPER: Get Your Real User ID ---
async function getMyUserId(): Promise<string | null> {
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    return data.ok ? data.user_id : null;
  } catch (e) {
    console.error("Auth Test Failed", e);
    return null;
  }
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

// ---------------------------------------------------------
// EXPORT 1: fetchSlackSignals (UI List)
// ---------------------------------------------------------
export async function fetchSlackSignals(startDate?: Date): Promise<UnifiedTask[]> {
  try {
    const userId = await getMyUserId();
    if (!userId) {
        console.error("Could not determine user ID");
        return [];
    }

    let queryString = `<@${userId}> OR to:${userId}`;
    
    if (startDate) {
        queryString += ` after:${formatDateForSlack(startDate)}`;
    }

    console.log(`🔎 Slack Query: ${queryString}`);

    const encodedQuery = encodeURIComponent(queryString);
    
    // Pagination Loop (Fetch up to 200 messages for the UI list)
    let allMatches: any[] = [];
    let page = 1;
    const MAX_PAGES = 2; // Keep UI fast

    while (page <= MAX_PAGES) {
        const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=100&page=${page}`, {
            headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
        });
        if (!response.ok) break;
        const data = await response.json() as any;
        if (!data.ok || !data.messages || !data.messages.matches) break;
        allMatches = [...allMatches, ...data.messages.matches];
        if (page >= data.messages.paging.pages) break;
        page++;
    }

    // Hydrate Ghosts
    const rawMatches = await Promise.all(allMatches.map(async (match: any) => {
      if (!match.text || match.text === "") {
        const hydrated = await hydrateMessage(match.channel.id, match.ts);
        if (hydrated) return { ...match, ...hydrated };
      }
      return match;
    }));

    // AI Categorization
    let aiParsedData: any = {};
    try {
        const projects = await getProjectList(); 
        // Slice to most recent 50 for AI to keep it fast
        const recentMatches = rawMatches.slice(0, 50); 
        aiParsedData = await smartParseSlack(recentMatches, projects);
    } catch (e) { }

    // Map to UnifiedTask
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
          if (provider === 'slack') {
             const linkMatch = fullMsg.text ? fullMsg.text.match(/<(https:\/\/docs\.google\.com\/.*?)(\|.*?)?>/) : null;
             if (linkMatch) { url = linkMatch[1]; provider = 'gdrive'; channelName = "Google Drive"; }
          }
      }

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

// ---------------------------------------------------------
// EXPORT 2: fetchRichSignals (FOR SYNTHESIS)
// ---------------------------------------------------------
export async function fetchRichSignals(startDate?: Date): Promise<any[]> {
  try {
    // FIX: Get Real User ID (Critical for Synthesis finding messages)
    const userId = await getMyUserId();
    if (!userId) return [];

    let queryString = `<@${userId}> OR to:${userId}`;
    if (startDate) queryString += ` after:${formatDateForSlack(startDate)}`;
    
    const encodedQuery = encodeURIComponent(queryString);
    
    // Fetch up to 50 threads for synthesis
    const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=50`, {
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
    });

    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data.ok || !data.messages) return [];

    const richData = await Promise.all(data.messages.matches.map(async (match: any) => {
      let thread = [];
      if (match.reply_count && match.reply_count > 0) {
        thread = await fetchThread(match.channel.id, match.ts);
      }
      return { 
          id: `slack-${match.ts}`, 
          mainMessage: match, 
          thread: thread, 
          source: 'slack',
          channelName: match.channel.name // Ensure channel name is passed for context
      };
    }));

    return richData;

  } catch (error) { return []; }
}