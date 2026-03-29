/**
 * Onboarding routes — serves the onboarding page and handles WebSocket
 * for live QR code / pairing code updates during WhatsApp linking.
 *
 * Also provides a reconnection endpoint for clients who need to re-link.
 */

import type { Express } from 'express';
import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
// @ts-ignore — types installed on VPS only
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';

import { sendReconnectionEmail, sendWelcomeEmail } from './mailer.js';
import {
  getClientById,
  getClientByToken,
  getClientByEmail,
  renewOnboardToken,
  updateClientStatus,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track active WebSocket connections by client ID
const activeConnections = new Map<string, Set<WebSocket>>();
// Track active auth processes by client ID (prevent duplicates)
const activeAuthProcesses = new Map<string, ChildProcess>();

const CLIENTS_DIR = process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');
const APP_DIR = process.env.APP_DIR || path.join(process.cwd(), '..', 'app');

/**
 * Check if a client's PM2 process is running.
 */
function isClientProcessRunning(clientId: string): boolean {
  try {
    const result = execSync(`pm2 jlist`, { timeout: 5000 }).toString();
    const list = JSON.parse(result);
    const proc = list.find((p: { name: string }) => p.name === `otto-${clientId}`);
    return proc?.pm2_env?.status === 'online';
  } catch {
    return false;
  }
}

/**
 * Broadcast a message to all WebSocket clients for a given client ID.
 */
function broadcast(clientId: string, data: object): void {
  const connections = activeConnections.get(clientId);
  if (!connections) return;
  const msg = JSON.stringify(data);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function setupOnboardRoutes(app: Express, server: Server): void {
  // --- Post-payment success page ---
  app.get('/onboard/success', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'success.html'));
  });

  // API to check provisioning status by Stripe checkout session ID
  app.get('/api/onboard/status/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    try {
      // Look up the checkout session to get the customer email
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        res.status(503).json({ error: 'Stripe not configured' });
        return;
      }
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(stripeKey);
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      const email =
        session.customer_email ||
        session.customer_details?.email;

      if (!email) {
        res.json({ status: 'pending', message: 'En attente du provisioning...' });
        return;
      }

      const client = getClientByEmail(email);
      if (!client) {
        res.json({ status: 'pending', message: 'En attente du provisioning...' });
        return;
      }

      if (client.onboard_token) {
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        res.json({
          status: 'ready',
          onboardUrl: `${baseUrl}/onboard/${client.onboard_token}`,
        });
      } else {
        res.json({ status: 'pending', message: 'En attente du provisioning...' });
      }
    } catch (err) {
      console.error('Status check error:', err);
      res.json({ status: 'pending', message: 'En attente...' });
    }
  });

  // --- Reconnection page ---
  app.get('/reconnect', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'reconnect.html'));
  });

  app.post('/api/reconnect', (req, res) => {
    // Parse body manually since express.json() may not be applied globally
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        if (!email) {
          res.status(400).json({ error: 'Email requis' });
          return;
        }

        const client = getClientByEmail(email);
        if (!client) {
          res.status(404).json({ error: 'Aucun compte trouv\u00e9 avec cet email' });
          return;
        }

        if (client.status === 'cancelled') {
          res.status(403).json({ error: 'Abonnement r\u00e9sili\u00e9' });
          return;
        }

        const { token } = renewOnboardToken(client.id);
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const onboardUrl = `${baseUrl}/onboard/${token}`;

        console.log(`Reconnection link generated for ${client.id}: ${onboardUrl}`);
        sendReconnectionEmail(email, onboardUrl).catch((err) =>
          console.error(`Failed to send reconnection email to ${email}:`, err),
        );
        res.json({ ok: true, message: 'Un email avec le lien de reconnexion a \u00e9t\u00e9 envoy\u00e9.' });
      } catch {
        res.status(400).json({ error: 'Invalid JSON' });
      }
    });
  });

  // --- Onboarding page ---
  app.get('/onboard/:token', (req, res) => {
    const client = getClientByToken(req.params.token);

    if (!client) {
      res.status(404).send(`
        <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
        <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#1a1a1a;padding:40px 20px;text-align:center}
        .btn{display:inline-block;margin-top:24px;padding:10px 24px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;font-size:0.95rem}</style></head>
        <body><div><img src="/static/hntic-logo.png" alt="HNTIC" style="width:48px;margin-bottom:24px">
        <h1 style="font-weight:300;letter-spacing:0.2em;margin-bottom:16px">Lien expir&eacute;</h1>
        <p style="color:#888">Ce lien a expir&eacute; ou a d&eacute;j&agrave; &eacute;t&eacute; utilis&eacute;.</p>
        <a href="/reconnect" class="btn">Obtenir un nouveau lien</a></div></body></html>
      `);
      return;
    }

    // All valid states go through onboard.html — the page handles state via WebSocket
    res.sendFile(path.join(__dirname, '..', 'public', 'onboard.html'));
  });

  // --- WebSocket server ---
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
          // Kill orphaned auth process when all connections close
          const proc = activeAuthProcesses.get(client.id);
          if (proc) {
            console.log(`All WebSocket connections closed for ${client.id} — killing auth process`);
            proc.kill('SIGTERM');
            activeAuthProcesses.delete(client.id);
          }
        }
      });

      // Determine client state and send to frontend
      if (client.status === 'active') {
        const running = isClientProcessRunning(client.id);
        const credsPath = path.join(CLIENTS_DIR, client.id, 'store', 'auth', 'creds.json');
        const hasCreds = fs.existsSync(credsPath);
        ws.send(JSON.stringify({
          type: 'status',
          status: 'active',
          connected: running && hasCreds,
        }));
      } else if (client.status === 'payment_failed') {
        ws.send(JSON.stringify({ type: 'status', status: 'payment_failed' }));
      } else if (client.status === 'cancelled') {
        ws.send(JSON.stringify({ type: 'status', status: 'cancelled' }));
      } else {
        // awaiting_whatsapp or other — start auth flow
        ws.send(JSON.stringify({ type: 'status', status: 'awaiting_whatsapp' }));
      }

      // Listen for auth commands from the frontend
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'start_auth' && msg.phone) {
            launchAuth(client.id, msg.phone, 'pairing-code');
          } else if (msg.type === 'start_qr_auth') {
            launchAuth(client.id, undefined, 'qr');
          } else if (msg.type === 'start_reconnect') {
            // Reconnection: clear old auth and restart
            const authDir = path.join(CLIENTS_DIR, client.id, 'store', 'auth');
            try { fs.rmSync(authDir, { recursive: true, force: true }); } catch { /* ok */ }
            if (msg.phone) {
              launchAuth(client.id, msg.phone, 'pairing-code');
            } else {
              launchAuth(client.id, undefined, 'qr');
            }
          }
        } catch { /* ignore non-JSON messages */ }
      });
    });
  });
}

