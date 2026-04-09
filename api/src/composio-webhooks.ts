/**
 * Composio webhook handler — receives trigger events from Composio and routes
 * them to the corresponding client's Otto process via file-based IPC.
 *
 * Flow:
 *   1. POST /webhook/composio (Composio sends trigger event)
 *   2. Verify HMAC-SHA256 signature (headers webhook-id/timestamp/signature)
 *   3. Parse payload, extract user_id from metadata
 *   4. Our convention: Composio user_id == our client_id
 *   5. Write an event file to clients/{id}/data/ipc/events/
 *   6. Client's host process watches this dir and wakes Otto with event context
 *
 * Payload V3 (https://docs.composio.dev/docs/webhook-verification):
 *   {
 *     id: string,
 *     type: "composio.trigger.message" | "composio.connected_account.expired",
 *     metadata: {
 *       trigger_slug: string,        // e.g. "GMAIL_NEW_MESSAGE"
 *       trigger_id: string,
 *       connected_account_id: string,
 *       auth_config_id: string,
 *       user_id: string,             // our client_id
 *       log_id: string
 *     },
 *     data: object,                  // event-specific (parsed email, calendar event, etc.)
 *     timestamp: string              // ISO 8601
 *   }
 */

import crypto from 'crypto';
import express, { Application, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

import { getClientById } from './db.js';

const CLIENTS_DIR =
  process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');

const SAFE_ID_PATTERN = /^[a-z0-9-]+$/;

interface ComposioWebhookPayload {
  id: string;
  type: string;
  metadata: {
    trigger_slug: string;
    trigger_id: string;
    connected_account_id: string;
    auth_config_id?: string;
    user_id: string;
    log_id?: string;
  };
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Verify the webhook signature using HMAC-SHA256.
 * Signing string: `{webhook-id}.{webhook-timestamp}.{body}`
 */
function verifySignature(
  webhookId: string,
  webhookTimestamp: string,
  body: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const signingString = `${webhookId}.${webhookTimestamp}.${body}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signingString)
    .digest('base64');

  // The signature header format is `v1,{signature}` (Svix-style)
  // Support both `v1,sig` and raw `sig` formats
  const received = signatureHeader.includes(',')
    ? signatureHeader.split(',')[1]
    : signatureHeader;

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(received);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/**
 * Reject stale webhooks (> 5 minutes old) to prevent replay attacks.
 */
function isTimestampFresh(timestamp: string): boolean {
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) < 5 * 60;
}

/**
 * Write a Composio event file to the client's IPC events directory.
 * The client's host process watches this directory and reacts accordingly.
 */
function dispatchEventToClient(
  clientId: string,
  payload: ComposioWebhookPayload,
): void {
  if (!SAFE_ID_PATTERN.test(clientId)) {
    throw new Error(`Invalid client ID: ${clientId}`);
  }
  const eventsDir = path.join(CLIENTS_DIR, clientId, 'data', 'ipc', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const filename = `composio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const filePath = path.join(eventsDir, filename);

  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        source: 'composio',
        event_id: payload.id,
        trigger_slug: payload.metadata.trigger_slug,
        trigger_id: payload.metadata.trigger_id,
        connected_account_id: payload.metadata.connected_account_id,
        data: payload.data,
        received_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // Fix permissions so the client's host process (uid 1000 group) can read it
  try {
    fs.chmodSync(filePath, 0o660);
  } catch {
    /* non-fatal */
  }
}

export function setupComposioWebhookRoutes(app: Application): void {
  // Use raw body parser for this route (signature verification needs raw bytes)
  app.post(
    '/webhook/composio',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: Request, res: Response) => {
      const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[composio-webhook] COMPOSIO_WEBHOOK_SECRET not set');
        res.status(500).json({ error: 'Webhook not configured' });
        return;
      }

      const webhookId = req.header('webhook-id');
      const webhookTimestamp = req.header('webhook-timestamp');
      const webhookSignature = req.header('webhook-signature');

      if (!webhookId || !webhookTimestamp || !webhookSignature) {
        res.status(400).json({ error: 'Missing webhook headers' });
        return;
      }

      if (!isTimestampFresh(webhookTimestamp)) {
        console.warn('[composio-webhook] Stale timestamp rejected', { webhookId });
        res.status(400).json({ error: 'Stale timestamp' });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body.toString('utf-8')
        : '';
      if (!rawBody) {
        res.status(400).json({ error: 'Empty body' });
        return;
      }

      if (
        !verifySignature(
          webhookId,
          webhookTimestamp,
          rawBody,
          webhookSignature,
          secret,
        )
      ) {
        console.warn('[composio-webhook] Invalid signature', { webhookId });
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      let payload: ComposioWebhookPayload;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
      }

      if (!payload.metadata?.user_id || !payload.metadata?.trigger_slug) {
        res.status(400).json({ error: 'Missing metadata fields' });
        return;
      }

      // Handle account expiration separately — Otto can't help with that
      if (payload.type === 'composio.connected_account.expired') {
        console.log(
          `[composio-webhook] Account expired for user ${payload.metadata.user_id}`,
          { connected_account_id: payload.metadata.connected_account_id },
        );
        // TODO: notify client via email/WhatsApp to re-link
        res.status(200).json({ ok: true, handled: 'account_expired' });
        return;
      }

      if (payload.type !== 'composio.trigger.message') {
        console.log(`[composio-webhook] Ignoring event type: ${payload.type}`);
        res.status(200).json({ ok: true, handled: 'ignored' });
        return;
      }

      // Our convention: Composio user_id == client_id in onboarding.db
      const clientId = payload.metadata.user_id;
      const client = getClientById(clientId);
      if (!client) {
        console.warn(`[composio-webhook] Unknown client: ${clientId}`);
        res.status(404).json({ error: 'Unknown client' });
        return;
      }

      if (client.status !== 'active' && client.status !== 'trial') {
        console.log(
          `[composio-webhook] Client ${clientId} not active (status=${client.status}) — event dropped`,
        );
        res.status(200).json({ ok: true, handled: 'client_inactive' });
        return;
      }

      try {
        dispatchEventToClient(clientId, payload);
        console.log(
          `[composio-webhook] Dispatched ${payload.metadata.trigger_slug} to ${clientId}`,
        );
        res.status(200).json({ ok: true });
      } catch (err) {
        console.error('[composio-webhook] Dispatch failed', err);
        res.status(500).json({ error: 'Dispatch failed' });
      }
    },
  );
}
