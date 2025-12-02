import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

// SECURE: Load from environment variable
const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;

const MAX_PAGES = 10; 

// CONFIG: Specific Channel IDs to always import
// NOTE: In a future multi-user version, this list should come from LocalStorage/Settings
const EXTRA_CHANNELS: string[] = ["C0A0JDYA3SR"];

// Type for our User Phonebook
type UserMap = Record<string, { name: string; real_name: string }>;

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
  if (match.files && match.files.length > 0) {
      const file = match.files[0];
      if (file.permalink) return file.permalink;
      if (file.url_private) return file.url_private;
  }
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
      const teamId = match.team || 'T09SE32ER';
      return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${match.ts}`;
  }
  return "";
}

// --- API HELPERS ---

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

// NEW: Fetch all users to create a "Phonebook" (Map ID -> Name)
async function getWorkspaceUsers(): Promise<UserMap> {
    try {
        const response = await fetch('https://slack.com/api/users.list', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
        });
        const data = await response.json() as any;
        if (!data.ok) return {};

        const map: UserMap = {};
        data.members.forEach((u: any) => {
            map[u.id] = { 
                name: u.name, // Handle (e.g. "jeremy")
                real_name: u.real_name || u.name // Display Name (e.g. "Jeremy Taylor")
            };
        });
        return map;
    } catch (e) {
        console.error("Failed to fetch users", e);
        return {};
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
    
    // We attach the ID here, the parser will resolve the Name later
    return data.messages.map((m: any) => ({
        ...m,
        channel: { id: channelId, name: channelId } 
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

// --- PARSER (Now Dynamic!) ---
function parseMessage(match: any, userMap: UserMap, currentUserId: string): UnifiedTask {
  const msgId = match.ts.replace('.', '');
  
  // Normalize Channel Info
  const rawChannelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
  const rawChannelName = typeof match.channel === 'string' ? match.channel : (match.channel.name || match.channel.id);
  
  const uniqueId = `slack-${rawChannelId}-${msgId}`;

  // --- DYNAMIC CHANNEL NAMING LOGIC ---
  let project = `#${rawChannelName}`; // Default

  // 1. Multi-Party DM (mpdm-user1--user2...)
  if (rawChannelName.startsWith("mpdm-")) {
      try {
          // Remove prefix and trailing numbers
          const cleanStr = rawChannelName.replace(/^mpdm-/, '').replace(/-\d+$/, '');
          const userHandles = cleanStr.split('--');
          
          // Convert handles to Real Names
          const names = userHandles
            .map((handle: string) => {
                // Find user by handle (inefficient scan, but robust)
                const user = Object.values(userMap).find(u => u.name === handle);
                return user ? user.real_name.split(' ')[0] : handle; // First name only
            })
            .filter((n: string) => n.toLowerCase() !== userMap[currentUserId]?.name); // Remove 'You'

          project = `DM: ${names.join(", ")}`;
      } catch (e) { project = "Group Message"; }
  }
  // 2. Direct Message (Channel ID starts with D or name is a User ID)
  else if (match.channel.is_im || rawChannelName.startsWith("U") || rawChannelName.startsWith("D")) {
      // If name is a User ID (e.g. U06...), lookup the name
      if (userMap[rawChannelName]) {
          project = `DM: ${userMap[rawChannelName].real_name}`;
      } else if (rawChannelName.startsWith("D")) {
           project = "Direct Message"; // Fallback if we can't resolve ID
      }
  }
  // 3. Public Channel
  else {
      project = `#${rawChannelName}`;
  }

  let title = cleanSlackText(match.text);
  let author = match.username || match.user || "Unknown";
  // Resolve Author Name if it's an ID
  if (userMap[author]) {
      author = userMap[author].real_name;
  }

  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  if (url.includes("docs.google.com") || url.includes("drive.google.com")) provider = 'gdrive';

  // 1. Email / File
  if (match.files && match.files.length > 0) {
      const file = match.files[0];
      let fileTitle = file.title || file.name;
      let bodyContent = "";
      if (file.plain_text) bodyContent = file.plain_text;
      else if (file.preview) bodyContent = file.preview;

      if (bodyContent) {
          const cleanBody = bodyContent.replace(/<http.*?>/g, '').substring(0, 300);
          fileTitle += `\n\n${cleanBody}...`;
      }
      if (!title || title === "" || title === "[Shared an Image or File]") {
          title = `📧 ${fileTitle}`; 
      }
      url = file.permalink || url;
  }

  // 2. GDrive Bot
  if (match.username === "google drive" || (match.text === "" && (match.attachments || match.blocks))) {
    provider = 'gdrive'; 
    if (match.blocks) {
        const rawBlocks = JSON.stringify(match.blocks);
        const docMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
        if (docMatch) title = `📄 ${docMatch[2]}`;
        
        for (const block of match.blocks) {
            if (block.elements) {
                for (const el of block.elements) {
                    const textVal = (typeof el.text === 'string') ? el.text : (el.text?.text || "");
                    if (textVal && !textVal.includes("docs.google.com") && !textVal.includes("marked a thread")) {
                         const clean = cleanSlackText(textVal);
                         if (clean.length > 2) title += `: "${clean}"`;
                    }
                    if (el.elements) {
                         for (const subEl of el.elements) {
                             const subVal = (typeof subEl.text === 'string') ? subEl.text : (subEl.text?.text || "");
                             if (subVal) {
                                 const clean = cleanSlackText(subVal);
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

  // 3. Notion
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
      channel: project, // Dynamic Project Name!
      type: match.channel?.is_im ? 'dm' : 'mention'
    }
  };
}

// ---------------------------------------------------------
// EXPORT 1: Main Fetcher (List View)
// ---------------------------------------------------------
export async function fetchSlackSignals(startDate?: Date, endDate?: Date): Promise<UnifiedTask[]> {
  try {
    // 1. Get Info & User Map (Parallel)
    const [userInfo, userMap] = await Promise.all([
        getUserInfo(),
        getWorkspaceUsers()
    ]);
    
    if (!userInfo) return [];

    let queryString = `to:@${userInfo.name}`;
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

    const directHistoryPromises = EXTRA_CHANNELS.map(id => fetchChannelHistory(id, startDate));
    const [directResults] = await Promise.all([Promise.all(directHistoryPromises)]);
    const directMatches = directResults.flat();
    const combinedMatches = [...allMatches, ...directMatches];
    
    const seenKeys = new Set();
    const uniqueMatches = combinedMatches.filter(m => {
        const chId = typeof m.channel === 'string' ? m.channel : m.channel.id;
        const key = `${chId}-${m.ts}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
    });

    console.log(`✅ Total Raw Messages: ${uniqueMatches.length}`);

    const filteredMatches = uniqueMatches.filter((match: any) => {
        const rawJson = JSON.stringify(match).toLowerCase();
        const msgDate = new Date(parseFloat(match.ts) * 1000);

        if (startDate && msgDate < startDate) return false;
        if (endDate && msgDate > endDate) return false; 
        if (match.username === 'asana') return false;
        if (rawJson.includes("marked a thread as resolved")) return false;
        
        // Dynamic Fun Filter (check startsWith)
        const chName = match.channel?.name || "";
        if (chName.toLowerCase().startsWith("fun")) return false;

        return true;
    });

    console.log(`✅ Filtered Messages: ${filteredMatches.length}`);

    const rawMatches = await Promise.all(filteredMatches.map(async (match: any) => {
      if ((!match.text || match.text === "") || (match.files && match.files.length > 0)) {
        const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
        const hydrated = await hydrateMessage(channelId, match.ts);
        if (hydrated) return { ...match, ...hydrated };
      }
      return match;
    }));

    // Pass userMap to parser for dynamic naming
    return rawMatches.map(m => parseMessage(m, userMap, userInfo.id));

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}

// ---------------------------------------------------------
// EXPORT 2: Rich Fetcher (Synthesis)
// ---------------------------------------------------------
export async function fetchRichSignals(startDate?: Date, endDate?: Date): Promise<any[]> {
  try {
    // Reuse same logic
    const tasks = await fetchSlackSignals(startDate, endDate);
    return tasks.map(task => ({
        id: task.id, 
        mainMessage: { 
            text: task.title, 
            user: task.metadata.author 
        }, 
        thread: [], 
        source: 'slack',
        channelName: task.metadata.channel 
    }));
  } catch (error) { return []; }
}
