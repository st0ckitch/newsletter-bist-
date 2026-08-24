const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { verifyCsrf } = require('../auth');

const router = express.Router();

// Small in-memory throttle on failed logins per (ip, email).
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function prune() {
  const now = Date.now();
  for (const [key, rec] of attempts) {
    if (now - rec.first > WINDOW_MS) attempts.delete(key);
  }
}

function isLocked(key) {
  prune();
  const rec = attempts.get(key);
  return Boolean(rec && rec.count >= MAX_ATTEMPTS);
}

function noteFailure(key) {
  const rec = attempts.get(key);
  if (rec) rec.count += 1;
  else attempts.set(key, { count: 1, first: Date.now() });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null, email: '' });
});

router.post('/login', verifyCsrf, async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    const key = `${req.ip}|${email.toLowerCase()}`;
    if (isLocked(key)) {
      return res
        .status(429)
        .render('login', { error: 'Too many failed attempts. Please try again in 15 minutes.', email });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      noteFailure(key);
      return res.status(401).render('login', { error: 'Incorrect email or password.', email });
    }
    attempts.delete(key);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', verifyCsrf, (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
