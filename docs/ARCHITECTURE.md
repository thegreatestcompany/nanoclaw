# Architecture Otto — Guide simplifié

## Vue d'ensemble

Otto est un assistant IA accessible via WhatsApp. Un dirigeant envoie un message, Otto répond en quelques secondes. Derrière, c'est un serveur Node.js qui orchestre des containers Docker contenant Claude (l'IA d'Anthropic).

```
Dirigeant                    VPS (Hetzner)                         Cloud
─────────                    ────────────                          ─────

  WhatsApp ────────────►  Host Node.js (PM2)
                              │
                              ├─ Identifie le client
                              ├─ Lance un container Docker ──────► Anthropic API
                              │   └─ Claude traite le message       (via credential proxy)
                              │
  WhatsApp ◄────────────  Récupère la réponse et l'envoie
```

---

## Les 4 composants clés

### 1. Le host (Node.js + PM2)

C'est le chef d'orchestre. Il tourne en permanence sur le VPS.

**Ce qu'il fait :**
- Se connecte à WhatsApp via Baileys (librairie open-source)
- Écoute les messages entrants
- Identifie quel client parle (via le JID WhatsApp)
- Lance un container Docker pour traiter le message
- Récupère la réponse et l'envoie sur WhatsApp

**Fichiers clés :**
- `src/index.ts` — boucle principale
- `src/container-runner.ts` — lance les containers
- `src/credential-proxy.ts` — injecte les clés API

### 2. Le container Docker

C'est une boîte isolée, créée à la demande, qui contient Claude et ses outils.

**Ce qu'il fait :**
- Reçoit le message du dirigeant
- Claude (via le Agent SDK) réfléchit et utilise des outils
- Peut créer des fichiers (Word, PowerPoint, Excel, PDF) via les skills Anthropic officiels
- Navigue sur le web (agent-browser + Chromium)
- Transcrit les messages vocaux (API OpenAI Whisper, ~2s)
- Accède à la base de données métier du client (SQLite via MCP)
- Renvoie la réponse au host

**Cycle de vie :**
```
Message arrive → Container créé → Traite → Reste en veille → 30 min sans message → Détruit
```

L'image Docker est la même pour tous les clients (`nanoclaw-agent:latest`). Ce qui change, c'est les dossiers montés dedans (chaque client a les siens).

**Fichiers clés :**
- `container/Dockerfile` — définition de l'image
- `container/agent-runner/src/index.ts` — code qui tourne dans le container

### 3. Le credential proxy

C'est un petit serveur HTTP qui tourne sur le host. Son rôle : le container n'a jamais la clé API Anthropic. Quand Claude veut appeler l'API, la requête passe par le proxy qui injecte la clé au vol.

```
Container                         Host                          Anthropic
─────────                         ────                          ─────────

SDK appelle Claude
  POST http://172.17.0.1:3002     Credential Proxy
  (pas de clé API)                  │
         ──────────────────────►    ├─ Lit la clé dans .env
                                    ├─ Ajoute le header x-api-key
                                    └─ Forward vers api.anthropic.com
                                           ──────────────────────►
```

**Pourquoi ?** Si un container est compromis, l'attaquant n'a pas la clé API. En multi-tenant, chaque client a son propre port proxy (3002, 3003, 3004...) avec sa propre clé.

### 4. La base de données métier (SQLite)

Chaque client a sa propre base `business.db` avec 25 tables : contacts, companies, deals, candidates, invoices, contracts, contract_clauses, team_members, projects, meetings, etc. Claude la lit et la modifie via un serveur MCP (outil structuré) avec human-in-the-loop sur les opérations sensibles (modifications financières, changement de stage deal).

### 5. L'API d'onboarding

Serveur Express séparé (`api/`) qui gère :
- **Stripe webhooks** — paiement → provisioning automatique du client
- **Onboarding WhatsApp** — page QR code / pairing code pour lier WhatsApp
- **Reconnexion** — `/reconnect` pour relancer la liaison si déconnexion
- **Emails transactionnels** — onboarding, bienvenue, reconnexion (via Gmail SMTP)
- **Admin back-office** — API REST pour gérer les clients

