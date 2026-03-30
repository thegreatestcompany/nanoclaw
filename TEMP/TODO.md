# TODO — Otto by HNTIC

## Fait (validé)

- [x] Flow onboarding complet : Stripe → email → QR code → WhatsApp connecté → email bienvenue
- [x] Reconnexion : /reconnect → email → nouveau lien 24h
- [x] QR code + pairing code (fallback)
- [x] Gestion d'erreurs (tous les échecs propagés à l'UI)
- [x] Skills Anthropic (docx, pptx, xlsx, pdf) + dépendances complètes (libreoffice, defusedxml, lxml, tesseract, etc.)
- [x] Whisper API OpenAI (2s)
- [x] Permissions multi-tenant (root:1000, 770)
- [x] Sécurité 3 couches (PreToolUse hooks + CLAUDE.md confidentiel + output filter formatOutbound)
- [x] Human-in-the-loop (pending file state machine pour emails et mutations DB sensibles)
- [x] Containers anti-blocage (session resume off, budget exceeded → exit, timeout 5 min, IPC idle 10 min, idle timer host, SQLite busy_timeout)
- [x] Landing page (otto.hntic.fr)
- [x] Coûts optimisés ($0.09/msg au lieu de $0.41)
- [x] agent-browser installé + instructions CLAUDE.md

## À faire avant le premier vrai client

### ~~Provisioning multi-tenant automatique~~ (RÉSOLU)
Les 7 bugs identifiés sont tous fixés : cwd auth, clé API par client (Admin API), port unique (base 3002), wrapper PM2, retry channel, credential-proxy fallback. À tester de bout en bout avec un vrai paiement Stripe.

### ~~Robustesse WhatsApp~~ (RÉSOLU 30/03/2026)
Le process pause après 3 QR codes sans connexion, envoie un email de reconnexion au client via PM2 IPC → API. Debounce pour éviter les emails en double. qrCount reset à chaque reconnexion transient (blip réseau). Logout explicite → clear auth + pause + email.

### Stripe live
Passer de test à prod : nouvelles clés + nouveau webhook endpoint dans le dashboard Stripe.

### Migration automatique business.db
Système de versioning avec `PRAGMA user_version` : au démarrage du process client, comparer la version de la base avec la version attendue et exécuter les migrations manquantes automatiquement.

### Admin dashboard
Page web admin pour visualiser et gérer le VPS. L'API admin existe déjà (`/api/admin/*`) — il faut juste un frontend.

### Monitoring
- PM2 auto-restart en cas de crash (`--max-memory-restart`)
- Alerting quand un process client crash

### Passive scanner
Infra en place, désactivé en dev. Activation = une ligne de code (commit `f332aa7`).
À faire : endpoint admin API pour gérer les exclusions scan_config + page onboarding pour exclure les conversations perso.

### Gmail OAuth automatisé
Intégration actuellement manuelle (scp). Pour le self-service : flow OAuth dans l'API d'onboarding (GCP déjà configuré).

## Roadmap (moyen terme)

### Migration WhatsApp Business API
Remplacer Baileys par l'API officielle Meta. Résout : notifications, multi-tenant single-process, risque de ban.
**Bloqué par :** vérification Meta Business (1-4 semaines). → https://business.facebook.com/

### Multi-tenant single-process
1 process PM2 pour tous les clients au lieu de 1 par client. Prérequis : WhatsApp Business API.

### Admin key Anthropic par client
Workspace + clé API isolés par client via Admin API. Isolation des coûts et révocation individuelle.

## Optimisation des coûts API (documenté le 30/03/2026)

Coût par message : **$0.41 → $0.09** (~78% de réduction). Cause racine : session resume accumulait 80K+ tokens.

| Message | Cold (1er msg) | Warm (2e+ msg) |
|---------|---------------|----------------|
| Simple ("Bonjour") | $0.09 | $0.02-0.05 |
| Moyen (query DB) | $0.10-0.15 | $0.05-0.10 |
| Complexe (création doc) | $0.15-0.25 | $0.10-0.20 |

Projection : ~20 msg/jour × ~$0.10 = **~$60/mois** par client. À 447€/mois → **~370€ de marge**.
