# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Isolated | Docker container, non-root, ephemeral |
| Incoming messages | User input | Potential prompt injection |
| Admin API | Authenticated | Static bearer token, input-validated |

## Security Boundaries — 4 couches

```
┌─────────────────────────────────────────────────────────────────┐
│                       UNTRUSTED ZONE                            │
│  Incoming Messages (potentially malicious)                      │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ Trigger check, JID matching
┌─────────────────────────────────────────────────────────────────┐
│                    HOST PROCESS (TRUSTED)                        │
│  • Message routing (JID → registered_groups)                    │
│  • IPC authorization (main vs non-main)                         │
│  • Mount validation (external allowlist)                        │
│  • Container lifecycle                                          │
│  • Credential proxy (injects API keys at request time)          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼ Explicit mounts only, no secrets
┌─────────────────────────────────────────────────────────────────┐
│               CONTAINER (DOCKER, ISOLATED)                      │
│  • Agent execution (Claude Agent SDK)                           │
│  • Bash commands (SDK sandbox disabled, Docker IS the sandbox)  │
│  • File operations (limited to mounted volumes)                 │
│  • PreToolUse hooks (block destructive commands)                │
│  • API calls routed through credential proxy                    │
│  • No real credentials in environment or filesystem             │
└─────────────────────────────────────────────────────────────────┘
```

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers, providing:
- **Process isolation** — Container processes cannot affect the host
- **Filesystem isolation** — Only explicitly mounted directories are visible
- **Non-root execution** — Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** — Fresh environment per invocation (`--rm`), destroyed after 30 min idle

The SDK's built-in Bash sandbox (`unshare`) is **disabled** (`sandbox: { enabled: false }`) because Docker already provides this isolation. The sandbox was blocking legitimate tools (python3, pandoc, ffmpeg) installed in the container.

### 2. Mount Security

**External Allowlist** — Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.).

### 3. Credential Proxy (Native)

Real API credentials **never enter containers**. The host runs a lightweight HTTP proxy (`src/credential-proxy.ts`) that intercepts API calls and injects credentials at request time.

**How it works:**
1. The host starts a credential proxy on a dedicated port (one per client in multi-tenant)
2. Container receives `ANTHROPIC_BASE_URL=http://172.17.0.1:{port}` — pointing to the proxy, not Anthropic
3. When the SDK makes API calls, they go to the proxy
4. The proxy reads the real API key from the client's `.env`, injects it as `x-api-key` header, and forwards to `api.anthropic.com`
5. The container never sees the real API key — not in environment, stdin, files, or `/proc`

**NOT Mounted:**
- Client `.env` (API keys) — read only by the proxy, never mounted
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- `.env` is shadowed with `/dev/null` in the project root mount

### 4. PreToolUse Hooks (Application-Level)

Inside the container, the agent-runner applies security hooks before each tool execution:

**Blocked Bash patterns:**
```
rm -rf /              — destructive filesystem operations
DROP TABLE/DATABASE   — destructive SQL
TRUNCATE              — destructive SQL
> /outside/workspace  — redirect outside workspace (except /workspace/group, /workspace/ipc, /dev/null, /tmp/)
```

**Tool redirections:**
- `WebSearch` bloqué quand Exa est configuré — le hook redirige vers `mcp__exa__*` (meilleurs résultats)

**Write restrictions:**
- `Write` and `Edit` tools limited to `/workspace/group/` and `/tmp/`
- Writes outside these paths are denied with an explanation

**HITL INSERT (anti-hallucination):**
- Tous les INSERT sur les tables business nécessitent une confirmation du dirigeant via la state machine pending_mutations
- Empêche l'agent d'inventer des contacts, deals, factures, etc. sans instruction explicite
- Tables exemptées (auto-générées) : audit_log, interactions, memories, activity_digests, relationship_summaries, pending_updates
- Scheduled tasks (passive scanner, cron) bypass HITL for INSERT only — UPDATE/DELETE toujours bloqués

