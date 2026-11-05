// Partners per issue: every partner in every issue by default (0). Booting
// moves a database on the old default (8), or on the 10 a short-lived update
// set, back to all of them - once; any other number, and a number chosen after
// that, is left alone. (A singleton module, so each boot is a child process.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ENV = (dataDir) => ({ ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: '', MAILCHIMP_API_KEY: '' });
const boot = (dataDir, code = "require('./src/db.js')") =>
  execFileSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: ENV(dataDir) }).toString();
const setting = (dbPath, key) => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : null;
};
const store = (dbPath, value, { migrated } = {}) => {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('partners_per_issue', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(value);
  if (!migrated) db.prepare("DELETE FROM settings WHERE key = 'partners_per_issue_all'").run();
  db.close();
};

for (const [before, after] of [['8', '0'], ['10', '0'], ['0', '0'], ['12', '12'], ['4', '4']]) {
  test(`partners per issue: a database on ${before} boots with ${after}`, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-partners-'));
    const dbPath = path.join(dataDir, 'newsletter.sqlite');
    boot(dataDir); // a new database
    store(dbPath, before); // as an older database left it
    boot(dataDir);
    assert.strictEqual(setting(dbPath, 'partners_per_issue'), after);
    // A number chosen afterwards - even 10 - stays.
    store(dbPath, '10', { migrated: true });
    boot(dataDir);
    assert.strictEqual(setting(dbPath, 'partners_per_issue'), '10');
  });
}

test('partners per issue: a new database shows every partner', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-partners-'));
  assert.strictEqual(boot(dataDir, "process.stdout.write(String(require('./src/db.js').getSetting('partners_per_issue')))"), '0');
});
