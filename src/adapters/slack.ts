import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';

// SECURE: Load from environment variable
const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;

const MAX_PAGES = 10; 

// CONFIG: Specific Channel IDs to always import (Bypasses Search)
const EXTRA_CHANNELS: string[] = ["C0A0JDYA3SR"];

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

  if (match.ts && match.channel) {
      const cleanTs = match.ts.replace('.', '');
      const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
      // Default Team ID if missing
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

// NEW: Fetch Real Channel Name (Dynamic)
async function getChannelName(channelId: string): Promise<string> {
    try {
        const response = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
        });
        const data = await response.json() as any;
        if (data.ok && data.channel) {
            return data.channel.name; // e.g. "ai-meeting-notes"
        }
        return channelId; // Fallback to ID if fetch fails
    } catch (e) {
        return channelId;
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
    if (!data.ok) {
        console.warn(`Failed to fetch history for ${channelId}: ${data.error}`);
        return [];
    }

    // FETCH NAME DYNAMICALLY
    const channelName = await getChannelName(channelId);

    return data.messages.map((m: any) => ({
        ...m,
        channel: { id: channelId, name: channelName } // Attach real name here
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
// Now takes a userMap to resolve names dynamically
function parseMessage(match: any, userMap: Record<string, any>, currentUserId: string): UnifiedTask {
  const msgId = match.ts.replace('.', '');
  
  const rawChannelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
  const rawChannelName = typeof match.channel === 'string' ? match.channel : (match.channel.name || match.channel.id);
  
  // Unique ID
  const uniqueId = `slack-${rawChannelId}-${msgId}`;

  // DYNAMIC PROJECT NAMING
  let project = `#${rawChannelName}`;

  // 1. Multi-Party DM (mpdm-...)
  if (rawChannelName.startsWith("mpdm-")) {
      try {
          // Clean up the ugly slug "mpdm-user1--user2-1"
          const cleanStr = rawChannelName.replace(/^mpdm-/, '').replace(/-\d+$/, '');
          const userHandles = cleanStr.split('--');
          
          // Map handles to Real Names
          const names = userHandles
            .map((handle: string) => {
                const user = Object.values(userMap).find((u: any) => u.name === handle);
                return user ? user.real_name.split(' ')[0] : handle; 
            })
            .filter((n: string) => n.toLowerCase() !== userMap[currentUserId]?.name); // Remove 'You'

          project = `DM: ${names.join(", ")}`;
      } catch (e) { project = "Group Message"; }
  }
  // 2. Direct Message (D...)
  else if (match.channel.is_im || rawChannelId.startsWith("D")) {
      if (userMap[rawChannelName]) {
          project = `DM: ${userMap[rawChannelName].real_name}`;
      } else if (rawChannelName.startsWith("D")) {
           project = "Direct Message"; 
      }
  }
  // 3. Public/Private Channel
  else {
      project = `#${rawChannelName}`;
  }

  let title = cleanSlackText(match.text);
  let author = match.username || match.user || "Unknown";
  
  // Resolve Author Name
  if (userMap[author]) {
      author = userMap[author].real_name;
  }

  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  if (url.includes("docs.google.com") || url.includes("drive.google.com")) provider = 'gdrive';

  // 1. ARCHETYPE: Email / File Forward
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

// --- HELPER: Fetch User Map for Name Resolution ---
async function getWorkspaceUsers(): Promise<Record<string, any>> {
    try {
        const response = await fetch('https://slack.com/api/users.list', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
        });
        const data = await response.json() as any;
        if (!data.ok) return {};

        const map: Record<string, any> = {};
        data.members.forEach((u: any) => {
            map[u.id] = { name: u.name, real_name: u.real_name || u.name };
        });
        return map;
    } catch (e) { return {}; }
}

// ---------------------------------------------------------
// EXPORT 1: Main Fetcher
// ---------------------------------------------------------
export async function fetchSlackSignals(startDate?: Date, endDate?: Date): Promise<UnifiedTask[]> {
  try {
    // 1. Parallel Prep: User Info + Workspace Users + Extra Channels
    const [userInfo, userMap] = await Promise.all([
        getUserInfo(),
        getWorkspaceUsers()
    ]);

    if (!userInfo) return [];

    const searchPromise = (async () => {
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
        return allMatches;
    })();

    // 2. Parallel History Fetch (Now includes dynamic name resolution inside)
    const directHistoryPromises = EXTRA_CHANNELS.map(id => fetchChannelHistory(id, startDate));
    const [searchResults, ...directResults] = await Promise.all([searchPromise, ...directHistoryPromises]);
    
    const directMatches = directResults.flat();
    const combinedMatches = [...searchResults, ...directMatches];
    
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
        if (match.channel && match.channel.name && match.channel.name.toLowerCase().startsWith("fun")) return false;

        return true;
    });

    const rawMatches = await Promise.all(filteredMatches.map(async (match: any) => {
      if ((!match.text || match.text === "") || (match.files && match.files.length > 0)) {
        const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
        const hydrated = await hydrateMessage(channelId, match.ts);
        if (hydrated) return { ...match, ...hydrated };
      }
      return match;
    }));

    // Pass userMap to parser
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