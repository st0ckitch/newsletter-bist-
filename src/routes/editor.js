// Live-editor API behind the preview: inline text edits and photo
// add/replace/remove, used by public/js/preview-editor.js. Manager-only.
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, getSetting, setSetting } = require('../db');
const { requireLayout, csrfOk } = require('../auth');
const { upload, isRealImage, removeFiles } = require('../uploads');
const { MAX_ARTICLE_WORDS, wordCount, CONTENT_SLOTS, DEFAULT_SLOT } = require('../slots');
const { isValidDateStr } = require('../week');

const router = express.Router();
const manager = requireLayout;

const bad = (res, error, status = 400) => res.status(status).json({ ok: false, error });

// Parses one uploaded photo, verifies CSRF (header or field) and that the
// file really is an image; cleans up on any failure.
function photoUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    const cleanup = () => removeFiles(req.file ? [req.file.filename] : []);
    if (err) {
      cleanup();
      return bad(res, err.message);
    }
    if (!csrfOk(req)) {
      cleanup();
      return bad(res, 'Your session expired - reload the page and try again.', 403);
    }
    if (!req.file) return bad(res, 'No photo was uploaded.');
    if (!isRealImage(req.file)) {
      cleanup();
      return bad(res, `"${req.file.originalname}" is not a valid image file.`);
    }
    next();
  });
}

/* ---------------- text ---------------- */

