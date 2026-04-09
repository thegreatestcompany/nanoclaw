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
    slug: 'GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER',
    toolkit: 'googlecalendar',
    triggerConfig: {
      calendarId: 'primary',
      minutes_before_start: 15, // fire 15 min before an event starts
      countdown_window_minutes: 60, // look 60 min ahead
      interval: 2, // poll every 2 min (Composio default)
      include_all_day: false, // skip all-day events
    },
    description: 'Calendar event starting soon (15 min before)',
  },
  {
    slug: 'GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER',
    toolkit: 'googlecalendar',
    triggerConfig: {
      calendarId: 'primary',
      interval: 2, // poll every 2 min
    },
    description: 'Calendar event canceled or deleted',
  },
  // Gmail is intentionally NOT here — most emails are noise, Otto would
  // burn budget analyzing each one with no real value (client can check
  // their own inbox). Calendar reminders are high-signal, low-volume.
  // Slack/Stripe/CRM triggers deliberately omitted to keep Otto's target
  // audience (light-tech-stack SMBs) aligned with the product positioning.
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

interface ConnectedAccountRaw {
  id?: string;
  status?: string;
  toolkit?: { slug?: string };
}

/**
 * List connected accounts for a given user_id (Composio user_id = WhatsApp JID).
 * Used to find the connected_account_id needed to create a trigger.
 */
async function listConnectedAccountsForUser(
  userId: string,
  toolkitSlug?: string,
): Promise<ConnectedAccountRaw[]> {
  const params = new URLSearchParams({ user_ids: userId });
  if (toolkitSlug) params.set('toolkit_slugs', toolkitSlug);
  const data = (await composioFetch(
    `/connected_accounts?${params.toString()}`,
  )) as { items?: ConnectedAccountRaw[] };
  return data.items || [];
}

/**
 * Create (upsert) a single trigger instance bound to a user_id + connected account.
 * Endpoint: POST /api/v3/trigger_instances/{slug}/upsert
 *
 * Composio requires connected_account_id explicitly — we look it up for the
 * given user/toolkit before creating.
 */
export async function createTrigger(
  userId: string,
  slug: string,
  toolkitSlug: string,
  triggerConfig: Record<string, unknown>,
): Promise<{ triggerId: string }> {
  const accounts = await listConnectedAccountsForUser(userId, toolkitSlug);
  const active = accounts.find((a) => a.status === 'ACTIVE') || accounts[0];
  if (!active?.id) {
    throw new Error(`No connected account for toolkit ${toolkitSlug} (user ${userId})`);
  }

  const data = (await composioFetch(
    `/trigger_instances/${encodeURIComponent(slug)}/upsert`,
    {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        connected_account_id: active.id,
        trigger_config: triggerConfig,
      }),
    },
  )) as { id?: string; trigger_id?: string };

  return { triggerId: data.id || data.trigger_id || '' };
}

/**
 * Provision the default set of triggers for a given client.
 * The composioUserId is the WhatsApp JID used by the agent-runner when
 * initializing the Composio MCP (see container/agent-runner/src/index.ts).
 * Skips triggers where the toolkit isn't connected yet.
 */
export async function provisionDefaultTriggers(
  composioUserId: string,
): Promise<{
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
        composioUserId,
        trigger.slug,
        trigger.toolkit,
        trigger.triggerConfig,
      );
      console.log(
        `[composio-triggers] Created ${trigger.slug} for ${composioUserId}: ${result.triggerId}`,
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
          `[composio-triggers] Skipped ${trigger.slug} for ${composioUserId} (toolkit not connected)`,
        );
        skipped.push(trigger.slug);
      } else {
        console.error(
          `[composio-triggers] Failed ${trigger.slug} for ${composioUserId}: ${msg}`,
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
 * List all active triggers for a client (composioUserId = WhatsApp JID).
 * Endpoint: GET /api/v3/trigger_instances/active
 */
export async function listClientTriggers(composioUserId: string): Promise<
  Array<{
    triggerId: string;
    triggerSlug: string;
    connectedAccountId: string;
    disabled: boolean;
  }>
> {
  const data = (await composioFetch(
    `/trigger_instances/active?user_id=${encodeURIComponent(composioUserId)}`,
  )) as { items?: ActiveTriggerRaw[] } | ActiveTriggerRaw[];

  const items = Array.isArray(data) ? data : data.items || [];

  return items
    .filter((t) => !t.user_id || t.user_id === composioUserId)
    .map((t) => ({
      triggerId: t.id || t.trigger_id || '',
      triggerSlug: t.slug || t.trigger_slug || '',
      connectedAccountId: t.connected_account_id || '',
      disabled: t.disabled === true,
    }));
}

/**
 * Periodic job: try to provision default triggers for all active clients.
 * Idempotent — clients without connected Calendar are skipped silently,
 * clients with triggers already created get no-ops.
 *
 * The caller provides pairs of (clientId, composioUserId=whatsappJid).
 * Clients without a JID (not yet linked) are skipped.
 */
export async function runPeriodicTriggerProvisioning(
  getActiveClients: () => Array<{ clientId: string; composioUserId: string | null }>,
): Promise<void> {
  if (!process.env.COMPOSIO_API_KEY) {
    return; // Composio not configured — skip silently
  }
  const clients = getActiveClients().filter((c) => c.composioUserId);
  for (const { clientId, composioUserId } of clients) {
    if (!composioUserId) continue;
    try {
      // Check what's already provisioned to avoid duplicates
      const existing = await listClientTriggers(composioUserId);
      const existingSlugs = new Set(existing.map((t) => t.triggerSlug));
      const missing = DEFAULT_TRIGGERS.filter(
        (t) => !existingSlugs.has(t.slug),
      );
      if (missing.length === 0) continue;

      for (const trigger of missing) {
        try {
          const result = await createTrigger(
            composioUserId,
            trigger.slug,
            trigger.toolkit,
            trigger.triggerConfig,
          );
          console.log(
            `[composio-triggers] Auto-provisioned ${trigger.slug} for ${clientId}: ${result.triggerId}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Skip silently if toolkit not connected yet
          if (
            !msg.toLowerCase().includes('connected account') &&
            !msg.toLowerCase().includes('not found') &&
            !msg.toLowerCase().includes('no connection')
          ) {
            console.error(
              `[composio-triggers] Auto-provision ${trigger.slug} for ${clientId} failed: ${msg}`,
            );
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('not found')) {
        console.error(
          `[composio-triggers] Periodic provisioning error for ${clientId}: ${msg}`,
        );
      }
    }
  }
}

/**
 * Delete all triggers for a client (called at deprovisioning).
 * Endpoint: DELETE /api/v3/trigger_instances/manage/{triggerId}
 */
export async function deleteAllClientTriggers(
  composioUserId: string,
): Promise<number> {
  const triggers = await listClientTriggers(composioUserId);
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
