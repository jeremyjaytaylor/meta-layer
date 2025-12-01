import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

// SECURE: Load from environment variable
const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;

// Safety Cap: Fetch up to 500 messages
const MAX_PAGES = 10; 

// --- CONFIG: Channel -> Project Mapping ---
const PROJECT_MAP: Record<string, string> = {
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

  return match.permalink;
}

// --- API HELPERS ---
async function getMyUserId(): Promise<string | null> {
  try {
    if (!SLACK_TOKEN) throw new Error("Missing VITE_SLACK_TOKEN");
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    return data.ok ? data.user_id : null;
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
  const rawChannel = match.channel.name || match.channel.id;
  
  let project = PROJECT_MAP[rawChannel] || PROJECT_MAP[match.channel.id];
  if (!project) {
      project = match.channel.is_im ? "Direct Messages" : `#${rawChannel}`;
  }

  let title = cleanSlackText(match.text);
  let author = match.username || match.user || "Unknown";
  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  if (url.includes("docs.google.com") || url.includes("drive.google.com")) {
      provider = 'gdrive';
  }

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
      type: match.channel.is_im ? 'dm' : 'mention'
    }
  };
}

// ---------------------------------------------------------
// EXPORT 1: Main Fetcher (List View)
// ---------------------------------------------------------
export async function fetchSlackSignals(startDate?: Date): Promise<UnifiedTask[]> {
  try {
    const userId = await getMyUserId();
    if (!userId) return [];

    // VACUUM QUERY: "to:me" only (client-side filters handle date/noise)
    let queryString = `to:${userId}`;
    
    // NOTE: We do NOT add "after:date" here to avoid API bugs.
    const encodedQuery = encodeURIComponent(queryString);
    
    let allMatches: any[] = [];
    let page = 1;

    console.log("📥 Starting Wide Slack Fetch...");

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

    console.log(`✅ Total Raw Messages: ${allMatches.length}`);

    // Client-Side Filtering
    const filteredMatches = allMatches.filter((match: any) => {
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

    console.log(`✅ Filtered Count: ${filteredMatches.length}`);

    // Hydrate Ghosts
    const rawMatches = await Promise.all(filteredMatches.map(async (match: any) => {
      if (!match.text || match.text === "") {
        const hydrated = await hydrateMessage(match.channel.id, match.ts);
        if (hydrated) return { ...match, ...hydrated };
      }
      return match;
    }));

    return rawMatches.map(parseMessage);

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
    const userId = await getMyUserId();
    if (!userId) return [];

    // Same Vacuum Query for consistency
    let queryString = `to:${userId}`;
    const encodedQuery = encodeURIComponent(queryString);
    
    const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=50`, {
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
    });

    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data.ok || !data.messages) return [];

    // Filter matches before fetching threads to save bandwidth
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