const TEXT_TARGETS = {
  news: {
    fields: {
      title: { required: true, max: 200 },
      body: { required: true, words: MAX_ARTICLE_WORDS },
    },
    load: (id) => db.prepare('SELECT * FROM news WHERE id = ?').get(id),
    save: (id, field, value) =>
      db.prepare(`UPDATE news SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id),
  },
  event: {
    fields: {
      title: { required: true, max: 200 },
      location: { required: false, max: 120 },
      time_note: { required: false, max: 60 },
    },
    load: (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id),
    save: (id, field, value) => db.prepare(`UPDATE events SET ${field} = ? WHERE id = ?`).run(value, id),
  },
  principal: {
    fields: { body: { required: true } },
    load: (week) => (isValidDateStr(week) ? db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(week) : null),
    save: (week, field, value) =>
      db.prepare(`UPDATE principal_messages SET ${field} = ?, updated_at = datetime('now') WHERE week_start = ?`).run(value, week),
  },
  quote: {
    fields: { text: { required: true, max: 300, column: 'quote' }, author: { required: false, max: 100, column: 'quote_author' } },
    load: (week) => (isValidDateStr(week) ? db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(week) : null),
    save: (week, field, value, column) =>
      db.prepare(`UPDATE principal_messages SET ${column} = ?, updated_at = datetime('now') WHERE week_start = ?`).run(value, week),
  },
};

router.post('/api/edit/text', manager, (req, res) => {
  const { target, value } = req.body || {};
  const [kind, ref, field] = String(target || '').split(':');
  const spec = TEXT_TARGETS[kind];
  const fieldSpec = spec && spec.fields[field];
  if (!fieldSpec) return bad(res, 'Unknown edit target.');
  const row = spec.load(ref);
  if (!row) return bad(res, 'That item no longer exists - reload the preview.', 404);

  const text = String(value ?? '').trim();
  if (fieldSpec.required && !text) return bad(res, 'This text cannot be empty.');
  if (fieldSpec.max && text.length > fieldSpec.max) return bad(res, `Keep it under ${fieldSpec.max} characters.`);
  if (fieldSpec.words) {
    const words = wordCount(text);
    if (words > fieldSpec.words) return bad(res, `Article text is limited to ${fieldSpec.words} words - currently ${words}.`);
  }
  spec.save(ref, field, text || null, fieldSpec.column);
  res.json({ ok: true });
});

/* ---------------- section drag-and-drop ---------------- */

// Move an article to another template section (D-I). A true section swap:
// whatever already lives in the target section takes the dragged article's
// old place, so dragging section E onto G exchanges the two.
router.post('/api/edit/slot', manager, (req, res) => {
  const { news_id, slot } = req.body || {};
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(news_id);
  if (!item) return bad(res, 'That article no longer exists - reload the preview.', 404);
  if (!CONTENT_SLOTS.includes(slot)) return bad(res, 'Unknown template section.');
  const from = item.slot || DEFAULT_SLOT;
  if (from !== slot) {
    db.prepare(
      "UPDATE news SET slot = ?, updated_at = datetime('now') WHERE week_start = ? AND slot = ? AND id != ?"
    ).run(from, item.week_start, slot, item.id);
    db.prepare("UPDATE news SET slot = ?, updated_at = datetime('now') WHERE id = ?").run(slot, item.id);
  }
  res.json({ ok: true });
});

/* ---------------- photos ---------------- */

router.post('/api/edit/photo/add', manager, photoUpload, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.body.news_id);
  if (!item) {
    removeFiles([req.file.filename]);
    return bad(res, 'That article no longer exists.', 404);
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE news_id = ?').get(item.id).c;
  if (count >= 12) {
    removeFiles([req.file.filename]);
    return bad(res, 'An article can hold at most 12 photos.');
  }
  db.prepare('INSERT INTO photos (news_id, filename, original_name, mime) VALUES (?, ?, ?, ?)').run(
    item.id,
    req.file.filename,
    req.file.originalname,
    req.file.mimetype
  );
  res.json({ ok: true });
});

router.post('/api/edit/photo/replace', manager, photoUpload, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.body.photo_id);
  if (!photo) {
    removeFiles([req.file.filename]);
    return bad(res, 'That photo no longer exists.', 404);
  }
  // Same row keeps its position in the article; the CDN copy is re-uploaded
  // on the next generation.
  db.prepare('UPDATE photos SET filename = ?, original_name = ?, mime = ?, mailchimp_url = NULL WHERE id = ?').run(
    req.file.filename,
    req.file.originalname,
    req.file.mimetype,
    photo.id
  );
  removeFiles([photo.filename]);
  res.json({ ok: true });
});

router.post('/api/edit/photo/delete', manager, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get((req.body || {}).photo_id);
  if (!photo) return bad(res, 'That photo no longer exists.', 404);
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  removeFiles([photo.filename]);
  res.json({ ok: true });
});

function loadWeekMessage(week) {
  return isValidDateStr(week) ? db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(week) : null;
}

router.post('/api/edit/principal-photo', manager, photoUpload, (req, res) => {
  const pm = loadWeekMessage(req.body.week);
  if (!pm) {
    removeFiles([req.file.filename]);
    return bad(res, "Write the principal's message first, then add the portrait.", 404);
  }
  if (pm.photo) removeFiles([pm.photo]);
  db.prepare('UPDATE principal_messages SET photo = ?, photo_mailchimp_url = NULL WHERE id = ?').run(req.file.filename, pm.id);
  res.json({ ok: true });
});

// Masthead background image (behind "THE ROAR"), stored as a setting.
router.post('/api/edit/masthead-photo', manager, photoUpload, (req, res) => {
  const old = getSetting('masthead_photo');
  if (old) removeFiles([old]);
  setSetting('masthead_photo', req.file.filename);
  setSetting('masthead_photo_mailchimp_url', '');
  setSetting('masthead_is_demo', '');
  res.json({ ok: true });
});

router.post('/api/edit/masthead-photo/delete', manager, (req, res) => {
  const old = getSetting('masthead_photo');
  if (!old) return bad(res, 'There is no background image to remove.', 404);
  removeFiles([old]);
  setSetting('masthead_photo', '');
  setSetting('masthead_photo_mailchimp_url', '');
  setSetting('masthead_is_demo', '');
  res.json({ ok: true });
});

router.post('/api/edit/principal-photo/delete', manager, (req, res) => {
  const pm = loadWeekMessage((req.body || {}).week);
  if (!pm || !pm.photo) return bad(res, 'There is no portrait to remove.', 404);
  removeFiles([pm.photo]);
  db.prepare('UPDATE principal_messages SET photo = NULL, photo_mailchimp_url = NULL WHERE id = ?').run(pm.id);
  res.json({ ok: true });
});

module.exports = router;
