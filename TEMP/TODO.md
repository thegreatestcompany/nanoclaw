# TODO — Otto by HNTIC

## À faire (court terme)

### Passive scanner opt-in
L'infra est en place (channel WhatsApp stocke les messages des JIDs dans `scan_config`, passive scanner les analyse toutes les 2h). Il manque l'interface pour que le client configure quelles conversations scanner.

**Fait :**
- [x] `isJidScanned()` dans scan-config.ts
- [x] Channel WhatsApp transmet les messages des JIDs scannés
- [x] `scan_config` est read-only pour l'agent (l'agent contourne le human-in-the-loop)
- [x] Chats snapshot écrit dans available_chats.json

**À faire :**
1. Ajouter un endpoint admin API pour gérer scan_config (add/remove JID)
2. Ajouter une page dans l'interface d'onboarding où le client voit ses conversations et coche celles à scanner
3. Ou implémenter un mécanisme d'approbation asynchrone robuste (IPC → message → attente confirmation → exécution)

### Gmail OAuth automatisé
L'intégration Gmail est actuellement manuelle (copie de credentials via scp). Pour l'onboarding self-service :
1. Créer un projet GCP unique avec consent screen vérifié (HNTIC)
2. Ajouter un flow OAuth dans l'API d'onboarding (redirection → callback → stockage tokens)
3. Le client clique un lien, autorise Gmail, et c'est configuré automatiquement
4. Refresh token stocké dans le dossier client, monté dans le container

### Notifications WhatsApp
Le self-chat ne génère pas de notifications. Solutions par ordre de priorité :
1. **Immédiat** : groupe solo (créer un groupe WhatsApp, retirer les autres, Otto reste membre → notifs)
2. **Premiers clients** : numéro dédié par client (eSIM ~5€/mois, pairing code depuis le VPS)

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
