# VPS Otto — Aide-mémoire

## Connexion

```bash
ssh otto-vps
```

## Infos serveur

| Champ | Valeur |
|-------|--------|
| IP | 46.224.90.17 |
| Type | CCX33 (8 vCPU AMD, 32 GB RAM, 240 GB SSD) |
| OS | Ubuntu 24.04 |
| Hébergeur | Hetzner Cloud |
| Console | https://console.hetzner.com/projects/13965583 |
| Prix | 58.09 EUR/mois |

## Connexion rapide

```bash
ssh otto-vps   # alias configuré dans ~/.ssh/config
```

## Déploiement

```bash
# Déployer tout (code + API)
ssh otto-vps 'cd /opt/otto/app && git pull origin main && npm run build && cd api && npm run build && pm2 restart otto-api'

# Rebuilder le container Docker (si Dockerfile, skills, ou agent-runner changé)
ssh otto-vps 'cd /opt/otto/app/container && ./build.sh'

# Déployer + rebuild container + restart client
ssh otto-vps 'cd /opt/otto/app && git pull origin main && npm run build && cd api && npm run build && cd ../container && ./build.sh && pm2 restart otto-test otto-api'

# Après mise à jour du global CLAUDE.md — copier chez chaque client + purger session
ssh otto-vps 'cp /opt/otto/app/groups/global/CLAUDE.md /opt/otto/clients/{id}/groups/global/CLAUDE.md && sqlite3 /opt/otto/clients/{id}/store/messages.db "DELETE FROM sessions" && pm2 restart otto-{id}'
```

## Gestion des process PM2

```bash
# Voir tous les process
ssh otto-vps 'pm2 list'

# Redémarrer un client
ssh otto-vps 'pm2 restart otto-test'

# Stopper un client
ssh otto-vps 'pm2 stop otto-test'

# Redémarrer l'API
ssh otto-vps 'pm2 restart otto-api'

# Sauvegarder la config PM2 (persiste après reboot)
ssh otto-vps 'pm2 save'
```

## Logs

```bash
# Logs en direct d'un client
ssh otto-vps 'pm2 logs otto-test --lines 30'

# Logs de l'API
ssh otto-vps 'pm2 logs otto-api --lines 30'

# Logs d'un container Docker en cours
ssh otto-vps 'docker logs $(docker ps --filter "name=nanoclaw" --format "{{.Names}}" | head -1) 2>&1 | tail -30'

# Voir les tool calls et coûts d'un container
ssh otto-vps 'docker logs $(docker ps --filter "name=nanoclaw" --format "{{.Names}}" | head -1) 2>&1 | grep -E "\[TOOL\]|\[MODEL\]|\[COST\]"'

# Logs archivés des containers (fichiers)
ssh otto-vps 'ls -t /opt/otto/clients/test/groups/main/logs/ | head -5'
ssh otto-vps 'cat /opt/otto/clients/test/groups/main/logs/<fichier>.log'
```

## Docker

```bash
# Containers en cours
ssh otto-vps 'docker ps'

# Taille de l'image
ssh otto-vps 'docker images nanoclaw-agent --format "{{.Size}}"'

# Nettoyer les images orphelines
ssh otto-vps 'docker image prune -f'
```

## Base de données

```bash
# Lister les tables d'un client
ssh otto-vps 'sqlite3 /opt/otto/clients/test/groups/main/business.db ".tables"'

# Query libre
ssh otto-vps 'sqlite3 /opt/otto/clients/test/groups/main/business.db "SELECT name, email FROM contacts LIMIT 10"'

# Base API (clients, onboarding)
ssh otto-vps 'sqlite3 /opt/otto/app/api/data/onboarding.db "SELECT id, email, status FROM clients"'
```

## Fichiers clients

```bash
# Lister les clients
ssh otto-vps 'ls /opt/otto/clients/'

# Voir le .env d'un client
ssh otto-vps 'cat /opt/otto/clients/test/.env'

# Voir le CLAUDE.md d'un client
ssh otto-vps 'cat /opt/otto/clients/test/groups/main/CLAUDE.md'

# Voir les documents générés
ssh otto-vps 'ls -lh /opt/otto/clients/test/groups/main/documents/'

# Espace disque par client
ssh otto-vps 'du -sh /opt/otto/clients/*'
```

## Monitoring

