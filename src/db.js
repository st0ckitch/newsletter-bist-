const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary','secondary','principal','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  end_date TEXT,
  time_note TEXT,
  location TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  week_start TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('primary','secondary','whole_school')),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  week_start TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT NOT NULL,
  mailchimp_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS principal_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  quote TEXT,
  quote_author TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  campaign_id TEXT,
  campaign_web_url TEXT,
  html TEXT NOT NULL,
  status TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  week_start TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  recipients TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_week ON events(week_start);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_news_week ON news(week_start);
CREATE INDEX IF NOT EXISTS idx_issues_week ON issues(week_start);
`);

const SETTING_DEFAULTS = {
  timezone: 'Asia/Tbilisi',
  // Reminder to fill in content — every Monday morning
  monday_reminder_cron: '0 9 * * 1',
  // Hard-deadline reminder — Thursday morning, only to those who have not submitted
  thursday_reminder_cron: '0 9 * * 4',
  // Aggregation + Mailchimp draft creation — Friday 15:00
  friday_generate_cron: '0 15 * * 5',
  newsletter_name: 'The Roar',
  school_name: 'British International School of Tbilisi',
  from_name: 'British International School of Tbilisi',
  reply_to: '',
  footer_note: '',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  return SETTING_DEFAULTS[key] !== undefined ? SETTING_DEFAULTS[key] : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function allSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

// First run: create the initial admin account so the panel is reachable.
function seedAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const hash = bcrypt.hashSync(config.admin.password, 10);
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    config.admin.email,
    config.admin.name,
    hash,
    'admin'
  );
  console.log(
    `[db] Created initial admin user ${config.admin.email}` +
      (process.env.ADMIN_PASSWORD ? '' : " with the DEFAULT password 'change-me' — change it immediately.")
  );
}

module.exports = { db, getSetting, setSetting, allSettings, seedAdmin, SETTING_DEFAULTS };
