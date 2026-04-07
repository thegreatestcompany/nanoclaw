-- ======================
-- HNTIC Business Schema
-- ======================
-- Base de données business pour l'assistant IA du dirigeant de PME.
-- Toutes les tables utilisent le soft delete (deleted_at) et l'audit_log.

PRAGMA foreign_keys = ON;

-- CRM

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

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  company_id TEXT REFERENCES companies(id),
  role TEXT,
  phone TEXT,
  email TEXT,
  relationship_type TEXT DEFAULT 'prospect', -- prospect, client, partner, supplier, advisor, investor, team, personal
  source TEXT, -- whatsapp, manual, scan, document
  linkedin_url TEXT,
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
  source TEXT, -- referral, inbound, cold, event, partner
  loss_reason TEXT, -- price, timing, competitor, no_budget, no_decision, other
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  phone TEXT,
  manager_id TEXT REFERENCES team_members(id),
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

-- suppliers AVANT expenses (expenses référence suppliers)
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  category TEXT, -- accounting, legal, insurance, it, banking, other
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  contract_end_date TEXT,
  annual_cost REAL,
  rating INTEGER, -- 1-5 satisfaction score
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

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
  payment_method TEXT, -- transfer, check, card, cash, direct_debit
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

-- RECRUTEMENT

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  stage TEXT DEFAULT 'sourced', -- sourced, screening, interview, offer, hired, rejected, withdrawn
  source TEXT, -- referral, linkedin, job_board, agency, internal
  email TEXT,
  phone TEXT,
  linkedin_url TEXT,
  resume_path TEXT,
  current_company TEXT,
  salary_expectation REAL,
  interviewer TEXT,
  rejection_reason TEXT,
  notes TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- CLAUSES CONTRACTUELLES

CREATE TABLE IF NOT EXISTS contract_clauses (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  contract_id TEXT REFERENCES contracts(id),
  clause_type TEXT NOT NULL, -- liability, termination, non_compete, confidentiality, payment, ip, indemnity, force_majeure, other
  title TEXT,
  summary TEXT NOT NULL,
  risk_level TEXT DEFAULT 'low', -- low, medium, high, critical
  original_text TEXT,
  notes TEXT,
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

-- PENDING UPDATES (mises à jour détectées par le scan passif, en attente de validation)

CREATE TABLE IF NOT EXISTS pending_updates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  target_table TEXT NOT NULL,  -- contacts, deals, invoices, etc.
  target_id TEXT NOT NULL,     -- ID de l'enregistrement à modifier
  field_name TEXT NOT NULL,    -- champ à modifier
  old_value TEXT,              -- valeur actuelle (au moment de la détection)
  new_value TEXT NOT NULL,     -- valeur proposée
  source_chat_jid TEXT,        -- conversation d'où vient l'info
  source_message TEXT,         -- extrait du message source
  confidence REAL DEFAULT 0.8, -- score de confiance (0-1)
  status TEXT DEFAULT 'pending', -- pending, applied, dismissed
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_updates_status ON pending_updates(status);

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
CREATE INDEX IF NOT EXISTS idx_candidates_stage ON candidates(stage);
CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position);
CREATE INDEX IF NOT EXISTS idx_contract_clauses_contract ON contract_clauses(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_clauses_risk ON contract_clauses(risk_level);
