// The production database was born with the v1 schema - CHECK constraints
// pinning roles/sections, no review or invite columns. Booting src/db.js must
// migrate it in place: this builds such a database, runs the migrations in a
// child process (a singleton module cannot be re-required), and verifies the
// new roles and areas actually insert afterwards. Regression for the 500 on
// /users/import: the old CHECK clauses nest parentheses and survived a
// regex-based strip.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

test('booting migrates a v1 database: CHECK constraints gone, new roles/areas insert', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roar-migrate-'));
  const dbPath = path.join(dataDir, 'newsletter.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('primary','secondary','principal','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      section TEXT NOT NULL CHECK (section IN ('primary','secondary','whole_school')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      week_start TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (email, name, password_hash, role) VALUES ('old.teacher@bist.ge', 'Old Teacher', 'hash', 'primary');
    INSERT INTO news (title, body, section, created_by, week_start) VALUES ('Old Story', 'Body', 'primary', 1, '2026-08-24');
  `);
  old.close();

  // Boot the app's database module against it - runs every migration.
  execFileSync(process.execPath, ['-e', "require('./src/db.js')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: '', MAILCHIMP_API_KEY: '' },
  });

  const db = new DatabaseSync(dbPath);
  for (const table of ['users', 'news']) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table).sql;
    assert.ok(!/\bCHECK\s*\(/i.test(sql), `${table} still carries a CHECK constraint: ${sql}`);
  }
  // Old data survived, new columns exist with sane values.
  const teacher = db.prepare("SELECT * FROM users WHERE email = 'old.teacher@bist.ge'").get();
  assert.strictEqual(teacher.role, 'primary');
  const story = db.prepare("SELECT * FROM news WHERE title = 'Old Story'").get();
  assert.strictEqual(story.review_status, 'approved', 'pre-existing stories count as checked');
  // The exact inserts that 500ed in production now work.
  db.prepare("INSERT INTO users (email, name, password_hash, role, section) VALUES ('new.staff@bist.ge', 'New Staff', '', 'staff', NULL)").run();
  db.prepare("INSERT INTO users (email, name, password_hash, role, section) VALUES ('new.slt@bist.ge', 'New SLT', '', 'slt', 'sixth_form')").run();
  db.prepare("INSERT INTO news (title, body, section, week_start, review_status) VALUES ('Sixth Form Story', 'Body', 'sixth_form', '2026-08-31', 'pending')").run();
  db.prepare("INSERT INTO news (title, body, section, week_start, review_status) VALUES ('Club Story', 'Body', 'co_curricular', '2026-08-31', 'pending')").run();
  // Rebuild recreated the news indexes.
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='news' AND name LIKE 'idx%'").all();
  assert.ok(indexes.length >= 2, 'news indexes recreated after the rebuild');
  // Booting again must be a no-op (no CHECK left to trigger a rebuild).
  db.close();
  execFileSync(process.execPath, ['-e', "require('./src/db.js')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: '', MAILCHIMP_API_KEY: '' },
  });
  const again = new DatabaseSync(dbPath);
  assert.strictEqual(again.prepare("SELECT COUNT(*) c FROM users").get().c, 3);
  again.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('stripCheckClauses removes nested-paren CHECKs and nothing else', () => {
  process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'roar-strip-'));
  const { stripCheckClauses } = require('../src/db');
  const sql = "CREATE TABLE t (a TEXT CHECK (a IN ('x','y')), b TEXT NOT NULL CHECK(length(b) > (1+2)), c INTEGER)";
  const out = stripCheckClauses(sql);
  assert.ok(!/CHECK/i.test(out));
  assert.match(out, /a TEXT ,/);
  assert.match(out, /b TEXT NOT NULL ,/);
  assert.match(out, /c INTEGER\)/);
});
