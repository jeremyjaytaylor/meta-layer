import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';
// Note: smartParseSlack is imported if you want AI categorization for the list
import { smartParseSlack } from './gemini'; 
import { getProjectList } from './asana'; 

// SECURE: Load from environment variable
const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;

const MAX_PAGES = 10; 

// CONFIG: Specific Channel IDs to always import (Bypasses Search)
const EXTRA_CHANNELS: string[] = ["C0A0JDYA3SR"];

// CONFIG: Channel ID -> Project Name Mapping
const PROJECT_MAP: Record<string, string> = {
  "C0A0JDYA3SR": "My Private Notes",
  "team-research-evaluation": "Research & Evaluation",
  "mpdm-donnat--meg--jeremy-1": "Leadership Team",
  "mpdm-thomas--salma--jeremy-1": "Data Team",
  "mpdm-michelle--miles--staci--jeremy--stephanie-1": "Operations",
  "CMMU8KHU2": "Research & Evaluation", 
  "D03HNCS79PD": "Thomas P (Direct)",
  "D07EYAP2G0L": "Amy M (Direct)",
  "D06QPGYP1AP": "Carmen F (Direct)"
};

function cleanSlackText(text: string): string {
  if (!text) return "";
  return text
    .replace(/&gt;/g, '')    
    .replace(/&lt;/g, '<')   
    .replace(/&amp;/g, '&')  
    .replace(/<@.*?>/g, '')        
    .replace(/<http.*?>/g, '')     
    .replace(/\s+/g, ' ')          
    .trim();
}

function formatDateForSlack(date: Date): string {
  return date.toISOString().split('T')[0];
}

// --- HELPER: Recursive URL Finder ---
function extractLink(match: any): string {
  if (match.blocks) {
      const rawBlocks = JSON.stringify(match.blocks);
      const blockMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
      if (blockMatch) return blockMatch[1];
  }
  if (match.attachments && match.attachments.length > 0) {
    const att = match.attachments[0];
    if (att.title_link) return att.title_link;
    if (att.from_url) return att.from_url;
  }
  const textLink = match.text ? match.text.match(/<(https?:\/\/[^|>]+)/) : null;
  if (textLink) return textLink[1];

  if (match.permalink) return match.permalink;
  
  if (match.ts && match.channel) {
      const cleanTs = match.ts.replace('.', '');
      const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
      return `slack://channel?team=${match.team || 'T09SE32ER'}&id=${channelId}&message=${cleanTs}`;
  }
  return "";
}

// --- API HELPERS ---

