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
 * Start WhatsApp auth for a client using pairing code method.
 * The page will ask the client for their phone number, then display
 * the pairing code to enter in WhatsApp.
 */
function startWhatsAppAuth(clientId: string, ws: WebSocket): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const authCredsPath = path.join(APP_DIR, 'store', 'auth');

  console.log(`WhatsApp auth ready for client ${clientId} — waiting for phone number`);

  // Listen for phone number from the WebSocket
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'start_auth' && msg.phone) {
        launchPairingCode(clientId, msg.phone, ws);
      }
    } catch { /* ignore non-JSON messages */ }
  });

  // Send ready signal to the page
  ws.send(JSON.stringify({ type: 'auth_ready' }));
}

/**
 * Launch the pairing code auth process for a client.
 */
function launchPairingCode(clientId: string, phone: string, ws: WebSocket): void {
  if (activeAuthProcesses.has(clientId)) {
    console.log(`Auth already in progress for ${clientId}`);
    return;
  }

  const clientDir = path.join(CLIENTS_DIR, clientId);
  console.log(`Starting WhatsApp pairing code auth for ${clientId} (phone: ${phone})`);

  // Ensure store directory exists
  fs.mkdirSync(path.join(clientDir, 'store', 'auth'), { recursive: true });

  const proc = spawn('npx', [
    'tsx', path.join(APP_DIR, 'setup', 'index.ts'),
    '--step', 'whatsapp-auth',
    '--', '--method', 'pairing-code', '--phone', phone,
  ], {
    cwd: APP_DIR, // Must be APP_DIR for module resolution. STORE_DIR env var directs credentials to client's store.
    env: {
      ...process.env,
      STORE_DIR: path.join(clientDir, 'store'),
      HOME: '/root',
      PATH: process.env.PATH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeAuthProcesses.set(clientId, proc);

  const handleData = (data: Buffer) => {
    const text = data.toString();

    // Check for pairing code
    const pairingMatch = text.match(/PAIRING_CODE:\s*(\S+)/);
    if (pairingMatch) {
      console.log(`Pairing code for ${clientId}: ${pairingMatch[1]}`);
      ws.send(JSON.stringify({ type: 'pairing_code', code: pairingMatch[1] }));
    }

    // Also check the pairing-code.txt file
    const codeFile = path.join(clientDir, 'store', 'pairing-code.txt');
    if (fs.existsSync(codeFile)) {
      const code = fs.readFileSync(codeFile, 'utf-8').trim();
      if (code) {
        console.log(`Pairing code from file for ${clientId}: ${code}`);
        ws.send(JSON.stringify({ type: 'pairing_code', code }));
      }
    }

    // Check for successful auth
    if (text.includes('AUTH_STATUS: authenticated') || text.includes('authenticated')) {
      console.log(`WhatsApp authenticated for client ${clientId}`);
      broadcastConnected(clientId);
      registerClientChannel(clientId);
    }
  };

  proc.stdout?.on('data', handleData);
  proc.stderr?.on('data', handleData);

  proc.on('close', (code) => {
    console.log(`WhatsApp auth process exited for ${clientId} with code ${code}`);
    activeAuthProcesses.delete(clientId);

    const credsPath = path.join(clientDir, 'store', 'auth', 'creds.json');
    if (fs.existsSync(credsPath)) {
      broadcastConnected(clientId);
      registerClientChannel(clientId);
    }
  });

  // Timeout after 5 minutes
  setTimeout(() => {
    if (activeAuthProcesses.has(clientId)) {
      proc.kill();
      activeAuthProcesses.delete(clientId);
      ws.send(JSON.stringify({ type: 'error', message: 'Délai expiré. Recharge la page pour réessayer.' }));
    }
  }, 5 * 60 * 1000);
}

/**
 * After WhatsApp auth, register the client's channel and start their Otto process.
 * Includes retry logic — creds.json may not have the `me` field immediately.
 */
function registerClientChannel(clientId: string): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  let attempts = 0;
  const maxAttempts = 10;

  const tryRegister = () => {
    attempts++;
    const credsPath = path.join(clientDir, 'store', 'auth', 'creds.json');

    if (!fs.existsSync(credsPath)) {
      if (attempts < maxAttempts) {
        console.log(`Waiting for creds.json for ${clientId} (attempt ${attempts}/${maxAttempts})`);
        setTimeout(tryRegister, 3000);
        return;
      }
      console.error(`No creds.json found for ${clientId} after ${maxAttempts} attempts`);
      return;
    }

    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const meId = creds.me?.id;

      if (!meId) {
        if (attempts < maxAttempts) {
          console.log(`No me.id in creds.json for ${clientId} yet (attempt ${attempts}/${maxAttempts})`);
          setTimeout(tryRegister, 3000);
          return;
        }
        console.error(`No me.id in creds.json for ${clientId} after ${maxAttempts} attempts`);
        return;
      }

      const phoneJid = meId.split(':')[0] + '@s.whatsapp.net';
      console.log(`Registering channel for ${clientId}: ${phoneJid}`);

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
        env: {
          ...process.env,
          STORE_DIR: path.join(clientDir, 'store'),
          GROUPS_DIR: path.join(clientDir, 'groups'),
          DATA_DIR: path.join(clientDir, 'data'),
          HOME: '/root',
          PATH: process.env.PATH,
        },
      });

      registerProc.on('close', (code) => {
        if (code === 0) {
          console.log(`Channel registered for client ${clientId} (${phoneJid})`);
          updateClientStatus(clientId, 'active');
          startClientProcess(clientId);
        } else {
          console.error(`Channel registration failed for ${clientId} with code ${code}`);
        }
      });
    } catch (err) {
      console.error(`Error reading creds for ${clientId}:`, err);
      if (attempts < maxAttempts) {
        setTimeout(tryRegister, 3000);
      }
    }
  };

  tryRegister();
}

/**
 * Start the client's Otto PM2 process.
 * The wrapper was already created by provision.ts — recreate if missing.
 */
function startClientProcess(clientId: string): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const wrapperPath = path.join(clientDir, 'start-pm2.sh');

  if (!fs.existsSync(wrapperPath)) {
    const wrapperContent = `#!/bin/bash
# Otto client wrapper for ${clientId}
set -a
source ${clientDir}/.env
set +a
export STORE_DIR="${clientDir}/store"
export GROUPS_DIR="${clientDir}/groups"
export DATA_DIR="${clientDir}/data"
cd ${APP_DIR}
exec node ${APP_DIR}/dist/index.js 2>&1
`;
    fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
  }

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
