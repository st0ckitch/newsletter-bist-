const express = require('express');
const { db } = require('../db');
const { requireManager } = require('../auth');

// The weekly canteen menus live wherever the school hosts them (the website,
// Google Drive, ...). Managers keep a short list of titled links here - e.g.
// "Foundation", "Year 1-5", "Year 6-13" - and the newsletter shows them as
// buttons in its School Menus section, right under the calendar and the
// principal's message.
const router = express.Router();
const URL_RE = /^https?:\/\/\S+$/i;

function menusLocals(extra = {}) {
  return { menus: db.prepare('SELECT * FROM menus ORDER BY id').all(), errors: [], ...extra };
}

function validate(body) {
  const title = (body.title || '').trim().slice(0, 80);
  const url = (body.url || '').trim();
  const errors = [];
  if (!title) errors.push('A link title is required (e.g. "Year 1-5").');
  if (!URL_RE.test(url)) errors.push('The link must be a full web address starting with http:// or https://.');
  return { title, url, errors };
}

router.get('/menus', requireManager, (req, res) => {
  res.render('menus', menusLocals());
});

router.post('/menus', requireManager, (req, res) => {
  const { title, url, errors } = validate(req.body);
  if (errors.length) return res.status(400).render('menus', menusLocals({ errors }));
  db.prepare('INSERT INTO menus (title, url) VALUES (?, ?)').run(title, url);
  res.redirect('/menus');
});

router.post('/menus/:id/delete', requireManager, (req, res) => {
  db.prepare('DELETE FROM menus WHERE id = ?').run(req.params.id);
  res.redirect('/menus');
});

router.post('/menus/:id', requireManager, (req, res) => {
  const row = db.prepare('SELECT * FROM menus WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).render('error', { message: 'Menu link not found.' });
  const { title, url, errors } = validate(req.body);
  if (errors.length) return res.status(400).render('menus', menusLocals({ errors }));
  db.prepare("UPDATE menus SET title = ?, url = ?, updated_at = datetime('now') WHERE id = ?").run(title, url, row.id);
  res.redirect('/menus');
});

module.exports = router;
