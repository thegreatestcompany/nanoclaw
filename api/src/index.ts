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

import { initDb, getDb, getClientById, renewOnboardToken } from './db.js';
import { setupStripeRoutes, runPeriodicChecks } from './stripe.js';
import { setupAdminRoutes } from './admin.js';
import { setupPortalRoutes } from './client-portal.js';
import { setupOnboardRoutes } from './onboard.js';
import { sendReconnectionEmail } from './mailer.js';

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

// Initialize database
initDb();

// Setup routes
setupStripeRoutes(app);
setupOnboardRoutes(app, server);
setupAdminRoutes(app);
setupPortalRoutes(app);

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

  // Listen for PM2 IPC messages from client processes (disconnection alerts)
  setupPm2IpcListener();
});
