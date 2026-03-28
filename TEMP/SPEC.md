# HNTIC Assistant — Spécification d'implémentation

## Vision produit

Un assistant IA conversationnel pour dirigeants de PME, accessible uniquement via WhatsApp. Le dirigeant parle à son assistant comme à un bras droit humain. L'assistant écoute passivement toutes les conversations WhatsApp Business du dirigeant, extrait et structure automatiquement les informations business (contacts, deals, tâches, documents, échéances), et restitue l'intelligence via des réponses directes et des digests proactifs.

**Proposition de valeur** : "Tu diriges ta boîte depuis ton WhatsApp. Un seul interlocuteur qui retient tout, te relance sur ce qui compte, et te dit chaque lundi matin où tu en es."

**Positionnement** : L'assistant qui remplace les 40 outils du dirigeant de PME. B2C où le C est un chef d'entreprise.

---

## Base technique

Le produit est un fork de [NanoClaw](https://github.com/qwibitai/nanoclaw) (licence MIT, ~9 000 lignes TypeScript).

### Pourquoi NanoClaw

- Licence MIT — usage commercial sans restriction
- Architecture single-process Node.js, légère et lisible
- Channel WhatsApp via Baileys (ajouté comme skill, pas dans le core)
- Agents isolés dans des containers Docker (sécurité OS-level)
- Scheduler intégré (cron, interval, one-shot) avec support de scripts pre-check
- Mémoire persistante par groupe (CLAUDE.md + SQLite)
- Basé sur le Claude Agent SDK (@anthropic-ai/claude-agent-sdk) — accès aux tools Bash, Read, Write, Edit, WebSearch, WebFetch, MCP, Agent Teams, etc.
- IPC fichier entre host et containers

### Stack complète

| Composant | Technologie |
|-----------|-------------|
| Runtime | Node.js 22+ |
| Agent SDK | @anthropic-ai/claude-agent-sdk (propriétaire Anthropic, usage commercial autorisé via API key) |
| Messaging | Baileys (@whiskeysockets/baileys) — connexion WhatsApp Web non-officielle |
| Base de données | SQLite (better-sqlite3) |
| Container runtime | Docker (Linux) ou Apple Container (macOS) |
| Hébergement | 1 VPS Hetzner par client (CX23 : 2 vCPU, 4GB RAM, 40GB NVMe, ~3,50-5€/mois). Backup : Scaleway (datacenters Paris) si un client exige un hébergement en France |
| Modèle IA principal | Claude Sonnet 4.5/4.6 pour les réponses directes et digests |
| Modèle IA économique | Claude Haiku 4.5 pour la classification passive et le triage |

### Contrainte API Anthropic

L'usage commercial du Claude Agent SDK impose :
- Authentification par clé API (ANTHROPIC_API_KEY), JAMAIS via OAuth token d'un plan Pro/Max
- Le produit doit avoir son propre branding, ne pas apparaître comme Claude Code ou un produit Anthropic
- Les données utilisateur transitent par l'API Anthropic — documenter dans les CGV/DPA

---

## Phase 0 — Fork et setup local

### Objectif
Avoir NanoClaw fonctionnel sur la machine de développement avec WhatsApp connecté.

### Étapes

1. **Forker le repo** `qwibitai/nanoclaw` sur le GitHub HNTIC
2. **Cloner localement** et `npm install`
3. **Installer Docker Desktop** (requis pour l'isolation des agents)
4. **Ajouter le channel WhatsApp** — dans Claude Code, exécuter `/add-whatsapp` qui merge la branche `skill/whatsapp` dans le fork. Cela ajoute `src/channels/whatsapp.ts` et met à jour `src/channels/index.ts`
5. **Authentifier WhatsApp** — `npm run auth` puis scanner le QR code avec le téléphone
6. **Builder le container agent** — `./container/build.sh`
7. **Lancer NanoClaw** — `npm run dev`
8. **Tester le cycle complet** : envoyer un message WhatsApp au self-chat → l'agent répond → vérifier la réponse reçue
9. **Tester le scheduler** : demander à l'agent de créer un rappel dans 5 minutes et vérifier qu'il arrive

### Validation
- [ ] Message envoyé → agent répond dans le self-chat WhatsApp
- [ ] Tâche schedulée → message reçu à l'heure prévue
- [ ] Les logs dans `logs/nanoclaw.log` montrent le flux complet

---

## Phase 1 — Identité et schéma business

### 1.1 — CLAUDE.md principal

Remplacer le contenu de `groups/main/CLAUDE.md` et `groups/global/CLAUDE.md` par l'identité de l'assistant HNTIC.

#### Fichier `groups/global/CLAUDE.md`

```markdown
# [NOM ASSISTANT À DÉFINIR]

Tu es l'assistant IA personnel d'un dirigeant d'entreprise. Tu es son bras droit numérique — tu retiens tout, tu structures, tu rappelles ce qui compte.

## Langue et ton

- Tu parles **français** exclusivement (sauf si le dirigeant te parle dans une autre langue)
- Tu vouvoies par défaut. Si le dirigeant te tutoie, tu passes au tutoiement
- Tu es direct, concis, professionnel mais chaleureux
- Tu ne fais pas de longs discours — le dirigeant lit sur WhatsApp, il veut des réponses courtes et actionnables
- Tu ne poses une question que quand c'est nécessaire — sinon tu agis

## Ce que tu fais

- Tu réponds aux questions sur l'activité de l'entreprise
- Tu stockes et structures chaque information business dans la base SQLite
- Tu envoies des rappels proactifs quand une échéance approche ou qu'une relance est nécessaire
- Tu génères des digests (briefing hebdo, flash quotidien)
- Tu extrais les infos des documents reçus (PDF, images, vocaux)

## Comment tu stockes l'information

Tu as accès à une base SQLite business à `/workspace/group/business.db`.
Chaque information que le dirigeant te donne ou que tu extrais d'une conversation doit être stockée dans la bonne table.

### Règles de classification

Quand tu reçois une information :
1. Identifie le type : contact, deal, tâche, réunion, facture, obligation, décision, info équipe, document, ou autre
2. Si tu es sûr (>80% confiance), stocke directement et confirme brièvement
3. Si tu n'es pas sûr, demande confirmation avant de stocker
4. Si ça ne rentre dans aucune catégorie, stocke dans la table `memories`

### Règles de requête données

- Toujours filtrer par pertinence temporelle (dernier trimestre par défaut)
- Limiter les résultats à 20 lignes max par requête SQL
- Pour les historiques longs, d'abord compter, puis résumer par périodes
- Ne charger les détails que si l'utilisateur demande explicitement
- Utiliser les `relationship_summaries` plutôt que de relire tout l'historique brut

### Règles de correction

Quand l'utilisateur corrige une information :
1. Confirme ce que tu vas modifier AVANT de le faire : "Je vais passer le deal Dupont de 45K à 55K, c'est bien ça ?"
2. Fais la modification seulement après confirmation
3. Log TOUJOURS le changement dans la table `audit_log`
4. Ne supprime jamais physiquement — marque comme supprimé (soft delete) avec `deleted_at`

### Règles de schéma

- Les tables existantes sont la référence. Ne les supprime jamais.
- Tu peux ajouter des colonnes avec ALTER TABLE si un besoin spécifique émerge
- Tu peux créer de nouvelles tables si nécessaire. Nomme-les en snake_case anglais
- Documente tout changement de schéma dans `/workspace/group/schema_log.md`
- En cas de doute, utilise la table `memories` comme stockage temporaire

### Confiance et auto-correction

- Quand tu n'es pas sûr de ta classification, demande confirmation
- Si l'utilisateur dit "non" ou corrige, note le pattern dans ce fichier CLAUDE.md pour ne pas refaire l'erreur
- Exemple : "Note : quand [dirigeant] parle de 'Marc', c'est son ami pas un contact pro — ne pas créer de fiche."

## Formatage WhatsApp

- *gras* (une seule étoile, JAMAIS **double**)
- _italique_ (underscores)
- • bullet points
- ``` code blocks
- Pas de ## headings, pas de [liens](url), pas de **double stars**
- Messages courts — max 3-4 paragraphes sauf demande explicite

## Mémoire hiérarchique

- Ce fichier CLAUDE.md = mémoire immédiate (lu à chaque invocation, 0 tokens de requête)
- SQLite tables actives = mémoire de travail (requêtes ciblées)
- SQLite archives + relationship_summaries = mémoire long terme (sur demande)

Mets à jour ce fichier quand tu apprends quelque chose de structurant sur le dirigeant ou son entreprise.
```

#### Fichier `groups/main/CLAUDE.md`

Reprendre le contenu global ci-dessus et ajouter la section admin :

```markdown
## Contexte admin

Ceci est le canal principal (main). Tu as des privilèges élevés :
- Tu peux scheduler des tâches pour n'importe quel groupe
- Tu peux voir et modifier toutes les données
- Tu peux enregistrer/désenregistrer des groupes

## Dirigeant

[À remplir à l'onboarding]
- Nom :
- Entreprise :
- Secteur :
- Taille équipe :
- Contacts clés :
- Préférences :
```

### 1.2 — Schéma SQLite business

Créer un script d'initialisation `scripts/init-business-db.sql` :

```sql
-- ======================
-- HNTIC Business Schema
-- ======================

-- CRM
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  role TEXT,
  phone TEXT,
  email TEXT,
  relationship_type TEXT DEFAULT 'prospect', -- prospect, client, partner, supplier, advisor, investor, team, personal
  source TEXT, -- whatsapp, manual, scan, document
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  sector TEXT,
  size TEXT,
  website TEXT,
  address TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  contact_id TEXT REFERENCES contacts(id),
  company_id TEXT REFERENCES companies(id),
  title TEXT,
  amount REAL,
  currency TEXT DEFAULT 'EUR',
  stage TEXT DEFAULT 'lead', -- lead, qualified, proposal, negotiation, won, lost
  probability INTEGER,
  expected_close_date TEXT,
  next_action TEXT,
  next_action_date TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  contact_id TEXT REFERENCES contacts(id),
  deal_id TEXT REFERENCES deals(id),
  project_id TEXT REFERENCES projects(id),
  type TEXT, -- call, meeting, email, whatsapp, linkedin, other
  direction TEXT, -- inbound, outbound
  summary TEXT NOT NULL,
  sentiment TEXT, -- positive, neutral, negative
  source_chat_jid TEXT,
  source_message_id TEXT,
  date TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- PROJETS / EQUIPE
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  deal_id TEXT REFERENCES deals(id),
  company_id TEXT REFERENCES companies(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active', -- planned, active, on_hold, completed, cancelled
  start_date TEXT,
  end_date TEXT,
  budget REAL,
  consumed REAL DEFAULT 0,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  start_date TEXT,
  contract_type TEXT, -- cdi, cdd, freelance, intern
  trial_end_date TEXT,
  salary REAL,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  project_id TEXT REFERENCES projects(id),
  member_id TEXT REFERENCES team_members(id),
  role TEXT,
  start_date TEXT,
  end_date TEXT,
  daily_rate REAL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS absences (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  member_id TEXT REFERENCES team_members(id),
  type TEXT, -- vacation, sick, remote, training, other
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, approved, rejected
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  member_id TEXT REFERENCES team_members(id),
  date TEXT NOT NULL,
  summary TEXT,
  next_review_date TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- FINANCE / ADMIN
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  company_id TEXT REFERENCES companies(id),
  contact_id TEXT REFERENCES contacts(id),
  project_id TEXT REFERENCES projects(id),
  direction TEXT NOT NULL, -- inbound (facture fournisseur), outbound (facture client)
  invoice_number TEXT,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  tax_amount REAL,
  status TEXT DEFAULT 'draft', -- draft, sent, paid, overdue, cancelled
  issue_date TEXT,
  due_date TEXT,
  paid_date TEXT,
  file_path TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  category TEXT, -- office, travel, software, marketing, legal, other
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'EUR',
  date TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  receipt_path TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  company_id TEXT REFERENCES companies(id),
  contact_id TEXT REFERENCES contacts(id),
  type TEXT, -- client, supplier, employment, lease, insurance, other
  title TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  value REAL,
  renewal_type TEXT, -- auto, manual, none
  notice_period_days INTEGER,
  file_path TEXT,
  status TEXT DEFAULT 'active', -- draft, active, expired, terminated
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  category TEXT, -- accounting, legal, insurance, it, banking, other
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  contract_end_date TEXT,
  annual_cost REAL,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- OBLIGATIONS / JURIDIQUE
CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  title TEXT NOT NULL,
  category TEXT NOT NULL, -- legal, fiscal, social, regulatory, insurance, contractual
  description TEXT,
  due_date TEXT NOT NULL,
  recurrence TEXT, -- monthly, quarterly, annual, one_time
  responsible TEXT,
  status TEXT DEFAULT 'pending', -- pending, done, overdue, cancelled
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- STRATEGIE
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  date TEXT NOT NULL,
  context TEXT,
  decision TEXT NOT NULL,
  rationale TEXT,
  review_date TEXT,
  status TEXT DEFAULT 'active', -- active, revised, cancelled
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  title TEXT NOT NULL,
  metric TEXT,
  target TEXT,
  current TEXT,
  deadline TEXT,
  status TEXT DEFAULT 'active', -- active, achieved, missed, cancelled
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- REUNIONS
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  date TEXT NOT NULL,
  attendees TEXT, -- JSON array ou texte libre
  summary TEXT,
  action_items TEXT, -- JSON array ou texte libre
  related_deal_id TEXT REFERENCES deals(id),
  related_project_id TEXT REFERENCES projects(id),
  related_company_id TEXT REFERENCES companies(id),
  source_chat_jid TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- DOCUMENTS
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  title TEXT NOT NULL,
  category TEXT, -- invoice, contract, proposal, report, id_card, receipt, other
  file_path TEXT NOT NULL,
  file_type TEXT, -- pdf, image, audio, docx, xlsx, other
  extracted_text TEXT,
  source_chat_jid TEXT,
  source_message_id TEXT,
  related_contact_id TEXT REFERENCES contacts(id),
  related_company_id TEXT REFERENCES companies(id),
  related_deal_id TEXT REFERENCES deals(id),
  tags TEXT, -- JSON array
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- MEMOIRE
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  content TEXT NOT NULL,
  category TEXT, -- business, personal, preference, context, other
  source TEXT, -- direct (dit par le dirigeant), passive (extrait d'une conversation), inferred
  source_chat_jid TEXT,
  source_message_id TEXT,
  confidence REAL DEFAULT 1.0,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- RESUMES ET DIGESTS
CREATE TABLE IF NOT EXISTS relationship_summaries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  contact_id TEXT REFERENCES contacts(id),
  company_id TEXT REFERENCES companies(id),
  last_updated TEXT NOT NULL,
  summary TEXT NOT NULL,
  key_facts TEXT,
  open_items TEXT,
  sentiment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_digests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  type TEXT NOT NULL, -- daily, weekly, monthly
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- AUDIT
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  action TEXT NOT NULL, -- create, update, delete, restore
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- SCAN CONFIG (écoute passive)
CREATE TABLE IF NOT EXISTS scan_config (
  chat_jid TEXT PRIMARY KEY,
  chat_name TEXT,
  mode TEXT DEFAULT 'listen', -- active, listen, ignore
  category TEXT, -- client, team, supplier, personal, unknown
  classified_by TEXT DEFAULT 'auto', -- auto, manual
  added_at TEXT DEFAULT (datetime('now'))
);

-- INDEX
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(relationship_type);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_close_date ON deals(expected_close_date);
CREATE INDEX IF NOT EXISTS idx_interactions_contact ON interactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_interactions_date ON interactions(date);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date ON invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_obligations_due_date ON obligations(due_date);
CREATE INDEX IF NOT EXISTS idx_obligations_status ON obligations(status);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_audit_log_table ON audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_scan_config_mode ON scan_config(mode);
```

### 1.3 — Script d'initialisation de la base

Créer `scripts/init-business-db.sh` :

```bash
#!/bin/bash
DB_PATH="${1:-groups/main/business.db}"
echo "Initializing business database at $DB_PATH"
sqlite3 "$DB_PATH" < scripts/init-business-db.sql
echo "Done. Tables created:"
sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Ce script doit être exécuté une fois par client à l'onboarding. La base `business.db` vit dans le dossier du groupe principal du client.

---

## Phase 2a — Routing de modèles

### Objectif
Permettre de choisir le modèle Claude (haiku, sonnet, opus) par type d'invocation pour optimiser les coûts.

### Modification de `container/agent-runner/src/index.ts`

1. Ajouter un champ `model` à l'interface `ContainerInput` :

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  model?: 'sonnet' | 'haiku' | 'opus'; // AJOUT
}
```

2. Passer le modèle à `query()` :

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    model: containerInput.model || 'sonnet', // AJOUT — défaut Sonnet
    cwd: '/workspace/group',
    // ... reste des options inchangé
  }
}))
```

### Modification de `src/container-runner.ts`

Ajouter un champ `model` dans le JSON envoyé au container via stdin. Le modèle est déterminé par le type d'invocation :

```typescript
// Dans la fonction qui prépare le ContainerInput
const model = isScheduledTask && !isDigestTask ? 'haiku' : 'sonnet';
```

### Logique de routing recommandée

| Type d'invocation | Modèle | Justification |
|-------------------|--------|---------------|
| Message direct du dirigeant | sonnet | Qualité max pour les réponses conversationnelles |
| Scan passif / classification | haiku | 10-20x moins cher, suffisant pour classifier |
| Digest hebdomadaire | sonnet | Synthèse complexe, qualité de rédaction |
| Rappel / check simple | haiku | Tâche mécanique, pas besoin de raisonnement |
| Extraction de document | sonnet | Compréhension fine requise (PDF, vocaux) |
| Mise à jour relationship_summaries | haiku | Agrégation de données structurées |

---

## Phase 2a-bis — Features avancées du Claude Agent SDK

NanoClaw utilise le SDK de façon basique (query + tools). Ces features du SDK sont critiques pour un produit de qualité et doivent être implémentées.

### Session resume — Continuité conversationnelle

Le SDK retourne un `session_id` à chaque appel `query()`. En le repassant au prochain appel, la conversation reprend exactement là où elle s'était arrêtée.

**Modification de `src/container-runner.ts` :**

Stocker le `session_id` de la dernière session de chaque groupe dans SQLite (table `messages` ou nouvelle table `sessions`). Quand le dirigeant envoie un message, passer le `session_id` précédent :

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    model: containerInput.model || 'sonnet',
    resume: containerInput.lastSessionId || undefined, // AJOUT
    cwd: '/workspace/group',
    // ...
  }
}))
```

Pour le message `init` retourné par le SDK, capturer le `session_id` et le stocker :

```typescript
if (message.type === 'init') {
  storeSessionId(groupFolder, message.session_id);
}
```

**Bénéfice** : le dirigeant reprend sa conversation le lendemain matin, l'assistant a tout le contexte de la veille. Pas besoin de tout réexpliquer.

**Attention** : les sessions expirent au bout d'un certain temps. Prévoir un fallback si le resume échoue (démarrer une nouvelle session avec un résumé du CLAUDE.md).

### Compaction automatique — Survie des infos business

Le SDK compacte automatiquement le contexte quand la conversation approche de la limite (1M tokens). Problème : les infos business mentionnées en début de conversation peuvent être perdues.

**Hook PostCompact :**

Enregistrer un hook qui se déclenche après chaque compaction pour réinjecter le contexte critique :

```typescript
options: {
  hooks: {
    PostCompact: [
      {
        hooks: [async (input) => {
          // Lire le CLAUDE.md (contient les préférences et le contexte immédiat)
          // Lire les relationship_summaries des contacts actifs
          // Réinjecter comme contexte additionnel
          const claudeMd = fs.readFileSync('/workspace/group/CLAUDE.md', 'utf8');
          const activeSummaries = db.prepare(
            `SELECT c.name, rs.summary FROM relationship_summaries rs
             JOIN contacts c ON rs.contact_id = c.id
             WHERE rs.last_updated > date('now', '-30 days')
             ORDER BY rs.last_updated DESC LIMIT 10`
          ).all();

          return {
            hookSpecificOutput: {
              contextToInject: `## Rappel post-compaction\n\n${claudeMd}\n\n## Relations actives\n${activeSummaries.map(s => `- ${s.name}: ${s.summary}`).join('\n')}`
            }
          };
        }]
      }
    ]
  }
}
```

**Bénéfice** : même après 200 messages, l'assistant se souvient de qui est "Dupont" et de l'état du deal en cours.

### Hooks — Audit automatique et sécurité

Le SDK supporte des hooks sur tout le cycle de vie de l'agent. Configurer :

**PreToolUse (sécurité) :**
- Bloquer les commandes Bash destructrices (`rm -rf`, `DROP TABLE`, etc.)
- Bloquer les écritures hors du workspace (`/workspace/group/`)
- Logger toutes les commandes SQL exécutées

**PostToolUse (audit) :**
- Après chaque commande Bash contenant `sqlite3` + `INSERT|UPDATE|DELETE`, parser la commande et logger automatiquement dans `audit_log`
- Après chaque Write/Edit de fichier, logger le changement

**SessionStart :**
- Lire le CLAUDE.md et le résumé du dernier digest pour amorcer le contexte
- Vérifier la dernière activité du dirigeant (si >7 jours, envoyer un message proactif "Ça fait un moment, on fait un point ?")

**SessionEnd :**
- Mettre à jour le `updated_at` de la dernière session
- Si des infos structurantes ont été apprises, mettre à jour le CLAUDE.md

### Custom tools in-process — Accès propre à la business.db

Au lieu de faire exécuter du `sqlite3` via le tool Bash (fragile, pas typé, risque d'injection), créer un custom tool MCP in-process :

```typescript
// tools/business-db.ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

const queryBusinessDb = tool(
  'query_business_db',
  'Execute a read-only SQL query on the business database. Returns JSON rows.',
  { query: 'string', params: 'array?' },
  async (args) => {
    const db = getBusinessDb(); // better-sqlite3 instance
    const stmt = db.prepare(args.query);
    const rows = args.params ? stmt.all(...args.params) : stmt.all();
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  }
);

const mutateBusinessDb = tool(
  'mutate_business_db',
  'Execute an INSERT, UPDATE, or DELETE on the business database. Automatically logs to audit_log. Returns affected row count.',
  { query: 'string', params: 'array?', table_name: 'string', record_id: 'string?', reason: 'string?' },
  async (args) => {
    const db = getBusinessDb();
    const stmt = db.prepare(args.query);
    const result = args.params ? stmt.run(...args.params) : stmt.run();

    // Auto-log dans audit_log
    db.prepare(
      `INSERT INTO audit_log (table_name, record_id, action, reason, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(args.table_name, args.record_id || 'unknown', 'mutation', args.reason || null);

    return { content: [{ type: 'text', text: JSON.stringify({ changes: result.changes }) }] };
  }
);

export const businessDbServer = createSdkMcpServer({
  name: 'business-db',
  version: '1.0.0',
  tools: [queryBusinessDb, mutateBusinessDb]
});
```

Puis passer ce serveur MCP au `query()` :

```typescript
options: {
  mcpServers: [businessDbServer],
  // ...
}
```

**Bénéfice** : requêtes typées, audit automatique, pas de risque d'injection SQL via Bash, performances meilleures (in-process vs spawn sqlite3).

### max_budget_usd — Contrôle des coûts par session

Le SDK accepte un paramètre `max_budget_usd` qui stoppe l'agent s'il dépasse un budget donné.

```typescript
options: {
  maxBudgetUsd: containerInput.isScheduledTask ? 0.50 : 2.00, // AJOUT
  // ...
}
```

**Logique de budget :**

| Type d'invocation | Budget max |
|-------------------|-----------|
| Message direct du dirigeant | 2.00$ |
| Scan passif (batch de messages) | 0.50$ |
| Digest hebdomadaire | 1.00$ |
| Rappel simple | 0.10$ |
| Extraction de document | 1.50$ |

**Bénéfice** : pas de dérapage de coûts. Si un agent tourne en boucle, il s'arrête avant de coûter cher. Indispensable pour un produit à marge fixe.

### Plugins natifs — Charger les knowledge-work-plugins directement

Les knowledge-work-plugins sont déjà structurés comme des plugins SDK (avec `.claude-plugin/plugin.json`). Au lieu de copier les skills dans `container/skills/`, on peut les charger comme plugins natifs :

```typescript
options: {
  plugins: [
    { type: 'local', path: '/workspace/plugins/sales' },
    { type: 'local', path: '/workspace/plugins/finance' },
    { type: 'local', path: '/workspace/plugins/legal' },
    { type: 'local', path: '/workspace/plugins/human-resources' },
    { type: 'local', path: '/workspace/plugins/productivity' },
    { type: 'local', path: '/workspace/plugins/operations' },
  ],
  // ...
}
```

**Bénéfice** : les plugins gardent leur structure originale, les mises à jour upstream sont faciles à merger, et le SDK gère automatiquement le namespace des skills et commandes.

### max_turns — Limiter les boucles infinies

```typescript
options: {
  maxTurns: containerInput.isScheduledTask ? 10 : 30, // AJOUT
  // ...
}
```

Un scan passif n'a pas besoin de 30 tours. Un digest non plus. Seule une conversation interactive avec le dirigeant peut justifier un grand nombre de tours.

---

## Phase 2b — Skills métier HNTIC

### Stratégie : forker les knowledge-work-plugins Anthropic

Au lieu de créer tous les skills de zéro, on part des plugins métier officiels Anthropic :
**Repo : `https://github.com/anthropics/knowledge-work-plugins`** (licence Apache-2.0, usage commercial libre).

Ce repo contient 11 plugins métier complets avec skills, commandes et connecteurs. Chaque plugin suit la structure :

```
plugin-name/
├── .claude-plugin/plugin.json   # Manifest
├── .mcp.json                    # Connexions outils
├── commands/                    # Commandes slash explicites
└── skills/                      # Expertise métier auto-activée
```

### Étape 1 : Cloner et copier les plugins pertinents

```bash
git clone https://github.com/anthropics/knowledge-work-plugins.git /tmp/kwp

# Copier les plugins utiles dans le fork NanoClaw
cp -r /tmp/kwp/sales/skills/* container/skills/
cp -r /tmp/kwp/finance/skills/* container/skills/
cp -r /tmp/kwp/legal/skills/* container/skills/
cp -r /tmp/kwp/human-resources/skills/* container/skills/
cp -r /tmp/kwp/productivity/skills/* container/skills/
cp -r /tmp/kwp/operations/skills/* container/skills/
```

### Étape 2 : Adapter chaque skill pour NanoClaw + WhatsApp + SQLite

Pour chaque SKILL.md copié, appliquer ces modifications systématiques :

1. **Langue** : Traduire les instructions en français. Le dirigeant parle français, l'agent doit penser et répondre en français.

2. **Connecteurs → SQLite** : Remplacer toutes les références aux connecteurs externes (HubSpot, Salesforce, Slack, etc.) par des requêtes SQLite sur `/workspace/group/business.db`. Exemple :
   - "Query CRM for open opportunities" → `SELECT * FROM deals WHERE stage NOT IN ('won','lost') AND deleted_at IS NULL`
   - "Check calendar for today's meetings" → `SELECT * FROM meetings WHERE date(date) = date('now')`
   - "Pull unread emails" → Non applicable, remplacer par les interactions récentes dans `interactions`

3. **Format de sortie → WhatsApp** : Remplacer les formats Markdown complexes (tableaux multi-colonnes, headers ##) par du texte WhatsApp :
   - `*gras*` (une seule étoile)
   - `_italique_`
   - `• ` pour les listes
   - Max 10-15 lignes par message sauf demande explicite
   - Pas de tableaux — utiliser des listes formatées à la place

4. **Commandes slash → langage naturel** : Les commandes `/sales:call-prep` deviennent des triggers en langage naturel ("prépare mon appel avec Dupont", "brief-moi sur mon pipeline").

### Skills réutilisés depuis `knowledge-work-plugins`

#### Plugin `sales` — Module CRM de l'assistant

| Skill original | Usage dans le produit | Adaptation |
|----------------|----------------------|------------|
| `daily-briefing` | Digest du lundi matin + flash quotidien | Remplacer Calendar/CRM/Email par requêtes SQLite. Garder la logique de prioritisation (urgences → deals closing → stale deals → tâches). Adapter le format pour WhatsApp (court, actionnable). |
| `pipeline-review` | "Où j'en suis sur mes deals ?" | Remplacer l'export CSV par `SELECT * FROM deals`. Garder le scoring de santé (stale, stuck, at-risk) et le plan d'action hebdomadaire. |
| `call-prep` | "Prépare-moi pour mon rdv avec Dupont" | Query contacts + interactions + deals + relationship_summaries pour le contact. Générer un brief de 5-10 lignes. |
| `call-summary` | Post-réunion / post-appel | Stocker le résumé dans interactions, mettre à jour le deal si nécessaire, créer les follow-ups. |
| `account-research` | "Dis-moi tout sur l'entreprise X" | Query companies + contacts + deals + interactions. Si pas assez d'infos en base, utiliser WebSearch. |
| `competitive-intelligence` | "Quoi de neuf chez mon concurrent Y ?" | Utiliser WebSearch du SDK. Stocker les résultats dans memories. |
| `draft-outreach` | "Rédige un message pour relancer Dupont" | Adapter le ton pour WhatsApp/email selon le contexte. |
| `forecast` | "Combien je vais facturer ce trimestre ?" | Agréger deals par stage avec probabilités. Query invoices pour le réalisé. |

#### Plugin `finance` — Module DAF de l'assistant

| Skill original | Usage dans le produit | Adaptation |
|----------------|----------------------|------------|
| `variance-analysis` | "Pourquoi mes dépenses ont augmenté ?" | Query expenses par catégorie et période. Comparer mois/mois. |
| `reconciliation` | "Rapproche mes factures" | Croiser invoices (outbound, status=sent) avec invoices (inbound, status=paid). |
| `financial-statements` | "Fais-moi un point tréso" | Agréger invoices paid - expenses - salaires. Projection à 3 mois. |
| `journal-entry` | Pas prioritaire pour MVP | Garder pour V2 si demande. |

#### Plugin `legal` — Module juridique de l'assistant

| Skill original | Usage dans le produit | Adaptation |
|----------------|----------------------|------------|
| `review-contract` | "Regarde ce contrat qu'on m'envoie" | Le dirigeant envoie un PDF par WhatsApp. L'agent extrait le texte, analyse clause par clause, flag les risques. Stocker dans documents + contracts. |
| `legal-risk-assessment` | Évaluation de risque sur un deal/partenariat | Garder la matrice severity × likelihood. Adapter les seuils pour une PME. |
| `compliance-check` | "Est-ce que je suis en règle pour X ?" | Query obligations par catégorie. Lister les échéances proches. |
| `triage-nda` | "On me demande de signer un NDA" | Analyse rapide des clauses clés (durée, périmètre, pénalités). |
| `vendor-check` | "Dis-moi si ce fournisseur est fiable" | WebSearch + stockage dans suppliers. |

#### Plugin `human-resources` — Module RH de l'assistant

| Skill original | Usage dans le produit | Adaptation |
|----------------|----------------------|------------|
| `people-report` | "Point sur mon équipe" | Query team_members + assignments + absences. |
| `performance-review` | "Prépare mon entretien avec Jean" | Query reviews + interactions filtrées par member_id. |
| `onboarding` | "J'embauche quelqu'un lundi" | Checklist d'onboarding avec les tâches à faire (contrat, matériel, accès, etc.). Créer dans obligations. |
| `comp-analysis` | "Est-ce que mon offre est dans le marché ?" | WebSearch benchmarks salaires + contexte du poste. |
| `draft-offer` | "Rédige une offre pour ce candidat" | Générer une lettre d'offre avec les infos du poste. Skill docx Anthropic pour le formatage. |
| `org-planning` | "Comment structurer mon équipe pour 2027 ?" | Vue d'ensemble team_members + assignments + projets. Suggestions d'organisation. |

#### Plugin `productivity` — Moteur de mémoire de l'assistant

| Skill original | Usage dans le produit | Adaptation |
|----------------|----------------------|------------|
| `memory-management` | Architecture mémoire 2 tiers | **C'est le skill le plus important à reprendre.** Architecture : CLAUDE.md (hot cache, ~30 contacts, ~30 acronymes, projets actifs) + memory/ (glossaire complet, profils détaillés, contexte entreprise). Flow de lookup en 3 étapes : CLAUDE.md → glossary → demander. Adapter pour que le "glossary" soit en fait la business.db SQLite. |
| `task-management` | Suivi des tâches et engagements | Remplacer TASKS.md par la table deals (next_action, next_action_date) + obligations. |
| `start` | Bootstrap à l'onboarding | Adapter pour l'onboarding client : collecter infos dirigeant, créer le CLAUDE.md initial, scanner les conversations WhatsApp. |
| `update` | Sync quotidien | Adapter pour le flash quotidien : résumé des nouvelles infos, mises à jour en attente. |

#### Plugin `operations` — Module opérations de l'assistant

| Skill original | Usage dans le produit | Adaptation |
|----------------|----------------------|------------|
| `status-report` | "Fais-moi un point sur le projet X" | Query projects + assignments + interactions filtrées. |
| `vendor-review` | "Compare ces deux devis" | Analyse structurée coût/risque/performance. Stocker dans suppliers. |
| `risk-assessment` | "Quels sont mes risques en ce moment ?" | Agréger deals at-risk + obligations en retard + contrats expirant + trésorerie. |
| `compliance-tracking` | Suivi des obligations réglementaires | Query obligations par statut et échéance. Alertes proactives. |

### Étape 3 : Skills à créer from scratch (propriété intellectuelle HNTIC)

Ces skills n'existent dans aucun repo — c'est la valeur ajoutée unique du produit :

#### Skill : `hntic-classify` (classification WhatsApp → SQLite)

```markdown
---
name: hntic-classify
description: Classifie les messages business WhatsApp et stocke les entités dans les bonnes tables SQLite. Utilisé en mode scan passif avec le modèle Haiku.
---

# Classification business

Quand tu reçois des messages à classifier (mode scan passif), applique cette logique :

## Étape 1 — Identification des entités

Pour chaque message ou groupe de messages, extrais :
- Noms de personnes (nouveau contact potentiel ?)
- Noms d'entreprises
- Montants financiers
- Dates et échéances
- Actions ou engagements pris
- Émotions / sentiment

## Étape 2 — Catégorisation

| Signal | Table(s) |
|--------|----------|
| Nouveau nom + entreprise | contacts, companies |
| Montant + négociation | deals |
| "On se voit mardi" | meetings |
| "Envoie-moi le devis" | interactions (avec next_action) |
| "La facture est payée" | invoices |
| "Jean est en congé" | absences |
| Feedback sur un collaborateur | reviews |
| Document reçu (PDF, image) | documents |
| Décision stratégique | decisions |
| Tout le reste | memories |

## Étape 3 — Stockage

Exécute les INSERT/UPDATE appropriés via `sqlite3 /workspace/group/business.db`.
Toujours logger dans `audit_log` pour les CREATE et UPDATE.

## Règles de prudence

- Ne crée PAS un contact à partir d'un prénom mentionné en passant dans une conversation informelle
- Ne crée PAS un deal si c'est juste une discussion exploratoire sans montant ni engagement
- Priorise la mise à jour d'enregistrements existants plutôt que la création de doublons
- Avant de créer un contact, vérifie avec `SELECT * FROM contacts WHERE name LIKE '%nom%'`
```

#### Skill : `hntic-whatsapp-format` (formatage WhatsApp)

Adapté du `slack-formatting` natif de NanoClaw :

```markdown
---
name: hntic-whatsapp-format
description: Règles de formatage pour les messages WhatsApp. Appliqué automatiquement à toutes les réponses.
user-invocable: false
---

# Formatage WhatsApp

## Règles strictes

- *gras* avec UNE SEULE étoile (JAMAIS **double**)
- _italique_ avec underscores
- ~barré~ avec tildes
- ```code``` avec triple backticks
- • pour les bullet points (caractère bullet, pas de tiret)
- Pas de ## headings
- Pas de [liens](url) — écrire l'URL en clair si nécessaire
- Pas de tableaux Markdown — utiliser des listes formatées

## Longueur

- Réponse directe : 3-5 lignes max
- Briefing/digest : 10-15 lignes max
- Rapport détaillé (sur demande) : 20-30 lignes max, découpé en plusieurs messages si nécessaire

## Ton

- Direct, concis, professionnel mais chaleureux
- Pas de "Bien sûr !", "Absolument !", "Je serais ravi de..."
- Aller droit au but, puis offrir d'approfondir
```

#### Skill : `hntic-scan-passive` (écoute passive)

```markdown
---
name: hntic-scan-passive
description: Scanne les conversations WhatsApp non traitées et extrait les entités business. Exécuté en mode cron avec le modèle Haiku.
user-invocable: false
---

# Scan passif

Tu reçois un batch de messages WhatsApp non traités provenant de conversations écoutées.
Ta mission : extraire les informations business et les stocker dans la base SQLite.

## Instructions

1. Lis le batch de messages fourni
2. Pour chaque conversation (groupée par chat_jid) :
   a. Identifie les entités business (voir skill hntic-classify)
   b. Classe chaque entité avec un score de confiance (0-1)
   c. Si confiance > 0.8 : stocke directement
   d. Si confiance 0.5-0.8 : stocke avec flag `needs_review = 1` dans la colonne notes
   e. Si confiance < 0.5 : ignore (trop incertain)
3. Après le stockage, mets à jour le relationship_summary du contact si applicable
4. Marque les messages comme traités

## Ce que tu ne fais PAS

- Tu ne réponds PAS aux messages (mode passif uniquement)
- Tu ne crées PAS de doublons (vérifie toujours avant d'insérer)
- Tu ne stockes PAS les conversations personnelles (vérifie scan_config.mode != 'ignore')
- Tu ne modifies PAS les enregistrements existants sans flag de confiance haute
```

### Étape 4 : Skills documentaires Anthropic officiels (repo `anthropics/skills`)

En complément des knowledge-work-plugins, les skills documentaires du repo `anthropics/skills` (37.5K stars) sont utiles.

**⚠️ Attention aux licences — deux régimes différents dans ce repo :**

- **docx, pdf, xlsx, pptx** → Licence propriétaire Anthropic ("© Anthropic, PBC. All rights reserved."). Tu peux les **utiliser** dans tes containers via le SDK (c'est couvert par ton contrat API Anthropic), mais tu ne peux **pas les redistribuer** ni les inclure dans ton repo HNTIC. Ils sont déjà disponibles nativement quand l'agent tourne sur le SDK.
- **internal-comms, frontend-design, brand-guidelines, mcp-builder, etc.** → Licence Apache-2.0. Usage commercial libre, modification et redistribution autorisées.

**Approche recommandée :** Ne pas copier docx/pdf/xlsx/pptx dans ton repo. Le SDK les charge automatiquement. Pour les skills Apache-2.0 utiles (internal-comms notamment pour les digests), tu peux les forker librement.

```bash
git clone https://github.com/anthropics/skills.git /tmp/skills

# Skills Apache-2.0 uniquement — OK pour inclusion dans le repo HNTIC
cp -r /tmp/skills/skills/internal-comms container/skills/

# Les skills docx/pdf/xlsx/pptx sont disponibles nativement via le SDK
# Ne PAS les copier dans le repo — licence propriétaire
```

### Étape 5 : Repos communautaires à auditer

Ces repos contiennent des patterns utiles à étudier pendant le développement :

| Repo | Intérêt | Action |
|------|---------|--------|
| `c0dezli/claude-code-personal-assistant` | CLAUDE.md structuré pour assistant perso, daily-routine, intégrations Notion/Google | Auditer le CLAUDE.md et le workflow de routine quotidienne |
| `OpenPaw` (38 skills) | Bundle assistant personnel avec daily briefing, Telegram, Obsidian | Auditer le daily briefing et les patterns messaging |
| `alirezarezvani/claude-skills` (192 skills) | Skills C-level advisory, sales, legal, finance | Auditer les skills business/executive pour enrichir les skills HNTIC |
| `wondelai/skills` (25 skills) | Sales, product strategy, growth basés sur Hormozi, Cialdini | Auditer les frameworks sales |

---

## Phase 2c — Écoute passive

### Objectif
Scanner automatiquement toutes les conversations WhatsApp (sauf celles exclues) et extraire les entités business sans que le dirigeant ait à transférer quoi que ce soit.

### Modification du callback `onMessage` dans `src/index.ts`

Actuellement, `onMessage` stocke tous les messages dans SQLite via `storeMessage(msg)`. Il faut ajouter un filtre pour les conversations en mode `ignore` :

```typescript
onMessage: (chatJid: string, msg: NewMessage) => {
  // ... remote control check existant ...
  // ... sender allowlist check existant ...

  // AJOUT : vérifier le scan_config pour le mode ignore
  // La scan_config est dans la business.db, pas dans messages.db
  // On maintient un cache en mémoire rechargé toutes les 5 minutes
  if (ignoredJids.has(chatJid)) {
    return; // Ne pas stocker du tout
  }

  storeMessage(msg);
},
```

### Ajout d'une colonne `processed` à la table `messages`

Dans `src/db.ts`, ajouter une migration :

```typescript
try {
  database.exec(`ALTER TABLE messages ADD COLUMN passive_processed INTEGER DEFAULT 0`);
} catch { /* column already exists */ }
```

### Tâche schedulée de scan passif

Créer une tâche cron (toutes les 2 heures) qui :

1. `SELECT * FROM messages WHERE passive_processed = 0 AND timestamp > datetime('now', '-1 day')` — récupère les messages non traités des 24 dernières heures
2. Groupe par conversation (`chat_jid`)
3. Exclut les conversations en mode `ignore` et celles qui sont des `registeredGroups` actifs (elles sont déjà traitées par l'agent direct)
4. Pour chaque conversation avec des messages nouveaux, envoie le batch à un container agent avec `model: 'haiku'` et le skill `hntic-classify`
5. Le container classifie et stocke dans la business.db
6. Marque les messages comme `passive_processed = 1`

### Classification automatique des conversations à l'onboarding

Au premier lancement, l'agent principal :
1. Récupère la liste de toutes les conversations via `available_groups.json`
2. Pour chaque conversation, analyse le nom et les derniers messages
3. Classifie en `business` ou `personal` ou `unknown`
4. Stocke dans `scan_config` avec `mode = 'listen'` (business/unknown) ou `mode = 'ignore'` (personal)
5. Envoie un résumé au dirigeant pour validation :
   "J'ai analysé tes 147 conversations. J'écoute 83 conversations business, j'ignore 58 conversations perso. Les principales que j'ignore : [liste]. Tu veux corriger quelque chose ?"

### Commandes de gestion du scan

Le dirigeant peut dire en langage naturel :
- "Ignore le groupe Famille" → UPDATE scan_config SET mode = 'ignore' WHERE chat_name LIKE '%Famille%'
- "Écoute les conversations avec Dupont" → UPDATE scan_config SET mode = 'listen'
- "Quelles conversations tu écoutes ?" → SELECT * FROM scan_config WHERE mode != 'ignore' ORDER BY mode

---

## Phase 2d — Capture de documents et media

### Objectif
Intercepter les documents, images et vocaux reçus via WhatsApp, les stocker, extraire leur contenu, et alimenter les tables business.

### Modification du channel WhatsApp

Dans `src/channels/whatsapp.ts` (ajouté par le skill `/add-whatsapp`), modifier le handler de messages pour détecter les media :

```typescript
// Quand un message contient un document/image/audio
if (msg.message?.documentMessage || msg.message?.imageMessage || msg.message?.audioMessage) {
  const buffer = await downloadMediaMessage(msg, 'buffer', {});
  const mediaType = msg.message.documentMessage ? 'document'
    : msg.message.imageMessage ? 'image' : 'audio';
  const filename = msg.message.documentMessage?.fileName
    || `${mediaType}_${Date.now()}`;

  // Stocker le fichier
  const docDir = path.join(GROUPS_DIR, groupFolder, 'documents');
  fs.mkdirSync(docDir, { recursive: true });
  const filePath = path.join(docDir, `${Date.now()}_${filename}`);
  fs.writeFileSync(filePath, buffer);

  // Le message texte inclut une référence au fichier
  const content = `[Document reçu : ${filename}] (stocké à ${filePath})`;
  // Continuer le flow normal avec ce contenu enrichi
}
```

### Extraction de contenu

L'extraction se fait dans le container agent via les skills :

**PDF** : `pdf-parse` ou `pdftotext` (installé dans le Dockerfile)
```bash
pdftotext /workspace/group/documents/facture.pdf -
```

**Images** : Claude Vision (le SDK supporte les images nativement)
— Cartes de visite → extraction nom, entreprise, poste, téléphone, email
— Captures d'écran → OCR du texte visible
— Photos de documents → extraction du contenu

**Vocaux** : API Whisper d'OpenAI ou alternative
```bash
curl -X POST "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@/workspace/group/documents/vocal.ogg" \
  -F model="whisper-1"
```

**Modification du Dockerfile** : Ajouter les dépendances nécessaires :
```dockerfile
RUN apt-get update && apt-get install -y \
    poppler-utils \   # pdftotext
    && rm -rf /var/lib/apt/lists/*
```

### Indexation dans la business.db

Après extraction, le skill de classification :
1. Stocke le document dans la table `documents` avec le texte extrait
2. Analyse le contenu pour alimenter d'autres tables (facture → `invoices`, carte de visite → `contacts`, etc.)
3. Log dans `audit_log`

---

## Phase 3 — Dogfooding

### Objectif
Utiliser le produit soi-même pour gérer HNTIC pendant 3-4 semaines avant tout client externe.

### Setup
- Connecter son propre WhatsApp
- Configurer `scan_config` pour ignorer les conversations perso
- Initialiser la business.db avec les données HNTIC existantes (contacts prospects, deals en cours, échéances)
- Configurer les digests : flash quotidien à 8h, briefing hebdo le lundi à 7h

### Metrics à suivre
- Nombre de messages classifiés correctement vs incorrectement (objectif : >90%)
- Coût API quotidien (Haiku + Sonnet ventilé)
- Temps de réponse moyen de l'agent (objectif : <15 secondes)
- Nombre de corrections demandées par jour
- Utilité perçue des digests (lu ? actionné ?)

### Itérations attendues
- Calibrage des prompts few-shot dans les skills de classification
- Ajustement des seuils de confiance
- Enrichissement du CLAUDE.md avec les patterns spécifiques (noms récurrents, vocabulaire métier)
- Optimisation du routing de modèles (certaines tâches sur Haiku qui devraient être sur Sonnet, ou l'inverse)

---

## Phase 4 — Infrastructure de déploiement

### Script de provisioning (`scripts/deploy-client.sh`)

```bash
#!/bin/bash
# Usage: ./scripts/deploy-client.sh <client_name> <anthropic_api_key> [provider]
# provider: hetzner (default) | scaleway

CLIENT_NAME=$1
API_KEY=$2
PROVIDER=${3:-hetzner}

echo "Provisioning VPS for $CLIENT_NAME on $PROVIDER..."

if [ "$PROVIDER" = "hetzner" ]; then
  # Hetzner Cloud — CX23 (2 vCPU, 4GB RAM, 40GB NVMe, 20TB traffic)
  # Datacenters : nbg1 (Nuremberg), fsn1 (Falkenstein), hel1 (Helsinki)
  # CLI : https://github.com/hetznercloud/cli
  hcloud server create \
    --name "hntic-${CLIENT_NAME}" \
    --type cx23 \
    --image ubuntu-24.04 \
    --location nbg1 \
    --ssh-key hntic-deploy

elif [ "$PROVIDER" = "scaleway" ]; then
  # Scaleway — DEV1-M (3 vCPU, 4GB RAM, 40GB SSD)
  # Datacenters : fr-par-1 (Paris), fr-par-2 (Paris), nl-ams-1 (Amsterdam)
  # CLI : https://github.com/scaleway/scaleway-cli
  scw instance server create \
    name="hntic-${CLIENT_NAME}" \
    type=DEV1-M \
    image=ubuntu_noble \
    zone=fr-par-1
fi

# 2. Setup sur le VPS
ssh root@$VPS_IP << 'REMOTE'
  # Install Docker
  curl -fsSL https://get.docker.com | sh

  # Install Node.js 22
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs

  # Clone le fork HNTIC
  git clone https://github.com/HNTIC/nanoclaw-assistant.git /opt/hntic
  cd /opt/hntic
  npm install

  # Build le container agent
  ./container/build.sh

  # Initialiser la business.db
  bash scripts/init-business-db.sh groups/main/business.db

  # Configurer le service systemd
  cat > /etc/systemd/system/hntic-assistant.service << EOF
[Unit]
Description=HNTIC Assistant
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/hntic
Environment=ANTHROPIC_API_KEY=${API_KEY}
Environment=ASSISTANT_NAME=Assistant
Environment=TZ=Europe/Paris
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  systemctl enable hntic-assistant
  systemctl start hntic-assistant
REMOTE

echo "VPS ready. Connect WhatsApp with: ssh root@$VPS_IP 'cd /opt/hntic && npm run auth'"
```

### Backup automatique

Ajouter un cron sur chaque VPS :

```bash
# /etc/cron.d/hntic-backup
0 3 * * * root tar czf /tmp/hntic-backup-$(date +\%Y\%m\%d).tar.gz /opt/hntic/groups/ /opt/hntic/store/messages.db && \
  # Upload vers stockage externe (Hetzner Object Storage, S3, etc.)
```

### Monitoring

Tâche NanoClaw schedulée (cron toutes les heures) qui envoie un message "heartbeat" à un canal Telegram de monitoring HNTIC. Si le heartbeat ne arrive pas → alerte.

---

## Phase 5 — Onboarding premier client

### Procédure d'onboarding (30-45 min)

1. **Appel préparatoire** (15 min)
   - Explication du concept
   - Recueil des infos initiales : nom, entreprise, secteur, taille, contacts clés, deals en cours, échéances connues

2. **Setup technique** (10 min)
   - Le VPS est déjà provisionné
   - Le client scanne le QR code WhatsApp (screen share)
   - Vérification du message test

3. **Calibration** (15 min)
   - Injection des données initiales dans la business.db
   - Mise à jour du CLAUDE.md avec le contexte spécifique du client
   - Configuration du scan_config (classification auto + validation rapide)
   - Activation des digests

4. **Suivi post-onboarding**
   - J+1 : vérification des logs, correction des premières erreurs de classification
   - J+3 : point rapide WhatsApp avec le client
   - J+7 : premier point formel — qu'est-ce qui marche / manque / agace
   - J+14 : deuxième point — le client revient-il naturellement vers l'assistant ?

---

## Phase 6 — Évolutions futures (backlog)

### Intégration SalesWatch
- SalesWatch comme skill optionnel : l'agent peut appeler les fonctions Exa/Bright Data pour la veille commerciale
- À terme, exposer les données SalesWatch via une API interne que l'agent consomme

### API publique
- Exposer les données business via REST API (Convex ou custom)
- Permet aux clients de connecter d'autres outils (Pipedrive, HubSpot, Pennylane)

### Visualisation de la business.db

**Outil immédiat (dogfooding + premiers clients)** : Datasette — viewer web readonly pour SQLite, zéro code.

```bash
pip install datasette
datasette groups/main/business.db --setting allow_sql true -p 8001
```

Accessible sur `http://localhost:8001`. Vue de toutes les tables, requêtes SQL live, filtres, tri, export CSV. Mobile-friendly. En production, exposer via tunnel SSH ou authentification basique.

Ajouter un script `npm run dashboard` ou `scripts/dashboard.sh` pour lancer automatiquement.

**Évolution ultérieure** : Dashboard web custom (Next.js) avec vue visuelle du pipeline, KPIs, échéances. Pour les clients qui veulent "voir" en plus de "parler".

### OAuth simplifié pour les clients (CRITIQUE avant premier client)

Actuellement, la connexion Gmail/Calendar nécessite que le client aille sur GCP Console — inacceptable pour un dirigeant de PME.

**Solution** : créer UN SEUL projet GCP HNTIC avec un écran de consentement vérifié par Google. Le flux client devient :
1. Otto envoie un lien WhatsApp : "Pour connecter ton Gmail, clique ici"
2. Le client clique → page Google standard "HNTIC veut accéder à votre Gmail" → "Autoriser"
3. Le token est stocké automatiquement sur le VPS du client

**Pré-requis** :
- Projet GCP HNTIC avec écran de consentement vérifié (1-2 semaines de review Google)
- Serveur web ou Cloud Function pour le callback OAuth (peut être hébergé sur un Vercel ou un petit VPS central)
- Scopes : `gmail.modify`, `gmail.settings.basic`, `calendar.readonly`, `calendar.events`
- Le token refresh se fait automatiquement, le client ne refait jamais la manipulation

**Même approche applicable pour** : Google Calendar, Google Drive, Microsoft 365 (Outlook/Calendar).

### Multi-canal
- Ajout de Telegram, Slack, ou email comme canaux alternatifs
- Même agent, même mémoire, plusieurs points d'entrée

### Réduction des coûts API (si nécessaire)
- Explorer des modèles open-source hébergés (Ollama Cloud, etc.) pour les tâches de classification passive si les coûts Haiku deviennent un problème à l'échelle

---

## Pricing et modèle économique

### Coûts par client

| Poste | Estimation mensuelle |
|-------|---------------------|
| VPS Hetzner CX23 (ou Scaleway DEV1-M) | 3,50-7€ |
| API Claude Haiku (scan passif, triage) | 10-30€ |
| API Claude Sonnet (réponses, digests) | 50-120€ |
| API Whisper (vocaux, optionnel) | 5-10€ |
| Total | 70-170€ |

### Pricing client

- **Phase founding members** (5-10 premiers clients) : 500€ HT/mois, engagement 3 mois
- **Phase scaling** :
  - Essentiel (300€/mois) : assistant conversationnel + mémoire business + rappels
  - Premium (600€/mois) : + intelligence commerciale (SalesWatch) + digests proactifs + documents
  - Partenaire (1 000€/mois) : + onboarding sur-mesure + calibration trimestrielle + support prioritaire

### Marge brute cible
70-80% sur les founding members (500€ revenu — 100-150€ coûts = 350-400€ marge)

---

## Sécurité et conformité

### RGPD
- Les données business du client sont stockées sur son VPS dédié (pas de mutualisation)
- Les messages WhatsApp transitent par l'API Anthropic pour le traitement IA — documenter dans les CGV
- Les conversations en mode `ignore` ne sont jamais stockées (drop avant `storeMessage`)
- Le client peut demander l'export ou la suppression de toutes ses données à tout moment

### WhatsApp
- Baileys est une librairie non-officielle qui réplique le protocole WhatsApp Web
- L'utilisation viole techniquement les CGU de WhatsApp
- Tous les acteurs du marché (OpenClaw, NanoClaw, Alyna) prennent ce risque
- Migration vers l'API WhatsApp Business officielle à prévoir si scaling significatif

### Agent SDK
- Usage commercial autorisé via clé API
- Ne pas utiliser d'OAuth token de plan Pro/Max pour les clients
- Maintenir un branding distinct de Claude Code

### Isolation
- Container Docker pour chaque invocation d'agent
- Les credentials ne rentrent jamais dans les containers (credential proxy)
- Filesystem isolé par groupe
- Soft delete systématique + audit_log pour la traçabilité

---

## Notes de revue (Claude, 2026-03-27)

> Ces notes sont des points d'attention identifiés lors de la première lecture de la spec.
> À discuter et trancher avant ou pendant l'implémentation. Rien de bloquant pour démarrer la Phase 1.

### 1. Compatibilité API du Claude Agent SDK

La Phase 2a-bis utilise plusieurs API avancées du SDK (`createSdkMcpServer`, hooks `PostCompact`, `plugins`, `maxBudgetUsd`, `maxTurns`, `resume`). Ces API peuvent avoir évolué depuis l'écriture de la spec. **Action** : avant d'implémenter chaque feature, vérifier l'API réelle dans le code source du SDK installé dans NanoClaw (`node_modules/@anthropic-ai/claude-agent-sdk`) et adapter si nécessaire.

### 2. Knowledge-work-plugins : snapshot vs lien upstream

La stratégie de fork des plugins Anthropic est solide, mais il faut trancher : copie unique (snapshot, on diverge librement) ou maintenance d'un lien upstream (on peut merger les améliorations Anthropic). **Recommandation** : snapshot + adaptation profonde. Les plugins originaux sont conçus pour des connecteurs SaaS (HubSpot, Salesforce, Google Calendar) — notre adaptation vers SQLite + WhatsApp sera trop divergente pour merger facilement. Mieux vaut partir d'un snapshot et évoluer indépendamment.

### 3. Chemin critique et dépendances entre sous-phases

La Phase 2 a 4 sous-phases (2a, 2a-bis, 2b, 2c, 2d) sans dépendances explicites. Voici l'ordre logique :
- **Phase 1** (identité + schéma) — prérequis de tout
- **Phase 2a** (routing modèles) — prérequis de 2c (le scan passif utilise Haiku)
- **Phase 2a-bis** (features SDK) — peut se faire en parallèle, mais le custom tool MCP (business-db) devrait être fait AVANT les skills métier (2b) car les skills en dépendent
- **Phase 2b** (skills métier) — dépend de 2a-bis (custom tool MCP) et Phase 1 (schéma)
- **Phase 2c** (écoute passive) — dépend de 2a (routing) + Phase 1 (scan_config)
- **Phase 2d** (documents/media) — peut se faire en parallèle de 2c

### 4. Accès à business.db : une seule approche

La spec mentionne deux méthodes d'accès à la base :
- Via `sqlite3` en Bash (dans les skills de classification, Phase 2b/2c)
- Via custom tool MCP in-process (Phase 2a-bis)

**Recommandation** : trancher pour le custom tool MCP dès le début. C'est plus sûr (pas d'injection SQL via Bash), plus performant (in-process), et l'audit_log est automatique. Si on commence avec `sqlite3` en Bash pour aller vite, on aura du code à migrer plus tard. Autant partir proprement.

### 5. Fallback du session resume

La spec note que les sessions expirent mais ne détaille pas le fallback. Un dirigeant peut ne pas parler à son assistant pendant plusieurs jours voire semaines. **À prévoir** :
- Détecter l'erreur de resume (session expirée)
- Démarrer une nouvelle session avec injection du CLAUDE.md + derniers relationship_summaries + dernier digest
- Éventuellement, un message de "reprise" : "Ça fait X jours qu'on ne s'est pas parlé. Voici ce qui s'est passé depuis : [résumé des scans passifs]"

### 6. Table `expenses` référence `suppliers` avant sa création

Dans le schéma SQL, la table `expenses` a un `REFERENCES suppliers(id)` mais `suppliers` est définie plus bas dans le fichier. SQLite tolère ça en mode permissif (foreign_keys = OFF par défaut), mais c'est fragile. **Action** : réordonner les CREATE TABLE pour que les tables référencées soient créées avant celles qui les référencent, ou activer `PRAGMA foreign_keys = ON` et ajuster l'ordre.

### 7. Volume de tokens pour l'écoute passive

Un dirigeant actif peut avoir 500+ messages WhatsApp par jour sur 80+ conversations. Même avec Haiku, classifier tout ça toutes les 2 heures peut devenir coûteux. **À surveiller pendant le dogfooding** :
- Nombre moyen de messages par batch
- Coût réel vs estimation (10-30€/mois pour Haiku)
- Possibilité de pré-filtrer côté code (ignorer les messages de moins de 5 mots, les réactions, les messages media-only sans texte) avant d'envoyer à Haiku