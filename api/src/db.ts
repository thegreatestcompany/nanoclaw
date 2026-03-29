/**
 * Onboarding database — tracks clients, provisioning status, and onboard tokens.
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.API_DB_PATH || path.join(process.cwd(), 'data', 'onboarding.db');

let db: Database.Database;

export function initDb(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      company TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      anthropic_workspace_id TEXT,
      anthropic_api_key_id TEXT,
      status TEXT DEFAULT 'provisioning',
      onboard_token TEXT,
      onboard_token_expires_at TEXT,
      whatsapp_jid TEXT,
      trial_ends_at TEXT,
      cancel_at TEXT,
      cancel_reason TEXT,
      proxy_port INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration for existing DBs
  try {
    db.exec('ALTER TABLE clients ADD COLUMN proxy_port INTEGER');
  } catch { /* column already exists */ }
}

export function getDb(): Database.Database {
  return db;
}

export interface Client {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  stripe_customer_id: string | null;
  anthropic_workspace_id: string | null;
  anthropic_api_key_id: string | null;
  status: string;
  onboard_token: string | null;
  onboard_token_expires_at: string | null;
  whatsapp_jid: string | null;
  trial_ends_at: string | null;
  cancel_at: string | null;
  cancel_reason: string | null;
  proxy_port: number | null;
  created_at: string;
  updated_at: string;
}

export function getClientByToken(token: string): Client | undefined {
  return db.prepare(
    `SELECT * FROM clients WHERE onboard_token = ? AND onboard_token_expires_at > datetime('now')`
  ).get(token) as Client | undefined;
}

export function getClientById(id: string): Client | undefined {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as Client | undefined;
}

export function getAllClients(): Client[] {
  return db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all() as Client[];
}

export function updateClientStatus(id: string, status: string): void {
  db.prepare(`UPDATE clients SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function slugify(email: string): string {
  return email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
}

const BASE_PROXY_PORT = 3002; // 3001 is reserved for otto-prod (main instance)

export function getNextProxyPort(): number {
  const row = db.prepare('SELECT MAX(proxy_port) as maxPort FROM clients').get() as { maxPort: number | null };
  return (row.maxPort || BASE_PROXY_PORT - 1) + 1;
}

export function setClientProxyPort(clientId: string, port: number): void {
  db.prepare(`UPDATE clients SET proxy_port = ?, updated_at = datetime('now') WHERE id = ?`).run(port, clientId);
}

export function getClientByEmail(email: string): Client | undefined {
  return db.prepare('SELECT * FROM clients WHERE email = ?').get(email) as Client | undefined;
}

export function renewOnboardToken(clientId: string): { token: string; expiresAt: string } {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `UPDATE clients SET onboard_token = ?, onboard_token_expires_at = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(token, expiresAt, clientId);
  return { token, expiresAt };
}
