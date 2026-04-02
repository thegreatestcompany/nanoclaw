import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WAMessageKey,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';
import { logger as appLogger } from '../logger.js';

// Baileys requires a pino-compatible logger with level, child, trace
const logger = Object.assign(appLogger, {
  level: 'warn',
  child: () => logger,
  trace: appLogger.debug.bind(appLogger),
}) as typeof appLogger & {
  level: string;
  child: () => any;
  trace: (...args: any[]) => void;
};
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  /** Cache of recently sent messages for retry requests (max 256 entries). */
  private sentMessageCache = new Map<string, proto.IMessage>();
  /** Bot's LID user ID (e.g. "80355281346633") for normalizing group mentions. */
  private botLidUser?: string;
  /** When true, the process has detected that the WhatsApp session is invalid
   *  and is waiting for the user to re-authenticate via /reconnect.
   *  No automatic reconnection attempts are made in this state. */
  private paused = false;
  /** Count of consecutive QR codes emitted in the current connection attempt.
   *  Reset on each connectInternal() call to avoid false positives after network blips. */
  private qrCount = 0;
  /** True if we already sent the disconnected_needs_reauth IPC message in this pause cycle.
   *  Prevents duplicate reconnection emails. */
  private notifiedReauth = false;
  /** Max QR codes per connection attempt before concluding session is invalid. */
  private static MAX_QR_BEFORE_PAUSE = 3;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    // Reset QR counter for this connection attempt so transient network
    // disconnects don't accumulate towards the pause threshold.
    this.qrCount = 0;

    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
      getMessage: async (key: WAMessageKey) => {
        const cached = this.sentMessageCache.get(key.id || '');
        if (cached) {
          logger.debug(
            { id: key.id },
            'getMessage: returning cached message for retry',
          );
          return cached;
        }
        logger.debug({ id: key.id }, 'getMessage: no cached message found');
        return undefined;
      },
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCount++;

        if (this.paused) {
          // Already paused — ignore further QR codes
          return;
        }

        if (!process.send) {
          // Local dev: show notification and exit (user should run /setup)
          const msg =
            'WhatsApp authentication required. Run /setup in Claude Code.';
          logger.error(msg);
          exec(
            `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
          );
          setTimeout(() => process.exit(1), 1000);
          return;
        }

        if (this.qrCount < WhatsAppChannel.MAX_QR_BEFORE_PAUSE) {
          // Forward QR to parent (used during onboarding web page)
          process.send({ type: 'qr', qr });
          logger.info(
            { qrCount: this.qrCount },
            'QR code sent to parent process (PM2 IPC)',
          );
        } else {
          // Too many QR codes without a successful connection — session is invalid.
          // Pause the process and notify the API to email the client.
          this.paused = true;
          logger.warn(
            { qrCount: this.qrCount },
            'Session invalid — too many QR codes without connection. Pausing.',
          );
          this.sendReauthNotification();
        }
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        logger.info(
          {
            reason,
            paused: this.paused,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        // Explicit logout — clear auth and pause for re-auth
        if (reason === DisconnectReason.loggedOut) {
          logger.info(
            'Logged out by user. Clearing auth and pausing for re-authentication.',
          );
          this.paused = true;
          // Clear stale auth files so the next connect starts fresh
          const authDir = path.join(STORE_DIR, 'auth');
          try {
            fs.rmSync(authDir, { recursive: true, force: true });
          } catch {}
          this.sendReauthNotification();
          return;
        }

        // Already paused (waiting for user re-auth) — don't reconnect
        if (this.paused) {
          logger.info(
            'Process paused — waiting for user to re-authenticate via /reconnect',
          );
          return;
        }

        // Transient disconnection (network issue, server restart) — auto-reconnect
        logger.info('Transient disconnection, reconnecting...');
        this.connectInternal().catch((err) => {
          logger.error({ err }, 'Failed to reconnect, retrying in 5s');
          setTimeout(() => {
            this.connectInternal().catch((err2) => {
              logger.error({ err: err2 }, 'Reconnection retry failed');
            });
          }, 5000);
        });
      } else if (connection === 'open') {
        this.connected = true;
        this.paused = false;
        this.qrCount = 0;
        this.notifiedReauth = false;
        logger.info('Connected to WhatsApp');

        // Notify parent process (PM2) that WhatsApp is connected
        if (process.send) {
          process.send({ type: 'connected' });
        }

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            this.botLidUser = lidUser;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
          const rawJid = msg.key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          // Translate LID JID to phone JID if applicable.
          // Prefer senderPn from the message key (available in newer WA protocol)
          // since translateJid may fail to resolve LID→phone via signalRepository.
          let chatJid = await this.translateJid(rawJid);
          if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
            const pn = (msg.key as any).senderPn as string;
            const phoneJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
            this.lidToPhoneMap[rawJid.split('@')[0].split(':')[0]] = phoneJid;
            chatJid = phoneJid;
            logger.info(
              { lidJid: rawJid, phoneJid },
              'Translated LID via senderPn',
            );
          }

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();

          // Always notify about chat metadata for group discovery
          const isGroup = chatJid.endsWith('@g.us');
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // WhatsApp group mentions use the LID in raw text (e.g. "@80355281346633")
            // instead of the display name. Normalize to @AssistantName for trigger matching.
            if (this.botLidUser && content.includes(`@${this.botLidUser}`)) {
              content = content.replace(
                `@${this.botLidUser}`,
                `@${ASSISTANT_NAME}`,
              );
            }

            // Voice messages: transcribe and prepend [Voice: ...]
            if (!content && isVoiceMessage(msg)) {
              try {
                const transcript = await transcribeAudioMessage(
                  msg,
                  this.sock!,
                );
                if (transcript) {
                  content = `[Voice: ${transcript}]`;
                }
              } catch (err) {
                logger.error({ err }, 'Voice transcription failed');
              }
            }

            // Document capture: download business documents (PDF, DOCX, XLSX)
            // Ignore photos/videos sent as media — only capture files sent via the paperclip
            let mediaType: 'document' | 'image' | 'audio' | undefined;
            let mediaPath: string | undefined;
            let mediaFilename: string | undefined;

            const docMsg = normalized.documentMessage;
            if (docMsg) {
              const filename = docMsg.fileName || `document_${Date.now()}`;
              const ext = path.extname(filename).toLowerCase();
              const BUSINESS_EXTENSIONS = new Set([
                '.pdf',
                '.docx',
                '.doc',
                '.xlsx',
                '.xls',
                '.pptx',
                '.ppt',
                '.csv',
                '.txt',
                '.rtf',
              ]);

              if (BUSINESS_EXTENSIONS.has(ext)) {
                try {
                  const buffer = (await downloadMediaMessage(
                    msg,
                    'buffer',
                    {},
                    {
                      logger: console as any,
                      reuploadRequest: this.sock!.updateMediaMessage,
                    },
                  )) as Buffer;

                  const groupFolder = groups[chatJid]?.folder || 'main';
                  const docDir = path.join(
                    GROUPS_DIR,
                    groupFolder,
                    'documents',
                  );
                  fs.mkdirSync(docDir, { recursive: true });
                  const savedName = `${Date.now()}_${filename}`;
                  const filePath = path.join(docDir, savedName);
                  fs.writeFileSync(filePath, buffer);

                  mediaType = 'document';
                  mediaPath = `documents/${savedName}`;
                  mediaFilename = filename;
                  content =
                    `[Document reçu : ${filename}] (stocké à ${mediaPath})\n${content || ''}`.trim();

                  logger.info(
                    { filename, size: buffer.length, path: mediaPath },
                    'Document captured',
                  );
                } catch (err) {
                  logger.error(
                    { err, filename },
                    'Failed to download document',
                  );
                }
              }
            }

            // Image capture: download, resize, and save for multimodal processing
            // Only for registered groups (clients) — passive scanner ignores images
            const imgMsg = normalized.imageMessage;
            if (imgMsg && groups[chatJid]) {
              try {
                const { processImage } = await import('../image.js');
                const buffer = (await downloadMediaMessage(
                  msg,
                  'buffer',
                  {},
                  {
                    logger: console as any,
                    reuploadRequest: this.sock!.updateMediaMessage,
                  },
                )) as Buffer;

                const groupFolder = groups[chatJid]?.folder || 'main';
                const groupDir = path.join(GROUPS_DIR, groupFolder);
                const result = await processImage(
                  buffer,
                  groupDir,
                  imgMsg.caption || '',
                );

                if (result) {
                  mediaType = 'image';
                  mediaPath = result.relativePath;
                  content = `${result.content}\n${content || ''}`.trim();
                  logger.info({ path: mediaPath }, 'Image captured');
                }
              } catch (err) {
                logger.error({ err }, 'Failed to process image');
              }
            }

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            if (!content) continue;

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];

            const fromMe = msg.key.fromMe || false;
            // Detect bot messages: with own number, fromMe is reliable
            // since only the bot sends from that number.
            // With shared number, bot messages carry the assistant name prefix
            // (even in DMs/self-chat) so we check for that.
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
              ? fromMe
              : content.startsWith(`${ASSISTANT_NAME}:`);

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
              media_type: mediaType,
              media_path: mediaPath,
              media_filename: mediaFilename,
            });
          } else if (chatJid !== rawJid) {
            // LID translation produced a JID that doesn't match any registered group
            logger.warn(
              {
                rawJid,
                translatedJid: chatJid,
                registeredJids: Object.keys(groups),
              },
              'Message JID not found in registered groups after translation',
            );
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      const sent = await this.sock.sendMessage(jid, { text: prefixed });
      // Cache for retry requests (recipient may ask us to re-encrypt)
      if (sent?.key?.id && sent.message) {
        this.sentMessageCache.set(sent.key.id, sent.message);
        if (this.sentMessageCache.size > 256) {
          const oldest = this.sentMessageCache.keys().next().value!;
          this.sentMessageCache.delete(oldest);
        }
      }
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    filename: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected || !fs.existsSync(filePath)) {
      logger.warn(
        { jid, filePath },
        'Cannot send document — not connected or file missing',
      );
      return;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pptx':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.csv': 'text/csv',
        '.txt': 'text/plain',
      };
      await this.sock.sendMessage(jid, {
        document: buffer,
        mimetype: mimeTypes[ext] || 'application/octet-stream',
        fileName: filename,
        caption: caption || undefined,
      });
      logger.info({ jid, filename, size: buffer.length }, 'Document sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send document');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  /** Send the reauth notification to the API via PM2 IPC — at most once per pause cycle. */
  private sendReauthNotification(): void {
    if (this.notifiedReauth || !process.send) return;
    this.notifiedReauth = true;
    process.send({ type: 'disconnected_needs_reauth' });
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await (
        this.sock.signalRepository as any
      )?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        const sent = await this.sock.sendMessage(item.jid, { text: item.text });
        if (sent?.key?.id && sent.message) {
          this.sentMessageCache.set(sent.key.id, sent.message);
        }
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
