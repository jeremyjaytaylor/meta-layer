import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask, SlackContext, SlackUser, SlackChannel } from '../types/unified';

const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;
const MAX_PAGES = 10; 

// --- 1. CLEANING & EXTRACTION UTILITIES ---

function cleanSlackText(text: string, context?: SlackContext): string {
  if (!text) return "";
  
  let cleaned = text
    .replace(/&gt;/g, '')    
    .replace(/&lt;/g, '<')   
    .replace(/&amp;/g, '&')
    .replace(/<http.*?>/g, '')     
    .replace(/\s+/g, ' ');

  // Feature: Resolve <@U123> tags to readable names using the Context
  if (context) {
    cleaned = cleaned.replace(/<@(U[A-Z0-9]+)>/g, (_, userId) => {
      const user = context.userMap[userId];
      return user ? `@${user.real_name}` : `@${userId}`;
    });
  } else {
    cleaned = cleaned.replace(/<@.*?>/g, '');
  }

  return cleaned.trim();
}

function extractLink(match: any): string {
  // Check Files, Blocks, and Attachments for the "real" URL
  if (match.files?.[0]) return match.files[0].permalink || match.files[0].url_private || "";
  
  if (match.blocks) {
      const rawBlocks = JSON.stringify(match.blocks);
      const blockMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
      if (blockMatch) return blockMatch[1];
  }
  
  const textLink = match.text ? match.text.match(/<(https?:\/\/[^|>]+)/) : null;
  if (textLink) return textLink[1];

  if (match.permalink) return match.permalink;

  // Fallback: Construct a deep link
  if (match.ts && match.channel) {
      const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
      return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${match.ts}`;
  }
  return "";
}

// --- 2. THE REFERENCE STORE BUILDER (Fixes the "ID instead of Name" bug) ---

async function fetchAllPages(url: string, limit = 1000): Promise<any[]> {
  let allItems: any[] = [];
  let nextCursor: string | undefined;
  
  try {
    do {
      const cursorParam = nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : '';
      const response = await fetch(`${url}&limit=${limit}${cursorParam}`, {
        headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
      });
      const data = await response.json() as any;
      
      if (!data.ok) break;
      
      // Slack returns data in different keys ('members' for users, 'channels' for conversations)
      const items = data.members || data.channels || [];
      allItems = [...allItems, ...items];
      
      nextCursor = data.response_metadata?.next_cursor;
    } while (nextCursor);
  } catch (e) {
    console.error("Pagination Fetch Error:", e);
  }
  
  return allItems;
}

export async function buildSlackContext(): Promise<SlackContext> {
  if (!SLACK_TOKEN) throw new Error("Missing VITE_SLACK_TOKEN");

  // A. Fetch "Self" (to identify 'Me' in DMs)
  let selfId = "";
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    if (data.ok) selfId = data.user_id;
  } catch (e) { console.error("Auth Test Failed", e); }

  // B. Fetch All Users
  const userMap: Record<string, SlackUser> = {};
  const users = await fetchAllPages('https://slack.com/api/users.list?');
  
  users.forEach((u: any) => {
    userMap[u.id] = {
      id: u.id,
      name: u.name, // The "handle"
      real_name: u.real_name || u.name, // The human name
      is_bot: u.is_bot || false
    };
  });

  // C. Fetch All Channels (Public, Private, DMs, Group DMs)
  // types argument ensures we get EVERYTHING
  const channelMap: Record<string, SlackChannel> = {};
  const channels = await fetchAllPages('https://slack.com/api/conversations.list?types=public_channel,private_channel,mpim,im');

  channels.forEach((c: any) => {
    channelMap[c.id] = {
      id: c.id,
      name: c.name || "", 
      is_channel: !!c.is_channel,
      is_im: c.is_im || false,
      is_mpim: c.is_mpim || false,
      user_id: c.user // For single DMs, this is the other person's ID
    };
  });

  return { userMap, channelMap, selfId };
}

// --- 3. INTELLIGENT PARSER ---

function resolveSourceLabel(channelId: string, context: SlackContext): string {
  const channel = context.channelMap[channelId];
  
  // Case 0: Unknown ID (Cache Miss)
  if (!channel) return channelId; 

  // Case 1: Single DM -> "DM: Jeremy Taylor"
  if (channel.is_im && channel.user_id) {
    const otherUser = context.userMap[channel.user_id];
    return otherUser ? `DM: ${otherUser.real_name}` : "DM: Unknown User";
  }

  // Case 2: Group DM -> "DM: Alice, Bob, Charlie"
  // Slack MPIM names are often "mpdm-alice-bob-charlie-123". We parse this.
  if (channel.is_mpim && channel.name) {
    try {
      const cleanStr = channel.name.replace(/^mpdm-/, '').replace(/-\d+$/, '');
      const handles = cleanStr.split('--'); // Handles are separated by double dashes
      
      // Map handles back to Real Names using the UserMap
      const realNames = handles.map(handle => {
        // Inefficient lookup but acceptable for small MPIM lists
        const user = Object.values(context.userMap).find(u => u.name === handle);
        return user ? user.real_name.split(' ')[0] : handle; 
      });
      
      return `DM: ${realNames.join(", ")}`;
    } catch (e) {
      return "Group DM";
    }
  }

  // Case 3: Standard Channel -> "#general"
  if (channel.name) return `#${channel.name}`;

  return channelId;
}

function parseMessage(match: any, context: SlackContext): UnifiedTask {
  const msgId = match.ts.replace('.', '');
  const rawChannelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
  
  // 1. Resolve The Source Label (The Fix)
  const sourceLabel = resolveSourceLabel(rawChannelId, context);
  const sourceType = sourceLabel.startsWith("DM:") ? 'dm' : 'channel';

  // 2. Resolve Author
  const userId = match.user || match.username;
  let author = userId;
  if (context.userMap[userId]) {
    author = context.userMap[userId].real_name;
  }

  // 3. Construct ID
  const uniqueId = `slack-${rawChannelId}-${msgId}`;

  // 4. Determine Provider/Title
  let title = cleanSlackText(match.text, context);
  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  // Heuristics for Provider Detection
  if (url.includes("docs.google.com") || url.includes("drive.google.com")) provider = 'gdrive';
  
  // Handle Files/Bots
  if (match.files?.[0]) {
      const f = match.files[0];
      const fileTitle = f.title || f.name;
      title = `📧 ${fileTitle}`; 
      url = f.permalink || url;
  }

  if (match.username === "google drive" || match.bot_profile?.name === "Google Drive") {
    if (url.includes("google.com")) provider = 'gdrive';
    // Try to grab document title from blocks
    const blockMatch = JSON.stringify(match.blocks || []).match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
    if (blockMatch) title = `📄 ${blockMatch[2]}`;
  }

  if (match.attachments?.some((a:any) => a.service_name === 'Notion')) {
      provider = 'notion';
      title = `📝 Notion: ${match.attachments[0].title}`;
  }

  if (!title) title = "[Shared an Image or File]";

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
      sourceLabel: sourceLabel, // Now contains "#general" or "DM: Alice, Bob"
      sourceType: sourceType
    }
  };
}

