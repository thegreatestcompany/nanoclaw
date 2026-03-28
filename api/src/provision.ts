/**
 * Client provisioning — creates Linux user, folders, business.db,
 * .env, and PM2 process for a new client.
 *
 * On macOS (dev), provisioning is simulated in a local directory.
 * On Linux (prod), it creates real Linux users and PM2 processes.
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { getDb } from './db.js';

const IS_LINUX = os.platform() === 'linux';
const CLIENTS_DIR = process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');
const APP_DIR = process.env.APP_DIR || path.join(process.cwd(), '..');
const INIT_SQL = path.join(APP_DIR, 'scripts', 'init-business-db.sql');

export interface ProvisionResult {
  clientId: string;
  onboardToken: string;
  onboardUrl: string;
}

export async function provisionClient(
  clientId: string,
  email: string,
  stripeCustomerId: string,
  apiKey?: string,
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
    path.join(clientDir, 'auth'),
    path.join(clientDir, 'logs'),
    path.join(clientDir, 'data', 'env'),
    path.join(clientDir, 'data', 'models'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 2. Initialize business.db
  const bizDbPath = path.join(clientDir, 'groups', 'main', 'business.db');
  if (fs.existsSync(INIT_SQL)) {
    execSync(`sqlite3 "${bizDbPath}" < "${INIT_SQL}"`);
  }

  // 3. Copy CLAUDE.md templates
  const globalTemplate = path.join(APP_DIR, 'groups', 'global', 'CLAUDE.md');
  const mainTemplate = path.join(APP_DIR, 'groups', 'main', 'CLAUDE.md');
  if (fs.existsSync(globalTemplate)) {
    fs.copyFileSync(globalTemplate, path.join(clientDir, 'groups', 'global', 'CLAUDE.md'));
  }
  if (fs.existsSync(mainTemplate)) {
    fs.copyFileSync(mainTemplate, path.join(clientDir, 'groups', 'main', 'CLAUDE.md'));
  }

  // 4. Create memory template files
  const memoryDir = path.join(clientDir, 'groups', 'main', 'memory');
  fs.writeFileSync(
    path.join(memoryDir, 'glossary.md'),
    '# Glossaire\n\n| Terme | Signification | Ajouté le |\n|-------|--------------|----------|\n',
  );
  fs.writeFileSync(
    path.join(memoryDir, 'context', 'company.md'),
    '# Contexte entreprise\n\n[À remplir pendant l\'onboarding]\n',
  );
  fs.writeFileSync(
    path.join(memoryDir, 'context', 'preferences.md'),
    '# Préférences du dirigeant\n\n[Mis à jour automatiquement]\n',
  );

  // 5. Write .env
  const envContent = [
    `ANTHROPIC_API_KEY=${apiKey || 'TO_BE_SET'}`,
    'ASSISTANT_NAME=Otto',
    'TZ=Europe/Paris',
    `CLIENT_ID=${clientId}`,
  ].join('\n');
  fs.writeFileSync(path.join(clientDir, '.env'), envContent, { mode: 0o600 });
  fs.copyFileSync(path.join(clientDir, '.env'), path.join(clientDir, 'data', 'env', 'env'));

  // 6. On Linux (prod): create Linux user + PM2 process
  if (IS_LINUX) {
    try {
      execSync(`sudo useradd -r -s /bin/false otto-${clientId} 2>/dev/null || true`);
      execSync(`sudo chown -R otto-${clientId}: ${clientDir}`);
      execSync(`sudo chmod 700 ${clientDir}`);
      execSync(
        `pm2 start ${APP_DIR}/dist/index.js ` +
        `--name otto-${clientId} ` +
        `--uid otto-${clientId} ` +
        `-- --data-dir ${clientDir}`,
      );
      execSync('pm2 save');
    } catch (err) {
      console.error('Linux provisioning error (non-fatal):', err);
    }
  }

  // 7. Generate onboard token
  const onboardToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  db.prepare(`
    INSERT OR REPLACE INTO clients (id, email, stripe_customer_id, onboard_token, onboard_token_expires_at, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'awaiting_whatsapp', datetime('now'))
  `).run(clientId, email, stripeCustomerId, onboardToken, expiresAt);

  console.log(`Client ${clientId} provisioned at ${clientDir}`);

  return {
    clientId,
    onboardToken,
    onboardUrl: `${baseUrl}/onboard/${onboardToken}`,
  };
}

export async function deprovisionClient(clientId: string): Promise<void> {
  const clientDir = path.join(CLIENTS_DIR, clientId);
  const db = getDb();

  // Stop PM2 process (Linux only)
  if (IS_LINUX) {
    try {
      execSync(`pm2 stop otto-${clientId} && pm2 delete otto-${clientId}`);
      execSync('pm2 save');
    } catch { /* may not exist */ }
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

  // Remove Linux user (prod only)
  if (IS_LINUX) {
    try {
      execSync(`sudo userdel otto-${clientId} 2>/dev/null || true`);
    } catch { /* ignore */ }
  }

  db.prepare('UPDATE clients SET status = ?, updated_at = datetime("now") WHERE id = ?')
    .run('cancelled', clientId);

  console.log(`Client ${clientId} deprovisioned`);
}
