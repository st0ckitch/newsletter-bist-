const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { verifyCsrf } = require('../auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null, email: '' });
});

router.post('/login', verifyCsrf, (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Incorrect email or password.', email });
  }
  req.session.userId = user.id;
  res.redirect('/');
});

router.post('/logout', verifyCsrf, (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