// --- 4. MAIN FETCHERS ---

export async function fetchSlackSignals(
  context: SlackContext, 
  startDate?: Date, 
  endDate?: Date
): Promise<UnifiedTask[]> {
  try {
    if (!context.selfId) return [];

    // Search specifically for messages TO the user
    // We can later add "OR in:channel_id" for monitored channels
    let queryString = `to:@${context.userMap[context.selfId]?.name || 'me'}`;
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

    console.log(`✅ Fetched ${allMatches.length} raw messages`);

    // Client-side filtering
    const filteredMatches = allMatches.filter((match: any) => {
        const msgDate = new Date(parseFloat(match.ts) * 1000);
        if (startDate && msgDate < startDate) return false;
        if (endDate && msgDate > endDate) return false; 
        if (match.username === 'asana') return false; // Filter noise
        return true;
    });

    // Parse using the FULL Context
    return filteredMatches.map(m => parseMessage(m, context));

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}

// Required for the Synthesize button
export async function fetchRichSignals(
  context: SlackContext,
  startDate?: Date, 
  endDate?: Date
): Promise<any[]> {
  try {
    const tasks = await fetchSlackSignals(context, startDate, endDate);
    return tasks.map(task => ({
        id: task.id, 
        mainMessage: { 
            text: task.title, 
            user: task.metadata.author 
        }, 
        thread: [], 
        source: 'slack',
        channelName: task.metadata.sourceLabel 
    }));
  } catch (error) { return []; }
}