/**
 * Launch WhatsApp auth process (QR code or pairing code).
 * Kills any existing auth process for this client first.
 */
function launchAuth(clientId: string, phone: string | undefined, method: 'qr' | 'pairing-code'): void {
  // Kill existing auth process if any
  const existing = activeAuthProcesses.get(clientId);
  if (existing) {
    console.log(`Killing existing auth process for ${clientId}`);
    existing.kill('SIGTERM');
    activeAuthProcesses.delete(clientId);
  }

  const clientDir = path.join(CLIENTS_DIR, clientId);
  console.log(`Starting WhatsApp auth for ${clientId} (method: ${method}${phone ? ', phone: ' + phone : ''})`);

  // Ensure store directory exists
  fs.mkdirSync(path.join(clientDir, 'store', 'auth'), { recursive: true });

  const args = ['tsx', path.join(APP_DIR, 'setup', 'index.ts'), '--step', 'whatsapp-auth', '--'];
  if (method === 'pairing-code' && phone) {
    args.push('--method', 'pairing-code', '--phone', phone);
  } else {
    args.push('--method', 'qr-browser');
  }

  const proc = spawn('npx', args, {
    cwd: APP_DIR,
    env: {
      ...process.env,
      STORE_DIR: path.join(clientDir, 'store'),
      HOME: '/root',
      PATH: process.env.PATH,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeAuthProcesses.set(clientId, proc);

  // Watch for QR code file (updated by whatsapp-auth.ts)
  const qrFile = path.join(clientDir, 'store', 'qr-data.txt');
  let qrPollInterval: ReturnType<typeof setInterval> | null = null;
  let lastQrData = '';

  if (method === 'qr') {
    qrPollInterval = setInterval(async () => {
      try {
        if (fs.existsSync(qrFile)) {
          const qrData = fs.readFileSync(qrFile, 'utf-8').trim();
          if (qrData && qrData !== lastQrData) {
            lastQrData = qrData;
            const dataUrl = await QRCode.toDataURL(qrData, { width: 280, margin: 2 });
            console.log(`[QR] Broadcasting QR for ${clientId}, connections: ${activeConnections.get(clientId)?.size || 0}`);
            broadcast(clientId, { type: 'qr', dataUrl });
          }
        }
      } catch (err) {
        console.error(`[QR] Error generating QR for ${clientId}:`, err);
      }
    }, 1000);
  }

  let registrationStarted = false;

  const handleData = (data: Buffer) => {
    const text = data.toString();

    // Check for pairing code
    const pairingMatch = text.match(/PAIRING_CODE:\s*(\S+)/);
    if (pairingMatch) {
      console.log(`Pairing code for ${clientId}: ${pairingMatch[1]}`);
      broadcast(clientId, { type: 'pairing_code', code: pairingMatch[1] });
    }

    // Also check pairing-code.txt file
    const codeFile = path.join(clientDir, 'store', 'pairing-code.txt');
    if (fs.existsSync(codeFile)) {
      try {
        const code = fs.readFileSync(codeFile, 'utf-8').trim();
        if (code) {
          broadcast(clientId, { type: 'pairing_code', code });
        }
      } catch { /* ok */ }
    }

    // Check for successful auth (guard against double registration)
    if (!registrationStarted && (text.includes('AUTH_STATUS: authenticated') || text.includes('authenticated'))) {
      registrationStarted = true;
      console.log(`WhatsApp authenticated for client ${clientId}`);
      if (qrPollInterval) clearInterval(qrPollInterval);
      broadcast(clientId, { type: 'connected' });
      registerClientChannel(clientId);
    }
  };

  proc.stdout?.on('data', handleData);
  proc.stderr?.on('data', handleData);

  proc.on('close', (code) => {
    console.log(`WhatsApp auth process exited for ${clientId} with code ${code}`);
    activeAuthProcesses.delete(clientId);
    if (qrPollInterval) clearInterval(qrPollInterval);

    // If process exited and creds exist but registration hasn't started yet
    if (!registrationStarted) {
      const credsPath = path.join(clientDir, 'store', 'auth', 'creds.json');
      if (fs.existsSync(credsPath)) {
        registrationStarted = true;
        broadcast(clientId, { type: 'connected' });
        registerClientChannel(clientId);
      }
    }
  });

  // Timeout after 5 minutes
  setTimeout(() => {
    if (activeAuthProcesses.get(clientId) === proc) {
      proc.kill();
      activeAuthProcesses.delete(clientId);
      if (qrPollInterval) clearInterval(qrPollInterval);
      broadcast(clientId, { type: 'error', message: 'D\u00e9lai expir\u00e9. Recharge la page pour r\u00e9essayer.' });
    }
  }, 5 * 60 * 1000);
}

/**
 * After WhatsApp auth, register the client's channel and start their Otto process.
 * Sends errors to WebSocket if anything fails.
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
      broadcast(clientId, { type: 'error', message: 'Authentification \u00e9chou\u00e9e. Recharge la page pour r\u00e9essayer.' });
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
        broadcast(clientId, { type: 'error', message: 'Le num\u00e9ro WhatsApp n\'a pas \u00e9t\u00e9 d\u00e9tect\u00e9. Recharge la page pour r\u00e9essayer.' });
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
          // Send welcome email
          const client = getClientById(clientId);
          if (client?.email) {
            sendWelcomeEmail(client.email).catch((err) =>
              console.error(`Failed to send welcome email to ${client.email}:`, err),
            );
          }
        } else {
          console.error(`Channel registration failed for ${clientId} with code ${code}`);
          broadcast(clientId, { type: 'error', message: 'L\'enregistrement a \u00e9chou\u00e9. Recharge la page pour r\u00e9essayer.' });
        }
      });
    } catch (err) {
      console.error(`Error reading creds for ${clientId}:`, err);
      if (attempts < maxAttempts) {
        setTimeout(tryRegister, 3000);
      } else {
        broadcast(clientId, { type: 'error', message: 'Erreur lors de l\'enregistrement. Recharge la page.' });
      }
    }
  };

  tryRegister();
}

/**
 * Start the client's Otto PM2 process.
 */
function startClientProcess(clientId: string): void {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const wrapperPath = path.join(clientDir, 'start-pm2.sh');

  if (!fs.existsSync(wrapperPath)) {
    const wrapperContent = `#!/bin/bash
# Otto client wrapper for ${clientId}
umask 000  # Ensure files created by host are accessible by Docker containers (user node)
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
    execSync(
      `chown -R root:1000 "${clientDir}/groups/" "${clientDir}/data/" "${clientDir}/store/" && ` +
      `chmod -R u=rwX,g=rwX,o= "${clientDir}/groups/" "${clientDir}/data/" "${clientDir}/store/"`,
    );
    execSync(`pm2 start ${wrapperPath} --name otto-${clientId} --interpreter bash`);
    execSync('pm2 save');
    console.log(`PM2 process otto-${clientId} started`);
  } catch (err) {
    console.error(`Failed to start PM2 process for ${clientId}:`, err);
    broadcast(clientId, { type: 'error', message: 'Le d\u00e9marrage d\'Otto a \u00e9chou\u00e9. Contacte le support.' });
  }
}
