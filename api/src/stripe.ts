/**
 * Stripe webhook handler — auto-provisions clients on payment.
 *
 * Events handled:
 *   checkout.session.completed              → provision new client (or reactivate)
 *   checkout.session.async_payment_succeeded → provision for delayed payment methods
 *   customer.subscription.deleted           → start 24h grace period, then deprovision
 *   invoice.payment_failed                  → notify client via WhatsApp
 *   invoice.paid                            → restore active status after failed payment
 *
 * Trial: 7-day trial with card required. Provisioning is identical.
 * Grace period: 24h delay before deprovisioning on cancellation.
 *
 * Best practices (per Stripe docs):
 *   - Return 200 immediately, process async
 *   - Idempotency via event.id dedup
 *   - Raw body for signature verification
 */

import type { Express, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';

import Stripe from 'stripe';

import { getDb, slugify } from './db.js';
import { provisionClient, deprovisionClient } from './provision.js';
import { sendOnboardingEmail } from './mailer.js';

const CLIENTS_DIR = process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

/**
 * Send a WhatsApp message to a client via IPC file.
 * Works even if the client's process is running — the IPC watcher picks it up.
 */
function sendClientWhatsApp(clientId: string, text: string): void {
  try {
    const db = getDb();
    const client = db.prepare('SELECT whatsapp_jid FROM clients WHERE id = ?').get(clientId) as { whatsapp_jid: string | null } | undefined;
    if (!client?.whatsapp_jid) return;

    const ipcDir = path.join(CLIENTS_DIR, clientId, 'data', 'ipc', 'main', 'messages');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcDir, `system-${Date.now()}.json`),
      JSON.stringify({ type: 'message', chatJid: client.whatsapp_jid, text }),
    );
  } catch { /* best effort */ }
}

// In-memory set to deduplicate events (Stripe can send the same event multiple times)
const processedEvents = new Set<string>();
const MAX_PROCESSED_EVENTS = 10000;

function markEventProcessed(eventId: string): boolean {
  if (processedEvents.has(eventId)) return false;
  processedEvents.add(eventId);
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const first = processedEvents.values().next().value;
    if (first) processedEvents.delete(first);
  }
  return true;
}

