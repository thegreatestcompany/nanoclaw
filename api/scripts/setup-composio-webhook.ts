/**
 * One-shot script: create a Composio webhook subscription for this environment.
 *
 * Usage:
 *   cd /opt/otto/app/api
 *   COMPOSIO_API_KEY=xxx tsx scripts/setup-composio-webhook.ts
 *
 * Output: the webhook secret. Copy it into api/.env as COMPOSIO_WEBHOOK_SECRET
 * then restart otto-api.
 *
 * Run this only ONCE per environment. Re-running creates a new subscription.
 */

import { createWebhookSubscription } from '../src/composio-triggers.js';

async function main(): Promise<void> {
  const webhookUrl =
    process.env.COMPOSIO_WEBHOOK_URL ||
    'https://otto.hntic.fr/api/webhook/composio';

  console.log(`Creating Composio webhook subscription for: ${webhookUrl}`);

  try {
    const { subscriptionId, secret } = await createWebhookSubscription(
      webhookUrl,
    );
    console.log('\n✅ Webhook subscription created!');
    console.log(`  Subscription ID: ${subscriptionId}`);
    console.log(`  Secret (copy to api/.env): COMPOSIO_WEBHOOK_SECRET=${secret}`);
    console.log('\n⚠️  This secret is only shown once. Save it now.');
  } catch (err) {
    console.error('❌ Failed to create webhook subscription:', err);
    process.exit(1);
  }
}

main();
