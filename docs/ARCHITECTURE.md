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
- Peut créer des fichiers Word/Excel, lire des PDF, chercher sur le web
- Accède à la base de données métier du client (SQLite)
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

Chaque client a sa propre base `business.db` avec ~20 tables : contacts, deals, factures, contrats, tâches, réunions, etc. Claude la lit et la modifie via un serveur MCP (outil structuré).

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
