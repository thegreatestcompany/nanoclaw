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
| `src/passive-scanner.ts` | Scans unregistered conversations for business data |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/db.ts` | SQLite operations (messages.db) |
| `container/agent-runner/src/index.ts` | Code running inside the container |
| `container/agent-runner/src/business-db-mcp.ts` | MCP server for business.db (query/mutate with audit) |
| `container/skills/` | 53 skills loaded inside agent containers |
| `groups/global/CLAUDE.md` | Global agent instructions (shared across clients) |
| `scripts/init-business-db.sql` | Business DB schema (25 tables) |
| `api/src/stripe.ts` | Stripe webhook → auto-provisioning |
| `api/src/onboard.ts` | WhatsApp QR code/pairing + reconnection flow |
| `api/src/mailer.ts` | Transactional emails (Gmail SMTP) |
| `api/src/admin.ts` | Admin back-office API |

## Secrets / Credentials

API keys are managed by the native credential proxy (`src/credential-proxy.ts`). Each client has a `.env` with their own API key, read by the proxy at request time. Containers never see real keys — they get `ANTHROPIC_BASE_URL` pointing to the proxy.

The API's `.env` is at `api/.env` (gitignored) and contains Stripe, SMTP, and admin credentials.

## VPS Architecture

```
/opt/otto/
  app/           ← This repo (git pull to update)
    api/         ← Onboarding API (runs as PM2 process otto-api)
    src/         ← Host process code
    container/   ← Docker image + skills
    groups/      ← Global CLAUDE.md template
  clients/       ← Per-client isolated directories
    {id}/
      .env       ← Client API key (never mounted in containers)
      groups/    ← Client data (business.db, CLAUDE.md, documents/)
      data/      ← Sessions, skills cache
      store/     ← WhatsApp auth credentials
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

- **register_group via IPC is disabled** — agents cannot add themselves to new WhatsApp groups (security)
- **scan_config is read-only for agents** — passive scan configuration is admin-only (privacy)
- **Session resume is enabled** — sessions persist across container restarts via mounted .claude/
- **maxTurns: 30, maxBudgetUsd: 0.50** — guardrails against infinite loops
- **Whisper: OpenAI API** when OPENAI_API_KEY is set, local whisper.cpp (ggml-small) as fallback

## Troubleshooting

See [TEMP/POSTMORTEM-DEPLOIEMENT.md](TEMP/POSTMORTEM-DEPLOIEMENT.md) for all known issues and fixes. Key gotchas:

- **Bash tool fails silently**: Check `.claude/` permissions (must be writable by uid 1000)
- **Container crashes on start**: Check entrypoint — TypeScript compilation may fail if source changed
- **WhatsApp not connecting**: Check `store/auth/` exists and has valid creds. Use `/reconnect` page.
- **PM2 "Script already launched"**: Use `pm2 restart` instead of `pm2 start`
