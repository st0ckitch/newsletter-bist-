const express = require('express');
const { db } = require('../db');
const { requireRole, csrfOk } = require('../auth');
const { formatHuman } = require('../week');
const { generationWeekStart, generationDay, generationTimeLabel } = require('../appweek');
const { upload, isRealImage, removeFiles, copyUpload } = require('../uploads');

const router = express.Router();

function currentMessage(weekStart) {
  return db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(weekStart) || null;
}

// The portrait can be chosen three ways: upload a file, pick a saved staff
// headshot (Users page), or do nothing - in which case the most recent
// previous week's portrait carries forward automatically, so it only ever
// needs choosing once.
function savedHeadshots() {
  return db.prepare('SELECT id, name FROM users WHERE headshot IS NOT NULL ORDER BY name').all();
}

function pageLocals(req, weekStart, extra = {}) {
  return {
    message: currentMessage(weekStart),
    weekStart,
    deadlineHuman: `${formatHuman(generationDay(weekStart))} at ${generationTimeLabel()}`,
    saved: req.query.saved === '1',
    savedHeadshots: savedHeadshots(),
    errors: [],
    ...extra,
  };
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
  res.render('principal', pageLocals(req, generationWeekStart()));
});

router.post('/principal-message', requireRole('principal', 'admin'), photoUpload, (req, res) => {
  const weekStart = generationWeekStart();
  const body = (req.body.body || '').trim();
  const quote = (req.body.quote || '').trim() || null;
  const quote_author = (req.body.quote_author || '').trim() || null;
  if (!body) {
    removeFiles(req.file ? [req.file.filename] : []);
    return res.status(400).render('principal', pageLocals(req, weekStart, {
      message: { ...(currentMessage(weekStart) || {}), body, quote, quote_author },
      saved: false,
      errors: ['The message text is required.'],
    }));
  }
  const existing = currentMessage(weekStart);
  db.prepare(
    `INSERT INTO principal_messages (week_start, body, quote, quote_author, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET body = excluded.body, quote = excluded.quote,
       quote_author = excluded.quote_author, created_by = excluded.created_by, updated_at = datetime('now')`
  ).run(weekStart, body, quote, quote_author, req.user.id);
  // Portrait priority: an uploaded file wins; otherwise a saved staff
  // headshot picked from the dropdown (the message gets its own copy).
  let newPhoto = req.file ? req.file.filename : null;
  if (!newPhoto) {
    const pickedId = parseInt(req.body.photo_user_id, 10);
    if (pickedId) {
      const person = db.prepare('SELECT headshot FROM users WHERE id = ? AND headshot IS NOT NULL').get(pickedId);
      if (person) newPhoto = copyUpload(person.headshot);
    }
  }
  if (newPhoto) {
    // A new portrait replaces the old one and must be re-uploaded to Mailchimp.
    if (existing && existing.photo) removeFiles([existing.photo]);
    db.prepare('UPDATE principal_messages SET photo = ?, photo_mailchimp_url = NULL WHERE week_start = ?').run(
      newPhoto,
      weekStart
    );
  } else if (!existing || !existing.photo) {
    // First save of a new week with no photo chosen: the portrait rarely
    // changes, so the most recent previous week's carries forward (as this
    // week's own copy, so deleting either week never breaks the other).
    const prev = db
      .prepare('SELECT photo FROM principal_messages WHERE photo IS NOT NULL AND week_start < ? ORDER BY week_start DESC LIMIT 1')
      .get(weekStart);
    const carried = prev ? copyUpload(prev.photo) : null;
    if (carried) {
      db.prepare('UPDATE principal_messages SET photo = ?, photo_mailchimp_url = NULL WHERE week_start = ?').run(
        carried,
        weekStart
      );
    }
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
