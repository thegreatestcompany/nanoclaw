/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { query, HookCallback, PreCompactHookInput, PostCompactHookInput, PreToolUseHookInput, PostToolUseHookInput, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { businessDbServer, closeDb } from './business-db-mcp.js';
import { exaServer } from './exa-mcp.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  model?: 'sonnet' | 'haiku';
  maxTurns?: number;
  maxBudgetUsd?: number;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
}

// Composio MCP server (initialized in main(), used in runQuery())
let composioServer: any = null;

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  pushMultimodal(content: ContentBlock[]): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

/**
 * PostCompact hook: reinject business context after compaction.
 * Reads CLAUDE.md and active relationship summaries so the agent
 * doesn't lose track of key contacts and deals after a long conversation.
 */
function createPostCompactHook(): HookCallback {
  return async (input) => {
    const hookInput = input as PostCompactHookInput;
    log(`PostCompact triggered (${hookInput.trigger}), reinjecting business context`);

    let context = '';

    // Re-read CLAUDE.md for immediate memory
    const claudeMdPath = '/workspace/group/CLAUDE.md';
    if (fs.existsSync(claudeMdPath)) {
      const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
      // Only include the first ~2000 chars to avoid bloating context
      context += `## Mémoire immédiate (CLAUDE.md)\n\n${claudeMd.slice(0, 2000)}\n\n`;
    }

    // Query active relationship summaries from business.db if available
    try {
      const { default: Database } = await import('better-sqlite3');
      const dbPath = '/workspace/group/business.db';
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const summaries = db.prepare(
          `SELECT c.name, rs.summary, rs.open_items FROM relationship_summaries rs
           LEFT JOIN contacts c ON rs.contact_id = c.id
           WHERE rs.last_updated > date('now', '-30 days')
           ORDER BY rs.last_updated DESC LIMIT 10`
        ).all() as { name: string | null; summary: string; open_items: string | null }[];
        db.close();

        if (summaries.length > 0) {
          context += '## Relations actives\n\n';
          for (const s of summaries) {
            context += `• *${s.name || 'Sans nom'}*: ${s.summary}`;
            if (s.open_items) context += ` — En cours: ${s.open_items}`;
            context += '\n';
          }
          context += '\n';
        }

        // Also grab urgent deals
        const db2 = new Database(dbPath, { readonly: true });
        const urgentDeals = db2.prepare(
          `SELECT title, stage, amount, expected_close_date, next_action FROM deals
           WHERE stage NOT IN ('won', 'lost') AND deleted_at IS NULL
           ORDER BY expected_close_date ASC LIMIT 5`
        ).all() as { title: string; stage: string; amount: number | null; expected_close_date: string | null; next_action: string | null }[];
        db2.close();

        if (urgentDeals.length > 0) {
          context += '## Deals en cours\n\n';
          for (const d of urgentDeals) {
            context += `• *${d.title}* (${d.stage})`;
            if (d.amount) context += ` — ${d.amount}€`;
            if (d.expected_close_date) context += ` — Échéance: ${d.expected_close_date}`;
            if (d.next_action) context += ` — Action: ${d.next_action}`;
            context += '\n';
          }
        }
      }
    } catch (err) {
      log(`PostCompact: could not read business.db: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (context) {
      return {
        systemMessage: `## Rappel post-compaction\n\nLe contexte a été compacté. Voici les informations business critiques à garder en tête :\n\n${context}`,
      };
    }

    return {};
  };
}

/**
 * PreToolUse hook: block destructive Bash commands and writes outside workspace.
 */
