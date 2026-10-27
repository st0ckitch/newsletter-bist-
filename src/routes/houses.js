const express = require('express');
const { db, setSetting, housePointsVisible } = require('../db');
const { requireManager, requireHouses, csrfOk, canManage } = require('../auth');
const { housePhases, HOUSE_PHASES } = require('../roles');
const { upload, isRealImage, removeFiles } = require('../uploads');

// The school houses and their running point totals. Houses (names, logos,
// colours) are set up by managers and live across the whole year; the points
// are what changes from issue to issue - Primary and Secondary each keep
// their own total per house. Managers update both; staff an admin gives
// house points access (Users page) update their own table. The newsletter's
// fixed House Points tables (right under the principal's message) pick the
// numbers up.
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

const PHASE_LABELS = { primary: 'Primary', secondary: 'Secondary' };

function housesLocals(req, extra = {}) {
  return {
    houses: db.prepare('SELECT * FROM houses ORDER BY id').all(),
    visible: { primary: housePointsVisible('primary'), secondary: housePointsVisible('secondary') },
    phases: housePhases(req.user),
    phaseLabels: PHASE_LABELS,
    isManager: canManage(req.user),
    saved: req.query.saved === '1',
    errors: [],
    ...extra,
  };
}

// A points field: blank leaves the number as it is; anything else must be a
// whole number.
function parsePoints(raw, label, errors) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    errors.push(`${label} points must be a whole number (0 or more).`);
    return null;
  }
  return parseInt(value, 10);
}

// The changes one house's submitted fields make, limited to what this person
// may change: managers everything, house points staff their tables' points.
function houseChanges(user, house, fields, errors) {
  const changes = {};
  for (const phase of housePhases(user)) {
    const n = parsePoints(fields[`${phase}_points`], `${house.name} - ${PHASE_LABELS[phase]}`, errors);
    if (n !== null) changes[`${phase}_points`] = n;
  }
  if (canManage(user)) {
    if (fields.name !== undefined) {
      const name = String(fields.name).trim().slice(0, 60);
      if (name) changes.name = name;
      else errors.push('Every house needs a name.');
    }
    if (/^#[0-9a-fA-F]{6}$/.test(fields.color || '')) changes.color = fields.color;
  }
  return changes;
}

// Column names come from the fixed list above, never from the request.
function applyChanges(id, changes) {
  const cols = Object.keys(changes);
  if (!cols.length) return;
  db.prepare(`UPDATE houses SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((c) => changes[c]),
    id
  );
}

router.get('/houses', requireHouses, (req, res) => {
  res.render('houses', housesLocals(req));
});

router.post('/houses', requireManager, (req, res) => {
  const errors = [];
  const name = (req.body.name || '').trim().slice(0, 60);
  if (!name) errors.push('The house needs a name.');
  const points = Object.fromEntries(
    HOUSE_PHASES.map((p) => [p, parsePoints(req.body[`${p}_points`], PHASE_LABELS[p], errors) || 0])
  );
  if (errors.length) return res.status(400).render('houses', housesLocals(req, { errors }));
  const color = HOUSE_COLORS[name.toLowerCase()] || '#1d3061';
  db.prepare('INSERT INTO houses (name, primary_points, secondary_points, color) VALUES (?, ?, ?, ?)').run(
    name,
    points.primary,
    points.secondary,
    color
  );
  res.redirect('/houses');
});

// The whole table in one go - fields are named <field>_<house id>. Nothing
// is saved if any number is invalid.
router.post('/houses/save', requireHouses, (req, res) => {
  const errors = [];
  const updates = db
    .prepare('SELECT * FROM houses ORDER BY id')
    .all()
    .map((house) => {
      const fields = {};
      for (const f of ['name', 'color', 'primary_points', 'secondary_points']) {
        if (req.body[`${f}_${house.id}`] !== undefined) fields[f] = req.body[`${f}_${house.id}`];
      }
      return [house.id, houseChanges(req.user, house, fields, errors)];
    });
  if (errors.length) return res.status(400).render('houses', housesLocals(req, { errors }));
  for (const [id, changes] of updates) applyChanges(id, changes);
  res.redirect('/houses?saved=1');
});

// Hide/show a standings table (Primary or Secondary) in the newsletter
// without touching the data - for weeks when its points were not updated.
// Without a phase, every table this person looks after switches together.
router.post('/houses/visibility', requireHouses, (req, res) => {
  const mine = housePhases(req.user);
  const wanted = HOUSE_PHASES.includes(req.body.phase) ? [req.body.phase] : mine;
  if (!wanted.every((p) => mine.includes(p))) {
    return res.status(403).render('error', { message: 'You can only show or hide the house points table you look after.' });
  }
  for (const phase of wanted) setSetting(`house_points_${phase}_visible`, req.body.visible === '1' ? '1' : '0');
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

// One house at a time (same rules as the whole-table save).
router.post('/houses/:id', requireHouses, (req, res) => {
  const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(req.params.id);
  if (!house) return res.status(404).render('error', { message: 'House not found.' });
  const errors = [];
  const changes = houseChanges(req.user, house, req.body, errors);
  if (errors.length) return res.status(400).render('houses', housesLocals(req, { errors }));
  applyChanges(house.id, changes);
  res.redirect('/houses?saved=1');
});

module.exports = router;
