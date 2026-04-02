/**
 * Webchat — WebSocket bridge between portal chat UI and client's Otto instance.
 *
 * Flow:
 *   1. Browser opens WebSocket at /ws/chat (JWT-authenticated via cookie or query param)
 *   2. User sends a message → written to client's messages.db with the main group JID
 *   3. The client's message loop detects it and processes it (same as WhatsApp)
 *   4. Otto's response (is_bot_message=1) is polled and forwarded to the WebSocket
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import Database from 'better-sqlite3';
import type { IncomingMessage } from 'http';

const CLIENTS_DIR =
  process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');
const SAFE_ID_PATTERN = /^[a-z0-9-]+$/;

interface ChatConnection {
  ws: WebSocket;
  clientId: string;
  chatJid: string;
  lastSeenTimestamp: string;
  pollInterval: ReturnType<typeof setInterval> | null;
}

function getMessagesDbPath(clientId: string): string {
  return path.join(CLIENTS_DIR, clientId, 'store', 'messages.db');
}

function getRegisteredGroupJid(clientId: string): string | null {
  const dbPath = getMessagesDbPath(clientId);
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1",
      )
      .get() as { jid: string } | undefined;
    return row?.jid || null;
  } finally {
    db.close();
  }
}

function authenticateWs(req: IncomingMessage): string | null {
  const secret = process.env.PORTAL_JWT_SECRET;
  if (!secret) return null;

  // Try token from query param
  const url = new URL(req.url || '', 'http://localhost');
  const token = url.searchParams.get('token');

  // Try token from cookie
  let cookieToken: string | undefined;
  const cookies = req.headers.cookie?.split(';') || [];
  for (const c of cookies) {
    const [name, ...rest] = c.trim().split('=');
    if (name === 'portal_token') {
      cookieToken = rest.join('=');
    }
  }

  const finalToken = token || cookieToken;
  if (!finalToken) return null;

  try {
    const payload = jwt.verify(finalToken, secret) as { client_id: string };
    if (!payload.client_id || !SAFE_ID_PATTERN.test(payload.client_id)) return null;
    return payload.client_id;
  } catch {
    return null;
  }
}

export function setupWebchat(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<WebSocket, ChatConnection>();

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '', 'http://localhost').pathname;
    if (pathname !== '/ws/chat') return;

    const clientId = authenticateWs(req);
    if (!clientId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, clientId);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, clientId: string) => {
    const chatJid = getRegisteredGroupJid(clientId);
    if (!chatJid) {
      ws.send(JSON.stringify({ type: 'error', message: 'Compte non configuré' }));
      ws.close();
      return;
    }

    const conn: ChatConnection = {
      ws,
      clientId,
      chatJid,
      lastSeenTimestamp: new Date().toISOString(),
      pollInterval: null,
    };
    connections.set(ws, conn);

    // Send recent messages for context
    sendRecentMessages(conn);

    // Start polling for bot responses
    conn.pollInterval = setInterval(() => pollNewMessages(conn), 1500);

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'message' && data.text) {
          injectMessage(conn, data.text.trim());
        }
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      if (conn.pollInterval) clearInterval(conn.pollInterval);
      connections.delete(ws);
    });

    ws.send(JSON.stringify({ type: 'connected', chatJid }));
  });

  console.log('Webchat WebSocket ready at /ws/chat');
}

function sendRecentMessages(conn: ChatConnection): void {
  const dbPath = getMessagesDbPath(conn.clientId);
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath, { readonly: true });
  try {
    const messages = db
      .prepare(
        `SELECT id, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages
         WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT 20`,
      )
      .all(conn.chatJid) as Array<{
        id: string;
        sender_name: string;
        content: string;
        timestamp: string;
        is_from_me: number;
        is_bot_message: number;
      }>;

    // Send oldest first
    messages.reverse();
    for (const m of messages) {
      conn.ws.send(
        JSON.stringify({
          type: 'message',
          id: m.id,
          sender: m.is_bot_message ? 'Otto' : m.sender_name || 'Vous',
          text: m.content,
          timestamp: m.timestamp,
          isBot: !!m.is_bot_message,
        }),
      );
    }

    if (messages.length > 0) {
      conn.lastSeenTimestamp = messages[messages.length - 1].timestamp;
    }
  } finally {
    db.close();
  }
}

function injectMessage(conn: ChatConnection, text: string): void {
  const dbPath = getMessagesDbPath(conn.clientId);
  if (!fs.existsSync(dbPath)) return;

  const msgId = `webchat-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = new Date().toISOString();

  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
    ).run(msgId, conn.chatJid, 'webchat', 'Dirigeant (web)', text, timestamp);
  } finally {
    db.close();
  }

  // Mirror user message to WhatsApp so the conversation stays in sync
  const ipcDir = path.join(CLIENTS_DIR, conn.clientId, 'data', 'ipc', 'main', 'messages');
  try {
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, `webchat-echo-${Date.now()}.json`),
      JSON.stringify({
        type: 'message',
        chatJid: conn.chatJid,
        text: `[Web] ${text}`,
      }),
    );
  } catch { /* non-critical */ }

  // Echo back to confirm
  conn.ws.send(
    JSON.stringify({
      type: 'message',
      id: msgId,
      sender: 'Vous',
      text,
      timestamp,
      isBot: false,
    }),
  );

  conn.lastSeenTimestamp = timestamp;
}

function pollNewMessages(conn: ChatConnection): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;

  const dbPath = getMessagesDbPath(conn.clientId);
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath, { readonly: true });
  try {
    // Poll ALL new messages (bot responses + WhatsApp user messages)
    // Skip webchat-originated messages (already echoed) via sender != 'webchat'
    const messages = db
      .prepare(
        `SELECT id, sender, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages
         WHERE chat_jid = ? AND timestamp > ? AND sender != 'webchat'
         ORDER BY timestamp ASC`,
      )
      .all(conn.chatJid, conn.lastSeenTimestamp) as Array<{
        id: string;
        sender: string;
        sender_name: string;
        content: string;
        timestamp: string;
        is_from_me: number;
        is_bot_message: number;
      }>;

    for (const m of messages) {
      const isBot = !!m.is_bot_message;
      const sender = isBot ? 'Otto' : m.is_from_me ? 'Vous (WhatsApp)' : m.sender_name || 'Vous';
      conn.ws.send(
        JSON.stringify({
          type: 'message',
          id: m.id,
          sender,
          text: m.content,
          timestamp: m.timestamp,
          isBot,
        }),
      );
      conn.lastSeenTimestamp = m.timestamp;
    }
  } finally {
    db.close();
  }
}
