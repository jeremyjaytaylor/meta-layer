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

  if (context && Object.keys(context.userMap).length > 0) {
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
  if (match.files?.[0]) return match.files[0].permalink || match.files[0].url_private || "";
  
  if (match.blocks) {
      const rawBlocks = JSON.stringify(match.blocks);
      const blockMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
      if (blockMatch) return blockMatch[1];
  }
  
  const textLink = match.text ? match.text.match(/<(https?:\/\/[^|>]+)/) : null;
  if (textLink) return textLink[1];

  if (match.permalink) return match.permalink;

  if (match.ts && match.channel) {
      const channelId = typeof match.channel === 'string' ? match.channel : match.channel.id;
      if (channelId) {
        return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${match.ts}`;
      }
  }
  return "";
}

// --- 2. ROBUST REFERENCE STORE BUILDER ---

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
      
      if (!data.ok) {
        if (data.error === 'missing_scope') {
            console.error(`🚨 PERMISSION ERROR: Your Slack Token is missing required scopes.`);
            console.error(`👉 Please add: channels:read, groups:read, im:read, mpim:read to 'User Token Scopes' in your Slack App settings.`);
        } else {
            console.warn(`⚠️ Slack API Error (${url}):`, data.error);
        }
        break;
      }
      
      const items = data.members || data.channels || [];
      allItems = [...allItems, ...items];
      
      nextCursor = data.response_metadata?.next_cursor;
      if (nextCursor) await new Promise(r => setTimeout(r, 200));

    } while (nextCursor);
  } catch (e) {
    console.error("Fetch Error:", e);
  }
  
  return allItems;
}

export async function buildSlackContext(): Promise<SlackContext> {
  if (!SLACK_TOKEN) throw new Error("Missing VITE_SLACK_TOKEN");

  let selfId = "";
  try {
    const response = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
    });
    const data = await response.json() as any;
    if (data.ok) selfId = data.user_id;
  } catch (e) { console.error("Auth Check Failed", e); }

  // 1. Fetch Users
  const userMap: Record<string, SlackUser> = {};
  const users = await fetchAllPages('https://slack.com/api/users.list?');
  users.forEach((u: any) => {
    userMap[u.id] = {
      id: u.id,
      name: u.name, 
      real_name: u.real_name || u.name, 
      is_bot: u.is_bot || false
    };
  });

  // 2. Fetch Channels (SPLIT STRATEGY)
  const channelMap: Record<string, SlackChannel> = {};
  
  const [publicCh, privateCh, mpims, ims] = await Promise.all([
    fetchAllPages('https://slack.com/api/conversations.list?types=public_channel'),
    fetchAllPages('https://slack.com/api/conversations.list?types=private_channel'),
    fetchAllPages('https://slack.com/api/conversations.list?types=mpim'),
    fetchAllPages('https://slack.com/api/conversations.list?types=im')
  ]);

  const allChannels = [...publicCh, ...privateCh, ...mpims, ...ims];

  allChannels.forEach((c: any) => {
    channelMap[c.id] = {
      id: c.id,
      name: c.name || "", 
      is_channel: !!c.is_channel,
      is_im: c.is_im || false,
      is_mpim: c.is_mpim || false,
      user_id: c.user 
    };
  });

  console.log(`✅ Context Built: ${Object.keys(userMap).length} users, ${Object.keys(channelMap).length} channels/DMs.`);
  return { userMap, channelMap, selfId };
}

// --- 3. INTELLIGENT PARSER ---

function parseGroupDmName(rawName: string, context: SlackContext): string {
  try {
    // rawName format: mpdm-user1--user2--user3-1
    const cleanStr = rawName.replace(/^mpdm-/, '').replace(/-\d+$/, '');
    const handles = cleanStr.split('--');
    
    const names = handles.map(handle => {
        const user = Object.values(context.userMap).find(u => u.name === handle);
        return user ? user.real_name.split(' ')[0] : handle; 
    });

    return `DM: ${names.join(", ")}`;
  } catch (e) {
    return "Group Message";
  }
}

function resolveSourceLabel(match: any, context: SlackContext): string {
  const channelObj = match.channel;
  if (!channelObj) return "Unknown Source";

  const channelId = typeof channelObj === 'string' ? channelObj : channelObj.id;
  
  // STRATEGY 1: Use Reference Map (Source of Truth)
  const channel = context.channelMap[channelId];
  if (channel) {
    if (channel.is_im && channel.user_id) {
      const otherUser = context.userMap[channel.user_id];
      return otherUser ? `DM: ${otherUser.real_name}` : "DM: Unknown User";
    }
    if (channel.is_mpim) {
       return channel.name ? parseGroupDmName(channel.name, context) : "Group Message";
    }
    if (channel.name) return `#${channel.name}`;
  }

  // STRATEGY 2: Fail-Safe (Use Name from Search Result if available)
  if (channelObj.name && channelObj.name !== channelId) {
      const name = channelObj.name;
      if (name.startsWith("mpdm-")) return parseGroupDmName(name, context);
      
      // Better regex to ignore raw IDs (e.g. C024..., G051..., D02...)
      // Standard Slack IDs are uppercase alphanumeric, ~9-11 chars
      const isId = /^[A-Z][A-Z0-9]{8,12}$/.test(name);
      
      if (!isId) return `#${name}`;
  }

  return channelId || "Unknown Channel";
}

function parseMessage(match: any, context: SlackContext): UnifiedTask {
  const msgId = match.ts ? match.ts.replace('.', '') : Math.random().toString(36).substr(2, 9);
  
  const channelObj = match.channel;
  const rawChannelId = typeof channelObj === 'string' ? channelObj : (channelObj?.id || "unknown");
  
  const sourceLabel = resolveSourceLabel(match, context) || "Unknown Source";
  const sourceType = sourceLabel.startsWith("DM:") ? 'dm' : 'channel';

  const userId = match.user || match.username;
  let author = userId || "Unknown";
  if (context.userMap[userId]) {
    author = context.userMap[userId].real_name;
  }

  const uniqueId = `slack-${rawChannelId}-${msgId}`;
  let title = cleanSlackText(match.text, context);
  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  if (url.includes("docs.google.com") || url.includes("drive.google.com")) provider = 'gdrive';
  
  if (match.files?.[0]) {
      const f = match.files[0];
      const fileTitle = f.title || f.name;
      title = `📧 ${fileTitle}`; 
      url = f.permalink || url;
  }

  if (match.username === "google drive" || match.bot_profile?.name === "Google Drive") {
    if (url.includes("google.com")) provider = 'gdrive';
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
      sourceLabel: sourceLabel,
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

    const filteredMatches = allMatches.filter((match: any) => {
        if (!match.ts) return false;
        const msgDate = new Date(parseFloat(match.ts) * 1000);
        if (startDate && msgDate < startDate) return false;
        if (endDate && msgDate > endDate) return false; 
        if (match.username === 'asana') return false; 
        return true;
    });

    return filteredMatches.map(m => parseMessage(m, context));

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}

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