async function handleCheckoutCompleted(session: any): Promise<void> {
  // Don't provision if payment hasn't completed yet (async payment methods like SEPA)
  // Note: for trials, payment_status is 'no_payment_required' — this is fine, we still provision
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    console.log(`Checkout completed but payment_status=${session.payment_status} — waiting for async payment`);
    return;
  }

  // customer_email may be on the session or on the Customer object
  let email = session.customer_email as string | null;
  if (!email && session.customer_details?.email) {
    email = session.customer_details.email as string;
  }
  // Last resort: fetch the Customer from Stripe API
  if (!email && session.customer && process.env.STRIPE_SECRET_KEY) {
    try {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const customer = await stripe.customers.retrieve(session.customer as string);
      if ('email' in customer && customer.email) {
        email = customer.email;
      }
    } catch (err) {
      console.error('Failed to fetch customer email from Stripe:', err);
    }
  }
  if (!email) {
    console.error('Checkout completed but no customer email found — cannot provision');
    return;
  }

  // Extract ALL customer details from Stripe checkout
  const details = session.customer_details || {};
  const customerName = (details.name as string) || null;
  const companyName = (details.business_name as string) || null;
  const phone = (details.phone as string) || null;
  const address = details.address || {};
  const addressLine1 = (address.line1 as string) || null;
  const addressLine2 = (address.line2 as string) || null;
  const addressCity = (address.city as string) || null;
  const addressPostalCode = (address.postal_code as string) || null;
  const addressCountry = (address.country as string) || null;
  const taxExempt = (details.tax_exempt as string) || null;
  const taxIds = details.tax_ids as Array<{ type: string; value: string }> | null;
  const taxId = taxIds?.length ? `${taxIds[0].type}:${taxIds[0].value}` : null;

  const clientId = slugify(email);
  const db = getDb();

  // Check if this is a reactivation (client exists with pending_cancellation)
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;
  if (existing && existing.status === 'pending_cancellation') {
    // Reactivate — process is still running during grace period
    db.prepare(
      `UPDATE clients SET status = ?, cancel_at = NULL, cancel_reason = NULL, stripe_customer_id = ?, stripe_subscription_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run('active', session.customer, session.subscription, clientId);
    console.log(`Client ${clientId} reactivated (was pending_cancellation)`);
    sendClientWhatsApp(clientId, 'Content de te revoir ! 🎉 Ton abonnement Otto est réactivé. Envoie-moi un message pour reprendre là où on en était.');
    return;
  }

  // Get trial info: trial_end is on the Subscription object, not the Session.
  // We need to fetch the subscription from Stripe to get the trial_end timestamp.
  let trialEndsAt: string | null = null;
  if (session.subscription && process.env.STRIPE_SECRET_KEY) {
    try {
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
      if (subscription.trial_end) {
        trialEndsAt = new Date(subscription.trial_end * 1000).toISOString();
      }
    } catch (err) {
      console.error('Failed to fetch subscription for trial_end:', err);
    }
  }

  try {
    const result = await provisionClient(clientId, email, session.customer as string, undefined, customerName, companyName);

    // Store subscription ID and trial end date
    const updates: Record<string, unknown> = {
      stripe_subscription_id: session.subscription || null,
    };
    if (trialEndsAt) {
      updates.trial_ends_at = trialEndsAt;
    }
    db.prepare(
      `UPDATE clients SET stripe_subscription_id = ?, trial_ends_at = ?,
       phone = ?, address_line1 = ?, address_line2 = ?, address_city = ?,
       address_postal_code = ?, address_country = ?, tax_id = ?, tax_exempt = ?,
       updated_at = datetime('now') WHERE id = ?`
    ).run(
      session.subscription || null, trialEndsAt,
      phone, addressLine1, addressLine2, addressCity,
      addressPostalCode, addressCountry, taxId, taxExempt,
      clientId,
    );

    console.log(`Client provisioned via Stripe: ${clientId} → ${result.onboardUrl}`);
    await sendOnboardingEmail(email, result.onboardUrl, customerName).catch((err) =>
      console.error(`Failed to send onboarding email to ${email}:`, err),
    );
  } catch (err) {
    console.error(`Provisioning failed for ${email}:`, err);
  }
}

export function setupStripeRoutes(app: Express): void {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecretKey) {
    console.warn('STRIPE_SECRET_KEY not set — Stripe webhooks disabled. Use POST /api/provision for manual provisioning.');

    // Manual provisioning endpoint (for testing without Stripe)
    app.post('/api/provision', express.json(), async (req: Request, res: Response) => {
      const { email, name, company, apiKey } = req.body as {
        email?: string;
        name?: string;
        company?: string;
        apiKey?: string;
      };

      if (!email) {
        res.status(400).json({ error: 'email is required' });
        return;
      }

      const clientId = slugify(email);
      const db = getDb();

      const existing = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
      if (existing) {
        res.status(409).json({ error: `Client ${clientId} already exists` });
        return;
      }

      try {
        const result = await provisionClient(clientId, email, 'manual', apiKey);

        if (name || company) {
          db.prepare('UPDATE clients SET name = ?, company = ? WHERE id = ?')
            .run(name || null, company || null, clientId);
        }

        res.json({
          ok: true,
          clientId: result.clientId,
          onboardUrl: result.onboardUrl,
        });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return;
  }

  // Stripe Customer Portal — allows client to manage/cancel subscription
  app.post(
    '/api/portal/billing',
    express.json(),
    async (req: Request, res: Response) => {
      // Authenticated via portal JWT cookie (reuse the portal middleware logic)
      const jwt = await import('jsonwebtoken');
      const secret = process.env.PORTAL_JWT_SECRET;
      const token = req.cookies?.portal_token;
      if (!secret || !token) {
        res.status(401).json({ error: 'Non authentifié' });
        return;
      }

      let clientId: string;
      try {
        const payload = jwt.default.verify(token, secret) as { client_id: string };
        clientId = payload.client_id;
      } catch {
        res.status(401).json({ error: 'Session expirée' });
        return;
      }

      const client = getDb().prepare('SELECT stripe_customer_id FROM clients WHERE id = ?').get(clientId) as { stripe_customer_id: string | null } | undefined;
      if (!client?.stripe_customer_id) {
        res.status(400).json({ error: 'Pas d\'abonnement Stripe trouvé' });
        return;
      }

      const stripe = getStripe();
      if (!stripe) {
        res.status(503).json({ error: 'Stripe non configuré' });
        return;
      }

      try {
        const baseUrl = process.env.BASE_URL || 'https://otto.hntic.fr';
        const session = await stripe.billingPortal.sessions.create({
          customer: client.stripe_customer_id,
          return_url: `${baseUrl}/portal`,
        });
        res.json({ url: session.url });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Stripe webhook (raw body required for signature verification)
  app.post(
    '/api/stripe-webhook',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      let event;
      try {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(stripeSecretKey);
        const sig = req.headers['stripe-signature'];
        if (!sig || typeof sig !== 'string') {
          res.status(400).send('Missing stripe-signature header');
          return;
        }
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret!);
      } catch (err) {
        console.error('Stripe webhook signature verification failed:', err);
        res.status(400).send('Webhook Error');
        return;
      }

      // Return 200 immediately (Stripe best practice)
      res.json({ received: true });

      // Deduplicate
      if (!markEventProcessed(event.id)) {
        console.log(`Duplicate Stripe event ${event.id} — skipping`);
        return;
      }

      processStripeEvent(event).catch((err) =>
        console.error(`Error processing Stripe event ${event.id}:`, err),
      );
    },
  );
}

async function processStripeEvent(event: { id: string; type: string; data: { object: any } }): Promise<void> {
  const db = getDb();

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await handleCheckoutCompleted(event.data.object);
      break;

    case 'customer.subscription.deleted': {
      // Start 24h grace period — don't deprovision immediately
      const sub = event.data.object;
      const client = db.prepare(
        'SELECT id FROM clients WHERE stripe_customer_id = ?'
      ).get(sub.customer as string) as { id: string } | undefined;

      if (client) {
        db.prepare(
          `UPDATE clients SET status = 'pending_cancellation',
           cancel_at = datetime('now', '+24 hours'),
           cancel_reason = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(sub.cancellation_details?.reason || 'subscription_deleted', client.id);

        console.log(`Client ${client.id} → pending_cancellation (24h grace period)`);
        sendClientWhatsApp(client.id, 'Ton abonnement Otto a été annulé. Tu as encore 24h pour exporter tes documents depuis ton espace client (dis-moi "Mon espace"). Après ce délai, tes données seront archivées.\n\nSi c\'est une erreur, tu peux te réabonner et tout sera restauré instantanément.');
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      db.prepare(
        `UPDATE clients SET status = ?, updated_at = datetime('now') WHERE stripe_customer_id = ?`
      ).run('payment_failed', invoice.customer as string);

      // TODO: send WhatsApp message with invoice.hosted_invoice_url
      // to let client update their payment method
      console.log(`Payment failed for customer ${invoice.customer} — invoice: ${invoice.hosted_invoice_url}`);
      break;
    }

    case 'customer.subscription.trial_will_end': {
      // Stripe sends this 3 days before trial ends — perfect for our reminder
      const sub = event.data.object;
      const client = db.prepare(
        'SELECT id FROM clients WHERE stripe_customer_id = ?'
      ).get(sub.customer as string) as { id: string } | undefined;
      if (client) {
        console.log(`Trial ending soon for ${client.id} (Stripe notification)`);
        // TODO: query client's business.db for usage stats and send WhatsApp summary
      }
      break;
    }

    case 'invoice.paid': {
      // Restore active status after a previously failed payment
      const invoice = event.data.object;
      const updated = db.prepare(
        `UPDATE clients SET status = ?, updated_at = datetime('now') WHERE stripe_customer_id = ? AND status = ?`
      ).run('active', invoice.customer as string, 'payment_failed');
      if (updated.changes > 0) {
        console.log(`Payment recovered for customer ${invoice.customer}`);
      }
      break;
    }
  }
}

