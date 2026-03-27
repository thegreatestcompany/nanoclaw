/**
 * Passive Scanner (HNTIC)
 *
 * Periodically scans unprocessed WhatsApp messages from non-registered
 * conversations, batches them by chat, and sends each batch to an agent
 * container running Haiku with the hntic-classify skill.
 *
 * Designed to run as a scheduled task (cron every 2 hours).
 */

import {
  getUnprocessedMessages,
  markMessagesProcessed,
  UnprocessedBatch,
} from './db.js';
import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

const SCAN_BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 10;

interface PassiveScanDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  mainGroup: RegisteredGroup;
  mainChatJid: string;
}

/**
 * Format a batch of messages into a prompt for the classify agent.
 */
function formatBatchPrompt(batch: UnprocessedBatch): string {
  const lines = batch.messages.map(
    (m) => `[${m.timestamp}] ${m.sender_name}: ${m.content}`,
  );
  return `[SCHEDULED TASK - SCAN PASSIF]

Conversation : ${batch.chatJid}
${lines.length} message(s) non traité(s) :

${lines.join('\n')}

Applique le skill hntic-classify et hntic-scan-passive pour extraire et stocker les entités business dans la business.db. Ne réponds PAS aux messages — travaille silencieusement.`;
}

/**
 * Run one pass of the passive scanner.
 * Returns the number of conversations scanned.
 */
export async function runPassiveScan(
  deps: PassiveScanDependencies,
): Promise<number> {
  const groups = deps.registeredGroups();
  const registeredJids = Object.keys(groups);

  // Get unprocessed messages, excluding registered groups (already handled by direct agent)
  const batches = getUnprocessedMessages(registeredJids, SCAN_BATCH_SIZE);

  if (batches.length === 0) {
    logger.debug('Passive scan: no unprocessed messages');
    return 0;
  }

  logger.info(
    {
      conversations: batches.length,
      totalMessages: batches.reduce((s, b) => s + b.messages.length, 0),
    },
    'Passive scan: processing batches',
  );

  let scanned = 0;

  for (const batch of batches.slice(0, MAX_BATCHES_PER_RUN)) {
    // Skip tiny batches (single emoji, "ok", etc.) — not worth an agent invocation
    const meaningfulMessages = batch.messages.filter(
      (m) => m.content.length >= 5,
    );
    if (meaningfulMessages.length === 0) {
      // Mark as processed without invoking agent
      const lastTimestamp = batch.messages[batch.messages.length - 1].timestamp;
      markMessagesProcessed(batch.chatJid, lastTimestamp);
      continue;
    }

    const prompt = formatBatchPrompt({
      chatJid: batch.chatJid,
      messages: meaningfulMessages,
    });

    try {
      await runContainerAgent(
        deps.mainGroup,
        {
          prompt,
          groupFolder: deps.mainGroup.folder,
          chatJid: deps.mainChatJid,
          isMain: true,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
          model: 'haiku',
          maxTurns: 10,
          maxBudgetUsd: 0.25,
        },
        (proc, containerName) =>
          deps.queue.registerProcess(
            deps.mainChatJid,
            proc,
            containerName,
            deps.mainGroup.folder,
          ),
      );

      // Mark batch as processed
      const lastTimestamp = batch.messages[batch.messages.length - 1].timestamp;
      markMessagesProcessed(batch.chatJid, lastTimestamp);
      scanned++;
    } catch (err) {
      logger.error(
        {
          chatJid: batch.chatJid,
          err: err instanceof Error ? err.message : String(err),
        },
        'Passive scan: error processing batch',
      );
    }
  }

  logger.info({ scanned }, 'Passive scan complete');
  return scanned;
}