```bash
# RAM et CPU
ssh otto-vps 'free -h && echo "---" && df -h /'

# RAM par process PM2
ssh otto-vps 'pm2 list'

# Vérifier que WhatsApp est connecté
ssh otto-vps 'pm2 logs otto-test --lines 5 --nostream 2>/dev/null | grep -i "connected\|WhatsApp"'
```

## Accès web

| Page | URL |
|------|-----|
| Landing page | https://otto.hntic.fr |
| Portail client | https://otto.hntic.fr/portal |
| Admin dashboard | https://otto.hntic.fr/admin |
| Health check | https://otto.hntic.fr/api/health |
| Reconnexion WhatsApp | https://otto.hntic.fr/reconnect |

## Troubleshooting — Sessions & Cache

L'agent utilise le **session resume** pour garder le contexte entre les messages. Si l'agent se comporte bizarrement (mauvaises instructions, ancien contexte), il faut purger la session.

```bash
# Voir la session active d'un client
ssh otto-vps 'sqlite3 /opt/otto/clients/{id}/store/messages.db "SELECT * FROM sessions"'

# Purger la session (force un fresh start au prochain message)
ssh otto-vps 'sqlite3 /opt/otto/clients/{id}/store/messages.db "DELETE FROM sessions" && pm2 restart otto-{id}'

# Purger aussi les fichiers de session SDK (si la purge DB ne suffit pas)
ssh otto-vps 'rm -rf /opt/otto/clients/{id}/data/sessions/main/.claude/projects/'
```

**Quand purger :**
- Après une mise à jour du CLAUDE.md (l'ancienne version est cachée dans la session)
- Si l'agent parle en anglais ou ignore les instructions
- Si "No conversation found with session ID" dans les logs
- Si le comportement de l'agent est incohérent

**Le cache Docker peut aussi poser problème :**
```bash
# Si le Dockerfile a changé mais le build ne prend pas en compte les changements
ssh otto-vps 'cd /opt/otto/app/container && docker build --no-cache -t nanoclaw-agent:latest .'

# Vérifier qu'un package est bien dans l'image
ssh otto-vps 'docker run --rm --entrypoint bash nanoclaw-agent:latest -c "python3 -c \"import pptx; print(pptx.__version__)\" 2>&1"'
```

**sharp (image vision) sur Linux :**
```bash
# Si sharp crash après un npm install sur Mac puis deploy sur le VPS
ssh otto-vps 'cd /opt/otto/app && npm install --os=linux --cpu=x64 sharp'
```

## Structure du VPS

```
/opt/otto/
  app/                 ← Ce repo (git pull pour mettre à jour)
    api/               ← API onboarding + portail + webchat (PM2 process otto-api)
      .env             ← Secrets (Stripe, SMTP, Anthropic admin key, Composio, Exa, PORTAL_JWT_SECRET)
      data/onboarding.db ← DB HNTIC (clients, Stripe data, contacts, facturation)
      public/          ← Landing page, portail client, admin dashboard
    src/               ← Code host (orchestrateur)
    container/         ← Image Docker + 47 skills business
    groups/            ← Templates CLAUDE.md (global + main)
  clients/             ← Données par client (isolées)
    {id}/
      .env             ← Clés API du client (Anthropic, Composio, Exa, PORTAL_JWT_SECRET)
      start-pm2.sh     ← Script PM2 (avec exp-backoff-restart-delay)
      store/
        messages.db    ← Messages WhatsApp + sessions
        auth/          ← Credentials WhatsApp (Baileys)
      groups/
        global/CLAUDE.md  ← Instructions globales (copié du template, pas linké)
        main/
          CLAUDE.md       ← Instructions groupe + mémoire client
          business.db     ← Données business (25 tables)
          documents/      ← Documents générés (PPT, Word, Excel, PDF)
          attachments/    ← Images reçues via WhatsApp
          memory/         ← Mémoire long terme (contexte, glossaire)
          logs/           ← Logs des containers
          .pending_emails/    ← HITL emails en attente
          .pending_mutations/ ← HITL mutations DB en attente
          .pending_composio/  ← HITL actions Composio en attente
      data/
        sessions/main/.claude/ ← Cache session SDK (session resume)
        ipc/main/         ← Communication host ↔ container
        env/              ← Copie du .env pour le container
  backups/             ← Backups clients (tar.gz au deprovisioning + quotidien Hetzner)
```
