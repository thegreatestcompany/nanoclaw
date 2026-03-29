# Post-mortem déploiement VPS — 28 mars 2026

Problèmes rencontrés lors du premier déploiement sur Hetzner CCX33 (Nuremberg).
À intégrer dans le script d'onboarding automatisé.

---

## 1. PM2 ne lance pas Node.js correctement en mode direct

**Symptôme** : le process PM2 crash en boucle (↺ restarts) avec des logs vides.

**Cause** : `pm2 start dist/index.js` ne fonctionne pas bien car pino (le logger) écrit sur stderr, et PM2 interprète la sortie WhatsApp (sync historique très verbeux) comme des erreurs.

**Solution** : utiliser un wrapper bash au lieu de lancer Node directement.

```bash
# /opt/otto/app/start-pm2.sh
#!/bin/bash
cd /opt/otto/app
exec node dist/index.js 2>&1
```

```bash
pm2 start /opt/otto/app/start-pm2.sh --name otto-prod --interpreter bash
```

**À intégrer dans** : `scripts/deploy-client.sh`, `SPEC-DEPLOIEMENT.md` section PM2.

---

## 2. Permissions filesystem Docker (EACCES)

**Symptôme** : `EACCES: permission denied, unlink '/workspace/ipc/input/...'` dans les logs du container agent.

**Cause** : le process PM2 tourne en tant que `root`, les fichiers IPC sont créés par `root`, mais le container agent tourne en tant que user `node` (non-root, requis par le SDK). Le user `node` ne peut pas supprimer les fichiers créés par `root`.

**Solution** : donner les permissions 777 aux dossiers montés dans les containers.

```bash
chmod -R 777 /opt/otto/app/groups/main/ /opt/otto/app/data/ /opt/otto/app/store/
```

**À intégrer dans** : `scripts/deploy-client.sh` (après le onboarding), et à chaque provisioning de client.

**Note** : en production multi-tenant avec des users Linux dédiés, ce problème sera différent — chaque process PM2 tournera sous son propre user, pas root.

---

## 3. Firewall UFW bloque le trafic Docker → host

**Symptôme** : `api_retry` en boucle dans le container agent. Le credential proxy est accessible depuis le host (`curl http://172.17.0.1:3001` OK) mais pas depuis le container Docker (`Connection timed out`).

**Cause** : `ufw` est configuré pour bloquer tout le trafic entrant sauf SSH/HTTP/HTTPS. Le trafic des containers Docker (depuis `172.17.0.0/16`) vers le host est aussi bloqué, y compris vers le credential proxy (port 3001).

**Solution** : ajouter une règle UFW pour autoriser le réseau Docker.

```bash
ufw allow from 172.17.0.0/16 to any port 3001
```

**À intégrer dans** : `scripts/setup-server.sh`, exécuter après l'installation de Docker et UFW.

**Alternative envisageable** : utiliser `DOCKER_OPTS="--iptables=false"` pour que Docker ne touche pas aux iptables, mais c'est plus complexe à gérer.

---

## 4. Token OAuth Pro/Max ne fonctionne pas depuis un VPS

**Symptôme** : `invalid x-api-key` retourné par l'API Anthropic quand on utilise un token OAuth (`sk-ant-oat01-...`) depuis le VPS.

**Cause** : les tokens OAuth générés par `claude setup-token` sont probablement liés à l'IP/machine d'origine. Anthropic bloque leur utilisation depuis une IP différente pour empêcher l'usage commercial via un abonnement personnel.

**Solution** : utiliser une clé API (`sk-ant-api03-...`) de console.anthropic.com sur le VPS. Les tokens OAuth ne fonctionnent que sur la machine locale.

**Implication pour l'onboarding automatisé** : chaque client doit avoir sa propre clé API Anthropic, pas un token OAuth. L'Admin API Anthropic permet de créer des workspaces et des clés automatiquement.

---

## 5. Session SDK persistée avec les mauvais credentials

**Symptôme** : après le changement de token OAuth vers clé API, le container continue de retourner `No conversation found with session ID: f446b170...`.

**Cause** : la session SDK avait été créée avec le token OAuth. Après le passage à la clé API, le SDK essaie de reprendre la session mais les credentials sont différentes → la session n'existe pas dans le nouveau contexte. La session ID est stockée dans la table `sessions` de `store/messages.db` et re-transmise à chaque nouveau container.

**Solution** : supprimer la session de la DB et redémarrer.

```bash
sqlite3 /opt/otto/app/store/messages.db 'DELETE FROM sessions'
pm2 restart otto-prod
```

