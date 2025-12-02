import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

// SECURE: Load from environment variable
const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;

const MAX_PAGES = 10; 

// CONFIG: Specific Channel IDs to always import
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
  // 1. Check Files (Email/PDF links)
  if (match.files && match.files.length > 0) {
      const file = match.files[0];
      if (file.permalink) return file.permalink;
      if (file.url_private) return file.url_private;
  }
  // 2. Check Blocks
  if (match.blocks) {
      const rawBlocks = JSON.stringify(match.blocks);
      const blockMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
      if (blockMatch) return blockMatch[1];
  }
  // 3. Check Attachments
  if (match.attachments && match.attachments.length > 0) {
    const att = match.attachments[0];
    if (att.title_link) return att.title_link;
    if (att.from_url) return att.from_url;
  }
  // 4. Check Text
  const textLink = match.text ? match.text.match(/<(https?:\/\/[^|>]+)/) : null;
  if (textLink) return textLink[1];

  if (match.permalink) return match.permalink;

  // 5. Fallback Construction
  if (match.ts && match.channel) {
      const cleanTs = match.ts.replace('.', '');
      const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
      const teamId = match.team || 'T09SE32ER';
      return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${match.ts}`;
  }
  return "";
}

// --- API HELPERS ---

// FIX: Renamed to getUserInfo to match the calls below
async function getUserInfo(): Promise<{ id: string, name: string } | null> {
  try {
    if (!SLACK_TOKEN) throw new Error("Missing VITE_SLACK_TOKEN");
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    if (!data.ok) return null;
    return { id: data.user_id, name: data.user };
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
    if (!data.ok) return [];
    return data.messages.map((m: any) => ({
        ...m,
        channel: { id: channelId, name: PROJECT_MAP[channelId] || "Private Note" }
    }));
  } catch (e) { return []; }
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
  
  // Unique ID to prevent React duplicate key errors
  const uniqueId = `slack-${rawChannelId}-${msgId}`;

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

  // 1. ARCHETYPE: Email / File Forward
  if (match.files && match.files.length > 0) {
      const file = match.files[0];
      let fileTitle = file.title || file.name;
      
      // Prefer "plain_text" (Full Email Body)
      let bodyContent = "";
      if (file.plain_text) bodyContent = file.plain_text;
      else if (file.preview) bodyContent = file.preview;

      // Use content for title if main text is empty
      if (!title || title === "" || title === "[Shared an Image or File]") {
          title = `📧 ${fileTitle}`; 
          if (bodyContent) {
              const cleanBody = bodyContent.replace(/<http.*?>/g, '').substring(0, 300);
              title += `\n\n${cleanBody}...`;
          }
      }
      url = file.permalink || url;
  }

  // 2. ARCHETYPE: Google Drive Bot
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

  // 3. ARCHETYPE: Notion
  if (match.attachments && match.attachments.some((a: any) => a.service_name === 'Notion' || a.title?.includes('Notion'))) {
      provider = 'notion';
      const att = match.attachments[0];
      title = `📝 Notion: ${att.title}`;
  }

  if (title === "" || title === "📄 null") title = "[Shared an Image or File]";

  return {
    id: uniqueId,
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
export async function fetchSlackSignals(startDate?: Date, cachedTasks: UnifiedTask[] = []): Promise<UnifiedTask[]> {
  try {
    const userInfo = await getUserInfo();
    if (!userInfo) return [];

    // Query: to:@name (Primary) OR to:ID (Backup) OR <@ID> (Mentions)
    let queryString = `(to:@${userInfo.name} OR to:${userInfo.id} OR <@${userInfo.id}>)`;
    
    // NO DATE FILTER IN API (Vacuum Strategy)
    const encodedQuery = encodeURIComponent(queryString);
    
    let allMatches: any[] = [];
    let page = 1;

    console.log(`📥 Slack Query: ${queryString}`);

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

    // Add Extra Channels (History)
    const directHistoryPromises = EXTRA_CHANNELS.map(id => fetchChannelHistory(id, startDate));
    const directResults = await Promise.all(directHistoryPromises);
    const directMatches = directResults.flat();
    const combinedMatches = [...allMatches, ...directMatches];
    
    // Deduplicate
    const seenIds = new Set();
    const uniqueMatches = combinedMatches.filter(m => {
        if (seenIds.has(m.ts)) return false;
        seenIds.add(m.ts);
        return true;
    });

    console.log(`✅ Total Raw Messages: ${uniqueMatches.length}`);

    // Client-Side Filtering
    const filteredMatches = uniqueMatches.filter((match: any) => {
        const rawJson = JSON.stringify(match).toLowerCase();
        const msgDate = new Date(parseFloat(match.ts) * 1000);

        if (startDate && msgDate < startDate) return false;
        return true;
    });

    console.log(`✅ Filtered Messages: ${filteredMatches.length}`);

    // Smart Hydration (With Cache)
    const hydrateFn = async (match: any) => {
        const cached = cachedTasks.find(t => t.externalId === match.ts);
        if (cached) return cached;

        if ((!match.text || match.text === "") || (match.files && match.files.length > 0)) {
            const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
            const hydrated = await hydrateMessage(channelId, match.ts);
            if (hydrated) return parseMessage({ ...match, ...hydrated });
        }
        return parseMessage(match);
    };

    // Process sequentially or in small batches to avoid "Too Many Requests" locally
    // Simple Promise.all is usually fine for <100 items
    const rawMatches = await Promise.all(filteredMatches.map(hydrateFn));

    return rawMatches;

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
    // Reuse logic
    const tasks = await fetchSlackSignals(startDate);
    
    const richData = await Promise.all(tasks.map(async (task: any) => {
        // Reconstruct minimal object for AI
        return { 
            id: task.id, 
            mainMessage: { 
                text: task.title, // Contains full email body/subject 
                user: task.metadata.author 
            }, 
            thread: [], 
            source: 'slack',
            channelName: task.metadata.channel 
        };
    }));

    return richData;
  } catch (error) { return []; }
}