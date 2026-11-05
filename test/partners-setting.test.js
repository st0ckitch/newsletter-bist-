// Partners per issue: 10 by default since every partner in each issue made the
// email too big for Gmail. Booting moves a database on the old default (8),
// on all of them (0) or on more than 15 to 10 - once; a number chosen after
// that is left alone. (A singleton module, so each boot is a child process.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

function boot(dataDir) {
  execFileSync(process.execPath, ['-e', "require('./src/db.js')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: '', MAILCHIMP_API_KEY: '' },
  });
}
const setting = (dbPath, key) => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  return row ? row.value : null;
};
const store = (dbPath, value, { reviewed } = {}) => {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('partners_per_issue', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(value);
  if (!reviewed) db.prepare("DELETE FROM settings WHERE key = 'partners_per_issue_reviewed'").run();
  db.close();
};

for (const [before, after] of [['0', '10'], ['8', '10'], ['34', '10'], ['12', '12'], ['4', '4']]) {
  test(`partners per issue: a database on ${before} boots with ${after}`, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-partners-'));
    const dbPath = path.join(dataDir, 'newsletter.sqlite');
    boot(dataDir); // a new database
    store(dbPath, before); // as an older database left it
    boot(dataDir);
    assert.strictEqual(setting(dbPath, 'partners_per_issue'), after);
    // Chosen again afterwards, even "all of them", it stays.
    store(dbPath, '0', { reviewed: true });
    boot(dataDir);
    assert.strictEqual(setting(dbPath, 'partners_per_issue'), '0');
  });
}

test('partners per issue: a new database shows 10', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-partners-'));
  boot(dataDir);
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/db.js').getSetting('partners_per_issue')))"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, ADMIN_PASSWORD: '', MAILCHIMP_API_KEY: '' },
  }).toString();
  assert.strictEqual(out, '10');
});
