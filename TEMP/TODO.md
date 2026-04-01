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
- [x] Containers anti-blocage (session resume off, budget exceeded → exit, timeout 5 min/query avec clearTimeout, IPC idle 10 min, idle timer host, SQLite busy_timeout)
- [x] Landing page (otto.hntic.fr)
- [x] Coûts optimisés ($0.09/msg au lieu de $0.41)
- [x] agent-browser installé + instructions CLAUDE.md
- [x] Provisioning multi-tenant (7 bugs fixés, Admin API Anthropic, port unique)
- [x] Robustesse WhatsApp (pause après 3 QR, email reconnexion, debounce, reset sur blip réseau)
- [x] Admin dashboard (/admin — clients, logs, SQL, mémoire, audit, docs, disk, coûts API réels)
- [x] PM2 max-memory-restart 500M
- [x] Système de migration business.db (PRAGMA user_version, prêt pour futures migrations)
- [x] Personnalisation onboarding (nom + entreprise depuis Stripe → CLAUDE.md, business.db, emails)
- [x] Exa search API intégrée (web_search, answer, get_contents, find_similar)
- [x] Symlink /opt/otto/api → /opt/otto/app/api (plus de confusion)

## À faire avant le premier vrai client

### Stripe live
Passer de test à prod : nouvelles clés + nouveau webhook endpoint dans le dashboard Stripe.

### Monitoring
Alerting quand un process client crash (PM2 auto-restart déjà en place).

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
Workspace + clé API isolés par client via Admin API. Isolation des coûts et révocation individuelle. Code déjà en place, à activer.

## Optimisation des coûts API (documenté le 30/03/2026)

### Historique

Le coût initial de $0.41/msg venait du session resume SANS `resumeAt` (relecture complète de l'historique à chaque query). La "fix" de désactiver `settingSources`, le preset `claude_code`, et le `sessionId` avait réduit les coûts à $0.09/msg mais cassé tout le comportement de l'agent (skills, contexte, instructions ignorées).

### État actuel (01/04/2026)

Session resume restauré avec `resumeAt` + `settingSources: ['project', 'user']` + preset `claude_code`.

| Message | Coût estimé |
|---------|-------------|
| Simple ("Bonjour") — cold start | ~$0.25 |
| Simple — warm (cache hit) | ~$0.02-0.05 |
| Moyen (email/calendar) | ~$0.25-0.33 |
| Complexe (PPT + recherche) | ~$0.33-0.43 |

Le cache_write domine (89% du coût). Le cache expire après 5 min — si le client met plus de 5 min entre les messages, le cache est réécrit.

Projection : ~$0.20/msg moyen × 20 msg/jour = **~$120/mois** par client. À 447€/mois → **~300€ de marge**.

À surveiller : comparer les coûts réels du 31/03 (sans resume) vs 01/04 (avec resume) dans le dashboard Anthropic.
