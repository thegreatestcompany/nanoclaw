/**
 * Otto Onboarding API + Admin Back-office
 *
 * Routes:
 *   POST /api/stripe-webhook     — Stripe payment webhook → auto-provision
 *   GET  /onboard/:token         — QR code page for WhatsApp linking
 *   WS   /ws/:token              — WebSocket for live QR code updates
 *   GET  /api/admin/*            — Admin back-office (protected by ADMIN_TOKEN)
 *   POST /api/admin/*            — Admin actions (restart, stop)
 */

import cookieParser from 'cookie-parser';
import express from 'express';
import { createServer } from 'http';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initDb,
  getDb,
  getClientById,
  getAllClients,
  renewOnboardToken,
} from './db.js';
import { setupStripeRoutes, runPeriodicChecks } from './stripe.js';
import { setupAdminRoutes } from './admin.js';
import { setupPortalRoutes } from './client-portal.js';
import { setupOnboardRoutes } from './onboard.js';
import { sendReconnectionEmail, sendContactNotification } from './mailer.js';
import { setupWebchat } from './webchat.js';
import { setupComposioWebhookRoutes } from './composio-webhooks.js';
import { runPeriodicTriggerProvisioning } from './composio-triggers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.API_PORT || '3000', 10);

const app = express();
const server = createServer(app);

app.use(cookieParser());

// Serve static files (onboard page)
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin dashboard
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Client portal
app.get('/portal', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'portal.html'));
});

// Legal pages
app.get('/cgv', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'cgv.html'));
});
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});
app.get('/legal', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'legal.html'));
});

// Contact form
app.post('/api/contact', express.json(), (req, res) => {
  const { name, email, company, message } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    res.status(400).json({ error: 'Nom invalide' });
    return;
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
    res.status(400).json({ error: 'Email invalide' });
    return;
  }
  console.log(`[CONTACT] ${name} <${email}> — ${company || 'N/A'} — ${message || ''}`);
  sendContactNotification(name, email, company, message).catch(err =>
    console.error('Failed to send contact notification:', err),
  );
  res.json({ ok: true });
});

// Initialize database
initDb();

// Setup routes
setupStripeRoutes(app);
setupOnboardRoutes(app, server);
setupAdminRoutes(app);
setupPortalRoutes(app);
setupComposioWebhookRoutes(app);

/**
 * Listen for IPC messages from client PM2 processes.
 * When a client's WhatsApp session becomes invalid, the client process
 * sends { type: 'disconnected_needs_reauth' } and pauses.
 * We send a reconnection email so the user can re-link.
 */
function setupPm2IpcListener(): void {
  try {
    const require = createRequire(import.meta.url);
    const pm2 = require('pm2');
    pm2.launchBus((err: Error | null, bus: any) => {
      if (err) {
        console.error('Failed to launch PM2 bus:', err);
        return;
      }
      console.log('PM2 IPC bus connected — listening for client disconnections');

      bus.on('process:msg', (packet: any) => {
        // PM2 bus packets have { process, raw, at } — the message is in `raw`
        if (packet.raw?.type !== 'disconnected_needs_reauth') return;

        const processName = packet.process?.name || '';
        // Process names follow the pattern "otto-{clientId}"
        const clientId = processName.replace(/^otto-/, '');
        if (!clientId || clientId === processName) {
          console.warn(`Ignoring disconnection from unknown process: ${processName}`);
          return;
        }

        console.log(`Client ${clientId} WhatsApp disconnected — sending reconnection email`);

        const client = getClientById(clientId);
        if (!client) {
          console.error(`Client ${clientId} not found in database`);
          return;
        }

        // Generate a fresh onboard token and send reconnection email
        const { token } = renewOnboardToken(clientId);
        const baseUrl = process.env.BASE_URL || 'https://otto.hntic.fr';
        const onboardUrl = `${baseUrl}/onboard/${token}`;

        sendReconnectionEmail(client.email, onboardUrl).catch((emailErr) =>
          console.error(`Failed to send reconnection email to ${client.email}:`, emailErr),
        );
      });
    });
  } catch {
    console.log('PM2 not available — IPC listener skipped (dev mode)');
  }
}

server.listen(PORT, () => {
  console.log(`Otto API listening on http://localhost:${PORT}`);
  console.log(`  Onboarding: http://localhost:${PORT}/onboard/:token`);
  console.log(`  Admin:      http://localhost:${PORT}/api/admin/clients`);
  console.log(`  Health:     http://localhost:${PORT}/api/health`);

  // Periodic checks: grace period expirations, trial reminders (every hour)
  setInterval(() => {
    runPeriodicChecks().catch((err) =>
      console.error('Periodic checks failed:', err),
    );
  }, 60 * 60 * 1000);

  // Periodic Composio trigger provisioning: ensures active clients get their
  // default triggers (Calendar reminders) even if they connected after onboarding.
  // Idempotent — no-ops if triggers already exist or toolkit not connected.
  const provisionActiveTriggers = () => {
    runPeriodicTriggerProvisioning(() =>
      getAllClients()
        .filter(
          (c) =>
            (c.status === 'active' || c.status === 'trial') && c.whatsapp_jid,
        )
        .map((c) => ({ clientId: c.id, composioUserId: c.whatsapp_jid })),
    ).catch((err) =>
      console.error('Periodic trigger provisioning failed:', err),
    );
  };
  // Run once 2 min after startup, then every hour
  setTimeout(provisionActiveTriggers, 2 * 60 * 1000);
  setInterval(provisionActiveTriggers, 60 * 60 * 1000);

  // Listen for PM2 IPC messages from client processes (disconnection alerts)
  setupPm2IpcListener();

  // Webchat WebSocket bridge
  setupWebchat(server);
});
