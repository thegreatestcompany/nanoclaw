/**
 * MCP server in-process pour l'accès à la business.db.
 * Fournit query_business_db (lecture) et mutate_business_db (écriture + audit).
 *
 * Tourne dans le même process que l'agent-runner — pas de spawn sqlite3.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = '/workspace/group/business.db';
let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`Business database not found at ${DB_PATH}. Run init-business-db.sh first.`);
    }
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Hard limits to prevent context/cost explosion
const MAX_ROWS = 50;
const MAX_FIELD_CHARS = 500;  // per-field truncation for long text columns
const MAX_RESPONSE_BYTES = 32_000; // ~8K tokens — final safety net

// Columns that can contain very long text (document extracts, summaries, notes)
const LONG_TEXT_COLUMNS = new Set([
  'extracted_text', 'content', 'summary', 'notes', 'description',
  'rationale', 'context', 'action_items', 'key_facts', 'open_items',
]);

/**
 * Truncate long text fields in query results to prevent context explosion.
 * Individual rows with a 50-page PDF extract would otherwise blow up costs.
 */
function truncateRows(rows: Record<string, unknown>[], fieldLimit = MAX_FIELD_CHARS): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && value.length > fieldLimit && LONG_TEXT_COLUMNS.has(key)) {
        out[key] = value.slice(0, fieldLimit) + `... [${value.length} chars total — query this record by ID for full text]`;
      } else {
        out[key] = value;
      }
    }
    return out;
  });
}

