/**
 * Composio triggers management — utilities to create/list/delete triggers
 * per client. Uses Composio HTTP API directly (no SDK dependency).
 *
 * Setup (one-time per environment):
 *   1. Set COMPOSIO_API_KEY in api/.env
 *   2. Run `npm run composio:setup-webhook` (creates a webhook subscription
 *      pointing to https://otto.hntic.fr/webhook/composio)
 *   3. Store the returned secret in api/.env as COMPOSIO_WEBHOOK_SECRET
 *
 * Per-client provisioning:
 *   After a client connects their Gmail/Slack/Calendar via the existing
 *   Composio Managed Auth flow, call `provisionDefaultTriggers(clientId)` to
 *   create the default set of triggers for that user.
 */

const COMPOSIO_API_BASE = 'https://backend.composio.dev/api/v3';

/**
 * Default triggers to create for each client when their account is active.
 * Configured with reasonable defaults — user can disable them via portal later.
 *
 * Slugs are validated at runtime; if Composio rejects a slug we'll see it in logs.
 * List of verified slugs: check via GET /api/v3/triggers_types or dashboard.
 */
const DEFAULT_TRIGGERS: Array<{
  slug: string;
  toolkit: string;
  triggerConfig: Record<string, unknown>;
  description: string;
}> = [
  {
    slug: 'GMAIL_NEW_GMAIL_MESSAGE',
    toolkit: 'gmail',
    triggerConfig: {
      interval: 15, // minutes — min is 15 for Gmail polling
      userId: 'me',
      labelIds: 'INBOX',
    },
    description: 'New Gmail message in inbox (polled every 15 min)',
  },
  // Add more as we validate slugs against the API:
  // - GOOGLECALENDAR_EVENT_STARTING_SOON
  // - SLACK_RECEIVE_MESSAGE
];

function getApiKey(): string {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error('COMPOSIO_API_KEY not set in environment');
  }
  return apiKey;
}

async function composioFetch(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    ...init,
    headers: {
      'X-API-KEY': getApiKey(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Composio API ${response.status}: ${errorText.slice(0, 500)}`,
    );
  }
  return response.json();
}

/**
 * Create a webhook subscription for this environment. Run once at setup.
 * Returns the secret that must be stored as COMPOSIO_WEBHOOK_SECRET.
 */
export async function createWebhookSubscription(
  webhookUrl: string,
): Promise<{ subscriptionId: string; secret: string }> {
  const data = (await composioFetch('/webhook_subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      webhook_url: webhookUrl,
      enabled_events: [
        'composio.trigger.message',
        'composio.connected_account.expired',
      ],
    }),
  })) as { id?: string; subscription_id?: string; secret?: string };

  const subscriptionId = data.id || data.subscription_id || '';
  const secret = data.secret || '';
  if (!secret) {
    throw new Error('Webhook subscription created but no secret returned');
  }
  return { subscriptionId, secret };
}

/**
 * Create (upsert) a single trigger instance bound to a user_id + connected account.
 * Endpoint: POST /api/v3/trigger_instances/{slug}/upsert
 */
export async function createTrigger(
  userId: string,
  slug: string,
  triggerConfig: Record<string, unknown>,
): Promise<{ triggerId: string }> {
  const data = (await composioFetch(
    `/trigger_instances/${encodeURIComponent(slug)}/upsert`,
    {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        trigger_config: triggerConfig,
      }),
    },
  )) as { id?: string; trigger_id?: string };

  return { triggerId: data.id || data.trigger_id || '' };
}

/**
 * Provision the default set of triggers for a given client.
 * Skips triggers where the toolkit isn't connected yet.
 */
export async function provisionDefaultTriggers(clientId: string): Promise<{
  created: string[];
  skipped: string[];
  failed: Array<{ slug: string; error: string }>;
}> {
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ slug: string; error: string }> = [];

  for (const trigger of DEFAULT_TRIGGERS) {
    try {
      const result = await createTrigger(
        clientId,
        trigger.slug,
        trigger.triggerConfig,
      );
      console.log(
        `[composio-triggers] Created ${trigger.slug} for ${clientId}: ${result.triggerId}`,
      );
      created.push(trigger.slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Common case: toolkit not connected yet → skip silently
      if (
        msg.toLowerCase().includes('connected account') ||
        msg.toLowerCase().includes('not found') ||
        msg.toLowerCase().includes('no connection')
      ) {
        console.log(
          `[composio-triggers] Skipped ${trigger.slug} for ${clientId} (toolkit not connected)`,
        );
        skipped.push(trigger.slug);
      } else {
        console.error(
          `[composio-triggers] Failed ${trigger.slug} for ${clientId}: ${msg}`,
        );
        failed.push({ slug: trigger.slug, error: msg });
      }
    }
  }

  return { created, skipped, failed };
}

interface ActiveTriggerRaw {
  id?: string;
  trigger_id?: string;
  slug?: string;
  trigger_slug?: string;
  connected_account_id?: string;
  user_id?: string;
  disabled?: boolean;
}

/**
 * List all active triggers for a client.
 * Endpoint: GET /api/v3/trigger_instances/active
 */
export async function listClientTriggers(clientId: string): Promise<
  Array<{
    triggerId: string;
    triggerSlug: string;
    connectedAccountId: string;
    disabled: boolean;
  }>
> {
  const data = (await composioFetch(
    `/trigger_instances/active?user_id=${encodeURIComponent(clientId)}`,
  )) as { items?: ActiveTriggerRaw[] } | ActiveTriggerRaw[];

  const items = Array.isArray(data) ? data : data.items || [];

  return items
    .filter((t) => !t.user_id || t.user_id === clientId)
    .map((t) => ({
      triggerId: t.id || t.trigger_id || '',
      triggerSlug: t.slug || t.trigger_slug || '',
      connectedAccountId: t.connected_account_id || '',
      disabled: t.disabled === true,
    }));
}

/**
 * Delete all triggers for a client (called at deprovisioning).
 * Endpoint: DELETE /api/v3/trigger_instances/manage/{triggerId}
 */
export async function deleteAllClientTriggers(
  clientId: string,
): Promise<number> {
  const triggers = await listClientTriggers(clientId);
  let deleted = 0;
  for (const t of triggers) {
    try {
      await composioFetch(
        `/trigger_instances/manage/${encodeURIComponent(t.triggerId)}`,
        { method: 'DELETE' },
      );
      deleted++;
    } catch (err) {
      console.error(
        `[composio-triggers] Failed to delete ${t.triggerId}:`,
        err,
      );
    }
  }
  return deleted;
}
