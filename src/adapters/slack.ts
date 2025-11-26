import { fetch } from '@tauri-apps/plugin-http';
import { UnifiedTask } from '../types/unified';
import { v4 as uuidv4 } from 'uuid';

// ⚠️ KEEP YOUR WORKING TOKEN HERE
const SLACK_TOKEN = "xoxp-9898104501-748244888420-10001329191810-c0c49f6cecdcb50074529c60ce59b252"; 

// THE SMART QUERY: Mentions or DMs, excluding your own messages
const SEARCH_QUERY = "mention:@me OR to:me";

export async function fetchSlackSignals(): Promise<UnifiedTask[]> {
  try {
    const encodedQuery = encodeURIComponent(SEARCH_QUERY);
    
    const response = await fetch(`https://slack.com/api/search.messages?query=${encodedQuery}&sort=timestamp&sort_dir=desc&count=20`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SLACK_TOKEN}`,
      },
    });

    if (!response.ok) return [];

    const data = await response.json() as any;
    if (!data.ok || !data.messages) return [];

    return data.messages.matches.map((match: any) => {
      const channelId = match.channel.id;
      const teamId = match.team; 
      const msgId = match.ts.replace('.', '');
      
      // Smart Context: Is it a DM or a Channel?
      const isDm = match.channel.is_im === true;
      const channelName = isDm ? "Direct Message" : match.channel.name;

      return {
        id: uuidv4(),
        externalId: match.ts, // <--- CRITICAL FIX: Map Slack's Timestamp here
        provider: 'slack',
        title: match.text,
        url: `slack://channel?team=${teamId}&id=${channelId}&message=${msgId}`,
        status: 'todo',
        createdAt: new Date(parseFloat(match.ts) * 1000).toISOString(),
        metadata: {
          author: match.username || match.user,
          channel: channelName,
          type: isDm ? 'dm' : 'mention'
        }
      };
    });

  } catch (error) {
    console.error("Slack Adapter Error:", error);
    return [];
  }
}