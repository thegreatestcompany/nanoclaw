import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  clearAllSessions,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRecentConversation,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  runDailyLearnings,
  runWeeklyAutoDream,
} from './memory-consolidator.js';
import { runPassiveScan } from './passive-scanner.js';
import { isJidIgnored } from './scan-config.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

/**
 * Compute a hash of the global CLAUDE.md and main CLAUDE.md.
 * Used to detect changes that require purging existing Claude sessions
 * (since the system prompt is locked in when a session starts).
 */
function computeInstructionsHash(): string {
  const hash = createHash('sha256');
  for (const file of [
    path.join(GROUPS_DIR, 'global', 'CLAUDE.md'),
    path.join(GROUPS_DIR, 'main', 'CLAUDE.md'),
  ]) {
    if (fs.existsSync(file)) {
      hash.update(fs.readFileSync(file));
    }
  }
  return hash.digest('hex');
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }

  // Auto-purge sessions if CLAUDE.md instructions changed since last startup.
  // Claude SDK locks the system prompt at session creation, so existing sessions
  // would never see the new instructions otherwise.
  const currentHash = computeInstructionsHash();
  const storedHash = getRouterState('instructions_hash');
  if (storedHash && storedHash !== currentHash) {
    const purged = clearAllSessions();
    logger.info(
      {
        purged,
        oldHash: storedHash.slice(0, 8),
        newHash: currentHash.slice(0, 8),
      },
      'CLAUDE.md instructions changed — purged sessions to apply updates',
    );
  }
  setRouterState('instructions_hash', currentHash);

  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md into the new group folder so agents have
  // identity and instructions from the first run.
  // Non-main groups get the client's main CLAUDE.md (same business context, DB access, etc.)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    // Prefer client's main CLAUDE.md (has personalized business context)
    const mainMdFile = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
    const templateFile = group.isMain
      ? path.join(GROUPS_DIR, 'main', 'CLAUDE.md')
      : fs.existsSync(mainMdFile)
        ? mainMdFile
        : path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info(
        { folder: group.folder, source: templateFile },
        'Created CLAUDE.md from template',
      );
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Build prompt with recent conversation context (including Otto's responses)
  // so the agent knows what it previously said, even without session resume.
  const recentConvo = getRecentConversation(chatJid, MAX_MESSAGES_PER_PROMPT);
  const contextMessages = recentConvo.filter(
    (m) => !missedMessages.some((mm) => mm.id === m.id),
  );
  // First-run detection for non-main groups: send a welcome message directly
  // from the host (deterministic, no LLM involved) before any agent invocation.
  // The marker file ensures this only happens once per group.
  if (!group.isMain) {
    const welcomedMarker = path.join(
      resolveGroupFolderPath(group.folder),
      'memory',
      '.welcomed',
    );
    if (!fs.existsSync(welcomedMarker)) {
      const welcomeText =
        `👋 *Bonjour à tous, je suis ${ASSISTANT_NAME}, l'assistant IA personnel du dirigeant. Quelques points importants à savoir :*\n\n` +
        `• *Vous pouvez m'interroger en m'écrivant ${group.trigger} suivi de votre question — je peux donner des informations sur l'activité de l'entreprise (contacts, deals, projets…)*\n` +
        `• *Les conversations de ce groupe sont analysées automatiquement pour enrichir la base de données business du dirigeant*\n` +
        `• *Je ne réponds qu'aux messages qui me mentionnent directement avec ${group.trigger}*\n\n` +
        `_Si tu n'es pas à l'aise avec ces points, signale-le au dirigeant._`;
      try {
        await channel.sendMessage(chatJid, welcomeText);
        fs.mkdirSync(path.dirname(welcomedMarker), { recursive: true });
        fs.writeFileSync(welcomedMarker, new Date().toISOString());
        logger.info(
          { folder: group.folder, chatJid },
          'Welcome message sent to new group',
        );
      } catch (err) {
        logger.warn(
          { err, folder: group.folder },
          'Failed to send welcome message',
        );
      }
    }
  }

  let prompt = '';

  if (contextMessages.length > 0) {
    prompt += '[Conversation récente pour contexte]\n';
    prompt += formatMessages(contextMessages, TIMEZONE);
    prompt += '\n\n[Nouveaux messages à traiter]\n';
  }
  prompt += formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Send ⏳ if agent takes more than 8 seconds to respond
  let feedbackSent = false;
  const feedbackTimer = setTimeout(async () => {
    if (!feedbackSent) {
      feedbackSent = true;
      try {
        await channel.sendMessage(chatJid, '⏳');
      } catch {
        /* best effort */
      }
    }
  }, 8000);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
      if (text) {
        feedbackSent = true;
        clearTimeout(feedbackTimer);
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
    }

    if (result.status === 'success') {
      // Reset idle timer on every successful result (including null-text ones)
      // so IPC-only tasks don't leave the container open for 30 min.
      resetIdleTimer();
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  feedbackSent = true;
  clearTimeout(feedbackTimer);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Sync group metadata before writing snapshot (ensures new groups are visible)
  if (isMain) {
    await Promise.all(
      channels
        .filter((c) => c.syncGroups)
        .map((c) => c.syncGroups!(true).catch(() => {})),
    );
  }

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Extract image references from the prompt text for multimodal processing
  const { parseImageReferences } = await import('./image.js');
  const imageAttachments = parseImageReferences([{ content: prompt }]);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model: 'haiku',
        maxTurns: 30,
        maxBudgetUsd: 1.0,
        ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      // Auto-purge corrupted session and retry on next message
      if (output.error?.includes('No conversation found with session ID')) {
        logger.warn(
          { group: group.name, folder: group.folder },
          'Corrupted session detected — auto-purging for fresh start',
        );
        delete sessions[group.folder];
        setSession(group.folder, '');
      }
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Refresh groups snapshot for main container (lightweight, no WhatsApp API call)
            // so newly created groups are visible without restarting the container
            if (group.isMain) {
              const freshGroups = getAvailableGroups();
              writeGroupsSnapshot(
                group.folder,
                true,
                freshGroups,
                new Set(Object.keys(registeredGroups)),
              );
            }
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // Run business.db migrations (safe — skips if already at latest version)
  const { migrateAllBusinessDbs } = await import('./business-db-migrate.js');
  migrateAllBusinessDbs();
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // HNTIC: skip messages from ignored conversations (scan_config)
      if (isJidIgnored(chatJid)) {
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  // HNTIC: Start passive scanner (every 2 hours)
  const PASSIVE_SCAN_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.isMain === true,
  );
  if (mainEntry) {
    const [mainJid, mainGroup] = mainEntry;
    const passiveScanLoop = async () => {
      try {
        await runPassiveScan({
          registeredGroups: () => registeredGroups,
          queue,
          mainGroup,
          mainChatJid: mainJid,
        });
      } catch (err) {
        logger.error({ err }, 'Passive scan error');
      }
      setTimeout(passiveScanLoop, PASSIVE_SCAN_INTERVAL);
    };
    // First scan 5 minutes after startup, then every 2 hours
    setTimeout(passiveScanLoop, 5 * 60 * 1000);
    logger.info('Passive scanner scheduled (every 2 hours)');

    // HNTIC: Daily memory extraction (every 24h, first run 1h after startup)
    const DAILY_LEARNINGS_INTERVAL = 24 * 60 * 60 * 1000;
    const memoryDeps = { mainGroup, mainChatJid: mainJid, queue };
    const dailyLearningsLoop = async () => {
      try {
        await runDailyLearnings(memoryDeps);
      } catch (err) {
        logger.error({ err }, 'Daily learnings error');
      }
      setTimeout(dailyLearningsLoop, DAILY_LEARNINGS_INTERVAL);
    };
    setTimeout(dailyLearningsLoop, 60 * 60 * 1000); // 1h after startup

    // HNTIC: Weekly AutoDream (every 7 days, first run Sunday night)
    const WEEKLY_AUTODREAM_INTERVAL = 7 * 24 * 60 * 60 * 1000;
    const weeklyAutoDreamLoop = async () => {
      try {
        await runWeeklyAutoDream(memoryDeps);
      } catch (err) {
        logger.error({ err }, 'Weekly AutoDream error');
      }
      setTimeout(weeklyAutoDreamLoop, WEEKLY_AUTODREAM_INTERVAL);
    };
    // Calculate ms until next Sunday 22:00 local time
    const now = new Date();
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + daysUntilSunday);
    nextSunday.setHours(22, 0, 0, 0);
    const msUntilSunday = nextSunday.getTime() - now.getTime();
    setTimeout(
      weeklyAutoDreamLoop,
      msUntilSunday > 0 ? msUntilSunday : WEEKLY_AUTODREAM_INTERVAL,
    );
    logger.info('Memory consolidation scheduled (daily + weekly AutoDream)');
  }

  // Auto-prune stale session artifacts (every 24h)
  startSessionCleanup();

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendDocument: (jid, filePath, filename, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel?.sendDocument)
        throw new Error(`No document support for JID: ${jid}`);
      return channel.sendDocument(jid, filePath, filename, caption);
    },
    groupsDir: GROUPS_DIR,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