const queryBusinessDb = tool(
  'query_business_db',
  `Execute a read-only SQL query on the business database. Returns JSON rows.
Tables: companies, contacts, deals, interactions, projects, team_members,
assignments, absences, reviews, suppliers, invoices, expenses, contracts,
obligations, decisions, goals, meetings, documents, memories,
relationship_summaries, activity_digests, audit_log, scan_config.

RULES:
- Always use parameterized queries with ? placeholders.
- Never SELECT * — always specify the columns you need.
- Always add a LIMIT clause (max ${MAX_ROWS} rows). Queries without LIMIT are auto-capped.
- Filter by date/status to reduce result size. Default to the last 3 months.
- For large tables (interactions, memories, audit_log), always use WHERE clauses.
- To get an overview, use COUNT(*) first, then query specific rows.
- Long text fields (extracted_text, notes, content, summary) are auto-truncated to ${MAX_FIELD_CHARS} chars. Query a specific record by ID if you need the full text.`,
  {
    query: z.string().describe('SQL SELECT query with ? placeholders for parameters'),
    params: z.array(z.union([z.string(), z.number(), z.null()])).optional()
      .describe('Parameter values for ? placeholders'),
  },
  async (args) => {
    const db = getDb();
    let sql = args.query.trim();

    // Block non-SELECT queries
    if (!/^\s*SELECT/i.test(sql)) {
      return {
        content: [{ type: 'text', text: 'Error: query_business_db only accepts SELECT queries. Use mutate_business_db for INSERT/UPDATE/DELETE.' }],
        isError: true,
      };
    }

    // Auto-inject LIMIT if missing (safety net)
    if (!/\bLIMIT\b/i.test(sql)) {
      sql = sql.replace(/;?\s*$/, ` LIMIT ${MAX_ROWS}`);
    }

    try {
      const stmt = db.prepare(sql);
      const rawRows = (args.params ? stmt.all(...args.params) : stmt.all()) as Record<string, unknown>[];

      // Per-field truncation for listings. Single-row results (targeted queries
      // like "get document by ID") get a much higher limit so the agent can
      // read full document text when it needs to.
      const rows = rawRows.length === 1
        ? truncateRows(rawRows, 10_000)
        : truncateRows(rawRows);

      let response = JSON.stringify(rows, null, 2);

      // Final safety net: truncate by total size
      if (response.length > MAX_RESPONSE_BYTES) {
        const truncatedRows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
        response = JSON.stringify(truncatedRows, null, 2);
        response += `\n\n[TRUNCATED: ${rawRows.length} rows total, showing ${truncatedRows.length}. Add more filters or specific columns to reduce result size.]`;
      }

      return {
        content: [{ type: 'text', text: response }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `SQL Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// Tables that can be modified by the agent
const WRITABLE_TABLES = new Set([
  'contacts', 'companies', 'deals', 'interactions', 'projects',
  'team_members', 'assignments', 'absences', 'reviews',
  'suppliers', 'invoices', 'expenses', 'contracts',
  'obligations', 'decisions', 'goals', 'meetings',
  'documents', 'memories', 'relationship_summaries', 'activity_digests',
  'candidates', 'contract_clauses',
]);

// Tables that are read-only (agent cannot modify)
// audit_log: integrity of audit trail
// scan_config: only modifiable via explicit user command
const READONLY_TABLES = new Set(['audit_log', 'scan_config', 'sqlite_sequence']);

// Operations that require explicit user confirmation before executing.
// The agent must ask the user and get a "oui" / "ok" / "yes" before proceeding.
const SENSITIVE_OPERATIONS = {
  // Any DELETE (even soft delete on important tables)
  isDelete: (sql: string) => /^\s*DELETE/i.test(sql),
  // Modifying financial data (amounts, salaries)
  isFinancialUpdate: (sql: string, table: string) =>
    /^\s*UPDATE/i.test(sql) &&
    ['deals', 'invoices', 'expenses', 'contracts', 'team_members'].includes(table) &&
    /amount|salary|value|budget|consumed|tax_amount|daily_rate|annual_cost/i.test(sql),
  // Changing deal stage (won/lost is irreversible business-wise)
  isDealStageChange: (sql: string, table: string) =>
    /^\s*UPDATE/i.test(sql) && table === 'deals' && /stage/i.test(sql),
  // Bulk updates (no WHERE clause)
  isBulkUpdate: (sql: string) =>
    /^\s*UPDATE/i.test(sql) && !/WHERE/i.test(sql),
};

const mutateBusinessDb = tool(
  'mutate_business_db',
  `Execute an INSERT, UPDATE, or DELETE on the business database.
Automatically logs to audit_log. Returns affected row count and last inserted ID.
Always use parameterized queries with ? placeholders. Never use DELETE — use UPDATE SET deleted_at = datetime('now') instead (soft delete).

WRITABLE TABLES: ${[...WRITABLE_TABLES].join(', ')}
READONLY TABLES (blocked): audit_log, scan_config

SENSITIVE OPERATIONS (require user confirmation BEFORE calling this tool):
- Any DELETE operation
- Changing financial amounts (deals.amount, invoices.amount, team_members.salary, etc.)
- Changing deal stage (especially to 'won' or 'lost')
- Any UPDATE without a WHERE clause

For sensitive operations, FIRST ask the user to confirm:
"Je vais [description du changement]. C'est bien ça ?"
Only call this tool AFTER the user confirms with "oui", "ok", "yes", or similar.
If the user has NOT confirmed, do NOT call this tool — ask first.`,
  {
    query: z.string().describe('SQL INSERT/UPDATE/DELETE query with ? placeholders'),
    params: z.array(z.union([z.string(), z.number(), z.null()])).optional()
      .describe('Parameter values for ? placeholders'),
    table_name: z.string().describe('Table being modified (for audit_log)'),
    record_id: z.string().optional().describe('ID of the record being modified (for audit_log)'),
    reason: z.string().optional().describe('Reason for the change (for audit_log)'),
    user_confirmed: z.boolean().optional()
      .describe('Set to true ONLY if the user has explicitly confirmed this operation in the current conversation. Required for sensitive operations.'),
  },
  async (args) => {
    const db = getDb();
    const sql = args.query.trim();

    // Block SELECT queries
    if (/^\s*SELECT/i.test(sql)) {
      return {
        content: [{ type: 'text', text: 'Error: mutate_business_db does not accept SELECT queries. Use query_business_db instead.' }],
        isError: true,
      };
    }

    // Block destructive schema operations
    if (/^\s*(DROP|TRUNCATE)/i.test(sql)) {
      return {
        content: [{ type: 'text', text: 'Error: DROP and TRUNCATE are not allowed. Use soft delete (UPDATE SET deleted_at) instead.' }],
        isError: true,
      };
    }

    // Block readonly tables
    if (READONLY_TABLES.has(args.table_name)) {
      return {
        content: [{ type: 'text', text: `Error: la table '${args.table_name}' est en lecture seule. Elle ne peut pas être modifiée par l'agent.` }],
        isError: true,
      };
    }

    // Block unknown tables
    if (!WRITABLE_TABLES.has(args.table_name)) {
      return {
        content: [{ type: 'text', text: `Error: table '${args.table_name}' inconnue. Tables autorisées : ${[...WRITABLE_TABLES].join(', ')}` }],
        isError: true,
      };
    }

    // Check sensitive operations — require user_confirmed = true
    const isSensitive =
      SENSITIVE_OPERATIONS.isDelete(sql) ||
      SENSITIVE_OPERATIONS.isFinancialUpdate(sql, args.table_name) ||
      SENSITIVE_OPERATIONS.isDealStageChange(sql, args.table_name) ||
      SENSITIVE_OPERATIONS.isBulkUpdate(sql);

    if (isSensitive && !args.user_confirmed) {
      return {
        content: [{
          type: 'text',
          text: `⚠️ OPÉRATION SENSIBLE — Confirmation requise.\n\nCette opération modifie des données critiques (${args.table_name}). Tu dois d'abord demander confirmation au dirigeant, puis rappeler ce tool avec user_confirmed: true.\n\nQuery: ${sql.slice(0, 200)}`,
        }],
        isError: true,
      };
    }

    try {
      const stmt = db.prepare(sql);
      const result = args.params ? stmt.run(...args.params) : stmt.run();

      // Determine action type
      const action = /^\s*INSERT/i.test(sql) ? 'create'
        : /^\s*UPDATE/i.test(sql) ? 'update'
        : /^\s*DELETE/i.test(sql) ? 'delete'
        : 'mutation';

      // Auto-log to audit_log
      db.prepare(
        `INSERT INTO audit_log (table_name, record_id, action, reason, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(
        args.table_name,
        args.record_id || String(result.lastInsertRowid || 'unknown'),
        action,
        args.reason || null
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid ? String(result.lastInsertRowid) : null,
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `SQL Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

const listBusinessTables = tool(
  'list_business_tables',
  'List all tables in the business database with their columns. Useful for discovering the schema.',
  {},
  async () => {
    const db = getDb();
    try {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name`
      ).all() as { name: string }[];

      const schema: Record<string, string[]> = {};
      for (const table of tables) {
        const columns = db.prepare(`PRAGMA table_info('${table.name}')`).all() as { name: string; type: string }[];
        schema[table.name] = columns.map(c => `${c.name} (${c.type})`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

export const businessDbServer = createSdkMcpServer({
  name: 'business-db',
  version: '1.0.0',
  tools: [queryBusinessDb, mutateBusinessDb, listBusinessTables],
});
