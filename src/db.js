const fs = require('fs');
const path = require('path');
// Node's built-in SQLite (stable since Node 24, available from 22.13) — no
// native compilation, so installs work on any machine and any Node release.
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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
  included INTEGER NOT NULL DEFAULT 1,
  slot TEXT NOT NULL DEFAULT 'D',
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
CREATE INDEX IF NOT EXISTS idx_news_week2 ON news(week_start, included);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_news_week ON news(week_start);
CREATE INDEX IF NOT EXISTS idx_issues_week ON issues(week_start);
`);

// Databases created before a column existed get it added in place.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('news', 'included', "included INTEGER NOT NULL DEFAULT 1");
ensureColumn('news', 'slot', "slot TEXT NOT NULL DEFAULT 'D'");
ensureColumn('principal_messages', 'photo', 'photo TEXT');
ensureColumn('principal_messages', 'photo_mailchimp_url', 'photo_mailchimp_url TEXT');
// Showcase content inserted by the "Fill with demo content" button is marked
// so it can be removed again without touching anything staff wrote.
ensureColumn('events', 'is_demo', 'is_demo INTEGER NOT NULL DEFAULT 0');
ensureColumn('news', 'is_demo', 'is_demo INTEGER NOT NULL DEFAULT 0');
ensureColumn('principal_messages', 'is_demo', 'is_demo INTEGER NOT NULL DEFAULT 0');

// The generation schedule moved from Friday 15:00 to Thursday 18:00 -
// databases still carrying the old default follow along; a custom schedule
// someone chose deliberately is left alone.
db.prepare("UPDATE settings SET value = '0 18 * * 4' WHERE key = 'friday_generate_cron' AND value = '0 15 * * 5'").run();

const SETTING_DEFAULTS = {
  timezone: 'Asia/Tbilisi',
  // Reminder to fill in content - every Monday morning
  monday_reminder_cron: '0 9 * * 1',
  // Hard-deadline reminder - Thursday morning, only to those who have not submitted
  thursday_reminder_cron: '0 9 * * 4',
  // Aggregation + Mailchimp draft creation - Thursday 18:00
  friday_generate_cron: '0 18 * * 4',
  // Automatic Monday/Thursday reminders to teachers. Off until individual
  // staff addresses are configured - group addresses cannot be subscribed to
  // a Mailchimp audience, so reminders would never arrive. The manual
  // "Send ... now" buttons keep working either way.
  auto_reminders: '0',
  // Who gets the "draft is ready - please review" email after the scheduled
  // generation (comma-separated addresses; blank = nobody).
  editor_email: '',
  newsletter_name: 'The Roar',
  school_name: 'British International School of Tbilisi',
  from_name: 'British International School of Tbilisi',
  reply_to: '',
  calendar_url: '',
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
// Without ADMIN_PASSWORD set, a random password is generated and printed
// once - there is no well-known default to leave lying around.
//
// On every later start, when ADMIN_EMAIL and ADMIN_PASSWORD are both set,
// that account is re-synced: created if missing, password re-aligned if it
// no longer matches. So the credentials in the host's environment always
// work - even when the very first boot happened before the variables were
// set (common on Railway/Render), and changing ADMIN_PASSWORD + restarting
// is also how a lost admin password is recovered.
function seedAdmin() {
  const { email, name, password } = config.admin;
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const generated = !password;
    const pw = password || require('crypto').randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
      email,
      name,
      bcrypt.hashSync(pw, 10),
      'admin'
    );
    console.log(
      `[db] Created initial admin user ${email}` +
        (generated ? ` with generated password: ${pw}  - log in and change it now.` : '.')
    );
    return;
  }
  if (!password) return;
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!existing) {
    db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
      email,
      name,
      bcrypt.hashSync(password, 10),
      'admin'
    );
    console.log(`[db] Created admin user ${email} from ADMIN_EMAIL / ADMIN_PASSWORD.`);
  } else if (!bcrypt.compareSync(password, existing.password_hash)) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(
      bcrypt.hashSync(password, 10),
      existing.id
    );
    console.log(`[db] Password for ${email} re-synced from ADMIN_PASSWORD.`);
  }
}

module.exports = { db, getSetting, setSetting, allSettings, seedAdmin, SETTING_DEFAULTS };
