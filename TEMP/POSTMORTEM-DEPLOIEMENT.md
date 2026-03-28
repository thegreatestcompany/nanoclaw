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

## Checklist pour le script d'onboarding automatisé

D'après ces post-mortem, le script de provisioning client doit :

1. [ ] Créer le wrapper `start-pm2.sh` (pas de `pm2 start dist/index.js` direct)
2. [ ] Ajouter la règle UFW Docker AVANT de lancer le premier container
3. [ ] Utiliser une clé API Anthropic (pas de token OAuth)
4. [ ] Donner les permissions correctes aux dossiers montés (chmod 777 ou user matching)
5. [ ] Ne JAMAIS réutiliser une session SDK après un changement de credentials → vider `sessions` table
6. [ ] Documenter que le credential proxy écoute sur `172.17.0.1`, pas `localhost`
