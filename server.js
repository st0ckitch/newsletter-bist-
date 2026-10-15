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

const app = createApp();
app.listen(config.port, () => {
  console.log(`[server] Newsletter admin panel running on ${config.appBaseUrl} (port ${config.port})`);
  scheduler.start();
  normalizeOldPhotos().catch((err) => console.error('[uploads] Photo catch-up failed:', err.message));
});
