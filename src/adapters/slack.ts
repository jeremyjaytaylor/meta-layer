import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask, SlackContext, SlackUser, SlackChannel } from '../types/unified';

const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;
const MAX_PAGES = 10;
const MAX_ITEMS_PER_FETCH = 1000; // Prevent unbounded memory growth

// Validate token early
if (!SLACK_TOKEN) {
  throw new Error("VITE_SLACK_TOKEN environment variable is not set. Please configure it in your .env file.");
}

// --- 1. CLEANING & EXTRACTION UTILITIES ---

function cleanSlackText(text: string, context?: SlackContext): string {
  if (!text || typeof text !== 'string') return "";
  
  let cleaned = text;

  // 1. Resolve User Mentions: <@U12345> or <@U12345|bob>
  cleaned = cleaned.replace(/<@(U[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, userId, label) => {
    if (context && context.userMap && context.userMap[userId]) {
      return `@${context.userMap[userId].real_name}`;
    }
    return label ? `@${label}` : `@UnknownUser`;
  });

  // 2. Resolve User Groups: <!subteam^S12345> or <!subteam^S12345|@engineering>
  cleaned = cleaned.replace(/<!subteam\^(S[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, groupId, label) => {
    if (context && context.groupMap && context.groupMap[groupId]) {
      return `@${context.groupMap[groupId]}`;
    }
    return label ? `${label}` : `@UnknownGroup`;
  });

  // 3. Resolve Special Mentions: <!here>, <!channel>, <!everyone>
  cleaned = cleaned.replace(/<!(here|channel|everyone)(?:\|([^>]+))?>/g, (_, type) => {
    return `@${type}`;
  });

  // 4. Clean formatting and links - PRESERVE TEXT LINKS
  cleaned = cleaned
    .replace(/&gt;/g, '>')    
    .replace(/&lt;/g, '<')   
    .replace(/&amp;/g, '&')
    .replace(/<(https?:\/\/[^|]+)\|([^>]+)>/g, '$2') // <link|text> -> text (preserve text)
    .replace(/<(https?:\/\/[^>]+)>/g, '$1') // <link> -> link (preserve URL)
    .replace(/\s+/g, ' ');

  return cleaned.trim();
}

function extractLink(match: any): string {
  // Try files first
  if (match.files && Array.isArray(match.files) && match.files.length > 0) {
    return match.files[0].permalink || match.files[0].url_private || "";
  }
  
  // Try blocks for Google Docs
  if (match.blocks && Array.isArray(match.blocks)) {
      const rawBlocks = JSON.stringify(match.blocks);
      const blockMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
      if (blockMatch) return blockMatch[1];
  }
  
  // Try text for links
  if (match.text && typeof match.text === 'string') {
    const textLink = match.text.match(/<(https?:\/\/[^|>]+)/);
    if (textLink) return textLink[1];
  }

  // Try permalink
  if (match.permalink && typeof match.permalink === 'string') {
    return match.permalink;
  }

  // Generate Slack link
  if (match.ts && match.channel) {
      const channelId = typeof match.channel === 'string' ? match.channel : match.channel?.id;
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
  let pageCount = 0;
  
  try {
    do {
      if (pageCount >= MAX_PAGES) break; // Enforce max pages
      
      const cursorParam = nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : '';
      const separator = url.includes('?') ? '&' : '?';
      const response = await fetch(`${url}${separator}limit=${Math.min(limit, 1000)}${cursorParam}`, {
        headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` }
      });
      
      if (!response.ok) {
        console.error(`API request failed with status ${response.status}`);
        break;
      }

      const data = await response.json() as any;
      
      if (!data.ok) {
        if (data.error === 'missing_scope') {
            console.error(`🚨 PERMISSION ERROR: Missing scope for ${url}`);
        } else {
            console.warn(`⚠️ Slack API Error (${url}):`, data.error);
        }
        break;
      }
      
      // Handle different list types
      const items = data.members || data.channels || data.usergroups || [];
      if (Array.isArray(items)) {
        allItems = [...allItems, ...items];
      }
      
      if (allItems.length >= MAX_ITEMS_PER_FETCH) {
        allItems = allItems.slice(0, MAX_ITEMS_PER_FETCH);
        break;
      }
      
      nextCursor = data.response_metadata?.next_cursor;
      if (nextCursor) await new Promise(r => setTimeout(r, 200));
      
      pageCount++;
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
    if (data.ok && data.user_id) selfId = data.user_id;
  } catch (e) { 
    console.error("Auth Check Failed", e); 
  }

  // 1. Fetch Users
  const userMap: Record<string, SlackUser> = {};
  const users = await fetchAllPages('https://slack.com/api/users.list');
  users.forEach((u: any) => {
    if (u.id && u.name) {
      userMap[u.id] = {
        id: u.id,
        name: u.name, 
        real_name: u.real_name || u.name, 
        is_bot: u.is_bot || false
      };
    }
  });

  // 2. Fetch User Groups
  const groupMap: Record<string, string> = {};
  try {
    const groups = await fetchAllPages('https://slack.com/api/usergroups.list?include_disabled=false');
    groups.forEach((g: any) => {
        if (g.id && (g.handle || g.name)) {
          groupMap[g.id] = g.handle || g.name;
        }
    });
  } catch (e) { 
    console.warn("Could not fetch user groups (scope: usergroups:read might be missing)"); 
  }

  // 3. Fetch Channels
  const channelMap: Record<string, SlackChannel> = {};
  
  try {
    const [publicCh, privateCh, mpims, ims] = await Promise.all([
      fetchAllPages('https://slack.com/api/conversations.list?types=public_channel'),
      fetchAllPages('https://slack.com/api/conversations.list?types=private_channel'),
      fetchAllPages('https://slack.com/api/conversations.list?types=mpim'),
      fetchAllPages('https://slack.com/api/conversations.list?types=im')
    ]);

    const allChannels = [...publicCh, ...privateCh, ...mpims, ...ims];

    allChannels.forEach((c: any) => {
      if (!c.id) return;
      if (c.is_archived) return; // Skip archived

      channelMap[c.id] = {
        id: c.id,
        name: c.name || "", 
        is_channel: !!c.is_channel,
        is_im: c.is_im || false,
        is_mpim: c.is_mpim || false,
        user_id: c.user 
      };
    });
  } catch (e) {
    console.error("Failed to fetch channels:", e);
  }

  console.log(`✅ Context Built: ${Object.keys(userMap).length} users, ${Object.keys(groupMap).length} groups, ${Object.keys(channelMap).length} channels.`);
  return { userMap, channelMap, groupMap, selfId };
}

// --- 3. INTELLIGENT PARSER ---

function parseGroupDmName(rawName: string, context: SlackContext): string {
  try {
    if (!rawName || typeof rawName !== 'string') return "Group Message";
    
    const cleanStr = rawName.replace(/^mpdm-/, '').replace(/-\d+$/, '');
    const handles = cleanStr.split('--');
    
    const names = handles.map(handle => {
        const user = Object.values(context.userMap).find(u => u.name === handle);
        return user ? user.real_name.split(' ')[0] : handle; 
    });

    return `DM: ${names.join(", ")}`;
  } catch (e) {
    console.error("Error parsing group DM name:", e);
    return "Group Message";
  }
}

function resolveSourceLabel(match: any, context: SlackContext): string {
  const channelObj = match.channel;
  if (!channelObj) return "Unknown Source";

  const channelId = typeof channelObj === 'string' ? channelObj : channelObj?.id;
  
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

  if (channelObj.name && typeof channelObj.name === 'string' && channelObj.name !== channelId) {
      const name = channelObj.name;
      if (name.startsWith("mpdm-")) return parseGroupDmName(name, context);
      const isId = /^[A-Z][A-Z0-9]{8,12}$/.test(name);
      if (!isId) return `#${name}`;
  }

  return channelId || "Unknown Channel";
}

function parseMessage(match: any, context: SlackContext): UnifiedTask {
  if (!match.ts) {
    console.warn("Message missing timestamp");
    return null as any;
  }

  const msgId = match.ts.replace('.', '');
  
  const channelObj = match.channel;
  const rawChannelId = typeof channelObj === 'string' ? channelObj : (channelObj?.id || "unknown");
  
  const sourceLabel = resolveSourceLabel(match, context) || "Unknown Source";
  const sourceType = sourceLabel.startsWith("DM:") ? 'dm' : 'channel';

  const userId = match.user || match.username;
  let author = userId || "Unknown";
  if (userId && context.userMap[userId]) {
    author = context.userMap[userId].real_name;
  }

  const uniqueId = `slack-${rawChannelId}-${msgId}`;
  
  let title = cleanSlackText(match.text, context);
  
  let provider: 'slack' | 'gdrive' | 'notion' = 'slack';
  let url = extractLink(match);

  if (url.includes("docs.google.com") || url.includes("drive.google.com")) provider = 'gdrive';
  
  if (match.files && Array.isArray(match.files) && match.files.length > 0) {
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

  if (match.attachments && Array.isArray(match.attachments) && match.attachments.some((a:any) => a.service_name === 'Notion')) {
      provider = 'notion';
      title = `📝 Notion: ${match.attachments[0].title || 'Document'}`;
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
    if (!context.selfId) {
      console.error("No selfId in context");
      return [];
    }

    let queryString = `*`;
    const encodedQuery = encodeURIComponent(queryString);
    
    let allMatches: any[] = [];
    let page = 1;

    console.log(`📥 Slack Query: ${queryString}`);

    while (page <= MAX_PAGES) {
        const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=100&page=${page}`, {
            headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
        });

        if (!response.ok) {
          console.error(`API error on page ${page}: ${response.status}`);
          break;
        }

        const data = await response.json() as any;
        if (!data.ok || !data.messages || !data.messages.matches) break;

        allMatches = [...allMatches, ...data.messages.matches];
        if (page >= (data.messages.paging?.pages || 1)) break;
        page++;
    }

    const now = new Date();
    const defaultEnd = endDate || now;
    const defaultStart = startDate || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Default 7 days

    const filteredMatches = allMatches.filter((match: any) => {
        if (!match.ts) return false;
        
        try {
          const msgDate = new Date(parseFloat(match.ts) * 1000);
          if (defaultStart && msgDate < defaultStart) return false;
          if (defaultEnd && msgDate > defaultEnd) return false;
        } catch {
          return false;
        }
        
        if (match.username === 'asana') return false; 
        
        const channelId = typeof match.channel === 'string' ? match.channel : match.channel?.id;
        if (channelId && !context.channelMap[channelId]) {
            return false;
        }

        return true;
    });

    return filteredMatches
      .map(m => parseMessage(m, context))
      .filter((task): task is UnifiedTask => task !== null);

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
  } catch (error) { 
    console.error("fetchRichSignals error:", error);
    return []; 
  }
}
