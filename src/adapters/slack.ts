import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask, SlackContext, SlackUser, SlackChannel } from '../types/unified';
import { downloadAndParseFile } from './fileParser';
import { generateFileSummary } from './gemini';

const SLACK_TOKEN = import.meta.env.VITE_SLACK_TOKEN;
const MAX_PAGES = 10;
const MAX_ITEMS_PER_FETCH = 1000;

if (!SLACK_TOKEN) {
  throw new Error("VITE_SLACK_TOKEN environment variable is not set. Please configure it in your .env file.");
}

// --- 1. CLEANING & EXTRACTION UTILITIES ---

function cleanSlackText(text: string, context?: SlackContext): string {
  if (!text || typeof text !== 'string') return "";
  
  let cleaned = text;

  cleaned = cleaned.replace(/<@(U[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, userId, label) => {
    if (context && context.userMap && context.userMap[userId]) {
      return `@${context.userMap[userId].real_name}`;
    }
    return label ? `@${label}` : `@UnknownUser`;
  });

  cleaned = cleaned.replace(/<!subteam\^(S[A-Z0-9]+)(?:\|([^>]+))?>/g, (_, groupId, label) => {
    if (context && context.groupMap && context.groupMap[groupId]) {
      return `@${context.groupMap[groupId]}`;
    }
    return label ? `${label}` : `@UnknownGroup`;
  });

  cleaned = cleaned.replace(/<!(here|channel|everyone)(?:\|([^>]+))?>/g, (_, type) => {
    return `@${type}`;
  });

  cleaned = cleaned
    .replace(/&gt;/g, '>')    
    .replace(/&lt;/g, '<')   
    .replace(/&amp;/g, '&')
    .replace(/<(https?:\/\/[^|]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/\s+/g, ' ');

  return cleaned.trim();
}

function extractLink(match: any): string {
  if (match.files && Array.isArray(match.files) && match.files.length > 0) {
    return match.files[0].permalink || match.files[0].url_private || "";
  }
  
  if (match.blocks && Array.isArray(match.blocks)) {
      const rawBlocks = JSON.stringify(match.blocks);
      const blockMatch = rawBlocks.match(/\*<(https:\/\/docs\.google\.com\/[^|]+)\|([^>]+)>\*/);
      if (blockMatch) return blockMatch[1];
  }
  
  if (match.text && typeof match.text === 'string') {
    const textLink = match.text.match(/<(https?:\/\/[^|>]+)/);
    if (textLink) return textLink[1];
  }

  if (match.permalink && typeof match.permalink === 'string') {
    return match.permalink;
  }

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
      if (pageCount >= MAX_PAGES) break;
      
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
      if (c.is_archived) return;

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

async function parseMessage(match: any, context: SlackContext): Promise<UnifiedTask | null> {
  if (!match.ts) {
    console.warn("Message missing timestamp");
    return null;
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
  
  // Extract file information if present and download full content
  let fileData: any = null;
  if (match.files && Array.isArray(match.files) && match.files.length > 0) {
      const f = match.files[0];
      const fileTitle = f.title || f.name;
      url = f.permalink || url;
      
      // Download and parse file content
      let fullContent = f.preview || f.plain_text || "";
      
      // Try multiple URL fields that Slack uses
      const downloadUrl = f.url_private_download || f.url_private;
      
      if (downloadUrl) {
        console.log(`📥 Downloading file: ${fileTitle} (${f.mimetype})...`);
        console.log(`   Download URL: ${downloadUrl.substring(0, 50)}...`);
        const parsedContent = await downloadAndParseFile(
          downloadUrl,
          f.mimetype || '',
          SLACK_TOKEN
        );
        if (parsedContent && parsedContent.length > 0) {
          fullContent = parsedContent;
          console.log(`✅ Extracted ${parsedContent.length} characters from ${fileTitle}`);
          console.log(`   First 200 chars: ${parsedContent.substring(0, 200)}...`);
        } else {
          console.warn(`⚠️ Failed to extract content from ${fileTitle}`);
        }
      } else {
        console.log(`ℹ️ No download URL for ${fileTitle}, using preview only (${fullContent.length} chars)`);
      }
      
      // Generate AI summary for the title
      let contentSummary = '';
      if (fullContent.length > 0) {
        console.log(`🤖 Generating AI summary for ${fileTitle}...`);
        contentSummary = await generateFileSummary(fullContent, fileTitle);
        console.log(`✅ Generated summary: ${contentSummary}`);
        title = `📧 ${fileTitle}: ${contentSummary}`;
      } else {
        title = `📧 ${fileTitle}`;
      }
      
      // Store file data for AI ingestion
      fileData = {
        title: fileTitle,
        name: f.name,
        preview: fullContent,
        mimetype: f.mimetype,
        size: f.size,
        fullContentLength: fullContent.length
      };
      
      console.log(`📋 Stored file data: ${fileTitle}, content length: ${fullContent.length}`);
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
      sourceType: sourceType,
      fileData: fileData
    }
  };
}

// --- 4. CONVERSATION HISTORY FETCHER (FOR PRIVATE CHANNELS) ---

async function fetchChannelHistory(channelId: string, startDate: Date, endDate: Date): Promise<any[]> {
  try {
    const oldest = Math.floor(startDate.getTime() / 1000);
    const latest = Math.floor(endDate.getTime() / 1000);
    
    const response = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&latest=${latest}&limit=100`,
      { headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` } }
    );

    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data.ok) {
      if (data.error !== 'channel_not_found') {
        console.warn(`⚠️ Error fetching history for ${channelId}:`, data.error);
      }
      return [];
    }
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (e) {
    console.error(`Error fetching history for ${channelId}:`, e);
    return [];
  }
}

