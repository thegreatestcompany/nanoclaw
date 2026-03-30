/**
 * Admin back-office routes — protected by ADMIN_TOKEN header.
 *
 * Read-only access to client data, logs, costs.
 * Actions: restart, stop client processes.
 */

import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

import { getAllClients } from './db.js';

const IS_LINUX = os.platform() === 'linux';
const CLIENTS_DIR = process.env.CLIENTS_DIR || path.join(process.cwd(), '..', 'clients');

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

const SAFE_ID_PATTERN = /^[a-z0-9-]+$/;

function validateClientId(
  _req: Request,
  res: Response,
  next: NextFunction,
  value: string,
): void {
  if (!SAFE_ID_PATTERN.test(value)) {
    res.status(400).json({ error: 'Invalid client ID' });
    return;
  }
  next();
}

function getClientDbPath(clientId: string): string {
  return path.join(CLIENTS_DIR, clientId, 'groups', 'main', 'business.db');
}

export function setupAdminRoutes(app: Express): void {
  app.use('/api/admin', express.json(), requireAdmin);
  // Validate :id param on all client-specific routes to prevent injection
  app.param('id', validateClientId as unknown as (req: Request, res: Response, next: NextFunction, value: string, name: string) => void);

  // List all clients with status and stats
  app.get('/api/admin/clients', (_req, res) => {
    const clients = getAllClients();

    const enriched = clients.map((client) => {
      const dbPath = getClientDbPath(client.id);
      let stats: Record<string, number> = {};

      try {
        if (fs.existsSync(dbPath)) {
          const db = new Database(dbPath, { readonly: true });
          stats = {
            contacts: (db.prepare('SELECT count(*) as n FROM contacts WHERE deleted_at IS NULL').get() as { n: number }).n,
            deals: (db.prepare('SELECT count(*) as n FROM deals WHERE deleted_at IS NULL').get() as { n: number }).n,
            interactions_7d: (db.prepare("SELECT count(*) as n FROM interactions WHERE date > datetime('now', '-7 days')").get() as { n: number }).n,
          };
          db.close();
        }
      } catch { /* db may not exist yet */ }

      // PM2 stats (Linux only)
      let pm2Stats: Record<string, unknown> = {};
      if (IS_LINUX) {
        try {
          const pm2List = JSON.parse(execSync('pm2 jlist').toString());
          const proc = pm2List.find((p: { name: string }) => p.name === `otto-${client.id}`);
          if (proc) {
            pm2Stats = {
              pm2_status: proc.pm2_env?.status,
              memory_mb: Math.round((proc.monit?.memory || 0) / 1024 / 1024),
              cpu: proc.monit?.cpu || 0,
              uptime: proc.pm2_env?.pm_uptime,
              restarts: proc.pm2_env?.restart_time,
            };
          }
        } catch { /* pm2 not available */ }
      }

      // WhatsApp status: check if auth credentials exist
      const authDir = path.join(CLIENTS_DIR, client.id, 'store', 'auth');
      const hasWhatsAppAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      const whatsappStatus = !hasWhatsAppAuth ? 'no_auth'
        : pm2Stats.pm2_status === 'online' ? 'connected'
        : 'disconnected';

      return { ...client, stats, ...pm2Stats, whatsapp_status: whatsappStatus };
    });

    res.json(enriched);
  });

  // Get a single client
  app.get('/api/admin/clients/:id', (req, res) => {
    const clients = getAllClients();
    const client = clients.find((c) => c.id === req.params.id);
    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    res.json(client);
  });

  // List tables in a client's business.db
  app.get('/api/admin/clients/:id/db', (req, res) => {
    const dbPath = getClientDbPath(req.params.id);
    if (!fs.existsSync(dbPath)) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name"
    ).all();
    db.close();
    res.json({ tables });
  });

  // Run read-only SQL query on a client's business.db
  app.post('/api/admin/clients/:id/query', (req, res) => {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string') {
      res.status(400).json({ error: 'sql field required' });
      return;
    }

    // Block writes
    if (/INSERT|UPDATE|DELETE|DROP|ALTER|CREATE/i.test(sql)) {
      res.status(403).json({ error: 'Lecture seule' });
      return;
    }

    const dbPath = getClientDbPath(req.params.id);
    if (!fs.existsSync(dbPath)) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(sql).all();
      db.close();
      res.json({ rows, count: rows.length });
    } catch (err) {
      db.close();
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // View client's CLAUDE.md and memory files
  app.get('/api/admin/clients/:id/memory', (req, res) => {
    const basePath = path.join(CLIENTS_DIR, req.params.id, 'groups', 'main');
    const claudeMdPath = path.join(basePath, 'CLAUDE.md');

    if (!fs.existsSync(claudeMdPath)) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
    const memoryFiles: Record<string, string> = {};
    const memoryDir = path.join(basePath, 'memory');

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

    res.json({ claudeMd, memoryFiles });
  });

  // View audit log
  app.get('/api/admin/clients/:id/audit', (req, res) => {
    const dbPath = getClientDbPath(req.params.id);
    if (!fs.existsSync(dbPath)) {
      res.status(404).json({ error: 'Database not found' });
      return;
    }

    const db = new Database(dbPath, { readonly: true });
    const logs = db.prepare(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100'
    ).all();
    db.close();
    res.json(logs);
  });

  // Actions (Linux/PM2 only)
  app.post('/api/admin/clients/:id/restart', (req, res) => {
    if (!IS_LINUX) {
      res.json({ ok: false, message: 'PM2 actions only available on Linux (production)' });
      return;
    }
    try {
      execSync(`pm2 restart otto-${req.params.id}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/admin/clients/:id/stop', (req, res) => {
    if (!IS_LINUX) {
      res.json({ ok: false, message: 'PM2 actions only available on Linux (production)' });
      return;
    }
    try {
      execSync(`pm2 stop otto-${req.params.id}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PM2 logs for a client
  app.get('/api/admin/clients/:id/logs', (req, res) => {
    if (!IS_LINUX) {
      res.json({ lines: ['PM2 logs only available on Linux (production)'] });
      return;
    }
    const lines = parseInt(req.query.lines as string) || 50;
    const cap = Math.min(lines, 200);
    try {
      const stdout = execSync(`pm2 logs otto-${req.params.id} --lines ${cap} --nostream --raw 2>/dev/null || true`, { timeout: 5000 }).toString();
      res.json({ lines: stdout.split('\n').filter(l => l.trim()) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // List documents for a client
  app.get('/api/admin/clients/:id/documents', (req, res) => {
    const docsDir = path.join(CLIENTS_DIR, req.params.id, 'groups', 'main', 'documents');
    if (!fs.existsSync(docsDir)) {
      res.json({ documents: [] });
      return;
    }
    try {
      const files = fs.readdirSync(docsDir).map(name => {
        const fullPath = path.join(docsDir, name);
        const stat = fs.statSync(fullPath);
        return {
          name,
          size_kb: Math.round(stat.size / 1024),
          modified: stat.mtime.toISOString(),
        };
      });
      files.sort((a, b) => b.modified.localeCompare(a.modified));
      res.json({ documents: files });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Disk usage per client
  app.get('/api/admin/clients/:id/disk', (req, res) => {
    const clientDir = path.join(CLIENTS_DIR, req.params.id);
    if (!fs.existsSync(clientDir)) {
      res.status(404).json({ error: 'Client directory not found' });
      return;
    }
    try {
      const total = execSync(`du -sh ${clientDir} 2>/dev/null | cut -f1`, { timeout: 5000 }).toString().trim();
      const breakdown: Record<string, string> = {};
      for (const sub of ['groups', 'data', 'store']) {
        const subDir = path.join(clientDir, sub);
        if (fs.existsSync(subDir)) {
          breakdown[sub] = execSync(`du -sh ${subDir} 2>/dev/null | cut -f1`, { timeout: 5000 }).toString().trim();
        }
      }
      res.json({ total, breakdown });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // API costs (requires ANTHROPIC_ADMIN_KEY)
  // Uses usage_report/messages with workspace filter + token pricing to compute real costs.
  // The cost_report endpoint returns inflated "list price" amounts, not actual billing.
  app.get('/api/admin/costs', async (_req, res) => {
    const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
    if (!adminKey) {
      res.status(503).json({ error: 'ANTHROPIC_ADMIN_KEY not configured' });
      return;
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Per-million-token pricing
    const PRICING: Record<string, { input: number; cache_write: number; cache_read: number; output: number }> = {
      'claude-sonnet-4-6':       { input: 3,    cache_write: 3.75, cache_read: 0.30, output: 15 },
      'claude-opus-4-6':         { input: 15,   cache_write: 18.75, cache_read: 1.50, output: 75 },
      'claude-haiku-4-5-20251001': { input: 0.80, cache_write: 1.00, cache_read: 0.08, output: 4 },
    };
    const DEFAULT_PRICING = { input: 3, cache_write: 3.75, cache_read: 0.30, output: 15 };
    const WEB_SEARCH_COST = 0.01; // per search

    // Fetch all workspaces to know which ones to query
    let workspaceIds: string[] = [];
    try {
      const wsResp = await fetch('https://api.anthropic.com/v1/organizations/workspaces', {
        headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
      });
      const wsBody = await wsResp.json() as { data?: { id: string; name: string }[] };
      workspaceIds = (wsBody.data || []).map(w => w.id);
    } catch { /* fallback: no workspace filter */ }

    const wsFilter = workspaceIds.length > 0
      ? workspaceIds.map(id => `workspace_ids[]=${id}`).join('&') + '&'
      : '';

    try {
      // Paginate through usage data
      interface UsageResult {
        uncached_input_tokens: number;
        cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
        cache_read_input_tokens: number;
        output_tokens: number;
        server_tool_use?: { web_search_requests: number };
        model: string;
      }
      interface UsageBucket {
        starting_at: string;
        ending_at: string;
        results: UsageResult[];
      }

      const allBuckets: UsageBucket[] = [];
      let nextPage: string | null = null;
      for (let page = 0; page < 10; page++) {
        let url = `https://api.anthropic.com/v1/organizations/usage_report/messages?starting_at=${startOfMonth}&ending_at=${now.toISOString()}&${wsFilter}group_by[]=model&bucket_width=1d`;
        if (nextPage) url += `&page=${nextPage}`;

        const response = await fetch(url, {
          headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' },
        });
        const body = await response.json() as { data?: UsageBucket[]; has_more?: boolean; next_page?: string };
        if (body.data) allBuckets.push(...body.data);
        if (!body.has_more) break;
        nextPage = body.next_page || null;
      }

      // Compute costs from token usage
      const dailyCosts: { date: string; cost: number; tokens: number; searches: number }[] = [];
      let totalCost = 0;

      for (const bucket of allBuckets) {
        let dayCost = 0;
        let dayTokens = 0;
        let daySearches = 0;
        for (const r of bucket.results) {
          const p = PRICING[r.model] || DEFAULT_PRICING;
          const cacheWrite = (r.cache_creation?.ephemeral_5m_input_tokens || 0) + (r.cache_creation?.ephemeral_1h_input_tokens || 0);
          const cost =
            (r.uncached_input_tokens / 1e6) * p.input +
            (cacheWrite / 1e6) * p.cache_write +
            (r.cache_read_input_tokens / 1e6) * p.cache_read +
            (r.output_tokens / 1e6) * p.output +
            (r.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_COST;
          dayCost += cost;
          dayTokens += r.uncached_input_tokens + cacheWrite + r.cache_read_input_tokens + r.output_tokens;
          daySearches += r.server_tool_use?.web_search_requests || 0;
        }
        if (dayCost > 0) {
          dailyCosts.push({ date: bucket.starting_at, cost: dayCost, tokens: dayTokens, searches: daySearches });
        }
        totalCost += dayCost;
      }

      res.json({ total_cost_usd: Math.round(totalCost * 100) / 100, daily: dailyCosts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
