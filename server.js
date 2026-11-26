const config = require('./src/config');
const { seedAdmin, db } = require('./src/db');
const { createApp } = require('./src/app');
const { normalizePhoto } = require('./src/uploads');
const scheduler = require('./src/scheduler');

seedAdmin();

// One-time catch-up: photos uploaded before uploads were processed get
// turned upright, downsized and stripped of metadata in the background (never
// cropped). Clearing mailchimp_url makes the next generation push the new
// copies to the CDN.
async function normalizeOldPhotos() {
  const rows = db.prepare('SELECT id, filename FROM photos WHERE normalized = 0').all();
  if (!rows.length) return;
  console.log(`[uploads] Processing ${rows.length} older photo(s)...`);
  for (const row of rows) {
    const newName = await normalizePhoto(row.filename);
    db.prepare(
      "UPDATE photos SET filename = ?, mime = 'image/jpeg', normalized = 1, mailchimp_url = NULL WHERE id = ?"
    ).run(newName, row.id);
  }
  console.log('[uploads] Existing photos normalized.');
}

// One-off, asked for on 26 Nov 2026: the Annual Whole School Parents Survey
// goes in the Spotlight (S) of that week's issue, above Join Circle. Runs
// once - if someone moves the story again by hand, that sticks.
function spotlightParentsSurvey() {
  const { getSetting, setSetting } = require('./src/db');
  const key = 'oneoff_spotlight_2026_11_23';
  if (getSetting(key)) return;
  const rows = db
    .prepare("SELECT id FROM news WHERE week_start = '2026-11-23' AND slot = 'W' AND title LIKE '%parent%survey%'")
    .all();
  if (rows.length === 1) {
    db.prepare("UPDATE news SET slot = 'S', updated_at = datetime('now') WHERE id = ?").run(rows[0].id);
  }
  setSetting(key, rows.length === 1 ? `moved ${rows[0].id}` : `${rows.length} matches`);
  console.log(`[layout] Parents survey: ${rows.length === 1 ? 'moved to the Spotlight' : `not moved (${rows.length} matches)`}.`);
}
spotlightParentsSurvey();

const app = createApp();
app.listen(config.port, () => {
  console.log(`[server] Newsletter admin panel running on ${config.appBaseUrl} (port ${config.port})`);
  scheduler.start();
  // Then the storage tidy-up (src/storage.js), which logs where the space goes.
  normalizeOldPhotos()
    .catch((err) => console.error('[uploads] Photo catch-up failed:', err.message))
    .then(() => require('./src/storage').startupTidy())
    // Staff portraits from the school website, the first time only.
    .then(() => require('./src/staff-photos').importOnce());
  require('./src/partners')
    .refreshPartners()
    .catch((err) => console.error('[partners] First read failed:', err.message));
});
