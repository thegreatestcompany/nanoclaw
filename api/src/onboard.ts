/**
 * Onboarding routes — serves the QR code page and handles WebSocket
 * for live QR code updates during WhatsApp linking.
 */

import type { Express } from 'express';
import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getClientByToken, updateClientStatus } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track active WebSocket connections by client ID
const activeConnections = new Map<string, Set<WebSocket>>();
// Track active auth processes by client ID (prevent duplicates)
const activeAuthProcesses = new Map<string, ChildProcess>();

const CLIENTS_DIR = process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');
const APP_DIR = process.env.APP_DIR || path.join(process.cwd(), '..', 'app');

export function setupOnboardRoutes(app: Express, server: Server): void {
  // Serve onboarding page
  app.get('/onboard/:token', (req, res) => {
    const client = getClientByToken(req.params.token);

    if (!client) {
      res.status(404).send(`
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
        <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#1a1a1a;padding:40px 20px;text-align:center}</style></head>
        <body><div><img src="/static/hntic-logo.png" alt="HNTIC" style="width:48px;margin-bottom:24px">
        <h1 style="font-weight:300;letter-spacing:0.2em;margin-bottom:16px">Lien expir&eacute;</h1>
        <p style="color:#888">Ce lien a expir&eacute; ou a d&eacute;j&agrave; &eacute;t&eacute; utilis&eacute;.<br>V&eacute;rifie tes emails pour un lien valide.</p></div></body></html>
      `);
      return;
    }

    if (client.status === 'active') {
      res.send(`
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
        <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#1a1a1a;padding:40px 20px;text-align:center}</style></head>
        <body><div><img src="/static/hntic-logo.png" alt="HNTIC" style="width:48px;margin-bottom:24px">
        <h1 style="font-weight:300;letter-spacing:0.2em;margin-bottom:16px;color:#166534">WhatsApp connect&eacute;</h1>
        <p style="color:#888">Otto est actif. Tu peux fermer cette page et ouvrir WhatsApp.</p></div></body></html>
      `);
      return;
    }

    res.sendFile(path.join(__dirname, '..', 'public', 'onboard.html'));
  });

  // WebSocket server for live QR code updates
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '';
    const match = url.match(/^\/ws\/(.+)$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const token = match[1];
    const client = getClientByToken(token);
    if (!client) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Track connection
      let connections = activeConnections.get(client.id);
      if (!connections) {
        connections = new Set();
        activeConnections.set(client.id, connections);
      }
      connections.add(ws);

      ws.on('close', () => {
        connections?.delete(ws);
        if (connections?.size === 0) {
          activeConnections.delete(client.id);
        }
      });

      // Send initial status
      ws.send(JSON.stringify({ type: 'status', status: client.status }));

      // If client is awaiting WhatsApp, start the auth process
      if (client.status === 'awaiting_whatsapp' && !activeAuthProcesses.has(client.id)) {
        startWhatsAppAuth(client.id, ws);
      }
    });
  });
}

/**
 * Start WhatsApp auth for a client. Spawns the setup script,
 * watches for QR code data, and pipes it to the WebSocket.
 */
