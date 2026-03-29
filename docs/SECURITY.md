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
> /outside/workspace  — redirect outside workspace (except /dev/null, /tmp/)
```

**Write restrictions:**
- `Write` and `Edit` tools limited to `/workspace/group/` and `/tmp/`
- Writes outside these paths are denied with an explanation

**PostToolUse audit logging:**
- SQL mutations via Bash are logged for audit
- All tool calls are logged with `[TOOL]` prefix for monitoring

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
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Via credential proxy | Via credential proxy |
| MCP tools | All | All |

## Known Pitfalls

1. **`.claude/` permissions** — The SDK requires write access to `~/.claude/session-env/`. If this directory is owned by root and the container runs as node, the Bash tool fails silently on every execution. Fix: `chown root:1000` applied automatically.

2. **SDK sandbox vs Docker** — The SDK's `unshare`-based sandbox is redundant inside Docker and blocks installed tools. Fix: `sandbox: { enabled: false }`.

3. **`umask 000` in PM2 wrapper** — Files created at runtime (IPC) are world-readable, but this is contained within the client's 770 directory tree.
