const express = require('express');
const { db } = require('../db');
const { requireRole, csrfOk } = require('../auth');
const { formatHuman } = require('../week');
const { generationWeekStart, generationDay, generationTimeLabel } = require('../appweek');
const { upload, isRealImage, removeFiles } = require('../uploads');

const router = express.Router();

function currentMessage(weekStart) {
  return db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(weekStart) || null;
}

// Parses the multipart body (optional portrait photo), then verifies the
// CSRF token from it and that the file really is an image.
function photoUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    const cleanup = () => removeFiles(req.file ? [req.file.filename] : []);
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
    if (req.file && !isRealImage(req.file)) {
      cleanup();
      const e = new Error(`"${req.file.originalname}" is not a valid image file.`);
      e.status = 400;
      e.expose = true;
      return next(e);
    }
    next();
  });
}

router.get('/principal-message', requireRole('principal', 'admin'), (req, res) => {
  const weekStart = generationWeekStart();
  res.render('principal', {
    message: currentMessage(weekStart),
    weekStart,
    deadlineHuman: `${formatHuman(generationDay(weekStart))} at ${generationTimeLabel()}`,
    saved: req.query.saved === '1',
    errors: [],
  });
});

router.post('/principal-message', requireRole('principal', 'admin'), photoUpload, (req, res) => {
  const weekStart = generationWeekStart();
  const body = (req.body.body || '').trim();
  const quote = (req.body.quote || '').trim() || null;
  const quote_author = (req.body.quote_author || '').trim() || null;
  if (!body) {
    removeFiles(req.file ? [req.file.filename] : []);
    return res.status(400).render('principal', {
      message: { ...(currentMessage(weekStart) || {}), body, quote, quote_author },
      weekStart,
      deadlineHuman: `${formatHuman(generationDay(weekStart))} at ${generationTimeLabel()}`,
      saved: false,
      errors: ['The message text is required.'],
    });
  }
  const existing = currentMessage(weekStart);
  db.prepare(
    `INSERT INTO principal_messages (week_start, body, quote, quote_author, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET body = excluded.body, quote = excluded.quote,
       quote_author = excluded.quote_author, created_by = excluded.created_by, updated_at = datetime('now')`
  ).run(weekStart, body, quote, quote_author, req.user.id);
  if (req.file) {
    // A new portrait replaces the old one and must be re-uploaded to Mailchimp.
    if (existing && existing.photo) removeFiles([existing.photo]);
    db.prepare('UPDATE principal_messages SET photo = ?, photo_mailchimp_url = NULL WHERE week_start = ?').run(
      req.file.filename,
      weekStart
    );
  }
  res.redirect('/principal-message?saved=1');
});

router.post('/principal-message/photo/delete', requireRole('principal', 'admin'), (req, res) => {
  const weekStart = generationWeekStart();
  const existing = currentMessage(weekStart);
  if (existing && existing.photo) {
    removeFiles([existing.photo]);
    db.prepare('UPDATE principal_messages SET photo = NULL, photo_mailchimp_url = NULL WHERE week_start = ?').run(weekStart);
  }
  res.redirect('/principal-message');
});

module.exports = router;
