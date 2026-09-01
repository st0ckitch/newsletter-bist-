const express = require('express');
const { db } = require('../db');
const { requireLogin, requireLayout, requireReviewer, csrfOk, canEditRecord, canManage } = require('../auth');
const { canReviewSection, isReviewer, canLayout } = require('../roles');
const { SECTION_KEYS, SECTIONS, isSection } = require('../sections');
const { submissionWeekStart } = require('../appweek');
const { CONTENT_SLOTS, DEFAULT_SLOT, SLOT_LABELS, MAX_ARTICLE_WORDS, wordCount } = require('../slots');
const { upload, isRealImage, removeFiles } = require('../uploads');
const { renderArticlePreview } = require('../newsletter');

const router = express.Router();

// Live preview beside the news form: the draft article rendered with the
// real newsletter template. Reads title/body/photos (data URIs of the
// selected files) from JSON; nothing is stored.
router.post('/news/preview.html', requireLogin, (req, res) => {
  const { title, body, sectionLabel, photos } = req.body || {};
  res.type('html').send(renderArticlePreview({ title, body, sectionLabel, photos }));
});

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

// Every member of staff can write for any area - the SLT member responsible
// for that area checks the story before it reaches the newsletter.
function allowedSections() {
  return SECTION_KEYS;
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
  if (!isSection(section)) errors.push('Choose the area this story belongs to.');
  // Template placement belongs to whoever lays the issue out.
  const slot = canLayout(user) && CONTENT_SLOTS.includes(body.slot) ? body.slot : null;
  return { errors, values: { title, body: bodyText, section, slot } };
}

function savePhotos(newsId, files) {
  const insert = db.prepare('INSERT INTO photos (news_id, filename, original_name, mime) VALUES (?, ?, ?, ?)');
  for (const f of files || []) insert.run(newsId, f.filename, f.originalname, f.mimetype);
}

function formLocals(req, extra) {
  return {
    sections: allowedSections(),
    sectionLabels: SECTIONS,
    isManager: canLayout(req.user),
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
      `SELECT n.*, u.name AS author, r.name AS reviewer,
              (SELECT COUNT(*) FROM photos p WHERE p.news_id = n.id) AS photo_count
       FROM news n
       LEFT JOIN users u ON u.id = n.created_by
       LEFT JOIN users r ON r.id = n.reviewed_by
       ORDER BY n.created_at DESC LIMIT 100`
    )
    .all()
    .map((n) => ({ ...n, canReview: canReviewSection(req.user, n.section) }));
  res.render('news', {
    rows,
    weekStart,
    isManager: canLayout(req.user),
    isReviewer: isReviewer(req.user),
    sectionLabels: SECTIONS,
    slotLabels: SLOT_LABELS,
    contentSlots: CONTENT_SLOTS,
  });
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
  // A story written by the person who would check it needs no second look.
  const selfChecked = canReviewSection(req.user, values.section);
  const info = db
    .prepare(
      `INSERT INTO news (title, body, section, slot, review_status, reviewed_by, reviewed_at, created_by, week_start)
       VALUES (?, ?, ?, ?, ?, ?, ${selfChecked ? "datetime('now')" : 'NULL'}, ?, ?)`
    )
    .run(
      values.title,
      values.body,
      values.section,
      values.slot || DEFAULT_SLOT,
      selfChecked ? 'approved' : 'pending',
      selfChecked ? req.user.id : null,
      req.user.id,
      submissionWeekStart()
    );
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
  // Rewriting a checked story sends it back for review, unless the person
  // editing is the one who would check it anyway.
  const recheck = req.newsItem.review_status === 'approved' && !canReviewSection(req.user, values.section);
  db.prepare(
    `UPDATE news SET title = ?, body = ?, section = ?, slot = ?, updated_at = datetime('now')
     ${recheck ? ", review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL" : ''}
     WHERE id = ?`
  ).run(values.title, values.body, values.section, values.slot || req.newsItem.slot || DEFAULT_SLOT, req.newsItem.id);
  savePhotos(req.newsItem.id, req.files);
  res.redirect(`/news/${req.newsItem.id}/edit`);
});

// SLT sign-off: each SLT member checks the stories in their own area
// (whole-school stories can be checked by any of them); the principal and
// admins can check anything. Only checked stories reach the newsletter.
router.post('/news/:id/review', requireReviewer, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  if (!canReviewSection(req.user, item.section)) {
    return res.status(403).render('error', {
      message: `Stories in "${SECTIONS[item.section] || item.section}" are checked by the SLT member responsible for that area.`,
    });
  }
  const decision = req.body.decision;
  if (!['approved', 'rejected', 'pending'].includes(decision)) {
    return res.status(400).render('error', { message: 'Unknown review decision.' });
  }
  const note = (req.body.review_note || '').trim().slice(0, 500) || null;
  db.prepare(
    "UPDATE news SET review_status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?"
  ).run(decision, req.user.id, note, item.id);
  res.redirect(req.body.back === 'dashboard' ? '/' : '/news');
});

// Curation: choose whether a checked story makes this week's issue.
router.post('/news/:id/include', requireLayout, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  db.prepare('UPDATE news SET included = ? WHERE id = ?').run(req.body.included === '1' ? 1 : 0, item.id);
  res.redirect('/news');
});

// Placement: move an article to another template section.
router.post('/news/:id/slot', requireLayout, (req, res) => {
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
