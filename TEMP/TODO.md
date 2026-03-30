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

### Provisioning multi-tenant automatique (CRITIQUE)
L'onboarding Stripe → provisioning a 7 bugs qui nécessitent des corrections manuelles. Voir plan détaillé dans `.claude/plans/synthetic-giggling-planet.md`. Points clés :
- WhatsApp creds écrits au mauvais endroit (cwd)
- Pas de clé API Anthropic par client (utiliser Admin API)
- Port proxy en conflit (allouer un port unique)
- Wrapper PM2 mal configuré (.env, cwd)
- Channel non enregistré (retry)

### Robustesse WhatsApp (CRITIQUE)
Le process PM2 du client ne doit PAS tenter de se re-lier tout seul quand WhatsApp se déconnecte. Actuellement Baileys émet des QR codes automatiquement → crée des liaisons fantômes.

À implémenter :
1. Quand Baileys détecte une déconnexion → le process se met en pause
2. Envoyer un email automatique au client : "Ton WhatsApp s'est déconnecté, clique ici pour reconnecter"
3. Le process attend que le client se reconnecte via /onboard
4. Tester tous les scénarios : déconnexion volontaire, changement de téléphone, timeout, crash

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