**Passive scanner — pending_updates flow:**
- Le scan passif ne peut que INSERT dans les tables business, jamais UPDATE/DELETE
- Quand une modification est détectée, elle est stockée dans `pending_updates` (table exemptée du HITL)
- Otto présente les pending au dirigeant dans le self-chat pour validation (confirmation partielle possible)
- Protections : vérification old_value avant apply, check record non-supprimé, anti-doublon (incl. dismissed), supersede des anciens pending, cleanup > 30 jours

**Auto feedback ⏳:**
- Le hook envoie automatiquement un ⏳ via IPC au premier appel d'outil lent (Bash, Skill, Exa, Composio, Gmail, Calendar)
- Cooldown de 10s entre chaque feedback
- chatJid passé par closure (pas process.env — non disponible dans les hooks)

**PostToolUse audit logging:**
- SQL mutations via Bash are logged for audit
- All tool calls are logged with `[TOOL]` prefix for monitoring
- Documents créés à la racine sont auto-déplacés vers `documents/`

## Multi-Tenant Isolation

In multi-tenant deployments, each client is isolated at multiple levels:

### Filesystem

```
/opt/otto/clients/
  ├─ dupont/          ← chown root:1000, chmod 770
  │   ├─ .env         ← chmod 600, never mounted in containers
  │   ├─ groups/      ← only Dupont's containers can access
  │   ├─ data/
  │   └─ store/
  │
  └─ martin/          ← completely separate, Dupont can't see this
      └─ ...
```

**Permission model:** `chown root:1000` + `chmod u=rwX,g=rwX,o=` (770/660)
- `root` (owner): host process can read/write
- `gid 1000` (group): container's `node` user can read/write
- `others`: no access — other clients cannot see these files

Applied automatically by `container-runner.ts` on all writable mounts before each container launch.

### Credential Isolation

Each client has:
- Their own `.env` with their own API key
- Their own credential proxy port
- (When enabled) Their own Anthropic workspace + API key via Admin API

### Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data is per-group, never shared

### IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |
| Register new group | ✓ (groups only) | ✗ |

**register_group security:**
- Double verification `isMain`: at MCP tool level (container) AND IPC handler level (host)
- JID validation: only `@g.us` (group) JIDs accepted — individual conversations (`@s.whatsapp.net`) are blocked to prevent contacts from querying business data via `@otto`
- Folder name validated via `isValidGroupFolder()` (prevents path traversal)
- `requiresTrigger: true` by default — Otto only responds to `@otto` in groups, not all messages
- User warning: CLAUDE.md instructs Otto to warn the user that group members will have access to business data before proceeding

## Admin API Security

The admin back-office (`api/src/admin.ts`) is protected by:

1. **Bearer token** — `x-admin-token` header checked against `ADMIN_TOKEN` env var
2. **Input validation** — All `:id` URL parameters validated against `/^[a-z0-9-]+$/` via `app.param()` to prevent command injection
3. **Platform gating** — PM2 commands (restart, stop) only execute on Linux

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Main folder (business.db) | Own (rw) | `/workspace/main` (ro) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Via credential proxy | Via credential proxy |
| MCP tools | All | All |
| DB mutations | INSERT (HITL) + UPDATE/DELETE | Read-only (blocked by PreToolUse) |
| Register groups | ✓ (groups only) | ✗ |

## Container Attack Surface Audit (30/03/2026)

### Mounts writable (l'agent peut lire ET écrire)

| Chemin container | Contenu | Risque | Protection |
|-----------------|---------|--------|------------|
| `/workspace/group/` | business.db, CLAUDE.md, documents/ | Légitime | Aucune restriction (c'est l'espace de travail) |
| `/home/node/.claude/` | settings.json, session-env/, skills/ | Sensible | Bash bloqué (`/.claude\//`), Write/Edit limité à `/workspace/group/` |
| `/home/node/.gmail-mcp/` | OAuth tokens, credentials | Très sensible | Bash bloqué (`/.gmail-mcp\//`) |
| `/workspace/ipc/` | Messages IPC | Légitime | Aucune restriction |
| `/app/src/` | Code source agent-runner | Très sensible | Bash bloqué (`/\/app\/src\//`), Write/Edit limité |

