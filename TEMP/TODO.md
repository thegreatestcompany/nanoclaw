# TODO — Otto by HNTIC

## Fait (validé — 02/04/2026)

- [x] Portail client ERP (/portal — 6 onglets, sidebar, dashboard business, auth code 6 chiffres)
- [x] Webchat (WebSocket, sync WhatsApp, markdown renderer, documents inline)
- [x] Anti-hallucination code-level (HITL sur tous les INSERT business)
- [x] Feedback ⏳ automatique (PreToolUse hook, pas de prompting)
- [x] WebSearch bloqué → Exa forcé (code-level)
- [x] Landing page redesign (formulaire contact, mockup dashboard, vouvoiement)
- [x] Agent teams activé (outil Agent dispo, Haiku ne l'utilise pas spontanément)
- [x] Blocklist skills complétée (32 skills admin bloqués)
- [x] Flow désabonnement complet (Stripe webhook → 24h grâce → WhatsApp farewell → backup tar.gz → deprovisioning → status cancelled)
- [x] Bouton "Gérer mon abonnement" dans le portail (→ Stripe Customer Portal)
- [x] WhatsApp JID sauvé à l'onboarding (bug fix — était vide avant)
- [x] Nettoyage VPS : suppression /opt/otto/app/clients (obsolète) et symlink /opt/otto/api

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
- [x] Symlink /opt/otto/api → /opt/otto/app/api (supprimé depuis, était inutile)

## À faire avant le premier vrai client

### Stripe live
Passer de test à prod :

**Dashboard Stripe :**
1. Activer le mode live dans le dashboard Stripe
2. Créer les clés prod (publishable + secret)
3. Créer un webhook endpoint prod : `https://otto.hntic.fr/api/stripe-webhook`
   - Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`, `customer.subscription.trial_will_end`
4. Créer un produit "Otto by HNTIC" + prix 447€/mois HT
5. Créer un payment link avec essai gratuit 7 jours
6. Configurer le Stripe Customer Portal (Settings → Billing → Customer portal) :
   - Activer l'annulation d'abonnement
   - Activer la mise à jour du moyen de paiement
   - Historique des factures visible
   - URL de retour : `https://otto.hntic.fr/portal`

**VPS :**
7. Mettre à jour `/opt/otto/api/.env` :
   - `STRIPE_SECRET_KEY=sk_live_...`
   - `STRIPE_WEBHOOK_SECRET=whsec_...` (le nouveau, pas celui de test)
8. `pm2 restart otto-api`

**Landing page :**
9. Mettre à jour le lien du CTA dans `api/public/index.html` (formulaire contact → payment link Stripe)

**Test end-to-end :**
10. Faire un vrai paiement (carte réelle, petit montant ou rembourser après)
11. Vérifier : provisioning → email → QR code → WhatsApp connecté → Otto répond
12. Tester le désabonnement via le Stripe Customer Portal :
    - Vérifier : webhook `subscription.deleted` reçu → status `pending_cancellation` → WhatsApp farewell → 24h grâce → deprovisioning → backup
13. Tester le paiement échoué : vérifier que le client reçoit une notification

### Pages légales (obligatoire avant lancement)
Mentions légales, CGV/CGU, Politique de confidentialité, Politique cookies. Infos HNTIC : SAS, 9 rue des Colonnes 75002 Paris, SIRET 999 125 420 00011, RCS Paris B 999 125 420. Hébergeur : Hetzner (Allemagne). Sous-traitants à déclarer : Anthropic (US), Hetzner (DE), Stripe (US), Meta/WhatsApp (US). Points sensibles : transferts hors UE, responsabilité IA, données business. **Faire valider par un juriste.**

### ~~Monitoring~~ ✅ Claude Code admin installé sur VPS (Remote Control + /loop)


### Lifecycle des documents
Après des mois/années d'utilisation, le dossier `documents/` d'un client va grossir (PPT, Word, Excel accumulés). À anticiper :
- Archivage automatique des documents > X mois (déplacer vers un dossier `archives/` ou S3)
- Nettoyage des doublons et versions intermédiaires
- Quota disque par client avec alerte dans le dashboard admin
- Purge des fichiers temporaires (.js build scripts) si l'agent en laisse traîner
- Impact sur les backups VPS (240 GB SSD limité)

## Proactivité & Autonomie (demandé par les clients)

### Otto proactif — alertes automatiques
Tâche planifiée créée à l'onboarding qui check business.db toutes les 24h :
- Deals sans activité depuis X jours → "Tu veux que je relance ?"
- Obligations à échéance dans 7 jours → rappel
- Contrats qui expirent bientôt → alerte
- Factures en retard → notification
Template de prompt à créer dans le CLAUDE.md ou comme skill.

### Passive scanner — activation
Infra en place (src/passive-scanner.ts), désactivé. Scanne les conversations WhatsApp et extrait contacts/deals/tâches automatiquement. À activer + endpoint admin pour gérer les exclusions scan_config + page onboarding pour exclure les conversations perso.

### Briefing quotidien automatique
Créé à l'onboarding via schedule_task. Tous les matins à 8h : résumé des deals, obligations du jour, rappels. Skill `hntic-daily-briefing` existe déjà.

### Memory consolidation — activation
`src/memory-consolidator.ts` existe : daily learnings + weekly AutoDream. À activer pour que Otto consolide sa mémoire automatiquement.

### Onboarding proactif
Après connexion WhatsApp, au lieu de juste "Bonjour" :
- Se présenter avec ses capacités
- Proposer de scanner les dernières conversations
- Proposer de configurer un briefing quotidien/hebdo
- Demander les infos clés de l'entreprise (secteur, équipe, objectifs)

### Groupes WhatsApp — ajout de groupes
Permettre au client d'activer Otto dans ses groupes d'équipe. Baileys voit déjà tous les groupes du client (même numéro). Il suffit d'enregistrer le JID du groupe. Flow UX :
1. Client écrit dans le self-chat : "Active Otto dans le groupe Équipe commerciale"
2. Otto liste les groupes WhatsApp visibles (Baileys les connaît)
3. Client confirme
4. Otto enregistre le groupe via IPC `register_group` (réactiver depuis main group uniquement, reste bloqué pour les autres groupes)
5. Otto écoute le groupe et répond sur trigger `@otto`
- Les réponses apparaissent avec le préfixe "Otto:" depuis le numéro du client
- Chaque groupe a son propre dossier, container, et contexte isolé
- Passive scanner applicable sur les groupes pour extraction auto

## À faire prochainement

### ~~Instance admin locale (otto-admin)~~ ✅ Remplacé par Claude Code admin sur VPS

### Indexation automatique des documents reçus
Quand un document est envoyé dans le chat (WhatsApp ou webchat), Otto doit :
1. Extraire et analyser le contenu du document
2. Évaluer sa pertinence business (contrat, facture, CV, rapport, etc.)
3. Demander au dirigeant s'il doit l'indexer dans la table `documents` de business.db avec le contenu extrait (`extracted_text`)
Actuellement l'indexation est faite par Otto via CLAUDE.md mais pas systématiquement — certains documents sont indexés sans `extracted_text`. À renforcer via une instruction CLAUDE.md + éventuellement un PostToolUse hook.

### Export données client au deprovisioning
Au moment du deprovisioning, générer un ZIP (documents/ + CSV de chaque table business.db) et l'envoyer par email au client. Si > 20MB, garder le ZIP dans `/opt/otto/backups/exports/` et envoyer un lien de téléchargement temporaire. Le backup tar.gz existe déjà comme filet de sécurité.

### Internationalisation (FR/EN/ES)
Landing page, portail, emails transactionnels, messages WhatsApp système, CLAUDE.md global. Les données business du client et les skills ne sont pas à traduire. Détection par URL (`/fr/`, `/en/`, `/es/`) ou header `Accept-Language`. Fichiers de traduction JSON par langue.

### Streaming webchat (à revisiter)
Tenté et reverté (timing race bulle/message final). Approche alternative à explorer : SSE (Server-Sent Events) au lieu de file polling, ou streaming natif côté host.

## Roadmap (moyen terme)

### Migration WhatsApp Business API
Remplacer Baileys par l'API officielle Meta. Résout : notifications, multi-tenant single-process, risque de ban.
**Bloqué par :** vérification Meta Business (1-4 semaines). → https://business.facebook.com/

### Multi-tenant single-process
1 process PM2 pour tous les clients au lieu de 1 par client. Prérequis : WhatsApp Business API.

### Isolation Anthropic par client
Workspace créé automatiquement par client via Admin API ✅. Clé API partagée (une seule pour tous les clients) car l'Admin API **ne supporte pas la création de clés** (uniquement via la Console). Isolation des coûts via workspace_id dans l'usage_report API. Suffisant pour le moment.

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
