const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { verifyCsrf } = require('../auth');
const invites = require('../invites');

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
    // Imported accounts have no password until their owner opens the invite
    // link - saying so beats a misleading "incorrect password".
    if (user && !user.password_hash) {
      noteFailure(key);
      return res.status(401).render('login', {
        error: 'This account has not been activated yet - use the "Create your password" link in your invitation email, or ask marketing to resend it.',
        email,
      });
    }
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      noteFailure(key);
      return res.status(401).render('login', { error: 'Incorrect email or password.', email });
    }
    attempts.delete(key);
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

/* ---------------- account activation via invite link ---------------- */

// The personal link from the invitation email: set a password, get signed in.
router.get('/invite/:token', (req, res) => {
  const user = invites.findByToken(req.params.token);
  if (!user) {
    return res.status(404).render('error', {
      message: 'This invitation link is no longer valid - it may have been used already or replaced by a newer email. Ask marketing to send you a fresh invite.',
    });
  }
  res.render('invite', { user, token: req.params.token, errors: [] });
});

router.post('/invite/:token', verifyCsrf, (req, res) => {
  const user = invites.findByToken(req.params.token);
  if (!user) {
    return res.status(404).render('error', {
      message: 'This invitation link is no longer valid - it may have been used already or replaced by a newer email. Ask marketing to send you a fresh invite.',
    });
  }
  const password = req.body.password || '';
  const errors = [];
  if (password.length < 8) errors.push('The password must be at least 8 characters.');
  if (password !== (req.body.password_confirm || '')) errors.push('The two passwords do not match.');
  if (errors.length) return res.status(400).render('invite', { user, token: req.params.token, errors });
  invites.activate(user.id, bcrypt.hashSync(password, 10));
  req.session.userId = user.id;
  res.redirect('/');
});

router.post('/logout', verifyCsrf, (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
