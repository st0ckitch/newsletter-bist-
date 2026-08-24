const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireRole, requireLogin } = require('../auth');

const router = express.Router();
const ROLES = ['primary', 'secondary', 'principal', 'admin'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/users', requireRole('principal', 'admin'), (req, res) => {
  const users = db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY role, name').all();
  res.render('users', { users, created: req.query.created === '1' });
});

router.get('/users/new', requireRole('principal', 'admin'), (req, res) => {
  res.render('user_form', { values: { email: '', name: '', role: 'primary' }, errors: [], roles: ROLES });
});

router.post('/users', requireRole('principal', 'admin'), (req, res) => {
  const values = {
    email: (req.body.email || '').trim(),
    name: (req.body.name || '').trim(),
    role: req.body.role,
  };
  const password = req.body.password || '';
  const errors = [];
  if (!EMAIL_RE.test(values.email)) errors.push('A valid email address is required.');
  if (!values.name) errors.push('Name is required.');
  if (!ROLES.includes(values.role)) errors.push('Invalid role.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (values.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) {
    errors.push('A user with this email already exists.');
  }
  if (errors.length) return res.status(400).render('user_form', { values, errors, roles: ROLES });

  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').run(
    values.email,
    values.name,
    bcrypt.hashSync(password, 10),
    values.role
  );
  res.redirect('/users?created=1');
});

router.post('/users/:id/password', requireRole('principal', 'admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { message: 'User not found.' });
  const password = req.body.password || '';
  if (password.length < 8) {
    return res.status(400).render('error', { message: 'Password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  res.redirect('/users');
});

router.post('/users/:id/delete', requireRole('principal', 'admin'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).render('error', { message: 'You cannot delete your own account.' });
  }
  const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role IN ('admin','principal')").get().c;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).render('error', { message: 'User not found.' });
  if (['admin', 'principal'].includes(target.role) && admins <= 1) {
    return res.status(400).render('error', { message: 'Cannot delete the last admin/principal account.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.redirect('/users');
});

// Every user can change their own password.
router.post('/account/password', requireLogin, (req, res) => {
  const current = req.body.current_password || '';
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, user.password_hash)) {
    return res.status(400).render('error', { message: 'Current password is incorrect.' });
  }
  if (password.length < 8) {
    return res.status(400).render('error', { message: 'New password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  res.render('message', { title: 'Password changed', message: 'Your password has been updated.' });
});

module.exports = router;
