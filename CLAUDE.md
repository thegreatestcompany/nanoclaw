# Otto by HNTIC

AI Chief of Staff SaaS accessible via WhatsApp, built on NanoClaw (Claude Agent SDK). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture guide and [docs/SECURITY.md](docs/SECURITY.md) for the security model.

## Quick Context

Multi-tenant SaaS on a single Hetzner VPS. Each client gets their own PM2 process, WhatsApp connection (Baileys), credential proxy port, and isolated data directory. Messages route to Claude Agent SDK running in ephemeral Docker containers. 53 skills (Anthropic official + knowledge-work + HNTIC custom).

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/container-runner.ts` | Spawns agent containers with mounts, fixes permissions |
| `src/credential-proxy.ts` | HTTP proxy that injects API keys into container requests |
| `src/channels/whatsapp.ts` | WhatsApp channel (Baileys) |
| `src/transcription.ts` | Voice transcription (OpenAI Whisper API, fallback whisper.cpp) |
| `src/memory-consolidator.ts` | Daily learnings + weekly AutoDream |
| `src/passive-scanner.ts` | Scans registered non-main groups for business data |
| `src/ipc.ts` | IPC watcher and task processing (portal_link, messages, tasks) |
| `src/db.ts` | SQLite operations (messages.db) |
| `container/agent-runner/src/index.ts` | Code running inside the container |
| `container/agent-runner/src/business-db-mcp.ts` | MCP server for business.db (query/mutate with audit) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP tools: send_message, send_document, portal_link, schedule_task |
| `container/skills/` | 47 business skills + blocked admin skills |
| `groups/global/CLAUDE.md` | Global agent instructions (shared across clients) |
| `scripts/init-business-db.sql` | Business DB schema (26 tables, incl. pending_updates) |
| `src/business-db-migrate.ts` | Auto-migration system for business.db (PRAGMA user_version) |
| `api/src/stripe.ts` | Stripe webhook → provisioning/deprovisioning + WhatsApp notifications |
| `api/src/onboard.ts` | WhatsApp QR code/pairing + reconnection flow |
| `api/src/mailer.ts` | Transactional emails (Gmail SMTP) |
| `api/src/admin.ts` | Admin back-office API |
| `api/src/client-portal.ts` | Client portal routes (JWT auth, business data, documents) |
| `api/src/webchat.ts` | WebSocket bridge for portal chat |
| `api/src/composio-webhooks.ts` | POST /api/webhook/composio handler — HMAC verify + route to client |
| `api/src/composio-triggers.ts` | Composio triggers management (create, list, delete, periodic provision) |
| `api/scripts/setup-composio-webhook.ts` | One-shot script to create webhook subscription (run once per env) |
| `api/public/portal.html` | Client portal SPA (6 tabs + chat) |
| `api/public/index.html` | Landing page (otto.hntic.fr) |
| `api/src/db.ts` | Onboarding DB (clients table — HNTIC CRM data) |

## Secrets / Credentials

API keys are managed by the native credential proxy (`src/credential-proxy.ts`). Each client has a `.env` with their own API key, read by the proxy at request time. Containers never see real keys — they get `ANTHROPIC_BASE_URL` pointing to the proxy.

The API's `.env` is at `api/.env` (gitignored) and contains Stripe, SMTP, and admin credentials.

## VPS Architecture

```
/opt/otto/
  app/           ← This repo (git pull to update)
    api/         ← Onboarding API + portal + webchat (PM2 process otto-api)
      data/onboarding.db  ← HNTIC CRM (all clients, Stripe data, contacts)
    src/         ← Host process code
    container/   ← Docker image + skills
    groups/      ← CLAUDE.md templates (global + main)
  clients/       ← Per-client isolated directories
    {id}/
      .env       ← Client API key + PORTAL_JWT_SECRET (never mounted in containers)
      groups/    ← Client data (business.db, CLAUDE.md, documents/)
      data/      ← Sessions, skills cache, IPC
      store/     ← WhatsApp auth credentials + messages.db
  backups/       ← Client backups (tar.gz, created on deprovisioning)
