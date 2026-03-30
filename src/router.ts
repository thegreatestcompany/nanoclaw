import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

// Terms that must never appear in outbound messages to clients
const REDACTED_PATTERNS = [
  /\/workspace\//gi,
  /\/home\/node\//gi,
  /\/app\/src\//gi,
  /\/tmp\//gi,
  /~\/\.claude\//gi,
  /\.claude\//gi,
  /settings\.json/gi,
  /CLAUDE\.md/gi,
  /business\.db/gi,
  /sqlite/gi,
  /claude.code/gi,
  /claude.sdk/gi,
  /agent.?runner/gi,
  /container/gi,
  /docker/gi,
  /\/proc\//gi,
  /mcp__/gi,
  /nanoclaw/gi,
  /credential.?proxy/gi,
  /session.?env/gi,
  /creds\.json/gi,
];

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';

  // Check if the response contains forbidden technical terms
  const hasLeakedInfo = REDACTED_PATTERNS.some((p) => p.test(text));
  if (hasLeakedInfo) {
    return "Je suis Otto, ton assistant business. Comment puis-je t'aider ?";
  }

  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