**À intégrer dans** : si les credentials changent (rotation de clé API, migration OAuth → API key), il faut vider la table `sessions`.

---

## 6. Credential proxy écoute sur Docker bridge IP, pas localhost

**Symptôme** : `curl http://localhost:3001` ne fonctionne pas depuis le VPS, alors que le proxy tourne.

**Cause** : le credential proxy détecte l'interface Docker bridge et écoute sur `172.17.0.1` au lieu de `0.0.0.0` ou `127.0.0.1`. C'est intentionnel pour la sécurité (le proxy n'est accessible que depuis les containers Docker).

**Impact** : les commandes de debug doivent utiliser `curl http://172.17.0.1:3001` au lieu de `curl http://localhost:3001`.

**À documenter dans** : VPS.md, commandes de debug.

---

## 7. Session SDK stale après destruction du container

**Symptôme** : `No conversation found with session ID: xxx` en boucle. L'agent ne répond jamais, le host relance un container qui échoue de la même façon.

**Cause** : le container crée une session SDK, Otto stocke le `sessionId` dans la table `sessions` de `store/messages.db`. Quand le container se ferme (timeout 30 min), la session est détruite côté Anthropic. Au prochain message, un nouveau container est spawné avec l'ancien `sessionId` → le SDK essaie de reprendre → "No conversation found" → erreur → Otto retry → même erreur → boucle infinie.

**Solution implémentée** : détection de l'erreur dans `container/agent-runner/src/index.ts`. Quand `runQuery()` retourne un `result` avec `subtype=error_during_execution` et le message contient "No conversation found with session ID", on retourne `resumeFailed: true`. La boucle principale détecte ce flag et relance `runQuery()` sans session (session fraîche).

```typescript
// Dans runQuery(), détection de l'erreur
if (message.subtype === 'error_during_execution' && errorText.includes('No conversation found with session ID')) {
  log('Detected stale session — will retry without resume');
  return { ..., resumeFailed: true };
}

// Dans la boucle principale, fallback
if (queryResult.resumeFailed) {
  log('Session resume failed, retrying with fresh session...');
  sessionId = undefined;
  queryResult = await runQuery(prompt, undefined, ...);
}
```

**Important** : le session resume fonctionne normalement pour les messages envoyés PENDANT que le container est actif (via IPC, dans les 30 min). C'est uniquement le resume ENTRE les containers (après timeout) qui peut échouer et qui est maintenant géré proprement.

**À ne PAS faire** : mettre `persistSession: false` — ça désactiverait le resume même à l'intérieur d'une session active, ce qui casse la continuité conversationnelle.

---

## 8. Gmail/Calendar OAuth non automatisé

**Situation actuelle** : les credentials Gmail (`~/.gmail-mcp/`) ont été copiées manuellement depuis le Mac vers le VPS via `scp`. Ce n'est pas scalable — on ne peut pas copier les credentials de chaque client manuellement.

**Solution à implémenter** :
- Un seul projet GCP HNTIC avec écran de consentement vérifié par Google (review 1-2 semaines)
- Le flow d'onboarding inclut un bouton "Connecter Gmail" qui déclenche un OAuth standard
- Les tokens sont stockés automatiquement dans le dossier du client
- Même approche pour Google Calendar

**Impact** : Gmail/Calendar ne fonctionne que pour toi (credentials hardcodées) tant que l'OAuth automatisé n'est pas implémenté. Les premiers clients n'auront pas Gmail/Calendar sauf configuration manuelle.

**Priorité** : haute — à faire avant le premier client qui veut Gmail.

---

## 9. Résiliation client et gestion des données

**Ce qui est codé** : webhook Stripe `customer.subscription.deleted` → grâce 24h → deprovision (archive tar.gz + supprime).

**Ce qui manque** :
- Le client n'a aucun moyen de résilier lui-même. Il faut activer le **Stripe Customer Portal** (dashboard Stripe → Settings → Customer portal). Le client accède à un lien pour gérer son abonnement, sa carte, et résilier.
- Otto devrait répondre à "je veux résilier" en envoyant le lien du Customer Portal.
- Le message d'adieu avec proposition d'export des données n'est pas implémenté (TODO dans stripe.ts).
- L'export des données (RGPD) doit être un tar.gz envoyé par email ou lien de téléchargement.

**Priorité** : moyenne — à faire avant le premier client mais pas bloquant pour les tests.

---

## 10. Pas de mécanisme de reconnexion WhatsApp

**Situation** : si un client délie son WhatsApp (changement de téléphone, suppression accidentelle, etc.), Otto crash en boucle car le handler QR code fait `process.exit(1)` en mode dev (et sur le VPS, le code IPC PM2 ne fonctionne pas en fork mode).

**Impact** : le client est bloqué, seule une intervention manuelle peut restaurer la connexion.

**Solution à implémenter** :
- Détecter la déconnexion `loggedOut` dans le channel WhatsApp
- Au lieu de crasher, mettre le process en pause et générer un nouveau token d'onboarding
- Envoyer un email au client avec un lien de reconnexion
- Route `/reconnect/:clientId` dans l'API qui régénère un QR code
- Le client rescanne et le process reprend

**Priorité** : haute — peut arriver à tout moment en production.

---

## 11. CRITIQUE — Otto a répondu dans la mauvaise conversation

**Symptôme** : Otto a envoyé un message au contact d'un autre client au lieu du self-chat.

**Cause** : Le mauvais JID (`33650524562` — un contact) a été enregistré comme groupe "main" au lieu du bon JID (`33650133431` — le self-chat). Otto a reçu un message de ce contact, l'a traité, et y a répondu.

**Pourquoi c'est arrivé** : Enregistrement manuel du mauvais JID pendant le debug. En fonctionnement automatique, `registerClientChannel()` extrait le JID depuis `creds.me.id` ce qui donne le bon numéro.

**Prévention** :
1. Ne JAMAIS enregistrer manuellement un JID sans vérifier qu'il est bien le self-chat du client
2. Le provisionning automatique utilise `creds.me.id` ce qui est correct
3. Ajouter une vérification dans le code : si le JID enregistré est un `@s.whatsapp.net` (DM, pas un groupe), vérifier qu'il correspond au numéro du client dans `creds.json`
4. Pour les clients avec numéro partagé (perso), recommander fortement d'utiliser un numéro dédié ou un solo group

**Impact** : bug de confidentialité majeur. Un message d'Otto a été envoyé à la mauvaise personne. Heureusement en test uniquement.

**Priorité** : CRITIQUE — ajouter une vérification automatique avant tout envoi.

---

## Checklist pour le script d'onboarding automatisé

D'après ces post-mortem, le script de provisioning client doit :

1. [ ] Créer le wrapper `start-pm2.sh` (pas de `pm2 start dist/index.js` direct)
2. [ ] Ajouter la règle UFW Docker AVANT de lancer le premier container
3. [ ] Utiliser une clé API Anthropic (pas de token OAuth)
4. [ ] Donner les permissions correctes aux dossiers montés (chmod 777 ou user matching)
5. [ ] Ne JAMAIS réutiliser une session SDK après un changement de credentials → vider `sessions` table
6. [ ] Documenter que le credential proxy écoute sur `172.17.0.1`, pas `localhost`
7. [x] `chmod -R 777` sur `.claude/` pour que le SDK puisse créer `session-env/`
8. [x] `sandbox: { enabled: false }` dans les options du SDK (redondant avec Docker)

---

## 12. Bash tool SDK échoue silencieusement dans les containers

**Symptôme** : l'agent essaie `python3 -c "from docx import Document..."` via le Bash tool, la commande est acceptée (pas bloquée par les hooks), mais rien ne se passe — pas de fichier créé, pas d'erreur. L'agent finit par abandonner et créer un .html ou .rtf en fallback.

**Diagnostic** :
- `docker exec -u node <container> python3 -c "..."` → fonctionne
- Le même commande via le Bash tool du SDK → échoue silencieusement
- L'agent rapporte "permission denied sur /home/node/.claude/session-env"

**Cause racine** : le dossier `/home/node/.claude/` est monté depuis le host où il est créé par root (PM2 tourne en root). Le container tourne en user `node` (uid 1000). Le SDK Claude essaie de créer `/home/node/.claude/session-env/` pour configurer l'environnement d'exécution du Bash tool. Sans permissions d'écriture → échec silencieux de TOUTES les commandes Bash.

**Fix** : `chmod -R 777` sur le dossier `.claude/` du host avant de lancer le container (`src/container-runner.ts`).

**Leçon** : le Bash tool du SDK a un prérequis non documenté — il doit pouvoir écrire dans `~/.claude/session-env/`. C'est distinct des permissions (`bypassPermissions`) et du sandbox (`sandbox: { enabled: false }`).

**Faux-pistes explorées** (toutes inutiles car ne traitaient pas la cause racine) :
- Retirer Task/Team des allowedTools → `allowedTools` ne bloque pas les outils
- Ajouter `disallowedTools` → bloquait des features utiles pour rien
- Hardcoder des instructions python-docx dans CLAUDE.md → patch symptomatique
- Interdire les sub-agents dans CLAUDE.md → même chose

**Priorité** : CRITIQUE — sans ce fix, aucun outil Bash ne fonctionne dans les containers.

---

## 13. Sandbox SDK redondante avec Docker

**Constat** : le SDK Claude a un sandbox Linux (via `unshare`) activé par défaut qui restreint filesystem et réseau des commandes Bash. Dans un container Docker, c'est redondant et contre-productif.

**Fix** : `sandbox: { enabled: false }` dans les options `query()`.

**Justification** : le container fournit déjà l'isolation (filesystem, réseau, user non-root). Les hooks `PreToolUse` ajoutent la sécurité applicative (blocage rm -rf, SQL destructif, écriture hors workspace). La sandbox SDK bloquait python3, pandoc, ffmpeg qu'on a installés exprès.

**Priorité** : HAUTE — à appliquer sur tout déploiement containerisé.

---

## 14. Stratégie globale des permissions multi-tenant

### Le problème récurrent

4 incidents distincts causés par la même racine : **root crée des fichiers sur le host, le container tourne en user `node` (uid 1000)**.

| # | Incident | Symptôme | Cause |
|---|----------|----------|-------|
| 1 | IPC EACCES | Container ne peut pas lire les messages IPC | Host crée les fichiers IPC en root:root |
| 2 | `.claude/session-env/` | Bash tool échoue silencieusement | SDK ne peut pas écrire dans .claude/ |
| 3 | WhatsApp creds | Auth sauvée au mauvais endroit | STORE_DIR pas configuré, permissions incorrectes |
| 4 | Documents générés | Fichiers créés par le container illisibles par le host | Mismatch uid/gid |

### Architecture des permissions

```
Host (PM2, root)                    Container (Docker, node uid=1000 gid=1000)
─────────────────                   ──────────────────────────────────────────
Crée les dossiers clients           Lit/écrit dans les dossiers montés
Écrit les fichiers IPC              Lit les fichiers IPC, écrit les réponses
Lance les containers                Exécute le SDK Claude + agent
                                    SDK crée .claude/session-env/ au runtime

        ┌──── Volume mounts (bind) ────┐
        │                              │
  /opt/otto/clients/{id}/         /workspace/group/
        groups/main/              /workspace/ipc/
        data/sessions/.claude/    /home/node/.claude/
        store/                    (etc.)
```

### Solution appliquée : group-based ownership

**Principe** : `chown root:1000` + `chmod u=rwX,g=rwX,o=` (770/660)

- **root** (owner) : accès complet — le host peut tout lire/écrire
- **gid 1000** (group) : accès complet — le container (node) peut tout lire/écrire
- **others** : aucun accès — les autres clients ne voient rien

**Où c'est appliqué** :

1. **`src/container-runner.ts`** — Boucle sur TOUS les mounts writable avant le lancement du container. C'est le point centralisé : tout nouveau mount est automatiquement couvert.

2. **`api/src/provision.ts`** — Au provisioning initial du client (groups/, data/, store/).

**Ce qui reste en `umask 000`** : le wrapper PM2 utilise `umask 000` pour les fichiers créés au runtime (IPC). C'est acceptable car le répertoire parent est déjà en 770 — seuls root et gid 1000 peuvent y accéder.

### Règles pour les contributeurs

1. **Ne jamais utiliser `chmod 777`** — Utiliser `chown root:1000` + `chmod u=rwX,g=rwX,o=`
2. **Ne pas créer de fichiers dans les dossiers clients sans fixer les permissions** — Le host tourne en root, les fichiers seront inaccessibles au container sans chown
3. **Tout nouveau mount writable est automatiquement couvert** par la boucle dans `container-runner.ts`
4. **Le `.env` client reste en `0o600 root:root`** — Jamais monté dans le container, lu uniquement par le credential proxy
5. **Le SDK Claude nécessite l'écriture dans `~/.claude/`** — Ne jamais monter ce dossier en readonly

### Vérification

Pour vérifier que les permissions sont correctes pour un client :
```bash
ls -la /opt/otto/clients/{id}/groups/main/
# Attendu : drwxrwx--- root 1000

ls -la /opt/otto/clients/{id}/data/sessions/main/.claude/
# Attendu : drwxrwx--- root 1000

# Aucun fichier ne doit être en 777 ou world-readable
find /opt/otto/clients/{id}/ -perm -o=r -not -path "*/node_modules/*" 2>/dev/null
# Attendu : aucun résultat
```