function startWhatsAppAuth(clientId: string, ws: WebSocket): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const authDir = path.join(clientDir, 'store', 'auth');

  // If already authenticated, skip
  if (fs.existsSync(path.join(authDir, 'creds.json'))) {
    broadcastConnected(clientId);
    return;
  }

  console.log(`Starting WhatsApp auth for client ${clientId}`);

  // Spawn the WhatsApp auth process
  const proc = spawn('npx', [
    'tsx', path.join(APP_DIR, 'setup', 'index.ts'),
    '--step', 'whatsapp-auth',
    '--', '--method', 'qr-terminal',
  ], {
    cwd: clientDir,
    env: {
      ...process.env,
      STORE_DIR: path.join(clientDir, 'store'),
      HOME: '/root',
      PATH: process.env.PATH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeAuthProcesses.set(clientId, proc);

  // Watch for QR code in stdout/stderr (Baileys outputs QR as text)
  let output = '';
  const handleData = (data: Buffer) => {
    const text = data.toString();
    output += text;

    // Check for pairing code or QR data
    const pairingMatch = text.match(/PAIRING_CODE:\s*(\S+)/);
    if (pairingMatch) {
      broadcastQrCode(clientId, pairingMatch[1]);
    }

    // Check for successful auth
    if (text.includes('AUTH_STATUS: authenticated') || text.includes('authenticated')) {
      console.log(`WhatsApp authenticated for client ${clientId}`);
      broadcastConnected(clientId);

      // Register the channel for this client
      registerClientChannel(clientId);
    }
  };

  proc.stdout?.on('data', handleData);
  proc.stderr?.on('data', handleData);

  proc.on('close', (code) => {
    console.log(`WhatsApp auth process exited for ${clientId} with code ${code}`);
    activeAuthProcesses.delete(clientId);

    // Check if auth succeeded
    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
      broadcastConnected(clientId);
      registerClientChannel(clientId);
    }
  });

  // Timeout after 5 minutes
  setTimeout(() => {
    if (activeAuthProcesses.has(clientId)) {
      proc.kill();
      activeAuthProcesses.delete(clientId);
    }
  }, 5 * 60 * 1000);
}

/**
 * After WhatsApp auth, register the client's channel and start their Otto process.
 */
function registerClientChannel(clientId: string): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);

  try {
    // Get the client's phone number from auth credentials
    const credsPath = path.join(clientDir, 'store', 'auth', 'creds.json');
    if (!fs.existsSync(credsPath)) return;

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    const phoneJid = creds.me?.id?.split(':')[0] + '@s.whatsapp.net';

    if (!phoneJid || phoneJid === 'undefined@s.whatsapp.net') {
      console.error(`Could not extract JID for client ${clientId}`);
      return;
    }

    // Register the channel
    const registerProc = spawn('npx', [
      'tsx', path.join(APP_DIR, 'setup', 'index.ts'),
      '--step', 'register',
      '--jid', phoneJid,
      '--name', 'Otto',
      '--trigger', '@otto',
      '--folder', 'main',
      '--channel', 'whatsapp',
      '--assistant-name', 'Otto',
      '--is-main',
      '--no-trigger-required',
    ], {
      cwd: clientDir,
      env: { ...process.env, HOME: '/root', PATH: process.env.PATH },
    });

    registerProc.on('close', (code) => {
      if (code === 0) {
        console.log(`Channel registered for client ${clientId} (${phoneJid})`);
        updateClientStatus(clientId, 'active');

        // Start the client's Otto PM2 process
        startClientProcess(clientId);
      } else {
        console.error(`Channel registration failed for ${clientId} with code ${code}`);
      }
    });
  } catch (err) {
    console.error(`Error registering channel for ${clientId}:`, err);
  }
}

/**
 * Start the client's Otto PM2 process.
 */
function startClientProcess(clientId: string): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);

  // Create the PM2 wrapper script
  const wrapperPath = path.join(clientDir, 'start-pm2.sh');
  fs.writeFileSync(wrapperPath, `#!/bin/bash\ncd ${clientDir}\nexec node ${APP_DIR}/dist/index.js 2>&1\n`);
  fs.chmodSync(wrapperPath, '755');

  // Set permissions
  try {
    execSync(`chmod -R 777 ${clientDir}/groups/ ${clientDir}/data/ ${clientDir}/store/`);
    execSync(`pm2 start ${wrapperPath} --name otto-${clientId} --interpreter bash`);
    execSync('pm2 save');
    console.log(`PM2 process otto-${clientId} started`);
  } catch (err) {
    console.error(`Failed to start PM2 process for ${clientId}:`, err);
  }
}

/**
 * Broadcast a QR code to all connected WebSocket clients for a given client ID.
 * Called by the NanoClaw process via PM2 IPC bus (production) or direct call (dev).
 */
export function broadcastQrCode(clientId: string, qrData: string): void {
  const connections = activeConnections.get(clientId);
  if (!connections) return;

  const message = JSON.stringify({ type: 'qr', data: qrData });
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

/**
 * Notify all connected WebSocket clients that WhatsApp is connected.
 */
export function broadcastConnected(clientId: string): void {
  updateClientStatus(clientId, 'active');

  const connections = activeConnections.get(clientId);
  if (!connections) return;

  const message = JSON.stringify({ type: 'connected' });
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