**Flow d'onboarding complet :**
```
Payment Link Stripe → paiement → email "Connecte ton WhatsApp"
     → page /onboard/success (polling) → redirection /onboard/{token}
     → QR code ou pairing code → WhatsApp connecté
     → email de bienvenue "Otto est actif"
```

---

## Identification des clients

Chaque message WhatsApp arrive avec un **JID** (identifiant unique) :
- `33612345678@s.whatsapp.net` → chat privé
- `120363045872@g.us` → groupe

Le host compare le JID avec la table `registered_groups` en base. Pas de match → ignoré. Match → routé vers le bon client.

```
JID entrant                       │ Client    │ Dossier
──────────────────────────────────┼───────────┼────────────
33650133431@s.whatsapp.net        │ Dupont    │ main
120363045872938@g.us              │ Dupont    │ whatsapp_equipe
```

Un client peut avoir plusieurs groupes enregistrés (son chat perso + des groupes d'équipe).

---

## Containers Docker — questions fréquentes

**Un container par client ?**
Non, un container par **groupe actif**. Si un client a 2 groupes et reçoit des messages dans les deux, 2 containers tournent en parallèle.

**Ils sont persistants ?**
Non. Ils sont créés au premier message et détruits après 30 min d'inactivité. Mais les **données sont persistantes** — elles vivent sur le host et sont montées dans le container via des volumes Docker.

**La même image pour tous ?**
Oui. `nanoclaw-agent:latest` est partagée. Ce qui diffère entre clients, c'est les volumes montés :

```
Host (persistant)                         Container (éphémère)
──────────────────                        ────────────────────
/opt/otto/clients/dupont/
  ├─ groups/main/             ──mount──►  /workspace/group/
  │   ├─ business.db                      (base de données métier)
  │   ├─ CLAUDE.md                        (mémoire de l'agent)
  │   └─ documents/                       (fichiers générés)
  ├─ data/sessions/.claude/   ──mount──►  /home/node/.claude/
  │                                       (sessions SDK, skills)
  ├─ store/auth/              (WhatsApp credentials — pas monté)
  └─ .env                    (clé API — jamais monté, lu par le proxy)
```

---

## Permissions — le piège du multi-tenant

### Le problème

Le host tourne en **root**. Le container tourne en **node** (uid 1000). Root crée des fichiers, node doit les lire/écrire. Sans rien faire → `Permission denied`.

```
┌─ VPS ──────────────────────────────────────────────┐
│                                                    │
│  Host (root)                                       │
│    crée /opt/otto/clients/dupont/groups/main/      │
│    propriétaire : root:root                        │
│                                                    │
│  Container Docker (user node, uid 1000)            │
│    veut écrire dans /workspace/group/              │
│    = le même dossier, monté via Docker             │
│    → Permission denied ❌                          │
│                                                    │
└────────────────────────────────────────────────────┘
```

### La solution

On donne le **groupe 1000** (celui de node) à tous les fichiers, avec les permissions groupe en lecture/écriture :

```bash
chown -R root:1000 /opt/otto/clients/dupont/groups/
chmod -R u=rwX,g=rwX,o= /opt/otto/clients/dupont/groups/
```

Résultat : `drwxrwx--- root 1000`
- root peut tout → le host fonctionne
- groupe 1000 peut tout → le container fonctionne
- les autres ne voient rien → le client B ne peut pas lire les données du client A

**Où c'est appliqué :**
- `src/container-runner.ts` — boucle automatique sur tous les volumes writable avant chaque lancement de container
- `api/src/provision.ts` — au provisioning initial du client
- `api/src/onboard.ts` — à l'onboarding WhatsApp

### Ce qui n'est PAS un container

Le SDK Claude (Agent SDK) utilise un mécanisme appelé "sandbox" — c'est un `unshare` Linux, PAS un container Docker. Ça tourne **à l'intérieur** du container Docker :

```
┌─ Container Docker ─────────────────────────┐
│  user: node (uid 1000)                     │
│                                            │
│  ┌─ Agent SDK (process Node.js) ────────┐  │
│  │                                      │  │
│  │  Quand l'agent utilise "Bash tool" : │  │
│  │  → child_process dans le container   │  │
│  │  → PAS un sous-container             │  │
│  │                                      │  │
│  │  "Sandbox" SDK = unshare Linux       │  │
│  │  = restrictions supplémentaires      │  │
│  │  → désactivé (redondant avec Docker) │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

On désactive la sandbox SDK (`sandbox: { enabled: false }`) parce que Docker fournit déjà l'isolation. La sandbox bloquait nos outils (python3, pandoc, ffmpeg).

---

## Sécurité — les 3 couches

| Couche | Ce qu'elle protège | Comment |
|--------|--------------------|---------|
| **Docker** | Isolation filesystem et réseau | Chaque container ne voit que ses propres fichiers montés |
| **Credential proxy** | Clés API | Le container n'a jamais la vraie clé, elle est injectée au vol |
| **Hooks PreToolUse** | Commandes destructrices | Bloque `rm -rf /`, `DROP TABLE`, écriture hors workspace |

Les permissions fichier (`root:1000, 770`) ajoutent l'isolation **entre clients** sur le host.

---

## Flux complet d'un message

```
1. Dirigeant envoie "Fais-moi un devis pour Acme" sur WhatsApp

2. Baileys (librairie WhatsApp) reçoit le message
   → JID: 33650133431@s.whatsapp.net

3. Host cherche dans registered_groups
   → Match: client "dupont", dossier "main"

4. Host vérifie s'il y a un container actif pour ce groupe
   → Non → Lance un nouveau container Docker

5. Container démarre :
   - Monte /workspace/group/ → les données du client
   - Monte /home/node/.claude/ → la session SDK
   - Env: ANTHROPIC_BASE_URL=http://172.17.0.1:3002 (proxy)

6. Agent SDK (Claude) reçoit le message + CLAUDE.md + historique

7. Claude décide d'utiliser des outils :
   - Bash: python3 pour créer le devis en .docx
   - MCP business-db: cherche les infos du contact Acme

8. Claude répond : "Voici le devis pour Acme, enregistré dans documents/"

9. Container renvoie la réponse au host via stdout

10. Host envoie la réponse sur WhatsApp via Baileys

11. Container reste en veille, attend le prochain message (IPC)

12. 30 min sans message → Host tue le container
```

---

## Arborescence multi-tenant

```
/opt/otto/
  ├─ app/                    ← Code source (partagé, read-only pour les containers)
  │   ├─ src/
  │   ├─ container/
  │   └─ dist/
  │
  ├─ api/                    ← API d'onboarding (Stripe, provisioning)
  │   └─ src/
  │
  └─ clients/                ← Un dossier par client (isolé)
      ├─ dupont/
      │   ├─ .env            ← Clé API Anthropic (600, jamais monté)
      │   ├─ start-pm2.sh    ← Wrapper PM2
      │   ├─ groups/
      │   │   ├─ main/       ← Données du chat principal
      │   │   │   ├─ business.db
      │   │   │   ├─ CLAUDE.md
      │   │   │   └─ documents/
      │   │   └─ global/     ← Mémoire partagée entre groupes
      │   ├─ data/
      │   │   └─ sessions/   ← Sessions SDK, skills
      │   └─ store/
      │       └─ auth/       ← Credentials WhatsApp
      │
      └─ martin/             ← Autre client, même structure
          ├─ .env
          └─ ...
```

---

## Scalabilité — limites actuelles et évolution

### Architecture actuelle : 1 process par client

Chaque client a son propre process Node.js (PM2), sa propre connexion WhatsApp, et son propre port credential proxy.

```
otto-api       (1 process, partagé)
otto-dupont    (1 process, port 3002, ~180MB RAM)
otto-martin    (1 process, port 3003, ~180MB RAM)
otto-garcia    (1 process, port 3004, ~180MB RAM)
```

**Limites :**

| Ressource | Limite | Impact |
|-----------|--------|--------|
| RAM | ~180MB par client | CCX33 (32GB) ≈ 150 clients max théorique, ~35 confortable |
| Ports | 1 port proxy par client + 1 règle UFW | 65535 ports max, gestion UFW lourde |
| PM2 | 1 process par client | Overhead de gestion, redémarrages individuels |
| CPU | 1 connexion WhatsApp par process | Baileys idle consomme peu, mais les reconnexions peuvent être coûteuses |

**Suffisant pour :** ~35 clients sur CCX33 (48€/mois).

### Architecture cible : process multi-tenant

Quand on approchera la centaine de clients, migrer vers un process unique qui gère toutes les connexions WhatsApp :

```
AVANT (1 process par client)                 APRÈS (1 process multi-tenant)
──────────────────────────                   ──────────────────────────────

otto-dupont  (180MB, port 3002)              otto (180MB total)
otto-martin  (180MB, port 3003)                ├─ WhatsApp Dupont ──┐
otto-garcia  (180MB, port 3004)                ├─ WhatsApp Martin   ├─ routing par JID
= 540MB, 3 ports, 3 processes                 ├─ WhatsApp Garcia ──┘
                                               └─ 1 credential proxy (port 3001)
                                                    └─ routing par header X-Client-Id
                                             = 180MB, 1 port, 1 process
```

**Changements nécessaires :**

1. **Credential proxy unique** — Un seul port, le container passe un `X-Client-Id` header, le proxy lookup la bonne clé API en base.

2. **Connexions WhatsApp multi-tenant** — Un seul process maintient toutes les connexions Baileys. Le routing se fait par JID (déjà supporté par le système de `registered_groups`). Chaque connexion a son propre dossier `store/auth/`.

3. **Isolation des données** — Déjà en place (dossiers par client, permissions `root:1000`). Ne change pas.

4. **Container spawning** — Le process unique lance les containers avec les bons volumes montés. Déjà compatible (le `group.folder` détermine quels volumes monter).

5. **PM2** — Un seul process `otto` au lieu de N. Plus simple à monitorer.

**Ce qui ne change PAS :**
- Les containers Docker (déjà éphémères et isolés)
- La base de données par client (déjà séparée)
- Le CLAUDE.md et les skills (déjà par groupe)
- L'API d'onboarding (déjà centralisée)

**Quand migrer :** Quand la RAM ou le nombre de ports devient un bottleneck (~100 clients). Pas avant — l'architecture actuelle est plus simple à debugger et chaque client peut être redémarré indépendamment.

---

## Skills de l'agent

L'agent dispose de 53 skills répartis en 3 catégories :

**Skills documentaires (Anthropic officiels)** — `docx`, `pptx`, `xlsx`, `pdf` avec scripts de validation, templates, et QA automatisé.

**Skills métier (knowledge-work-plugins)** — Sales (call-prep, pipeline-review, forecast...), Finance (financial-statements, reconciliation...), Legal (review-contract, compliance-check...), HR (recruiting-pipeline, performance-review...), Operations (status-report, vendor-review...).

**Skills HNTIC (custom)** — Spécifiques à notre base de données : classify, memory, session-learnings, scan-passive, whatsapp-format.

Les skills sont chargés automatiquement dans le container via `container/skills/` → sync dans `/home/node/.claude/skills/`.

---

## Déploiement

Tout le code vit dans `/opt/otto/app/` (repo git). L'API tourne depuis `/opt/otto/app/api/`.

```bash
# Déployer tout
cd /opt/otto/app && git pull origin main && npm run build
cd api && npm run build && pm2 restart otto-api

# Rebuild container (si Dockerfile ou skills modifiés)
cd /opt/otto/app/container && ./build.sh
pm2 restart otto-test  # ou le client concerné
```