// UPDATED: Returns { id, name } so we can search by @username
async function getUserInfo(): Promise<{ id: string, name: string } | null> {
  try {
    if (!SLACK_TOKEN) throw new Error("Missing VITE_SLACK_TOKEN");
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    if (!data.ok) return null;
    return { id: data.user_id, name: data.user }; // "user" is the username handle (e.g. "jeremy")
  } catch (e) { return null; }
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

async function fetchChannelHistory(channelId: string, startDate?: Date): Promise<any[]> {
  try {
    let url = `https://slack.com/api/conversations.history?channel=${channelId}&limit=50`;
    if (startDate) {
        const oldest = (startDate.getTime() / 1000).toString();
        url += `&oldest=${oldest}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    
    const data = await response.json() as any;
    if (!data.ok) {
        console.warn(`Failed to fetch history for ${channelId}: ${data.error}`);
        return [];
    }

    return data.messages.map((m: any) => ({
        ...m,
        channel: { id: channelId, name: PROJECT_MAP[channelId] || "Private Note" }
    }));
  } catch (e) { 
    console.error("Channel History Error:", e);
    return []; 
  }
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

// --- PARSER ---
function parseMessage(match: any): UnifiedTask {
  const msgId = match.ts.replace('.', '');
  const rawChannelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
  const rawChannelName = typeof match.channel === 'string' ? match.channel : (match.channel.name || match.channel.id);
  
  let project = PROJECT_MAP[rawChannelName] || PROJECT_MAP[rawChannelId];
  if (!project) {
      project = (match.channel.is_im || match.channel === 'D') ? "Direct Messages" : `#${rawChannelName}`;
  }

  let title = cleanSlackText(match.text);
  let author = match.username || match.user || "Unknown";
  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  if (url.includes("docs.google.com") || url.includes("drive.google.com")) {
      provider = 'gdrive';
  }

  // GDrive Logic
  if (match.username === "google drive" || (match.text === "" && (match.attachments || match.blocks))) {
    provider = 'gdrive'; 
    if (match.blocks) {
        const rawBlocks = JSON.stringify(match.blocks);
        const docMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
        if (docMatch) title = `📄 ${docMatch[2]}`;
        
        for (const block of match.blocks) {
            if (block.elements) {
                for (const el of block.elements) {
                    if (el.text && !el.text.includes("docs.google.com") && !el.text.includes("marked a thread")) {
                         const clean = cleanSlackText(el.text);
                         if (clean.length > 2) title += `: "${clean}"`;
                    }
                    if (el.elements) {
                         for (const subEl of el.elements) {
                             if (subEl.text) {
                                 const clean = cleanSlackText(subEl.text);
                                 if (clean.length > 2 && !clean.includes("commented on")) title += `: "${clean}"`;
                             }
                         }
                    }
                }
            }
        }
    }
    if ((!title || title.startsWith("📄 null")) && match.attachments && match.attachments.length > 0) {
        const att = match.attachments[0];
        if (att.title) title = `📄 ${att.title}`;
        if (att.text) title += `: "${cleanSlackText(att.text)}"`;
    }
  }

  // Notion Logic
  if (match.attachments && match.attachments.some((a: any) => a.service_name === 'Notion' || a.title?.includes('Notion'))) {
      provider = 'notion';
      const att = match.attachments[0];
      title = `📝 Notion: ${att.title}`;
  }

  if (title === "" || title === "📄 null") title = "[Shared an Image or File]";

  return {
    id: `slack-${msgId}`,
    externalId: match.ts,
    provider: provider,
    title: title,
    url: url,
    status: 'todo',
    createdAt: new Date(parseFloat(match.ts) * 1000).toISOString(),
    metadata: {
      author: author,
      channel: project,
      type: match.channel?.is_im ? 'dm' : 'mention'
    }
  };
}

// ---------------------------------------------------------
// EXPORT 1: Main Fetcher (List View)
// ---------------------------------------------------------
export async function fetchSlackSignals(startDate?: Date): Promise<UnifiedTask[]> {
  try {
    const userInfo = await getUserInfo();
    if (!userInfo) return [];

    // 1. Start Parallel Requests: Search + Extra Channels
    const searchPromise = (async () => {
        // FIX: Using the USERNAME syntax as you verified works
        // We also include <@ID> just in case, but prioritize @name
        let queryString = `to:@${userInfo.name} -from:asana`;
        
        // Note: Keeping vacuum strategy (no date in API) for reliability
        const encodedQuery = encodeURIComponent(queryString);
        
        let allMatches: any[] = [];
        let page = 1;

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
        return allMatches;
    })();

    const directHistoryPromises = EXTRA_CHANNELS.map(id => fetchChannelHistory(id, startDate));
    
    // 2. Wait for all
    const [searchResults, ...directResults] = await Promise.all([searchPromise, ...directHistoryPromises]);
    const directMatches = directResults.flat();
    const combinedMatches = [...searchResults, ...directMatches];
    
    // 3. Deduplicate
    const seenIds = new Set();
    const uniqueMatches = combinedMatches.filter(m => {
        if (seenIds.has(m.ts)) return false;
        seenIds.add(m.ts);
        return true;
    });

    console.log(`✅ Total Raw Messages: ${uniqueMatches.length}`);

    // 4. Client-Side Filtering
    const filteredMatches = uniqueMatches.filter((match: any) => {
        const rawJson = JSON.stringify(match).toLowerCase();
        const msgDate = new Date(parseFloat(match.ts) * 1000);

        // Date Filter
        if (startDate && msgDate < startDate) return false;
        
        // Noise Filters
        if (match.username === 'asana') return false;
        if (rawJson.includes("marked a thread as resolved")) return false;
        if (match.channel && match.channel.name && match.channel.name.toLowerCase().startsWith("fun")) return false;

        return true;
    });

    console.log(`✅ Filtered Messages: ${filteredMatches.length}`);

    // 5. Hydrate Ghosts
    const rawMatches = await Promise.all(filteredMatches.map(async (match: any) => {
      if (!match.text || match.text === "") {
        const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
        const hydrated = await hydrateMessage(channelId, match.ts);
        if (hydrated) return { ...match, ...hydrated };
      }
      return match;
    }));

    // Optional: AI Categorization if desired
    let aiParsedData: any = {};
    try {
        const projects = await getProjectList(); 
        const recentMatches = rawMatches.slice(0, 50); 
        aiParsedData = await smartParseSlack(recentMatches, projects);
    } catch (e) { }

    return rawMatches.map((match: any) => {
        const task = parseMessage(match);
        const aiInfo = aiParsedData[match.ts];
        if (aiInfo && aiInfo.suggestedProject && aiInfo.suggestedProject !== "Inbox") {
            task.metadata.channel = `📂 ${aiInfo.suggestedProject}`;
        }
        return task;
    });

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}

// ---------------------------------------------------------
// EXPORT 2: Rich Fetcher (Synthesis)
// ---------------------------------------------------------
export async function fetchRichSignals(startDate?: Date): Promise<any[]> {
  try {
    const userInfo = await getUserInfo();
    if (!userInfo) return [];

    // FIX: Use the same successful query for Synthesis
    let queryString = `to:@${userInfo.name} -from:asana -"marked a thread as resolved"`;
    
    // Keeping vacuum (no date) consistent
    const encodedQuery = encodeURIComponent(queryString);
    
    const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=50`, {
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
    });

    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data.ok || !data.messages) return [];

    const filteredMatches = data.messages.matches.filter((match: any) => {
        const rawJson = JSON.stringify(match).toLowerCase();
        const msgDate = new Date(parseFloat(match.ts) * 1000);
        
        if (startDate && msgDate < startDate) return false;
        if (match.username === 'asana') return false;
        if (rawJson.includes("marked a thread as resolved")) return false;
        return true;
    });

    const richData = await Promise.all(filteredMatches.map(async (match: any) => {
      let thread = [];
      if (match.reply_count && match.reply_count > 0) {
        thread = await fetchThread(match.channel.id, match.ts);
      }
      return { 
          id: `slack-${match.ts}`, 
          mainMessage: match, 
          thread: thread, 
          source: 'slack',
          channelName: match.channel.name 
      };
    }));

    return richData;
  } catch (error) { return []; }
}