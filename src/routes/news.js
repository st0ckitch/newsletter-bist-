const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');
const { requireLogin, csrfOk, canEditRecord, canManage } = require('../auth');
const { submissionWeekStart } = require('../appweek');

const router = express.Router();

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + MIME_EXT[file.mimetype]),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (MIME_EXT[file.mimetype]) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP or GIF images can be uploaded.'));
  },
});

// Magic-byte check so a renamed non-image (or spoofed Content-Type) is
// rejected regardless of what the client claims.
const MAGIC_CHECKS = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

function isRealImage(file) {
  try {
    const fd = fs.openSync(path.join(config.uploadDir, file.filename), 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const check = MAGIC_CHECKS[file.mimetype];
    return Boolean(check && check(buf));
  } catch {
    return false;
  }
}

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
  if (!allowedSections(user).includes(section)) errors.push('Invalid section.');
  return { errors, values: { title, body: bodyText, section } };
}

function savePhotos(newsId, files) {
  const insert = db.prepare('INSERT INTO photos (news_id, filename, original_name, mime) VALUES (?, ?, ?, ?)');
  for (const f of files || []) insert.run(newsId, f.filename, f.originalname, f.mimetype);
}

function removeFiles(filenames) {
  for (const name of filenames) {
    fs.unlink(path.join(config.uploadDir, name), (err) => {
      if (err && err.code !== 'ENOENT') console.error('[news] Could not delete photo file:', err.message);
    });
  }
}

router.get('/news', requireLogin, (req, res) => {
  const weekStart = submissionWeekStart();
  const rows = db
    .prepare(
      `SELECT n.*, u.name AS author, (SELECT COUNT(*) FROM photos p WHERE p.news_id = n.id) AS photo_count
       FROM news n LEFT JOIN users u ON u.id = n.created_by ORDER BY n.created_at DESC LIMIT 100`
    )
    .all();
  res.render('news', { rows, weekStart });
});

router.get('/news/new', requireLogin, (req, res) => {
  res.render('news_form', { item: null, photos: [], errors: [], sections: allowedSections(req.user) });
});

router.post('/news', requireLogin, photosUpload, (req, res) => {
  const { errors, values } = validate(req.body, req.user);
  if (errors.length) {
    removeFiles((req.files || []).map((f) => f.filename));
    return res.status(400).render('news_form', { item: values, photos: [], errors, sections: allowedSections(req.user) });
  }
  const info = db
    .prepare('INSERT INTO news (title, body, section, created_by, week_start) VALUES (?, ?, ?, ?, ?)')
    .run(values.title, values.body, values.section, req.user.id, submissionWeekStart());
  savePhotos(info.lastInsertRowid, req.files);
  res.redirect('/news');
});

router.get('/news/:id/edit', requireLogin, loadNews, (req, res) => {
  const photos = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(req.newsItem.id);
  res.render('news_form', { item: req.newsItem, photos, errors: [], sections: allowedSections(req.user) });
});

router.post('/news/:id', requireLogin, loadNews, photosUpload, (req, res) => {
  const { errors, values } = validate(req.body, req.user);
  if (errors.length) {
    removeFiles((req.files || []).map((f) => f.filename));
    const photos = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(req.newsItem.id);
    return res
      .status(400)
      .render('news_form', { item: { ...values, id: req.newsItem.id }, photos, errors, sections: allowedSections(req.user) });
  }
  db.prepare("UPDATE news SET title = ?, body = ?, section = ?, updated_at = datetime('now') WHERE id = ?").run(
    values.title,
    values.body,
    values.section,
    req.newsItem.id
  );
  savePhotos(req.newsItem.id, req.files);
  res.redirect(`/news/${req.newsItem.id}/edit`);
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
