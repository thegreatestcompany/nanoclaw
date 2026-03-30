# Analyse des coûts API — Otto by HNTIC

Date : 30 mars 2026

## Coûts mesurés par message (Sonnet 4.6, sans session resume)

| Type de message | Coût mesuré |
|----------------|-------------|
| Simple ("Bonjour") — cold start | $0.09 |
| Simple — container chaud | $0.03-0.05 |
| Moyen (query DB, résumé deals) | $0.15-0.20 |
| Complexe (PowerPoint 10 slides) | $0.25 |
| Vocal (transcription Whisper API) | $0.001 |
| Maximum par message (maxBudgetUsd) | $1.00 |

## Décomposition des coûts

Le coût fixe par query est ~$0.09 (23K tokens de system prompt SDK Claude Code).

| Composant | Tokens | Coût |
|-----------|--------|------|
| System prompt SDK (incompressible) | ~23K | ~$0.07 (cache write) / ~$0.007 (cache read) |
| Notre CLAUDE.md global | ~2.5K | ~$0.01 |
| Skills metadata (53 skills) | ~5K | ~$0.02 |
| MCP tool definitions | ~3K | ~$0.01 |
| Output (réponse) | Variable | $3-15/M tokens |

## Ce qu'on a désactivé pour réduire les coûts

| Changement | Tokens économisés | Économie |
|-----------|-------------------|----------|
| Preset `claude_code` → string custom | 0 (le SDK le charge quand même) | $0 |
| `settingSources: []` | ~5K | ~$0.02 |
| **Session resume désactivé** | **~80K** | **~$0.32/message** |
| `MAX_MESSAGES_PER_PROMPT`: 10 → 30 | +500 tokens | -$0.002 (négligeable) |

## Comportement du cache SDK

- **Premier message** (cold start) : cache_write à $3.75/M tokens → coûteux
- **Messages suivants** (même container) : cache_read à $0.30/M tokens → 12x moins cher
- Le container vit 30 min — après, nouveau cold start

## Projection par profil client

### Usage faible (entrepreneur solo)
- 15 messages/jour, majoritairement simples
- 3-4 sessions/jour
- **~$30/mois**

### Usage moyen (dirigeant PME actif)
- 40 messages/jour, mix simple/moyen/complexe
- 6-8 sessions/jour
- **~$200/mois**

### Usage élevé (power user)
- 80 messages/jour, beaucoup de documents
- 10-15 sessions/jour
- **~$450/mois**

### Usage intensif
- 200 messages/jour
- 10+ sessions/jour, 20 msgs/session
- **~$750/mois**

## Coûts annexes par client

| Poste | Coût/mois |
|-------|----------|
| API Anthropic (usage moyen) | ~$200 |
| Whisper API (5 vocaux/jour) | ~$0.15 |
| Tâches planifiées (Haiku) | ~$3.50 |
| VPS Hetzner (part par client sur CCX33) | ~$1.40 (48€/35 clients) |
| **Total hors API** | **~$5** |

## Marge selon le pricing

| Prix/mois | Usage faible | Usage moyen | Usage élevé | Usage intensif |
|-----------|-------------|-------------|-------------|----------------|
| 297€ ($325) | $295 (91%) | $125 (38%) | -$125 (perte) | -$425 (perte) |
| 447€ ($490) | $460 (94%) | $290 (59%) | $40 (8%) | -$260 (perte) |
| 597€ ($655) | $625 (95%) | $455 (69%) | $205 (31%) | -$95 (perte) |
| 897€ ($985) | $955 (97%) | $785 (80%) | $535 (54%) | $235 (24%) |
| 997€ ($1095) | $1065 (97%) | $895 (82%) | $645 (59%) | $345 (32%) |

## Leviers d'optimisation futurs

1. **Haiku pour les messages simples** — $0.01/msg au lieu de $0.05. Nécessite un routeur de complexité.
2. **Réduire les skills** — 53 → 20 skills essentiels. Économie ~2K tokens.
3. **Attendre les baisses de prix Anthropic** — tendance historique : -30-50%/an.
4. **Issue #21773** — si Anthropic strip les tool definitions inutilisées, -16K tokens.
5. **API Messages directe** — remplacerait le SDK, system prompt de 3K au lieu de 23K. Gros chantier.
6. **Plans avec cap de messages** — limite le risque de perte sur les power users.

## Bug critique découvert le 30/03 : session resume interne au container

### Le problème
Le session resume était désactivé côté HOST mais le container maintenait une session entre les messages IPC. Après 10 messages dans la même session container (30 min), la session accumulait 944K tokens → coût de $0.97 et container bloqué pendant 22 minutes.

### La cause
Dans l'agent-runner, le query loop réutilisait le `sessionId` entre les IPC messages :
```
query #1 → sessionId = new → OK ($0.09)
query #2 → sessionId = from #1 → charge #1 history ($0.15)
query #3 → sessionId = from #2 → charge #1+#2 history ($0.25)
...
query #10 → charge tout → 944K tokens ($0.97) → BLOQUE
```

### Le fix
Chaque IPC message lance une query fraîche (`sessionId: undefined`). Coût constant ~$0.09 par message.

### Compensation
Pour que l'agent se souvienne de ses réponses sans session resume, le prompt inclut maintenant les 30 derniers messages **incluant les réponses d'Otto** (via `getRecentConversation()`). Le prompt a deux sections :
- `[Conversation récente pour contexte]` — historique avec les réponses d'Otto
- `[Nouveaux messages à traiter]` — les nouveaux messages du client

## Limites de l'architecture actuelle

- Le SDK Claude Code ajoute ~23K tokens de system prompt incompressible (issue #18744, closed "not planned")
- L'option `tools` en array ne réduit pas ce system prompt (issue #21773)
- Sans session resume, l'agent n'a pas de mémoire conversationnelle au-delà des 30 derniers messages WhatsApp
- La mémoire long terme repose sur CLAUDE.md + business.db + conversations/
- Un container bloqué (query lente) empêche les messages suivants d'être traités → besoin d'un timeout par query
