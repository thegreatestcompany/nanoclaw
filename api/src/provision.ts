/**
 * Client provisioning — creates folders, business.db, .env, Anthropic
 * workspace+API key, and prepares the PM2 wrapper.
 *
 * On macOS (dev), provisioning is simulated in a local directory.
 * On Linux (prod), it creates real Linux users and PM2 processes.
 *
 * NOTE: PM2 process is NOT started here — it starts after WhatsApp
 * auth succeeds (in onboard.ts → startClientProcess).
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { getDb, getNextProxyPort, setClientProxyPort } from './db.js';

const IS_LINUX = os.platform() === 'linux';
const CLIENTS_DIR = process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');
const APP_DIR = process.env.APP_DIR || path.join(process.cwd(), '..', 'app');
const INIT_SQL = path.join(APP_DIR, 'scripts', 'init-business-db.sql');
const ANTHROPIC_ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY || '';

export interface ProvisionResult {
  clientId: string;
  onboardToken: string;
  onboardUrl: string;
}

/**
 * Create an Anthropic workspace and API key for a client.
 * Returns the API key string, or null if Admin API is not configured.
 */
async function createAnthropicCredentials(clientId: string): Promise<{
  apiKey: string | null;
  workspaceId: string | null;
  apiKeyId: string | null;
}> {
  if (!ANTHROPIC_ADMIN_KEY) {
    console.warn('ANTHROPIC_ADMIN_KEY not set — using shared API key for client');
    // Fallback to shared key from the API's environment
    const sharedKey = process.env.ANTHROPIC_API_KEY || '';
    return { apiKey: sharedKey || null, workspaceId: null, apiKeyId: null };
  }

  try {
    // 1. Create workspace
    const wsRes = await fetch('https://api.anthropic.com/v1/organizations/workspaces', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_ADMIN_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: `otto-${clientId}` }),
    });
    const workspace = await wsRes.json() as { id: string };

    if (!workspace.id) {
      console.error('Failed to create Anthropic workspace:', workspace);
      const sharedKey = process.env.ANTHROPIC_API_KEY || '';
      return { apiKey: sharedKey || null, workspaceId: null, apiKeyId: null };
    }

    // Note: Anthropic Admin API does NOT support creating API keys programmatically.
    // Keys can only be created in the Console. We use the shared API key for all
    // clients but track costs per workspace via the usage_report API.
    const sharedKey = process.env.ANTHROPIC_API_KEY || '';
    console.log(`Anthropic workspace ${workspace.id} created for ${clientId} (using shared API key)`);
    return { apiKey: sharedKey || null, workspaceId: workspace.id, apiKeyId: null };
  } catch (err) {
    console.error('Anthropic Admin API error:', err);
    const sharedKey = process.env.ANTHROPIC_API_KEY || '';
    return { apiKey: sharedKey || null, workspaceId: null, apiKeyId: null };
  }
}

/**
 * Revoke an Anthropic API key. Called during deprovisioning.
 */
