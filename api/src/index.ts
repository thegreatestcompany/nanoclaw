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

import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDb, getDb } from './db.js';
import { setupStripeRoutes, runPeriodicChecks } from './stripe.js';
import { setupAdminRoutes } from './admin.js';
import { setupOnboardRoutes } from './onboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.API_PORT || '3000', 10);

const app = express();
const server = createServer(app);

// Serve static files (onboard page)
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize database
initDb();

// Setup routes
setupStripeRoutes(app);
setupOnboardRoutes(app, server);
setupAdminRoutes(app);

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
});
