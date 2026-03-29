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

### Monitoring
- PM2 auto-restart en cas de crash (`--max-memory-restart`)
- Alerting quand un process client crash
- Détection de déconnexion WhatsApp (heartbeat)

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
