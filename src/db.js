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
-- Roles and content areas are validated in the application (src/roles.js,
-- src/sections.js) rather than by CHECK constraints: the school changes them
-- from time to time and a constraint would mean rebuilding the table on
-- every change.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  section TEXT,
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
  section TEXT NOT NULL,
  included INTEGER NOT NULL DEFAULT 1,
  slot TEXT NOT NULL DEFAULT 'D',
  review_status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT,
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
  warnings TEXT NOT NULL DEFAULT '[]',
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT
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

CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

`);

// Databases created before a column existed get it added in place.
// Returns true when the column was actually added, so callers can back-fill.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

// SQLite cannot drop a CHECK constraint in place. The original schema pinned
// the list of roles and content areas into CHECK clauses; the school has
// since added Sixth Form, Co-Curricular and the SLT/marketing roles, so
// databases still carrying those constraints are rebuilt once, without them.
// Columns are matched by name, so this runs after the ensureColumn calls.
// Removes every CHECK clause from a CREATE TABLE statement. The clauses
// contain nested parentheses - CHECK (role IN ('a','b')) - so this walks the
// text balancing parens rather than trusting a regex.
function stripCheckClauses(sql) {
  let out = sql;
  for (;;) {
    const m = /\bCHECK\s*\(/i.exec(out);
    if (!m) return out;
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < out.length; i++) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`Unbalanced CHECK clause while rebuilding: ${sql}`);
    out = out.slice(0, m.index).replace(/\s+$/, ' ') + out.slice(end + 1);
  }
}

function dropCheckConstraints(table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || !/\bCHECK\s*\(/i.test(row.sql)) return;
  const tmp = `${table}__rebuild`;
  const rebuilt = stripCheckClauses(row.sql).replace(
    new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'),
    `CREATE TABLE ${tmp}`
  );
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(rebuilt);
    const newCols = db.prepare(`PRAGMA table_info(${tmp})`).all().map((c) => c.name);
    const oldCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const shared = newCols.filter((c) => oldCols.includes(c)).join(', ');
    db.exec(`INSERT INTO ${tmp} (${shared}) SELECT ${shared} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
    db.exec('COMMIT');
    console.log(`[db] Rebuilt "${table}" without its CHECK constraint (roles/areas are validated in the app).`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
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

// SLT sign-off on stories, and the principal's approval of the whole issue.
ensureColumn('users', 'section', 'section TEXT');
// Invited accounts: created without a password (password_hash = ''), then
// activated through a personal /invite/<token> link sent by email. Only a
// SHA-256 of the token is stored, so the database never holds a live link.
ensureColumn('users', 'invite_token_hash', 'invite_token_hash TEXT');
ensureColumn('users', 'invite_sent_at', 'invite_sent_at TEXT');
// Activation/usage visibility: when the person set their password through
// their invite link, and when they last signed in.
ensureColumn('users', 'activated_at', 'activated_at TEXT');
ensureColumn('users', 'last_login_at', 'last_login_at TEXT');
ensureColumn('photos', 'normalized', 'normalized INTEGER NOT NULL DEFAULT 0');
ensureColumn('news', 'lead_photo', 'lead_photo TEXT');
ensureColumn('news', 'lead_photo_mailchimp_url', 'lead_photo_mailchimp_url TEXT');
// Foundation moved from its own full-width band (V) into the right column.
db.exec("UPDATE news SET slot = 'E' WHERE slot = 'V'");
ensureColumn('news', 'reviewed_by', 'reviewed_by INTEGER');
ensureColumn('news', 'reviewed_at', 'reviewed_at TEXT');
ensureColumn('news', 'review_note', 'review_note TEXT');
ensureColumn('issues', 'approved_by', 'approved_by INTEGER');
ensureColumn('issues', 'approved_at', 'approved_at TEXT');
if (ensureColumn('news', 'review_status', "review_status TEXT NOT NULL DEFAULT 'pending'")) {
  // Stories that existed before reviewing was introduced were already live -
  // treat them as checked rather than hiding them from the next issue.
  db.prepare("UPDATE news SET review_status = 'approved'").run();
}

dropCheckConstraints('users');
dropCheckConstraints('news');
// Indexes are created only here, AFTER the column migrations (idx_news_week2
// covers a column that old databases gain via ensureColumn) and after any
// table rebuild (which drops the old table's indexes with it).
db.exec(`
CREATE INDEX IF NOT EXISTS idx_events_week ON events(week_start);
CREATE INDEX IF NOT EXISTS idx_news_week2 ON news(week_start, included);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_news_week ON news(week_start);
CREATE INDEX IF NOT EXISTS idx_issues_week ON issues(week_start);
`);

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
  } else if (!existing.password_hash || !bcrypt.compareSync(password, existing.password_hash)) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(
      bcrypt.hashSync(password, 10),
      existing.id
    );
    console.log(`[db] Password for ${email} re-synced from ADMIN_PASSWORD.`);
  }
}

module.exports = { db, getSetting, setSetting, allSettings, seedAdmin, SETTING_DEFAULTS, stripCheckClauses, dropCheckConstraints };
