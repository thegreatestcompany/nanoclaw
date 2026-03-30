# TODO — Otto by HNTIC

## Prêt pour la prod (validé)

- [x] Flow onboarding complet : Stripe → email → QR code → WhatsApp connecté → email bienvenue
- [x] Reconnexion : /reconnect → email → nouveau lien 24h
- [x] QR code + pairing code (fallback)
- [x] Gestion d'erreurs (tous les échecs propagés à l'UI)
- [x] Skills Anthropic (docx, pptx, xlsx, pdf) + 36 skills métier
- [x] Whisper API OpenAI (2s)
- [x] Permissions multi-tenant (root:1000, 770)
- [x] Sécurité (injection admin, sandbox, register_group désactivé)

## À faire avant le premier vrai client

### Admin dashboard
Page web admin pour visualiser et gérer le VPS :
- Vue d'ensemble : clients actifs, process PM2, containers Docker
- Par client : statut WhatsApp, logs récents, contenu business.db, CLAUDE.md, documents générés
- Actions : restart, stop, voir les logs, consulter la base
- L'API admin existe déjà (`/api/admin/*`) — il faut juste un frontend

### Stripe live
Passer de test à prod : nouvelles clés + nouveau webhook endpoint dans le dashboard Stripe.

### ~~Timeout par query dans le container~~ (RÉSOLU 30/03/2026)
Résolu par 3 fixes combinés :
1. **Session resume désactivé** — chaque IPC = fresh query, plus d'accumulation de tokens (cause racine)
2. **Budget exceeded → exit** — quand `error_max_budget_usd`, le container s'arrête au lieu de bloquer
3. **Query timeout 5 min** — filet de sécurité ultime (hang réseau, API bloquée)
4. **IPC idle timeout 10 min** — le container s'auto-termine si le host ne lui envoie jamais `_close`
5. **Idle timer (host)** — armé sur tous les résultats, pas juste ceux avec du texte
6. **SQLite busy_timeout 5s** — retry sur lock au lieu de fail immédiat

Watchdog `GroupQueue` (nice-to-have) : si Docker daemon freeze, `active=true` pourrait rester coincé indéfiniment. Risque très faible (3 couches de timeout tuent le container avant). Un timer indépendant dans GroupQueue forcerait `active=false` après 35 min.

### Robustesse WhatsApp (CRITIQUE)
Le process PM2 du client ne doit PAS tenter de se re-lier tout seul quand WhatsApp se déconnecte. Actuellement Baileys émet des QR codes automatiquement → crée des liaisons fantômes.

À implémenter :
1. Quand Baileys détecte une déconnexion (connection.close, loggedOut, QR refs ended) → le process se met en pause au lieu d'émettre des QR
2. Envoyer un email automatique au client : "Ton WhatsApp s'est déconnecté, clique ici pour reconnecter"
3. Le process attend que le client se reconnecte via /onboard (pas via les QR internes de Baileys)
4. Tester tous les scénarios : déconnexion volontaire, changement de téléphone, timeout, crash process

### Migration automatique business.db
Les clients existants ne bénéficient pas des nouveaux schémas (tables/colonnes). Implémenter un système de versioning avec `PRAGMA user_version` : au démarrage du process client, comparer la version de la base avec la version attendue et exécuter les migrations manquantes automatiquement. Pattern standard, zéro downtime.

### Monitoring
- PM2 auto-restart en cas de crash (`--max-memory-restart`)
- Alerting quand un process client crash

### Passive scanner
L'infra est en place (passive scanner analyse toutes les 2h, `scan_config` pour exclure des JIDs). Désactivé en dev (conversations perso).

**Activation prod** : dans `src/channels/whatsapp.ts`, remplacer `if (groups[chatJid]) {` par `if (!isRegistered) { ... } else if (isRegistered) {` pour stocker les messages de toutes les conversations non-enregistrées. C'est une ligne de code (voir commit `f332aa7`).

**Modèle** : opt-out (tout est scanné sauf `scan_config mode='ignore'`). Adapté aux clients WhatsApp Business (contacts pro uniquement).

**À faire :**
1. Endpoint admin API pour gérer les exclusions scan_config (add/remove JID)
2. Page dans l'interface d'onboarding pour que le client exclue ses conversations perso

### Gmail OAuth automatisé
L'intégration Gmail est actuellement manuelle (copie de credentials via scp). Pour l'onboarding self-service :
1. Créer un projet GCP unique avec consent screen vérifié (HNTIC)
2. Ajouter un flow OAuth dans l'API d'onboarding (redirection → callback → stockage tokens)
3. Le client clique un lien, autorise Gmail, et c'est configuré automatiquement
4. Refresh token stocké dans le dossier client, monté dans le container

## Optimisation des coûts API (documenté le 30/03/2026)

### Résumé