### Mounts readonly (l'agent peut lire)

| Chemin container | Contenu | Risque | Protection |
|-----------------|---------|--------|------------|
| `/workspace/project/` | Code source complet de l'app host | Sensible | Bash bloqué (`/\/workspace\/project\//`) |
| `/workspace/project/.env` | Shadowed avec /dev/null | OK | Inaccessible |
| `/workspace/global/` | CLAUDE.md global | OK | Lecture seule |

### Commandes Bash bloquées

| Pattern | Ce qu'il bloque |
|---------|----------------|
| `rm -rf /` | Suppression destructrice |
| `DROP TABLE/DATABASE`, `TRUNCATE` | SQL destructif |
| `> /outside/workspace` | Redirection hors workspace |
| `settings.json` | Modification config SDK |
| `.claude/` | Accès au dossier SDK |
| `.gmail-mcp/` | Accès aux credentials Gmail |
| `creds.json` | Accès aux credentials WhatsApp |
| `.env` | Accès aux fichiers d'environnement |
| `/app/src/` | Accès au code source agent-runner |
| `/workspace/project/` | Accès au code source host |
| `env` (commande seule) | Affichage des variables d'environnement |
| `printenv` | Affichage des variables d'environnement |
| `/proc/` | Introspection système (environ, cmdline) |
| `curl/wget 172.17.*` | Accès réseau au host Docker |

### Skills natifs bloqués (PreToolUse hook)

32 skills dev/admin bloqués par nom : update-config, setup, debug, customize, init-onecli, claw, convert-to-apple-container, update-nanoclaw, update-skills, add-telegram, add-slack, add-discord, add-emacs, add-parallel, add-ollama-tool, add-macos-statusbar, add-whatsapp, add-compact, add-telegram-swarm, use-local-whisper, use-native-credential-proxy, x-integration, add-voice-transcription, add-image-vision, add-reactions, add-pdf-reader, add-gmail, channel-formatting, get-qodo-rules, qodo-pr-resolver, slack-formatting, capabilities, status.

### Incident du 30/03 : contournement du blocage Skill

L'agent a contourné le blocage du skill `update-config` en modifiant directement `~/.claude/settings.json` via Bash (`cat > ~/.claude/settings.json`). Fix : ajout de `.claude/` et `settings.json` aux patterns Bash bloqués.

**Leçon** : chaque blocage (Skill, Write/Edit, Bash) est indépendant. L'agent peut contourner un blocage en utilisant un autre outil. Il faut bloquer à TOUS les niveaux simultanément.

## Defense-in-depth contre le prompt leak (30/03/2026)

Problème : le modèle ignore les instructions de confidentialité du CLAUDE.md sous pression sociale ("question de vie ou de mort") et expose l'architecture interne (chemins, fichiers, technologies).

### 3 couches de protection (recommandations Anthropic)

| Couche | Mécanisme | Fichier | Contournable ? |
|--------|-----------|---------|----------------|
| 1. Prompt engineering | `<confidential>` tags + refusal message canonique | `groups/global/CLAUDE.md` | Oui (social engineering) |
| 2. Hook blocking | PreToolUse bloque skills admin + Bash sensibles | `container/agent-runner/src/index.ts` | Non (code-level) |
| 3. Output filtering | Regex sur 20+ patterns avant envoi WhatsApp | `src/router.ts` (`formatOutbound`) | Non (code-level) |

### Output filter (`formatOutbound`)

Appliqué sur **tous** les chemins de sortie (résultats agent + IPC send_message). Si un pattern technique est détecté, la réponse entière est remplacée par : "Désolé, je ne suis pas en mesure de répondre à cette demande."

Patterns bloqués : `/workspace/`, `/home/node/`, `.claude/`, `settings.json`, `CLAUDE.md`, `business.db`, `sqlite`, `claude code`, `claude sdk`, `agent runner`, `container`, `docker`, `/proc/`, `mcp__`, `nanoclaw`, `credential proxy`, `session env`, `creds.json`.

### Non implémenté (coût trop élevé)