export async function revokeAnthropicApiKey(apiKeyId: string): Promise<void> {
  if (!ANTHROPIC_ADMIN_KEY || !apiKeyId) return;

  try {
    await fetch(`https://api.anthropic.com/v1/organizations/api_keys/${apiKeyId}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': ANTHROPIC_ADMIN_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    console.log(`Revoked Anthropic API key ${apiKeyId}`);
  } catch (err) {
    console.error('Failed to revoke Anthropic API key:', err);
  }
}

export async function provisionClient(
  clientId: string,
  email: string,
  stripeCustomerId: string,
  apiKey?: string,
  customerName?: string | null,
  companyName?: string | null,
): Promise<ProvisionResult> {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const db = getDb();

  // 1. Create directory structure
  const dirs = [
    path.join(clientDir, 'groups', 'main', 'memory', 'people'),
    path.join(clientDir, 'groups', 'main', 'memory', 'projects'),
    path.join(clientDir, 'groups', 'main', 'memory', 'context'),
    path.join(clientDir, 'groups', 'main', 'documents'),
    path.join(clientDir, 'groups', 'main', 'logs'),
    path.join(clientDir, 'groups', 'global'),
    path.join(clientDir, 'store'),
    path.join(clientDir, 'store', 'auth'),
    path.join(clientDir, 'logs'),
    path.join(clientDir, 'data', 'env'),
    path.join(clientDir, 'data', 'models'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 2. Initialize business.db and seed with client's own contact
  const bizDbPath = path.join(clientDir, 'groups', 'main', 'business.db');
  if (fs.existsSync(INIT_SQL)) {
    execSync(`sqlite3 "${bizDbPath}" < "${INIT_SQL}"`);
    // Seed the owner as the first contact so Otto knows who it's talking to
    if (customerName || email) {
      const Database = (await import('better-sqlite3')).default;
      const bizDb = new Database(bizDbPath);
      bizDb.prepare(
        `INSERT INTO contacts (name, email, role, notes) VALUES (?, ?, 'Dirigeant', 'Contact principal — propriétaire du compte Otto')`
      ).run(customerName || email.split('@')[0], email);
      bizDb.close();
    }
  }

  // 3. Copy CLAUDE.md templates (with client-specific substitutions)
  const globalTemplate = path.join(APP_DIR, 'groups', 'global', 'CLAUDE.md');
  const mainTemplate = path.join(APP_DIR, 'groups', 'main', 'CLAUDE.md');
  if (fs.existsSync(globalTemplate)) {
    fs.copyFileSync(globalTemplate, path.join(clientDir, 'groups', 'global', 'CLAUDE.md'));
  }
  if (fs.existsSync(mainTemplate)) {
    let mainContent = fs.readFileSync(mainTemplate, 'utf8');
    // Replace placeholder section with actual client data
    const dirigeantSection = `## Dirigeant\n\n- Nom : ${customerName || '[À remplir]'}\n- Email : ${email}\n- Entreprise : ${companyName || '[À remplir]'}\n- Secteur : [À remplir]\n- Taille équipe : [À remplir]\n- Contacts clés : [À remplir]\n- Préférences : [À remplir]`;
    mainContent = mainContent.replace(
      /## Dirigeant\n\n[\s\S]*?(?=\n---)/,
      dirigeantSection,
    );
    fs.writeFileSync(path.join(clientDir, 'groups', 'main', 'CLAUDE.md'), mainContent);
  }

  // 4. Create memory template files (pre-populated with known data)
  const memoryDir = path.join(clientDir, 'groups', 'main', 'memory');
  fs.writeFileSync(
    path.join(memoryDir, 'glossary.md'),
    '# Glossaire\n\n| Terme | Signification | Ajouté le |\n|-------|--------------|----------|\n',
  );
  fs.writeFileSync(
    path.join(memoryDir, 'context', 'company.md'),
    `# Contexte entreprise\n\n- Dirigeant : ${customerName || '[À remplir]'}\n- Email : ${email}\n- Entreprise : ${companyName || '[À remplir — demander au dirigeant]'}\n- Secteur : [À remplir]\n- Effectif : [À remplir]\n`,
  );
  fs.writeFileSync(
    path.join(memoryDir, 'context', 'preferences.md'),
    '# Préférences du dirigeant\n\n[Mis à jour automatiquement]\n',
  );

  // 5. Create Anthropic workspace + API key for this client
  let clientApiKey = apiKey;
  let workspaceId: string | null = null;
  let apiKeyId: string | null = null;

  if (!clientApiKey) {
    const creds = await createAnthropicCredentials(clientId);
    clientApiKey = creds.apiKey || undefined;
    workspaceId = creds.workspaceId;
    apiKeyId = creds.apiKeyId;
  }

  // 6. Allocate a unique proxy port
  const proxyPort = getNextProxyPort();

  // 7. Write .env (NEVER include the admin key — only the client's own API key)
  const envLines = [
    `ANTHROPIC_API_KEY=${clientApiKey || 'TO_BE_SET'}`,
    'ASSISTANT_NAME=Otto',
    'TZ=Europe/Paris',
    `CLIENT_ID=${clientId}`,
    `CREDENTIAL_PROXY_PORT=${proxyPort}`,
    `WHISPER_MODEL=${APP_DIR}/data/models/ggml-small.bin`,
  ];
  // Pass through shared API keys from the API's env
  if (process.env.EXA_API_KEY) envLines.push(`EXA_API_KEY=${process.env.EXA_API_KEY}`);
  if (process.env.OPENAI_API_KEY) envLines.push(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
  if (process.env.PORTAL_JWT_SECRET) envLines.push(`PORTAL_JWT_SECRET=${process.env.PORTAL_JWT_SECRET}`);
  const envContent = envLines.join('\n');
  fs.writeFileSync(path.join(clientDir, '.env'), envContent, { mode: 0o600 });
  fs.mkdirSync(path.join(clientDir, 'data', 'env'), { recursive: true });
  fs.copyFileSync(path.join(clientDir, '.env'), path.join(clientDir, 'data', 'env', 'env'));

  // 8. Create the PM2 wrapper script
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
  fs.writeFileSync(path.join(clientDir, 'start-pm2.sh'), wrapperContent, { mode: 0o755 });

  // 9. Fix permissions for Docker containers (agent runs as user "node", uid 1000, gid 1000)
  // Use group ownership instead of world-writable for multi-tenant safety.
  try {
    execSync(
      `chown -R root:1000 "${clientDir}/groups/" "${clientDir}/data/" "${clientDir}/store/" && ` +
      `chmod -R u=rwX,g=rwX,o= "${clientDir}/groups/" "${clientDir}/data/" "${clientDir}/store/"`,
    );
  } catch { /* best effort */ }

  // 10. On Linux (prod): create Linux user + UFW rule
  if (IS_LINUX) {
    try {
      execSync(`sudo useradd -r -s /bin/false otto-${clientId} 2>/dev/null || true`);
      execSync(`sudo ufw allow from 172.17.0.0/16 to any port ${proxyPort} 2>/dev/null || true`);
    } catch (err) {
      console.error('Linux provisioning error (non-fatal):', err);
    }
  }

  // 11. Generate onboard token
  const onboardToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  db.prepare(`
    INSERT OR REPLACE INTO clients (id, email, name, company, stripe_customer_id, anthropic_workspace_id, anthropic_api_key_id, proxy_port, onboard_token, onboard_token_expires_at, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_whatsapp', datetime('now'))
  `).run(clientId, email, customerName, companyName, stripeCustomerId, workspaceId, apiKeyId, proxyPort, onboardToken, expiresAt);

  // Store the port
  setClientProxyPort(clientId, proxyPort);

  console.log(`Client ${clientId} provisioned at ${clientDir} (port ${proxyPort})`);

  return {
    clientId,
    onboardToken,
    onboardUrl: `${baseUrl}/onboard/${onboardToken}`,
  };
}

export async function deprovisionClient(clientId: string): Promise<void> {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const db = getDb();

  // Stop PM2 process
  try {
    execSync(`pm2 stop otto-${clientId} && pm2 delete otto-${clientId}`);
    execSync('pm2 save');
  } catch { /* may not exist */ }

  // Revoke Anthropic API key
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId) as any;
  if (client?.anthropic_api_key_id) {
    await revokeAnthropicApiKey(client.anthropic_api_key_id);
  }

  // Archive client data
  const backupDir = path.join(CLIENTS_DIR, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  try {
    execSync(`tar czf "${backupDir}/${clientId}-${date}.tar.gz" -C "${CLIENTS_DIR}" "${clientId}"`);
  } catch (err) {
    console.error('Backup error:', err);
  }

  // Remove client directory
  fs.rmSync(clientDir, { recursive: true, force: true });

  // Remove Linux user + UFW rule (prod only)
  if (IS_LINUX) {
    try {
      execSync(`sudo userdel otto-${clientId} 2>/dev/null || true`);
      if (client?.proxy_port) {
        execSync(`sudo ufw delete allow ${client.proxy_port}/tcp 2>/dev/null || true`);
      }
    } catch { /* ignore */ }
  }

  db.prepare(`UPDATE clients SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run('cancelled', clientId);

  console.log(`Client ${clientId} deprovisioned`);
}