// --- 5. MAIN FETCHERS ---

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

    const now = new Date();
    const defaultEnd = endDate || now;
    const defaultStart = startDate || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Default 7 days

    let allMatches: any[] = [];

    // FIX: Fetch from both search.messages API AND conversation history for private channels
    console.log(`📥 Fetching Slack messages from ${defaultStart.toLocaleDateString()} to ${defaultEnd.toLocaleDateString()}`);

    // 1. Try search.messages for broader coverage
    try {
      const encodedQuery = encodeURIComponent('*');
      let page = 1;
      
      while (page <= MAX_PAGES) {
        const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=100&page=${page}`, {
            headers: { 'Authorization': `Bearer ${SLACK_TOKEN}` },
        });

        if (!response.ok) break;

        const data = await response.json() as any;
        if (!data.ok || !data.messages || !data.messages.matches) break;

        allMatches = [...allMatches, ...data.messages.matches];
        if (page >= (data.messages.paging?.pages || 1)) break;
        page++;
      }
      console.log(`✅ Found ${allMatches.length} messages via search.messages`);
    } catch (e) {
      console.warn("⚠️ search.messages failed, will use conversation history:", e);
    }

    // 2. ALSO fetch from private channels directly to ensure coverage
    const privateChannels = Object.values(context.channelMap).filter(ch => 
      ch.is_channel && !ch.is_im && !ch.is_mpim
    );
    
    console.log(`📝 Fetching from ${privateChannels.length} private channels directly...`);
    
    for (const channel of privateChannels) {
      try {
        const historyMessages = await fetchChannelHistory(channel.id, defaultStart, defaultEnd);
        if (historyMessages.length > 0) {
          // Add channel info to messages for proper parsing
          const withChannel = historyMessages.map((msg: any) => ({
            ...msg,
            channel: channel.id
          }));
          allMatches = [...allMatches, ...withChannel];
          console.log(`  📄 ${channel.name}: ${historyMessages.length} messages`);
        }
      } catch (e) {
        console.warn(`  ⚠️ Error fetching ${channel.name}:`, e);
      }
    }

    console.log(`✅ Total ${allMatches.length} messages fetched`);

    // 3. Filter and deduplicate
    const seen = new Set<string>();
    const filteredMatches = allMatches.filter((match: any) => {
        if (!match.ts) return false;
        
        // Deduplicate by ts + channel
        const dedupeKey = `${match.ts}-${typeof match.channel === 'string' ? match.channel : match.channel?.id}`;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        
        try {
          const msgDate = new Date(parseFloat(match.ts) * 1000);
          if (defaultStart && msgDate < defaultStart) return false;
          if (defaultEnd && msgDate > defaultEnd) return false;
        } catch {
          return false;
        }
        
        if (match.username === 'asana') return false; 
        
        return true;
    });

    // Parse messages in parallel and wait for all to complete
    const parsedMessages = await Promise.all(
      filteredMatches.map(m => parseMessage(m, context))
    );
    
    return parsedMessages.filter((task): task is UnifiedTask => task !== null);

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
            user: task.metadata.author,
            files: task.metadata.fileData ? [task.metadata.fileData] : []
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