```

## Permissions

Host runs as root, containers run as node (uid 1000). All writable mounts get `chown root:1000 + chmod u=rwX,g=rwX,o=` automatically before each container launch. Never use `chmod 777`.

The SDK sandbox is disabled (`sandbox: { enabled: false }`) — Docker IS the sandbox.

## Development

```bash
npm run build              # Compile TypeScript
npm run dev                # Run with hot reload
./container/build.sh       # Rebuild agent container
```

## Deployment

```bash
cd /opt/otto/app && git pull origin main && npm run build
cd api && npm run build && pm2 restart otto-api
# If Dockerfile or skills changed:
cd /opt/otto/app/container && ./build.sh
pm2 restart otto-test  # or the client process
```

## Key Decisions

- **register_group via IPC is main-only + groups-only** — only the main group can register new groups, and only group JIDs (@g.us) are accepted (individual conversations blocked to prevent contacts from accessing business data)
- **scan_config is read-only for agents** — passive scan configuration is admin-only (privacy)
- **Session resume is enabled** — sessions persist across container restarts via mounted .claude/
- **maxTurns: 30, maxBudgetUsd: 0.50** — guardrails against infinite loops
- **Whisper: OpenAI API** when OPENAI_API_KEY is set, local whisper.cpp (ggml-small) as fallback
- **WebSearch blocked when Exa available** — PreToolUse hook forces Exa for web search (better results)
- **HITL on all INSERT** — business tables require user confirmation before creating data (anti-hallucination). Scheduled tasks (passive scanner, cron) bypass HITL for INSERT but can never UPDATE/DELETE business data — they write to `pending_updates` instead, which Otto presents to the user for validation
- **Composio triggers via webhook** — proactive Otto via Composio events. Webhook URL: `https://otto.hntic.fr/api/webhook/composio` (must be under `/api/` for nginx routing). HMAC-SHA256 signature verification with secret stored in `api/.env` as `COMPOSIO_WEBHOOK_SECRET`. Composio user_id = WhatsApp JID (not client slug). Default triggers: Calendar only (Gmail intentionally excluded — too much noise/cost). Auto-provisioning via hourly periodic job in otto-api, cleanup on deprovisioning
- **Auto ⏳ feedback** — PreToolUse hook sends hourglass on first slow tool call (code-level, not prompting)
- **Portal auth by 6-digit code** — no JWT in URL, code sent via WhatsApp, 5min TTL, single-use
- **PM2 exponential backoff** — `--exp-backoff-restart-delay=1000` prevents crash restart loops
- **Stripe shared API key** — Admin API can't create keys programmatically, workspace per client for cost tracking
- **Deprovisioning 24h grace** — WhatsApp farewell → backup tar.gz → delete → status cancelled

## Web Pages

| URL | Description |
|-----|-------------|
| `https://otto.hntic.fr` | Landing page |
| `https://otto.hntic.fr/portal` | Client portal (code auth) |
| `https://otto.hntic.fr/admin` | Admin dashboard (token auth) |
| `https://otto.hntic.fr/reconnect` | WhatsApp reconnection |
| `https://otto.hntic.fr/onboard/:token` | QR code onboarding |

## Troubleshooting

See [TEMP/POSTMORTEM-DEPLOIEMENT.md](TEMP/POSTMORTEM-DEPLOIEMENT.md) for all known issues and fixes. Key gotchas:

- **Bash tool fails silently**: Check `.claude/` permissions (must be writable by uid 1000)
- **Container crashes on start**: Check entrypoint — TypeScript compilation may fail if source changed
- **WhatsApp not connecting**: Check `store/auth/` exists and has valid creds. Use `/reconnect` page.
- **PM2 "Script already launched"**: Use `pm2 restart` instead of `pm2 start`
- **PM2 PID N/A + 0b memory**: Process in crash loop — `pm2 delete` + `pm2 start` to reset restart counter
- **Global CLAUDE.md not updated on client**: It's copied at provisioning, not symlinked. Update manually: `cp groups/global/CLAUDE.md /opt/otto/clients/{id}/groups/global/CLAUDE.md`
- **Session purge needed after CLAUDE.md changes**: `sqlite3 store/messages.db "DELETE FROM sessions"` + pm2 restart
