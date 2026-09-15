const express = require('express');
const { db } = require('../db');
const { requireManager, csrfOk } = require('../auth');
const { upload, isRealImage, removeFiles } = require('../uploads');

// The school houses and their running point totals. Houses (names + logos)
// live across the whole year; the points are what changes from issue to
// issue - a manager updates the numbers here and the newsletter's fixed
// House Points strip (right under the principal's message) picks them up.
const router = express.Router();

// The school's house palette (from the brand sheet): a new house with one of
// these names gets its colour automatically; anything else starts navy and
// can be changed with the per-row colour picker.
const HOUSE_COLORS = {
  tigers: '#DD2127',
  pumas: '#9AC8E1',
  panthers: '#189B49',
  leopards: '#F0E928',
};

function housesLocals(extra = {}) {
  return { houses: db.prepare('SELECT * FROM houses ORDER BY points DESC, id').all(), errors: [], ...extra };
}

function validate(body) {
  const name = (body.name || '').trim().slice(0, 60);
  const points = parseInt(body.points, 10);
  const color = /^#[0-9a-fA-F]{6}$/.test(body.color || '') ? body.color : null;
  const errors = [];
  if (!name) errors.push('The house needs a name.');
  if (body.points !== undefined && body.points !== '' && (Number.isNaN(points) || points < 0)) {
    errors.push('Points must be a whole number (0 or more).');
  }
  return { name, points: Number.isNaN(points) ? 0 : Math.max(0, points), color, errors };
}

router.get('/houses', requireManager, (req, res) => {
  res.render('houses', housesLocals());
});

router.post('/houses', requireManager, (req, res) => {
  const { name, points, errors } = validate(req.body);
  if (errors.length) return res.status(400).render('houses', housesLocals({ errors }));
  const color = HOUSE_COLORS[name.toLowerCase()] || '#1d3061';
  db.prepare('INSERT INTO houses (name, points, color) VALUES (?, ?, ?)').run(name, points, color);
  res.redirect('/houses');
});

router.post('/houses/:id/delete', requireManager, (req, res) => {
  const row = db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
  if (row) {
    db.prepare('DELETE FROM houses WHERE id = ?').run(row.id);
    removeFiles([row.logo]);
  }
  res.redirect('/houses');
});

// The house crest/logo, uploaded once and reused issue after issue. A new
// upload replaces the old file; the CDN copy refreshes on the next
// generation. This is a multipart route, so the CSRF token is verified
// after multer has parsed the body (see MULTIPART_PATHS in auth.js).
router.post('/houses/:id/logo', requireManager, (req, res) => {
  upload.single('logo')(req, res, (err) => {
    const cleanup = () => removeFiles(req.file ? [req.file.filename] : []);
    if (err) {
      cleanup();
      return res.status(400).render('error', { message: err.message });
    }
    if (!csrfOk(req)) {
      cleanup();
      return res.status(403).send('Invalid CSRF token. Go back, reload the page and try again.');
    }
    const row = db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
    if (!row) {
      cleanup();
      return res.status(404).render('error', { message: 'House not found.' });
    }
    if (req.body.remove_logo === '1') {
      cleanup();
      removeFiles([row.logo]);
      db.prepare('UPDATE houses SET logo = NULL, logo_mailchimp_url = NULL WHERE id = ?').run(row.id);
      return res.redirect('/houses');
    }
    if (!req.file || !isRealImage(req.file)) {
      cleanup();
      return res.status(400).render('error', { message: 'Choose a valid image file for the house logo.' });
    }
    removeFiles([row.logo]);
    db.prepare('UPDATE houses SET logo = ?, logo_mailchimp_url = NULL WHERE id = ?').run(req.file.filename, row.id);
    res.redirect('/houses');
  });
});

router.post('/houses/:id', requireManager, (req, res) => {
  const row = db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).render('error', { message: 'House not found.' });
  const { name, points, color, errors } = validate(req.body);
  if (errors.length) return res.status(400).render('houses', housesLocals({ errors }));
  db.prepare('UPDATE houses SET name = ?, points = ?, color = COALESCE(?, color) WHERE id = ?').run(
    name,
    points,
    color,
    row.id
  );
  res.redirect('/houses');
});

module.exports = router;