function createPreToolUseHook(): HookCallback {
  const BLOCKED_PATTERNS = [
    // Destructive operations
    /rm\s+(-[rf]+\s+)*\//,     // rm -rf /
    /DROP\s+TABLE/i,
    /DROP\s+DATABASE/i,
    /TRUNCATE/i,
    /(?<!\d)>\s*\/(?!workspace\/group|dev\/null|tmp\/)/,  // redirect outside workspace

    // Credentials and config files
    /settings\.json/,          // SDK settings
    /\.claude\//,              // SDK directory
    /\.gmail-mcp\//,           // Gmail OAuth tokens
    /creds\.json/,             // WhatsApp credentials
    /\.env\b/,                 // environment files (\b to not match .envrc etc in paths)

    // Source code and infrastructure
    /\/app\/src\//,            // agent-runner source code
    /\/workspace\/project\//,  // host application code

    // System introspection
    /^\s*env\s*$/,             // bare env command (prints all env vars)
    /^\s*printenv/,            // printenv command
    /\/proc\//,                // process info (environ, cmdline, etc.)

    // Network access to host
    /curl.*172\.17\./,         // curl to Docker host gateway
    /wget.*172\.17\./,         // wget to Docker host gateway
  ];

  return async (input) => {
    const hookInput = input as PreToolUseHookInput;

    // Log ALL tool calls for debugging
    const toolInput = hookInput.tool_input as Record<string, unknown>;
    const summary = hookInput.tool_name === 'Bash'
      ? (toolInput.command as string || '').slice(0, 200)
      : hookInput.tool_name === 'Write' || hookInput.tool_name === 'Edit'
        ? (toolInput.file_path as string || '')
        : JSON.stringify(toolInput).slice(0, 150);
    log(`[TOOL] ${hookInput.tool_name}: ${summary}`);

    // Block dev/admin skills — not for clients
    if (hookInput.tool_name === 'Skill') {
      const skillName = (toolInput.skill as string || '').toLowerCase();
      const BLOCKED_SKILLS = new Set([
        'update-config', 'setup', 'debug', 'customize', 'init-onecli',
        'claw', 'convert-to-apple-container', 'update-nanoclaw', 'update-skills',
        'add-telegram', 'add-slack', 'add-discord', 'add-emacs', 'add-parallel',
        'add-ollama-tool', 'add-macos-statusbar', 'add-whatsapp', 'add-compact',
        'add-telegram-swarm', 'use-local-whisper', 'use-native-credential-proxy',
        'x-integration', 'add-voice-transcription', 'add-image-vision',
        'add-reactions', 'add-pdf-reader', 'add-gmail',
      ]);
      if (BLOCKED_SKILLS.has(skillName)) {
        log(`[SECURITY] Blocked admin skill: ${skillName}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Cette fonctionnalité n'est pas disponible. Réponds simplement au dirigeant que ce n'est pas possible, sans donner de détails techniques.`,
          },
        };
      }
    }

    // Human-in-the-loop for email sending
    if (hookInput.tool_name === 'mcp__gmail__send_email') {
      const pendingDir = '/workspace/group/.pending_emails';
      const pendingFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')) : [];

      if (pendingFiles.length > 0) {
        // Pending email exists → user has seen it and confirmed → ALLOW
        const pendingFile = path.join(pendingDir, pendingFiles[0]);
        log(`[EMAIL] Sending approved email (pending: ${pendingFiles[0]})`);
        try { fs.unlinkSync(pendingFile); } catch { /* ok */ }
        // Fall through — allow the tool call
      } else {
        // No pending → save email details and BLOCK
        fs.mkdirSync(pendingDir, { recursive: true });
        const emailData = toolInput as { to?: string[]; subject?: string; body?: string };
        const pendingId = `email-${Date.now()}.json`;
        fs.writeFileSync(
          path.join(pendingDir, pendingId),
          JSON.stringify({ to: emailData.to, subject: emailData.subject, body: emailData.body, created: new Date().toISOString() }),
        );
        const to = Array.isArray(emailData.to) ? emailData.to.join(', ') : emailData.to || '?';
        const subject = emailData.subject || '(sans objet)';
        log(`[EMAIL] Blocked send_email — pending approval: ${pendingId}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Email en attente de confirmation. Envoie ce résumé au dirigeant via send_message et demande sa confirmation :\n\nDestinataire : ${to}\nObjet : ${subject}\n\nQuand le dirigeant confirme ("oui", "go", "envoie", etc.), rappelle send_email avec les mêmes paramètres.`,
          },
        };
      }
    }

    // Human-in-the-loop for sensitive DB mutations
    if (hookInput.tool_name === 'mcp__business-db__mutate_business_db') {
      const sql = ((toolInput as { query?: string }).query || '').trim();
      const tableName = (toolInput as { table_name?: string }).table_name || '';
      const isDelete = /^\s*DELETE/i.test(sql);
      const isFinancial = /^\s*UPDATE/i.test(sql) &&
        ['deals', 'invoices', 'expenses', 'contracts', 'team_members'].includes(tableName) &&
        /amount|salary|value|budget|consumed|tax_amount|daily_rate|annual_cost/i.test(sql);
      const isDealStage = /^\s*UPDATE/i.test(sql) && tableName === 'deals' && /stage/i.test(sql);
      const isBulkUpdate = /^\s*UPDATE/i.test(sql) && !/WHERE/i.test(sql);

      if (isDelete || isFinancial || isDealStage || isBulkUpdate) {
        const pendingDir = '/workspace/group/.pending_mutations';
        const pendingFiles = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter(f => f.endsWith('.json')) : [];

        if (pendingFiles.length > 0) {
          const pendingFile = path.join(pendingDir, pendingFiles[0]);
          log(`[DB] Executing approved mutation (pending: ${pendingFiles[0]})`);
          try { fs.unlinkSync(pendingFile); } catch { /* ok */ }
          // Fall through — allow
        } else {
          fs.mkdirSync(pendingDir, { recursive: true });
          const pendingId = `mutation-${Date.now()}.json`;
          fs.writeFileSync(
            path.join(pendingDir, pendingId),
            JSON.stringify({ sql: sql.slice(0, 300), table: tableName, created: new Date().toISOString() }),
          );
          const opType = isDelete ? 'Suppression' : isDealStage ? 'Changement de stage' : isFinancial ? 'Modification financière' : 'Modification en masse';
          log(`[DB] Blocked sensitive mutation — pending approval: ${pendingId}`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Opération sensible en attente de confirmation. Envoie ce résumé au dirigeant via send_message et demande sa confirmation :\n\n${opType} sur ${tableName}\nRequête : ${sql.slice(0, 150)}\n\nQuand le dirigeant confirme, rappelle mutate_business_db avec les mêmes paramètres.`,
            },
          };
        }
      }
    }

    if (hookInput.tool_name === 'Bash') {
      const command = (hookInput.tool_input as { command?: string })?.command || '';

      // Block package installation (security — prevents supply chain attacks)
      if (/pip\s+install|npm\s+install|apt(-get)?\s+install/i.test(command)) {
        log(`[SECURITY] Blocked package install: ${command.slice(0, 100)}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `L'installation de packages n'est pas autorisée. Utilise uniquement les outils déjà installés dans l'environnement.`,
          },
        };
      }

      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          log(`[SECURITY] Blocked command: ${command.slice(0, 100)}`);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Cette action n'est pas possible. Réponds simplement au dirigeant que ce n'est pas disponible, sans donner de détails techniques.`,
            },
          };
        }
      }
    }

    if (hookInput.tool_name === 'Write' || hookInput.tool_name === 'Edit') {
      const filePath = (hookInput.tool_input as { file_path?: string })?.file_path || '';
      if (filePath && !filePath.startsWith('/workspace/group/') && !filePath.startsWith('/tmp/')) {
        log(`[SECURITY] Blocked write outside workspace: ${filePath}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Écriture bloquée : seuls les fichiers dans /workspace/group/ sont modifiables.`,
          },
        };
      }
    }

    return {};
  };
}

/**
 * PostToolUse hook: log SQL mutations executed via Bash (fallback audit for non-MCP access).
 */
function createPostToolUseHook(): HookCallback {
  return async (input) => {
    const hookInput = input as PostToolUseHookInput;

    // Log tool response for debugging
    const toolResponse = (hookInput as unknown as { tool_response?: unknown }).tool_response;
    if (toolResponse) {
      const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
      log(`[TOOL_RESPONSE] ${hookInput.tool_name}: ${responseStr.slice(0, 500)}`);
    }

    if (hookInput.tool_name === 'Bash') {
      const command = (hookInput.tool_input as { command?: string })?.command || '';
      if (/sqlite3.*business\.db/i.test(command) && /INSERT|UPDATE|DELETE/i.test(command)) {
        log(`[AUDIT] SQL mutation via Bash detected: ${command.slice(0, 200)}`);
      }

      // Auto-copy document files from /tmp/ to /workspace/group/documents/
      const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse || '');
      const docPattern = /\/tmp\/([^\s"']+\.(pptx|docx|xlsx|pdf))/gi;
      let match;
      while ((match = docPattern.exec(responseStr)) !== null) {
        const tmpPath = `/tmp/${match[1]}`;
        if (fs.existsSync(tmpPath)) {
          const docsDir = '/workspace/group/documents';
          fs.mkdirSync(docsDir, { recursive: true });
          const destPath = path.join(docsDir, match[1]);
          try {
            fs.copyFileSync(tmpPath, destPath);
            log(`[DOCS] Auto-copied ${tmpPath} → ${destPath}`);
          } catch (err) {
            log(`[DOCS] Failed to copy ${tmpPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 * Times out after IPC_IDLE_TIMEOUT_MS to avoid blocking forever
 * if the host crashes or never sends _close.
 */
const IPC_IDLE_TIMEOUT_MS = 600_000; // 10 minutes

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + IPC_IDLE_TIMEOUT_MS;
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      if (Date.now() >= deadline) {
        log(`IPC idle timeout (${IPC_IDLE_TIMEOUT_MS / 1000}s) — no message received, exiting`);
        resolve(null);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; resumeFailed?: boolean }> {
  const stream = new MessageStream();

  // If there are image attachments, send as multimodal content blocks
  if (containerInput.imageAttachments?.length) {
    const blocks: ContentBlock[] = [{ type: 'text', text: prompt }];
    for (const att of containerInput.imageAttachments) {
      const imgPath = path.join('/workspace/group', att.relativePath);
      if (fs.existsSync(imgPath)) {
        const data = fs.readFileSync(imgPath).toString('base64');
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: att.mediaType, data },
        });
        log(`[IMAGE] Loaded ${att.relativePath} (${Math.round(data.length / 1024)}KB base64)`);
      }
    }
    stream.pushMultimodal(blocks);
  } else {
    stream.push(prompt);
  }

  // Poll IPC for follow-up messages and _close sentinel during the query.
  // Stream stays open so IPC messages can be piped into the same SDK session,
  // preserving conversation context across rapid-fire WhatsApp messages.
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      model: containerInput.model || 'sonnet',
      maxTurns: containerInput.maxTurns || 30,
      maxBudgetUsd: containerInput.maxBudgetUsd || 1.00,
      systemPrompt: globalClaudeMd || undefined,
      tools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'TodoWrite', 'Skill',
        'mcp__nanoclaw__*',
        'mcp__business-db__*',
        'mcp__gmail__*',
        'mcp__google-calendar__*',
        ...(process.env.EXA_API_KEY ? ['mcp__exa__*'] : []),
        ...(composioServer ? ['mcp__composio__*'] : []),
      ],
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'TodoWrite', 'Skill',
        'mcp__nanoclaw__*',
        'mcp__business-db__*',
        'mcp__gmail__*',
        'mcp__google-calendar__*',
        ...(process.env.EXA_API_KEY ? ['mcp__exa__*'] : []),
        ...(composioServer ? ['mcp__composio__*'] : []),
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      sandbox: { enabled: false },
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        'business-db': businessDbServer,
        ...(process.env.EXA_API_KEY ? { exa: exaServer } : {}),
        ...(composioServer ? { composio: composioServer } : {}),
        // Legacy Gmail/Calendar MCP servers (fallback when Composio is not configured)
        ...(!composioServer ? { gmail: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
        }} : {}),
        ...(!composioServer ? { 'google-calendar': {
          command: 'npx',
          args: ['-y', '@cocal/google-calendar-mcp'],
          env: {
            GOOGLE_OAUTH_CREDENTIALS: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
            GOOGLE_CALENDAR_MCP_TOKEN_PATH: '/home/node/.gmail-mcp/calendar-tokens.json',
          },
        }} : {}),
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PostCompact: [{ hooks: [createPostCompactHook()] }],
        PreToolUse: [{ hooks: [createPreToolUseHook()] }],
        PostToolUse: [{ hooks: [createPostToolUseHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const errorText = (message as { error?: string }).error || '';
      const costUsd = (message as { total_cost_usd?: number }).total_cost_usd;
      const usage = (message as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage;
      const modelUsage = (message as { modelUsage?: Record<string, { costUSD: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> }).modelUsage;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      if (costUsd !== undefined || usage) {
        log(`[COST] $${costUsd?.toFixed(4) || '?'} | input=${usage?.input_tokens || 0} output=${usage?.output_tokens || 0} cache_read=${usage?.cache_read_input_tokens || 0} cache_write=${usage?.cache_creation_input_tokens || 0}`);
      }
      if (modelUsage) {
        for (const [model, mu] of Object.entries(modelUsage)) {
          log(`[MODEL] ${model}: $${mu.costUSD.toFixed(4)} | in=${mu.inputTokens} out=${mu.outputTokens} cache_r=${mu.cacheReadInputTokens} cache_w=${mu.cacheCreationInputTokens}`);
        }
      }

      // Detect stale session resume failure
      if (message.subtype === 'error_during_execution' && errorText.includes('No conversation found with session ID')) {
        log('Detected stale session — will retry without resume');
        ipcPolling = false;
        return { newSessionId: undefined, lastAssistantUuid: undefined, closedDuringQuery: false, resumeFailed: true };
      }

      // Budget exceeded — send a clear error and stop the container
      if (message.subtype === 'error_max_budget_usd') {
        log(`Budget exceeded ($${costUsd?.toFixed(4) || '?'}) — stopping container`);
        writeOutput({
          status: 'error',
          result: 'Désolé, cette demande a consommé trop de ressources. Réessaie avec une question plus simple.',
          error: 'Budget exceeded',
        });
        ipcPolling = false;
        closeDb();
        process.exit(0);
      }

      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });

      // Close input stream after result — the SDK query is done.
      // IPC messages after this will be new queries in main() loop.
      stream.end();
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  // Initialize Composio MCP server for integrations (Gmail, Google Calendar, etc.)
  // Uses the client's chatJid as user_id for per-client auth isolation
  if (process.env.COMPOSIO_API_KEY) {
    try {
      const { Composio } = await import('@composio/core');
      const { ClaudeAgentSDKProvider } = await import('@composio/claude-agent-sdk');
      const composio = new Composio({
        apiKey: process.env.COMPOSIO_API_KEY,
        provider: new ClaudeAgentSDKProvider(),
      });

      // Parse custom auth config IDs from env (format: "gmail:ac_xxx,googlecalendar:ac_yyy")
      const authConfigs: Record<string, string> = {};
      if (process.env.COMPOSIO_AUTH_CONFIGS) {
        for (const entry of process.env.COMPOSIO_AUTH_CONFIGS.split(',')) {
          const [toolkit, configId] = entry.trim().split(':');
          if (toolkit && configId) authConfigs[toolkit] = configId;
        }
        log(`Composio custom auth configs: ${JSON.stringify(authConfigs)}`);
      }

      const sessionOpts: any = {};
      if (Object.keys(authConfigs).length > 0) {
        sessionOpts.auth_configs = authConfigs;
      }

      const session = await composio.create(containerInput.chatJid, sessionOpts);
      const tools = await session.tools();
      composioServer = createSdkMcpServer({
        name: 'composio',
        version: '1.0.0',
        tools,
      });
      log(`Composio MCP initialized (${tools.length} tools, user: ${containerInput.chatJid})`);
    } catch (err) {
      log(`Composio init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: 'success',
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log(`Script wakeAgent=true, enriching prompt with data`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  // Query loop: resume from last assistant message to preserve context
  // across IPC messages within the same container lifetime (30 min).
  // resumeAt ensures we don't reload the full session history — just
  // continue from where we left off. Cost is minimal (~cached tokens).
  const QUERY_TIMEOUT_MS = 300_000; // 5 minutes
  let resumeAt: string | undefined;

  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryPromise = runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('QUERY_TIMEOUT')), QUERY_TIMEOUT_MS);
      });

      let queryResult;
      try {
        queryResult = await Promise.race([queryPromise, timeoutPromise]);
        clearTimeout(timeoutHandle!); // Cancel timeout on success
      } catch (err) {
        if (err instanceof Error && err.message === 'QUERY_TIMEOUT') {
          log(`Query timed out after ${QUERY_TIMEOUT_MS / 1000}s — exiting container`);
          writeOutput({
            status: 'error',
            result: 'Désolé, cette demande a pris trop de temps. Réessaie avec une question plus simple.',
            error: 'Query timeout (5 min)',
          });
          closeDb();
          process.exit(0);
        }
        throw err;
      }

      // Track session for resume across IPC messages
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    closeDb();
    process.exit(1);
  }

  closeDb();
}

main();
