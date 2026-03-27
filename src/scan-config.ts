/**
 * Cache for scan_config from business.db.
 * Maintains a Set of ignored JIDs, refreshed periodically.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let ignoredJids = new Set<string>();
let lastRefresh = 0;

function getBusinessDbPath(): string {
  return path.join(GROUPS_DIR, 'main', 'business.db');
}

/**
 * Refresh the ignored JIDs cache from business.db scan_config table.
 */
function refreshCache(): void {
  const dbPath = getBusinessDbPath();
  if (!fs.existsSync(dbPath)) {
    return; // business.db not yet initialized
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(`SELECT chat_jid FROM scan_config WHERE mode = 'ignore'`)
      .all() as { chat_jid: string }[];
    db.close();

    ignoredJids = new Set(rows.map((r) => r.chat_jid));
    lastRefresh = Date.now();
    logger.debug(
      { count: ignoredJids.size },
      'Refreshed scan_config ignored JIDs cache',
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Could not read scan_config (business.db may not be initialized yet)',
    );
  }
}

/**
 * Check if a chat JID should be ignored (not stored at all).
 * Uses a cached Set refreshed every 5 minutes.
 */
export function isJidIgnored(chatJid: string): boolean {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    refreshCache();
  }
  return ignoredJids.has(chatJid);
}