/**
 * Check for clients whose grace period has expired and deprovision them.
 * Also check for trial ending soon and send reminders.
 * Called periodically from a setInterval in the main API process.
 */
export async function runPeriodicChecks(): Promise<void> {
  const db = getDb();

  // 1. Deprovision clients past grace period
  const expired = db.prepare(
    `SELECT id FROM clients WHERE status = 'pending_cancellation' AND cancel_at < datetime('now')`
  ).all() as { id: string }[];

  for (const client of expired) {
    try {
      await deprovisionClient(client.id);
      console.log(`Client ${client.id} deprovisioned (grace period expired)`);
    } catch (err) {
      console.error(`Failed to deprovision ${client.id}:`, err);
    }
  }

  // 2. Trial ending reminders (2 days before trial_ends_at)
  const trialEnding = db.prepare(
    `SELECT id, trial_ends_at FROM clients
     WHERE trial_ends_at IS NOT NULL
     AND trial_ends_at BETWEEN datetime('now') AND datetime('now', '+2 days')
     AND status = 'active'`
  ).all() as { id: string; trial_ends_at: string }[];

  for (const client of trialEnding) {
    // TODO: send WhatsApp trial-ending summary via the client's Otto process
    // Query their business.db for stats (contacts, deals, interactions, documents)
    console.log(`Trial ending soon for ${client.id} (${client.trial_ends_at})`);
  }
}