Le coût par message était de **$0.41** et est descendu à **$0.09** (~78% de réduction).

### Cause racine

Le session resume du SDK chargeait ~80K tokens d'historique de session à chaque query. Combiné au system prompt interne de Claude Code (~23K tokens), chaque message coûtait ~$0.40-0.50.

### Mesures prises

| Changement | Impact |
|-----------|--------|
| Retrait du preset `claude_code` dans systemPrompt | -0K (le SDK charge son propre prompt de toute façon) |
| `settingSources: []` | Empêche le chargement des settings/CLAUDE.md additionnels |
| Passage du CLAUDE.md global en string direct | Contrôle total du system prompt |
| **Désactivation du session resume** | **-80K tokens, -$0.32/message** |
| `MAX_MESSAGES_PER_PROMPT` de 10 → 30 | Compense la perte de session resume avec le contexte WhatsApp récent |
| Option `tools` en array explicite | Réduit légèrement les tool definitions |

### Coûts mesurés (Sonnet 4.6)

| Message | Cold (1er msg) | Warm (2e+ msg) |
|---------|---------------|----------------|
| Simple ("Bonjour") | $0.09 | $0.02-0.05 |
| Moyen (query DB) | $0.10-0.15 | $0.05-0.10 |
| Complexe (création doc) | $0.15-0.25 | $0.10-0.20 |

### Projection mensuelle

~20 messages/jour × ~$0.10/msg = **~$60/mois** par client.
À 447€/mois → **~370€ de marge**.

### Limites connues

- Le system prompt interne du SDK (~23K tokens) est incompressible — Anthropic ne prévoit pas de le réduire ([issue #18744](https://github.com/anthropics/claude-code/issues/18744), closed "not planned")
- L'option `tools` en array ne réduit pas les tool definitions internes ([issue #21773](https://github.com/anthropics/claude-code/issues/21773))
- Sans session resume, Otto ne se souvient pas des conversations passées au-delà des 30 derniers messages WhatsApp — la mémoire long terme repose sur CLAUDE.md + business.db + conversations/
- Si un jour les prix API baissent ou le SDK est optimisé, on pourra réactiver le session resume

## Roadmap (moyen terme)

### Migration WhatsApp Business API
Remplacer Baileys (protocole non-officiel) par l'API officielle Meta. Résout 3 problèmes d'un coup : notifications, multi-tenant single-process, et risque de ban.

**Prérequis admin :**
1. Créer un Meta Business Account
2. Vérifier l'entreprise HNTIC (documents, 1-4 semaines)
3. Obtenir un numéro WhatsApp Business via le dashboard Meta
4. Faire approuver les message templates (rappels, briefings initiés par Otto)

**Implémentation (1-2 jours de code) :**
1. Nouveau channel `src/channels/whatsapp-business.ts` (~150 lignes)
   - Webhook POST pour recevoir les messages (comme Stripe)
   - HTTP POST vers `graph.facebook.com` pour envoyer
2. Le routing se fait par numéro de téléphone du client (plus par JID)
3. Un seul webhook pour TOUS les clients (multi-tenant natif)
4. Plus besoin de 1 process PM2 par client pour WhatsApp

**Avantages :**
- API officielle, zéro risque de ban
- Stateless — pas de reconnexion, pas de session stale
- Multi-tenant single-process (1 webhook vs N connexions Baileys)
- Notifications fonctionnent nativement

**Coûts :**
- Messages client→Otto : gratuit (fenêtre 24h)
- Messages Otto→client (rappels, briefings) : ~0.05-0.10€/conversation
- Estimation 35 clients × 5 conv/jour : 250-500€/mois

**Quand migrer :** Quand la vérification Meta Business est terminée. Garder Baileys comme fallback pendant la transition.

### Multi-tenant single-process
Passer de 1 process PM2 par client à 1 process unique. Prérequis : WhatsApp Business API (un seul webhook au lieu de N connexions Baileys). Voir `docs/ARCHITECTURE.md` section Scalabilité.

### Admin key Anthropic par client
Actuellement commentée (`ANTHROPIC_ADMIN_KEY`). À activer en prod pour créer un workspace + clé API isolés par client. Permet l'isolation des coûts et la révocation individuelle.

## À lancer maintenant (process admin)

### Vérification Meta Business
Créer un Meta Business Account + vérifier HNTIC. Prend 1-4 semaines. Bloque la migration WhatsApp Business API.
→ https://business.facebook.com/

### Landing page / site commercial
Page de vente pour Otto avec le Payment Link Stripe intégré.

## Résumé de la session du 29/03/2026

Journée complète de dev : permissions, sandbox, skills, sécurité, architecture, onboarding. ~40 commits. Tout documenté dans ARCHITECTURE.md, SECURITY.md, et POSTMORTEM-DEPLOIEMENT.md.