- **Input screening** : pré-filtrer les messages client avec Haiku pour détecter les jailbreaks → ajoute ~$0.01 + latence par message
- **LLM output screening** : vérifier la réponse avec un second modèle → double le coût

### Leçon apprise

Le prompt engineering seul ne suffit JAMAIS pour la sécurité. Le modèle peut toujours être convaincu d'ignorer ses instructions. Seul le filtrage côté code (post-processing) est fiable. C'est la recommandation officielle d'Anthropic : "Use post-processing: Filter outputs for keywords that might indicate a leak."

### Risques résiduels

- L'agent peut toujours `curl` vers des sites externes (pas seulement le host) — nécessaire pour Exa/WebFetch. L'accès au host Docker (`172.17.*`) est bloqué.
- L'agent peut lire le contenu de `/workspace/group/` qui contient business.db — c'est légitime mais un client malveillant pourrait tenter une injection de prompt via les données
- `mcp__gmail__send_email` / Composio : les emails nécessitent une confirmation via CLAUDE.md (instruction) + HITL pending_emails. Le code bloque l'envoi et demande confirmation au dirigeant.
- Les clés Exa, OpenAI (Whisper), Composio sont dans les env vars du container. En cas de compromission, un attaquant pourrait les utiliser — risque acceptable (rate limitées, scopées, par client).
- Le global CLAUDE.md est **copié** à chaque client au provisioning, pas symlinké. Une mise à jour nécessite de copier manuellement chez chaque client + purger les sessions.

## Portail client & Webchat

### Authentification portail

| Couche | Mécanisme |
|--------|-----------|
| Entrée | Code 6 chiffres envoyé via WhatsApp (pas de token dans l'URL) |
| Code | 5 min TTL, usage unique, stocké en mémoire API (pas en DB) |
| Brute force | Rate limité : 5 tentatives / 15 min / IP |
| Session | JWT cookie httpOnly + secure + sameSite strict, 24h |
| Isolation | client_id extrait du JWT uniquement, jamais de paramètre URL |
| Fichiers | Path traversal (`path.resolve` + préfixe check), extension whitelist, paths bloqués (.env, store/, data/, .claude/, business.db) |
| DB | Queries prédéfinies (pas de SQL arbitraire), Database ouvert en readonly |
| Rate limit | 200 req/min par client |
| Billing | Lien vers Stripe Customer Portal (hébergé par Stripe, pas nous) |

### Webchat

| Risque | Protection |
|--------|-----------|
| Auth WebSocket | JWT vérifié à l'upgrade (cookie ou query param) |
| Injection messages | Écrits avec `sender='webchat'`, `is_from_me=1` — traités comme messages du dirigeant |
| Cross-client | Chaque connexion est scopée au `chatJid` du client (extrait de `registered_groups` dans sa propre `messages.db`) |
| [Web] echo | Messages filtrés par `content NOT LIKE '%[Web] %'` pour éviter les doublons |

### Billing & Deprovisioning

| Risque | Protection |
|--------|-----------|
| Webhook Stripe spoofé | Signature vérifiée avec `STRIPE_WEBHOOK_SECRET` |
| Deprovisioning accidentel | 24h de grâce, réabonnement possible pendant la grâce |
| Données perdues | Backup tar.gz automatique avant suppression + backups quotidiens Hetzner |
| Notification manquée | Fallback email si WhatsApp est déconnecté |
| PM2 crash loop | Exponential backoff (`--exp-backoff-restart-delay=1000`) |

## Known Pitfalls

1. **`.claude/` permissions** — The SDK requires write access to `~/.claude/session-env/`. If this directory is owned by root and the container runs as node, the Bash tool fails silently on every execution. Fix: `chown root:1000` applied automatically.

2. **SDK sandbox vs Docker** — The SDK's `unshare`-based sandbox is redundant inside Docker and blocks installed tools. Fix: `sandbox: { enabled: false }`.

3. **`umask 000` in PM2 wrapper** — Files created at runtime (IPC) are world-readable, but this is contained within the client's 770 directory tree.
