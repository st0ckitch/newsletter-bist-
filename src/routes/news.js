const express = require('express');
const { db } = require('../db');
const { requireLogin, requireRole, csrfOk, canEditRecord, canManage } = require('../auth');
const { submissionWeekStart } = require('../appweek');
const { CONTENT_SLOTS, DEFAULT_SLOT, SLOT_LABELS, MAX_ARTICLE_WORDS, wordCount } = require('../slots');
const { upload, isRealImage, removeFiles } = require('../uploads');

const router = express.Router();

// Parses the multipart body (multer), then verifies the CSRF token from it
// and that every uploaded file really is an image. On any failure the files
// already written to disk are removed.
function photosUpload(req, res, next) {
  upload.array('photos', 12)(req, res, (err) => {
    const cleanup = () => removeFiles((req.files || []).map((f) => f.filename));
    if (err) {
      cleanup();
      err.status = 400;
      err.expose = true;
      return next(err);
    }
    if (!csrfOk(req)) {
      cleanup();
      return res.status(403).send('Invalid CSRF token. Go back, reload the page and try again.');
    }
    const fake = (req.files || []).find((f) => !isRealImage(f));
    if (fake) {
      cleanup();
      const e = new Error(`"${fake.originalname}" is not a valid image file.`);
      e.status = 400;
      e.expose = true;
      return next(e);
    }
    next();
  });
}

function allowedSections(user) {
  if (canManage(user)) return ['whole_school', 'primary', 'secondary'];
  return [user.role, 'whole_school'];
}

function loadNews(req, res, next) {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  if (!canEditRecord(req.user, item)) {
    return res.status(403).render('error', { message: 'You can only edit news items you created.' });
  }
  req.newsItem = item;
  next();
}

function validate(body, user) {
  const errors = [];
  const title = (body.title || '').trim();
  const bodyText = (body.body || '').trim();
  const section = body.section;
  if (!title) errors.push('Title is required.');
  if (!bodyText) errors.push('The article text is required.');
  const words = wordCount(bodyText);
  if (words > MAX_ARTICLE_WORDS) {
    errors.push(`Article text is limited to ${MAX_ARTICLE_WORDS} words - currently ${words}. Please shorten it.`);
  }
  if (!allowedSections(user).includes(section)) errors.push('Invalid section.');
  // Template placement is the admin's / principal's call.
  const slot = canManage(user) && CONTENT_SLOTS.includes(body.slot) ? body.slot : null;
  return { errors, values: { title, body: bodyText, section, slot } };
}

function savePhotos(newsId, files) {
  const insert = db.prepare('INSERT INTO photos (news_id, filename, original_name, mime) VALUES (?, ?, ?, ?)');
  for (const f of files || []) insert.run(newsId, f.filename, f.originalname, f.mimetype);
}

function formLocals(req, extra) {
  return {
    sections: allowedSections(req.user),
    isManager: canManage(req.user),
    slotLabels: SLOT_LABELS,
    contentSlots: CONTENT_SLOTS,
    maxWords: MAX_ARTICLE_WORDS,
    ...extra,
  };
}

router.get('/news', requireLogin, (req, res) => {
  const weekStart = submissionWeekStart();
  const rows = db
    .prepare(
      `SELECT n.*, u.name AS author, (SELECT COUNT(*) FROM photos p WHERE p.news_id = n.id) AS photo_count
       FROM news n LEFT JOIN users u ON u.id = n.created_by ORDER BY n.created_at DESC LIMIT 100`
    )
    .all();
  res.render('news', { rows, weekStart, isManager: canManage(req.user), slotLabels: SLOT_LABELS, contentSlots: CONTENT_SLOTS });
});

router.get('/news/new', requireLogin, (req, res) => {
  res.render('news_form', formLocals(req, { item: null, photos: [], errors: [] }));
});

router.post('/news', requireLogin, photosUpload, (req, res) => {
  const { errors, values } = validate(req.body, req.user);
  if (errors.length) {
    removeFiles((req.files || []).map((f) => f.filename));
    return res.status(400).render('news_form', formLocals(req, { item: values, photos: [], errors }));
  }
  const info = db
    .prepare('INSERT INTO news (title, body, section, slot, created_by, week_start) VALUES (?, ?, ?, ?, ?, ?)')
    .run(values.title, values.body, values.section, values.slot || DEFAULT_SLOT, req.user.id, submissionWeekStart());
  savePhotos(info.lastInsertRowid, req.files);
  res.redirect('/news');
});

router.get('/news/:id/edit', requireLogin, loadNews, (req, res) => {
  const photos = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(req.newsItem.id);
  res.render('news_form', formLocals(req, { item: req.newsItem, photos, errors: [] }));
});

router.post('/news/:id', requireLogin, loadNews, photosUpload, (req, res) => {
  const { errors, values } = validate(req.body, req.user);
  if (errors.length) {
    removeFiles((req.files || []).map((f) => f.filename));
    const photos = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(req.newsItem.id);
    return res
      .status(400)
      .render('news_form', formLocals(req, { item: { ...values, id: req.newsItem.id }, photos, errors }));
  }
  db.prepare(
    "UPDATE news SET title = ?, body = ?, section = ?, slot = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(values.title, values.body, values.section, values.slot || req.newsItem.slot || DEFAULT_SLOT, req.newsItem.id);
  savePhotos(req.newsItem.id, req.files);
  res.redirect(`/news/${req.newsItem.id}/edit`);
});

// Admin curation: choose whether an article makes this week's issue.
router.post('/news/:id/include', requireRole('principal', 'admin'), (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  db.prepare('UPDATE news SET included = ? WHERE id = ?').run(req.body.included === '1' ? 1 : 0, item.id);
  res.redirect('/news');
});

// Admin placement: move an article to another template section.
router.post('/news/:id/slot', requireRole('principal', 'admin'), (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  if (!CONTENT_SLOTS.includes(req.body.slot)) {
    return res.status(400).render('error', { message: 'Invalid template section.' });
  }
  db.prepare('UPDATE news SET slot = ? WHERE id = ?').run(req.body.slot, item.id);
  res.redirect('/news');
});

router.post('/news/:id/delete', requireLogin, loadNews, (req, res) => {
  const files = db.prepare('SELECT filename FROM photos WHERE news_id = ?').all(req.newsItem.id);
  db.prepare('DELETE FROM news WHERE id = ?').run(req.newsItem.id);
  removeFiles(files.map((f) => f.filename));
  res.redirect('/news');
});

router.post('/photos/:id/delete', requireLogin, (req, res) => {
  const photo = db.prepare('SELECT p.*, n.created_by FROM photos p JOIN news n ON n.id = p.news_id WHERE p.id = ?').get(req.params.id);
  if (!photo) return res.status(404).render('error', { message: 'Photo not found.' });
  if (!canEditRecord(req.user, photo)) {
    return res.status(403).render('error', { message: 'You can only delete photos from your own news items.' });
  }
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  removeFiles([photo.filename]);
  res.redirect(`/news/${photo.news_id}/edit`);
});

module.exports = router;
