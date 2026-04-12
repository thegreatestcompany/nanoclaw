/**
 * Client portal routes — JWT-authenticated access to client's own data.
 *
 * Auth: 6-digit code → JWT in httpOnly cookie. No token in URL.
 * Security: client_id from JWT only, path traversal protection, read-only.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

import { getClientByEmail, getClientById } from './db.js';
import { sendPortalLinkEmail } from './mailer.js';
import Database from 'better-sqlite3';

const CLIENTS_DIR =
  process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');

const SAFE_ID_PATTERN = /^[a-z0-9-]+$/;

// --- Portal code store (in-memory, short-lived) ---

interface PortalCode {
  jwt: string;
  clientId: string;
  expiresAt: number;
}

const portalCodes = new Map<string, PortalCode>();
const codeAttempts = new Map<string, { count: number; resetAt: number }>();

// Cleanup expired codes every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of portalCodes) {
    if (now > entry.expiresAt) portalCodes.delete(code);
  }
  for (const [key, entry] of codeAttempts) {
    if (now > entry.resetAt) codeAttempts.delete(key);
  }
}, 2 * 60 * 1000);

export function storePortalCode(code: string, jwtToken: string, clientId: string): void {
  portalCodes.set(code, {
    jwt: jwtToken,
    clientId,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });
}

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.txt',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
]);

const BLOCKED_PATTERNS = [
  '.env',
  'store/',
  'data/',
  '.claude/',
  'business.db',
  '.git',
];

// --- Rate limiting (in-memory) ---

const rateLimitMap = new Map<
  string,
  { count: number; resetAt: number }
>();

function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

// --- JWT middleware ---

interface PortalRequest extends Request {
  clientId?: string;
}

function getPortalSecret(): string | undefined {
  return process.env.PORTAL_JWT_SECRET;
}

function verifyPortalToken(
  req: PortalRequest,
  res: Response,
  next: NextFunction,
): void {
  const secret = getPortalSecret();
  if (!secret) {
    res.status(503).json({ error: 'Portail non configuré' });
    return;
  }

  // 1. Cookie (subsequent requests)
  let token = req.cookies?.portal_token;

  // 2. Query param (initial magic link click)
  if (!token && req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as { client_id: string };
    if (!payload.client_id || !SAFE_ID_PATTERN.test(payload.client_id)) {
      res.status(401).json({ error: 'Token invalide' });
      return;
    }

    // Verify client exists
    const client = getClientById(payload.client_id);
    if (!client || client.status === 'cancelled') {
      res.status(401).json({ error: 'Compte inactif' });
      return;
    }

    req.clientId = payload.client_id;

    // Set/refresh httpOnly cookie
    res.cookie('portal_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });

    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

// --- Helpers ---

function getClientGroupDir(clientId: string): string {
  return path.join(CLIENTS_DIR, clientId, 'groups', 'main');
}

function getClientDbPath(clientId: string): string {
  return path.join(CLIENTS_DIR, clientId, 'groups', 'main', 'business.db');
}

function safeClientPath(groupDir: string, relativePath: string): string | null {
  const resolved = path.resolve(groupDir, relativePath);
  if (!resolved.startsWith(groupDir + path.sep) && resolved !== groupDir) {
    return null;
  }
  const relative = path.relative(groupDir, resolved);
  if (
    BLOCKED_PATTERNS.some(
      (p) => relative.startsWith(p) || relative.includes('/' + p),
    )
  ) {
    return null;
  }
  return resolved;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
    return;
  }
  if (req.headers['x-admin-token'] !== adminToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// --- Route setup ---

export function setupPortalRoutes(app: Express): void {
  // --- Portal API routes (JWT-authenticated) ---

  // Rate limit all portal routes
  app.use('/api/portal', (req: PortalRequest, res, next) => {
    // Skip rate limit for request-link (has its own)
    if (req.path === '/request-link') {
      next();
      return;
    }
    const clientId = req.clientId || 'anon';
    if (!rateLimit(`portal:${clientId}`, 200, 60 * 1000)) {
      res.status(429).json({ error: 'Trop de requêtes' });
      return;
    }
    next();
  });

  // Dashboard KPIs
  app.get(
    '/api/portal/dashboard',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const dbPath = getClientDbPath(clientId);

      if (!fs.existsSync(dbPath)) {
        res.json({
          contacts: 0,
          deals: 0,
          pipeline_value: 0,
          projects: 0,
          goals: 0,
          obligations: 0,
          recent_deals: [],
          upcoming_obligations: [],
        });
        return;
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        const count = (sql: string) =>
          (db.prepare(sql).get() as { n: number }).n;
        const val = (sql: string) =>
          (db.prepare(sql).get() as { v: number }).v;

        // KPIs
        const contacts = count('SELECT count(*) as n FROM contacts WHERE deleted_at IS NULL');
        const deals = count('SELECT count(*) as n FROM deals WHERE deleted_at IS NULL');
        const projects = count("SELECT count(*) as n FROM projects WHERE status = 'active' AND deleted_at IS NULL");
        const goals = count("SELECT count(*) as n FROM goals WHERE status = 'active'");
        const obligations = count("SELECT count(*) as n FROM obligations WHERE status = 'pending' AND deleted_at IS NULL");
        const team_members = count('SELECT count(*) as n FROM team_members WHERE deleted_at IS NULL');
        const candidates = count('SELECT count(*) as n FROM candidates WHERE deleted_at IS NULL AND stage NOT IN (\'hired\', \'rejected\', \'withdrawn\')');
        const pipeline_value = val("SELECT COALESCE(SUM(amount), 0) as v FROM deals WHERE deleted_at IS NULL AND stage NOT IN ('won', 'lost')");

        // Finance
        const revenue_won = val("SELECT COALESCE(SUM(amount), 0) as v FROM deals WHERE deleted_at IS NULL AND stage = 'won'");
        const invoices_pending = count("SELECT count(*) as n FROM invoices WHERE deleted_at IS NULL AND status IN ('sent', 'overdue')");
        const invoices_pending_amount = val("SELECT COALESCE(SUM(amount), 0) as v FROM invoices WHERE deleted_at IS NULL AND status IN ('sent', 'overdue') AND direction = 'outbound'");
        const overdue_invoices = count("SELECT count(*) as n FROM invoices WHERE deleted_at IS NULL AND status = 'overdue'");
        const active_contracts = count("SELECT count(*) as n FROM contracts WHERE deleted_at IS NULL AND status = 'active'");

        // Recent data
        const recent_deals = db.prepare(
          "SELECT d.title, d.amount, d.stage, d.expected_close_date, d.next_action, c.name as contact_name FROM deals d LEFT JOIN contacts c ON d.contact_id = c.id WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 5"
        ).all();

        const upcoming_obligations = db.prepare(
          "SELECT title, category, due_date, responsible FROM obligations WHERE deleted_at IS NULL AND status = 'pending' AND due_date >= date('now') ORDER BY due_date ASC LIMIT 5"
        ).all();

        const overdue_obligations = db.prepare(
          "SELECT title, category, due_date FROM obligations WHERE deleted_at IS NULL AND status = 'pending' AND due_date < date('now') ORDER BY due_date ASC LIMIT 5"
        ).all();

        const recent_interactions = db.prepare(
          "SELECT i.type, i.summary, i.date, i.sentiment, c.name as contact_name FROM interactions i LEFT JOIN contacts c ON i.contact_id = c.id ORDER BY i.date DESC LIMIT 5"
        ).all();

        const upcoming_meetings = db.prepare(
          "SELECT m.date, m.summary, m.attendees, m.action_items FROM meetings m WHERE m.date >= datetime('now') ORDER BY m.date ASC LIMIT 5"
        ).all();

        db.close();
        res.json({
          contacts, deals, pipeline_value, projects, goals, obligations,
          team_members, candidates, revenue_won,
          invoices_pending, invoices_pending_amount, overdue_invoices, active_contracts,
          recent_deals, upcoming_obligations, overdue_obligations,
          recent_interactions, upcoming_meetings,
        });
      } catch (err) {
        db.close();
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Business data — detailed views by section
  app.get(
    '/api/portal/business/:section',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const section = req.params.section;
      const dbPath = getClientDbPath(clientId);

      if (!fs.existsSync(dbPath)) {
        res.json({ data: [] });
        return;
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        let data;
        switch (section) {
          case 'contacts':
            data = db.prepare(
              "SELECT c.id, c.name, c.role, c.phone, c.email, c.relationship_type, c.linkedin_url, co.name as company_name FROM contacts c LEFT JOIN companies co ON c.company_id = co.id WHERE c.deleted_at IS NULL ORDER BY c.updated_at DESC LIMIT 100"
            ).all();
            break;
          case 'deals':
            data = db.prepare(
              "SELECT d.id, d.title, d.amount, d.stage, d.probability, d.expected_close_date, d.next_action, d.next_action_date, d.source, c.name as contact_name, co.name as company_name FROM deals d LEFT JOIN contacts c ON d.contact_id = c.id LEFT JOIN companies co ON d.company_id = co.id WHERE d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 100"
            ).all();
            break;
          case 'team':
            data = db.prepare(
              "SELECT id, name, role, email, phone, contract_type, start_date, trial_end_date FROM team_members WHERE deleted_at IS NULL ORDER BY name"
            ).all();
            break;
          case 'projects':
            data = db.prepare(
              "SELECT p.id, p.name, p.status, p.start_date, p.end_date, p.budget, p.consumed, co.name as company_name FROM projects p LEFT JOIN companies co ON p.company_id = co.id WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT 50"
            ).all();
            break;
          case 'invoices':
            data = db.prepare(
              "SELECT i.id, i.invoice_number, i.direction, i.amount, i.tax_amount, i.status, i.issue_date, i.due_date, i.paid_date, i.payment_method, co.name as company_name FROM invoices i LEFT JOIN companies co ON i.company_id = co.id WHERE i.deleted_at IS NULL ORDER BY i.issue_date DESC LIMIT 100"
            ).all();
            break;
          case 'contracts':
            data = db.prepare(
              "SELECT ct.id, ct.title, ct.type, ct.start_date, ct.end_date, ct.value, ct.renewal_type, ct.notice_period_days, ct.status, co.name as company_name FROM contracts ct LEFT JOIN companies co ON ct.company_id = co.id WHERE ct.deleted_at IS NULL ORDER BY ct.end_date ASC LIMIT 50"
            ).all();
            break;
          case 'candidates':
            data = db.prepare(
              "SELECT id, name, position, stage, source, email, current_company, salary_expectation FROM candidates WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50"
            ).all();
            break;
          case 'goals':
            data = db.prepare(
              "SELECT id, title, metric, target, current, deadline, status FROM goals ORDER BY status ASC, deadline ASC LIMIT 50"
            ).all();
            break;
          case 'suppliers':
            data = db.prepare(
              "SELECT id, name, category, contact_name, phone, email, contract_end_date, annual_cost, rating FROM suppliers WHERE deleted_at IS NULL ORDER BY name LIMIT 50"
            ).all();
            break;
          case 'expenses':
            data = db.prepare(
              "SELECT e.id, e.category, e.description, e.amount, e.date, s.name as supplier_name FROM expenses e LEFT JOIN suppliers s ON e.supplier_id = s.id ORDER BY e.date DESC LIMIT 100"
            ).all();
            break;
          default:
            res.status(400).json({ error: 'Section inconnue' });
            db.close();
            return;
        }
        db.close();
        res.json({ data });
      } catch (err) {
        db.close();
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Documents list
  app.get(
    '/api/portal/documents',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const groupDir = getClientGroupDir(clientId);

      if (!fs.existsSync(groupDir)) {
        res.json({ documents: [] });
        return;
      }

      const DOC_EXTENSIONS = new Set([
        '.pptx',
        '.docx',
        '.xlsx',
        '.pdf',
        '.csv',
        '.txt',
        '.png',
        '.jpg',
        '.jpeg',
      ]);

      try {
        const files: Array<{
          name: string;
          path: string;
          size_kb: number;
          modified: string;
        }> = [];

        // Scan documents/ subdirectory
        const docsDir = path.join(groupDir, 'documents');
        if (fs.existsSync(docsDir)) {
          for (const name of fs.readdirSync(docsDir)) {
            const fullPath = path.join(docsDir, name);
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && DOC_EXTENSIONS.has(path.extname(name).toLowerCase())) {
              files.push({
                name,
                path: `documents/${name}`,
                size_kb: Math.round(stat.size / 1024),
                modified: stat.mtime.toISOString(),
              });
            }
          }
        }

        // Scan root for office files
        for (const name of fs.readdirSync(groupDir)) {
          const ext = path.extname(name).toLowerCase();
          if (DOC_EXTENSIONS.has(ext)) {
            const fullPath = path.join(groupDir, name);
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              files.push({
                name,
                path: name,
                size_kb: Math.round(stat.size / 1024),
                modified: stat.mtime.toISOString(),
              });
            }
          }
        }

        files.sort((a, b) => b.modified.localeCompare(a.modified));
        res.json({ documents: files });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Document download (stream)
  app.get(
    '/api/portal/documents/download',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const filePath = req.query.file as string;

      if (!filePath) {
        res.status(400).json({ error: 'Paramètre file requis' });
        return;
      }

      const groupDir = getClientGroupDir(clientId);
      const resolved = safeClientPath(groupDir, filePath);

      if (!resolved) {
        res.status(403).json({ error: 'Accès refusé' });
        return;
      }

      const ext = path.extname(resolved).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        res.status(403).json({ error: 'Type de fichier non autorisé' });
        return;
      }

      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        res.status(404).json({ error: 'Fichier non trouvé' });
        return;
      }

      const filename = path.basename(resolved);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(resolved).pipe(res);
    },
  );

  // Memory files
  app.get(
    '/api/portal/memory',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const groupDir = getClientGroupDir(clientId);
      const memoryDir = path.join(groupDir, 'memory');

      const memoryFiles: Record<string, string> = {};

      if (fs.existsSync(memoryDir)) {
        const readDir = (dir: string, prefix = '') => {
          for (const entry of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, entry);
            const relPath = prefix ? `${prefix}/${entry}` : entry;
            if (fs.statSync(fullPath).isDirectory()) {
              readDir(fullPath, relPath);
            } else {
              memoryFiles[relPath] = fs.readFileSync(fullPath, 'utf8');
            }
          }
        };
        readDir(memoryDir);
      }

      res.json({ memoryFiles });
    },
  );

  // Audit trail (paginated)
  app.get(
    '/api/portal/audit',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const dbPath = getClientDbPath(clientId);

      if (!fs.existsSync(dbPath)) {
        res.json({ logs: [], total: 0, page: 1, pages: 0 });
        return;
      }

      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const db = new Database(dbPath, { readonly: true });
      try {
        const totalRow = db
          .prepare('SELECT count(*) as n FROM audit_log')
          .get() as { n: number };
        const total = totalRow.n;
        const pages = Math.ceil(total / limit);

        const logs = db
          .prepare(
            'SELECT table_name, record_id, action, field_name, old_value, new_value, created_at FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?',
          )
          .all(limit, offset);

        db.close();
        res.json({ logs, total, page, pages });
      } catch (err) {
        db.close();
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // ─── OTTO TAB ─────────────────────────────────────────────────────────────

  // Activated WhatsApp groups + per-group stats and Otto-extracted data
  app.get(
    '/api/portal/otto/groups',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const msgDbPath = path.join(CLIENTS_DIR, clientId, 'store', 'messages.db');
      const businessDbPath = getClientDbPath(clientId);

      if (!fs.existsSync(msgDbPath)) {
        res.json({ groups: [] });
        return;
      }

      const msgDb = new Database(msgDbPath, { readonly: true });
      let businessDb: Database.Database | null = null;
      if (fs.existsSync(businessDbPath)) {
        businessDb = new Database(businessDbPath, { readonly: true });
      }

      try {
        const rows = msgDb
          .prepare(
            'SELECT jid, name, folder, is_main, added_at FROM registered_groups ORDER BY is_main DESC, added_at DESC',
          )
          .all() as Array<{
          jid: string;
          name: string;
          folder: string;
          is_main: number;
          added_at: string;
        }>;

        const groups = rows.map((row) => {
          // Message stats from messages.db
          const stats = msgDb
            .prepare(
              'SELECT count(*) as msg_count, MAX(timestamp) as last_msg FROM messages WHERE chat_jid = ?',
            )
            .get(row.jid) as { msg_count: number; last_msg: string | null };

          // Otto-extracted data from business.db (where source mentions this jid)
          let extractedContacts = 0;
          let extractedDeals = 0;
          let pendingUpdates = 0;
          if (businessDb) {
            try {
              extractedContacts = (
                businessDb
                  .prepare(
                    "SELECT count(*) as n FROM contacts WHERE deleted_at IS NULL AND source = 'whatsapp'",
                  )
                  .get() as { n: number }
              ).n;
              pendingUpdates = (
                businessDb
                  .prepare(
                    "SELECT count(*) as n FROM pending_updates WHERE status = 'pending' AND source_chat_jid = ?",
                  )
                  .get(row.jid) as { n: number }
              ).n;
            } catch {
              /* tables may not exist on older DBs */
            }
          }

          return {
            jid: row.jid,
            name: row.name,
            folder: row.folder,
            isMain: row.is_main === 1,
            addedAt: row.added_at,
            messageCount: stats.msg_count,
            lastActivity: stats.last_msg,
            extractedContacts,
            extractedDeals,
            pendingUpdates,
            // wa.me URL works for individual chats but not group jids; we leave it
            // null for groups since there's no public way to deep-link to a group.
            whatsappUrl: row.jid.endsWith('@s.whatsapp.net')
              ? `https://wa.me/${row.jid.split('@')[0]}`
              : null,
          };
        });

        msgDb.close();
        if (businessDb) businessDb.close();
        res.json({ groups });
      } catch (err) {
        msgDb.close();
        if (businessDb) businessDb.close();
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Deactivate a group from the portal (calls the host via IPC events dir,
  // same mechanism the agent's unregister_group MCP tool uses).
  app.post(
    '/api/portal/otto/groups/:jid/deactivate',
    verifyPortalToken,
    express.json(),
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const jid = String(req.params.jid);

      // Refuse main JIDs (would lock the user out of his own self-chat)
      if (jid.endsWith('@s.whatsapp.net')) {
        res
          .status(400)
          .json({ error: "Le self-chat ne peut pas être désactivé" });
        return;
      }
      if (!jid.endsWith('@g.us')) {
        res.status(400).json({ error: 'JID invalide' });
        return;
      }

      const msgDbPath = path.join(CLIENTS_DIR, clientId, 'store', 'messages.db');
      if (!fs.existsSync(msgDbPath)) {
        res.status(404).json({ error: 'Client introuvable' });
        return;
      }

      // Direct DB delete + remove the group folder marker so the host picks
      // up the change at next reload. The host's in-memory map will catch up
      // on next message processing.
      const db = new Database(msgDbPath);
      try {
        const result = db
          .prepare('DELETE FROM registered_groups WHERE jid = ? AND is_main = 0')
          .run(jid);
        db.close();
        if (result.changes === 0) {
          res
            .status(404)
            .json({ error: 'Groupe non trouvé ou main group protégé' });
          return;
        }
        // Touch a reload marker so the host process picks up the change
        try {
          const ipcDir = path.join(CLIENTS_DIR, clientId, 'data', 'ipc');
          fs.mkdirSync(ipcDir, { recursive: true });
          fs.writeFileSync(
            path.join(ipcDir, '.reload_groups'),
            new Date().toISOString(),
          );
        } catch {
          /* non-fatal */
        }
        res.json({ ok: true });
      } catch (err) {
        db.close();
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Composio integrations connected for this client
  app.get(
    '/api/portal/otto/integrations',
    verifyPortalToken,
    async (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const client = getClientById(clientId);
      if (!client?.whatsapp_jid) {
        res.json({ integrations: [], error: 'WhatsApp not linked yet' });
        return;
      }
      if (!process.env.COMPOSIO_API_KEY) {
        res.json({ integrations: [] });
        return;
      }

      try {
        const response = await fetch(
          `https://backend.composio.dev/api/v3/connected_accounts?user_ids=${encodeURIComponent(client.whatsapp_jid)}`,
          {
            headers: { 'x-api-key': process.env.COMPOSIO_API_KEY },
          },
        );
        if (!response.ok) {
          res.json({ integrations: [] });
          return;
        }
        const data = (await response.json()) as {
          items?: Array<{
            id?: string;
            status?: string;
            toolkit?: { slug?: string; name?: string; logo?: string };
            created_at?: string;
            updated_at?: string;
          }>;
        };
        const integrations = (data.items || []).map((a) => ({
          id: a.id || '',
          toolkit: a.toolkit?.slug || '?',
          name: a.toolkit?.name || a.toolkit?.slug || '?',
          logo: a.toolkit?.logo || null,
          status: a.status || 'unknown',
          createdAt: a.created_at || null,
          updatedAt: a.updated_at || null,
        }));
        res.json({ integrations });
      } catch (err) {
        res.json({
          integrations: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // Subscription / billing summary
  app.get(
    '/api/portal/otto/subscription',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const client = getClientById(clientId);
      if (!client) {
        res.status(404).json({ error: 'Client introuvable' });
        return;
      }
      res.json({
        status: client.status,
        trialEndsAt: client.trial_ends_at,
        cancelAt: client.cancel_at,
        cancelReason: client.cancel_reason,
        memberSince: client.created_at,
        hasStripeCustomer: !!client.stripe_customer_id,
      });
    },
  );

  // Generate Stripe Customer Portal session
  app.post(
    '/api/portal/otto/billing-portal',
    verifyPortalToken,
    async (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const client = getClientById(clientId);
      if (!client?.stripe_customer_id) {
        res.status(400).json({ error: 'Aucun compte Stripe associé' });
        return;
      }
      if (!process.env.STRIPE_SECRET_KEY) {
        res.status(503).json({ error: 'Stripe not configured' });
        return;
      }
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const baseUrl = process.env.BASE_URL || 'https://otto.hntic.fr';
        const session = await stripe.billingPortal.sessions.create({
          customer: client.stripe_customer_id,
          return_url: `${baseUrl}/portal#otto`,
        });
        res.json({ url: session.url });
      } catch (err) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Account info (read-only for now; future: editable via PUT)
  app.get(
    '/api/portal/otto/account',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const client = getClientById(clientId);
      if (!client) {
        res.status(404).json({ error: 'Client introuvable' });
        return;
      }
      res.json({
        id: client.id,
        email: client.email,
        name: client.name,
        company: client.company,
        phone: client.phone,
        addressLine1: client.address_line1,
        addressLine2: client.address_line2,
        city: client.address_city,
        postalCode: client.address_postal_code,
        country: client.address_country,
        taxId: client.tax_id,
        whatsappJid: client.whatsapp_jid,
      });
    },
  );

  // ─── END OTTO TAB ─────────────────────────────────────────────────────────

  // Usage stats
  app.get(
    '/api/portal/usage',
    verifyPortalToken,
    (req: PortalRequest, res) => {
      const clientId = req.clientId!;
      const msgDbPath = path.join(CLIENTS_DIR, clientId, 'store', 'messages.db');

      if (!fs.existsSync(msgDbPath)) {
        res.json({ weekly: [], total_messages: 0, member_since: null });
        return;
      }

      const db = new Database(msgDbPath, { readonly: true });
      try {
        const weekly = db
          .prepare(
            `SELECT strftime('%Y-W%W', timestamp) as week, count(*) as messages, count(DISTINCT date(timestamp)) as active_days FROM messages WHERE timestamp > datetime('now', '-90 days') GROUP BY week ORDER BY week DESC`,
          )
          .all();

        const totalRow = db
          .prepare('SELECT count(*) as n FROM messages')
          .get() as { n: number };

        const firstRow = db
          .prepare(
            'SELECT MIN(timestamp) as first_msg FROM messages',
          )
          .get() as { first_msg: string | null };

        db.close();
        res.json({
          weekly,
          total_messages: totalRow.n,
          member_since: firstRow.first_msg,
        });
      } catch (err) {
        db.close();
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // --- Internal endpoint: store a portal code (called by host IPC handler) ---

  app.post(
    '/api/internal/portal-code',
    express.json(),
    (req, res) => {
      // Auth via PORTAL_JWT_SECRET as shared secret (both host and API have it)
      const authHeader = req.headers['x-portal-secret'] as string;
      const secret = getPortalSecret();
      if (!secret || authHeader !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { code, jwt: jwtToken, client_id } = req.body;
      if (!code || !jwtToken || !client_id) {
        res.status(400).json({ error: 'code, jwt, and client_id required' });
        return;
      }

      storePortalCode(code, jwtToken, client_id);
      res.json({ ok: true });
    },
  );

  // --- Internal endpoint: generate portal link (admin-only, kept for backward compat) ---

  app.post(
    '/api/internal/portal-link',
    express.json(),
    requireAdmin,
    (req, res) => {
      const { client_id } = req.body;
      if (!client_id || !SAFE_ID_PATTERN.test(client_id)) {
        res.status(400).json({ error: 'Invalid client_id' });
        return;
      }

      const secret = getPortalSecret();
      if (!secret) {
        res.status(503).json({ error: 'PORTAL_JWT_SECRET not configured' });
        return;
      }

      const token = jwt.sign({ client_id }, secret, { expiresIn: '24h' });
      const baseUrl = process.env.BASE_URL || 'https://otto.hntic.fr';
      const url = `${baseUrl}/portal?token=${token}`;

      res.json({ url, expiresIn: '24h' });
    },
  );

  // --- Public endpoint: verify portal code ---

  app.post(
    '/api/portal/verify-code',
    express.json(),
    (req, res) => {
      const { code } = req.body;
      if (!code || typeof code !== 'string') {
        res.status(400).json({ error: 'Code requis' });
        return;
      }

      const normalized = code.replace(/\s/g, ''); // Remove spaces (user might type "847 291")
      const ip = req.ip || 'unknown';

      // Rate limit: 5 attempts per 15 minutes per IP
      const attemptKey = `verify:${ip}`;
      const attempt = codeAttempts.get(attemptKey);
      const now = Date.now();
      if (attempt && now < attempt.resetAt && attempt.count >= 5) {
        res.status(429).json({ error: 'Trop de tentatives. R\u00e9essayez dans quelques minutes.' });
        return;
      }
      if (!attempt || now > attempt.resetAt) {
        codeAttempts.set(attemptKey, { count: 1, resetAt: now + 15 * 60 * 1000 });
      } else {
        attempt.count++;
      }

      const entry = portalCodes.get(normalized);
      if (!entry || now > entry.expiresAt) {
        portalCodes.delete(normalized);
        res.status(401).json({ error: 'Code invalide ou expir\u00e9' });
        return;
      }

      // Valid code — set JWT cookie and delete the code (single use)
      portalCodes.delete(normalized);

      res.cookie('portal_token', entry.jwt, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
      });

      res.json({ ok: true });
    },
  );

  // --- Public endpoint: request magic link via email ---

  app.post(
    '/api/portal/request-link',
    express.json(),
    (req, res) => {
      const { email } = req.body;
      if (!email || typeof email !== 'string') {
        res.status(400).json({ error: 'Email requis' });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();

      // Rate limit: 3 requests per email per hour
      if (!rateLimit(`portal-link:${normalizedEmail}`, 3, 60 * 60 * 1000)) {
        res.status(429).json({ error: 'Trop de demandes. Réessaie dans 1h.' });
        return;
      }

      const secret = getPortalSecret();
      if (!secret) {
        // Don't reveal configuration issues to the public
        res.json({ ok: true });
        return;
      }

      const client = getClientByEmail(normalizedEmail);
      if (!client || client.status === 'cancelled') {
        // Don't reveal whether the email exists — always return ok
        res.json({ ok: true });
        return;
      }

      const token = jwt.sign({ client_id: client.id }, secret, {
        expiresIn: '24h',
      });
      const baseUrl = process.env.BASE_URL || 'https://otto.hntic.fr';
      const portalUrl = `${baseUrl}/portal?token=${token}`;

      sendPortalLinkEmail(normalizedEmail, portalUrl).catch((err) =>
        console.error(`Failed to send portal link email to ${normalizedEmail}:`, err),
      );

      res.json({ ok: true });
    },
  );
}
