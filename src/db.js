const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  website TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  brand_color TEXT DEFAULT '#4B2A8A',
  address TEXT DEFAULT '',
  signature_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  secure INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 150,
  delay_seconds INTEGER NOT NULL DEFAULT 5,
  ramp_up INTEGER NOT NULL DEFAULT 1,
  sig_name TEXT DEFAULT '',
  sig_title TEXT DEFAULT '',
  sig_phone TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT DEFAULT '',
  sent_date TEXT DEFAULT '',
  sent_today INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(company_id, name)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  consent_source TEXT DEFAULT '',
  consent_at TEXT,
  token TEXT NOT NULL UNIQUE,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(company_id, email)
);

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  mailbox_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_campaign ON messages(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_msg_mailbox ON messages(mailbox_id, status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  url TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ev_campaign ON events(campaign_id, type);
CREATE INDEX IF NOT EXISTS idx_ev_message ON events(message_id, type);
`);

module.exports = db;
