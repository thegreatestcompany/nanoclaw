/**
 * Deterministic handlers for Composio trigger events.
 *
 * Philosophy: webhooks should be automatic and 100% reliable. Instead of
 * waking the LLM for every event (which costs money and might decide to
 * ignore it), we format a WhatsApp message directly from the payload and
 * send it via the channel.
 *
 * The LLM is only invoked as a fallback for unknown trigger types.
 */

import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

export interface ComposioEventData {
  trigger_slug: string;
  data: Record<string, unknown>;
  received_at: string;
}

type SendMessageFn = (jid: string, text: string) => Promise<void>;

/**
 * Format a start time (ISO string) into French local time like "14h30".
 */
function formatFrenchTime(iso: string): string {
  try {
    const date = new Date(iso);
    return new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TIMEZONE,
    }).format(date);
  } catch {
    return iso;
  }
}

/**
 * Format attendee list into "Jean D., Marie L., 3 autres".
 * Filters out the organizer and self.
 */
function formatAttendees(
  attendees: unknown,
  organizerEmail?: string,
): string {
  if (!Array.isArray(attendees) || attendees.length === 0) return '';
  const names: string[] = [];
  for (const a of attendees) {
    if (!a || typeof a !== 'object') continue;
    const att = a as { email?: string; displayName?: string; self?: boolean };
    if (att.self) continue;
    if (att.email === organizerEmail) continue;
    const label = att.displayName || att.email || '';
    if (label) names.push(label);
  }
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} et ${names.length - 2} autres`;
}

/**
 * Handle GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER — event about to start.
 * Sends a concise reminder with participants + meet link.
 */
async function handleCalendarStartingSoon(
  event: ComposioEventData,
  chatJid: string,
  sendMessage: SendMessageFn,
): Promise<void> {
  const data = event.data as {
    summary?: string;
    start_time?: string;
    minutes_until_start?: number;
    organizer_email?: string;
    attendees?: unknown;
    hangout_link?: string;
    location?: string;
  };

  const title = data.summary || 'RDV';
  const time = data.start_time ? formatFrenchTime(data.start_time) : '';
  const minutes = data.minutes_until_start
    ? Math.round(data.minutes_until_start)
    : null;
  const attendees = formatAttendees(data.attendees, data.organizer_email);

  const lines: string[] = [];
  const whenLabel =
    minutes !== null && minutes > 0
      ? `dans ${minutes} min${time ? ` (${time})` : ''}`
      : time
        ? `à ${time}`
        : 'bientôt';
  lines.push(`⏰ *RDV ${whenLabel}* — ${title}`);
  if (attendees) lines.push(`👥 ${attendees}`);
  if (data.location) lines.push(`📍 ${data.location}`);
  if (data.hangout_link) lines.push(`🔗 ${data.hangout_link}`);

  await sendMessage(chatJid, lines.join('\n'));
}

/**
 * Handle GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER — event canceled/deleted.
 * Always notifies, even if payload is minimal.
 */
async function handleCalendarCanceled(
  event: ComposioEventData,
  chatJid: string,
  sendMessage: SendMessageFn,
): Promise<void> {
  const data = event.data as { summary?: string };
  const title = data.summary?.trim();
  const text = title
    ? `❌ *RDV annulé* — ${title}`
    : `❌ Un RDV de ton agenda a été annulé`;
  await sendMessage(chatJid, text);
}

/**
 * Dispatch a Composio event to the right deterministic handler.
 * Returns true if handled deterministically (no LLM needed).
 * Returns false if the trigger is unknown and the caller should fall back
 * to the LLM path.
 */
export async function handleComposioEventDeterministic(
  event: ComposioEventData,
  chatJid: string,
  sendMessage: SendMessageFn,
): Promise<boolean> {
  try {
    switch (event.trigger_slug) {
      case 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER':
        await handleCalendarStartingSoon(event, chatJid, sendMessage);
        logger.info(
          { trigger: event.trigger_slug },
          'Composio event handled deterministically',
        );
        return true;

      case 'GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER':
        await handleCalendarCanceled(event, chatJid, sendMessage);
        logger.info(
          { trigger: event.trigger_slug },
          'Composio event handled deterministically',
        );
        return true;

      default:
        return false;
    }
  } catch (err) {
    logger.error(
      { err, trigger: event.trigger_slug },
      'Deterministic handler failed',
    );
    // Don't fall back to LLM on errors — better to fail loud than to spam
    return true;
  }
}
