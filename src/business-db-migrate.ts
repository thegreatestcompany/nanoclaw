/**
 * Business DB migration system.
 *
 * Uses PRAGMA user_version to track schema version.
 * Runs automatically at process startup — applies only missing migrations.
 * Each migration is idempotent (uses IF NOT EXISTS, IF NOT COLUMN checks).
 *
 * To add a migration:
 * 1. Add a new entry to MIGRATIONS array with the next version number
 * 2. Write the SQL (use IF NOT EXISTS for safety)
 * 3. Bump CURRENT_VERSION
 * That's it — existing clients will auto-migrate on next process restart.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

// Current schema version — increment when adding migrations
const CURRENT_VERSION = 0;

interface Migration {
  version: number;
  description: string;
  sql: string;
}

// Migration list — append only, never modify existing entries
const MIGRATIONS: Migration[] = [
  // Example for future use:
  // {
  //   version: 1,
  //   description: 'Add priority column to deals',
  //   sql: `ALTER TABLE deals ADD COLUMN priority TEXT DEFAULT 'medium';`,
  // },
];

/**
 * Run pending migrations on a business.db file.
 * Safe to call on every startup — skips already-applied migrations.
 */
export function migrateBusinessDb(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath);
  try {
    const currentVersion =
      (db.pragma('user_version', { simple: true }) as number) || 0;

    if (currentVersion >= CURRENT_VERSION) return;

    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
    if (pending.length === 0) return;

    logger.info(
      {
        dbPath: path.basename(dbPath),
        from: currentVersion,
        to: CURRENT_VERSION,
        count: pending.length,
      },
      'Running business.db migrations',
    );

    db.pragma('journal_mode = WAL');

    for (const migration of pending) {
      try {
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.version}`);
        logger.info(
          { version: migration.version, description: migration.description },
          'Migration applied',
        );
      } catch (err) {
        logger.error(
          {
            version: migration.version,
            description: migration.description,
            err,
          },
          'Migration failed — stopping',
        );
        break;
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Run migrations on all business.db files found in GROUPS_DIR.
 * Called once at process startup.
 */
export function migrateAllBusinessDbs(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  for (const group of fs.readdirSync(GROUPS_DIR)) {
    const dbPath = path.join(GROUPS_DIR, group, 'business.db');
    if (fs.existsSync(dbPath)) {
      migrateBusinessDb(dbPath);
    }
  }
}
