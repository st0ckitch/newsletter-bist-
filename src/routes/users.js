const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAdmin, requireLogin } = require('../auth');
const { ASSIGNABLE_ROLES, ALL_ROLES, ROLE_LABELS } = require('../roles');
const { SECTIONS, SECTION_KEYS } = require('../sections');
const invites = require('../invites');

// The staff-import and invitation email actions belong to the site admin
// alone (the marketing owner's account) - SLT keep the ordinary account
// management on this page but cannot bulk-import or mass-email.
function requireSiteAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'Only the site admin can import staff and send invitation emails.' });
  }
  next();
}

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Only SLT members carry an area of responsibility; for everyone else the
// field is meaningless and is stored as NULL.
function areaFor(role, section) {
  if (role !== 'slt') return null;
  return SECTION_KEYS.includes(section) ? section : null;
}

function userFormLocals(extra) {
  return {
    roles: ASSIGNABLE_ROLES,
    roleLabels: ROLE_LABELS,
    sections: SECTIONS,
    ...extra,
  };
}

// The session lives in a 4KB cookie, so import/invite results are rendered
// straight into the response instead of being stashed as flash data.
function usersLocals(req, extra = {}) {
  const users = db
    .prepare(
      `SELECT id, email, name, role, section, created_at, invite_sent_at,
              (password_hash = '') AS invited
       FROM users ORDER BY role, name`
    )
    .all();
  return {
    users,
    created: false,
    roleLabels: ROLE_LABELS,
    sections: SECTIONS,
    assignableRoles: ASSIGNABLE_ROLES,
    sectionKeys: SECTION_KEYS,
    isSiteAdmin: req.user.role === 'admin',
    pendingInvites: invites.pendingInvitees().length,
    importReport: null,
    inviteResult: null,
    ...extra,
  };
}

router.get('/users', requireAdmin, (req, res) => {
  res.render('users', usersLocals(req, { created: req.query.created === '1' }));
});

/* ---------------- bulk import & invitation emails (site admin only) ------ */

// Paste/upload of "Name,Email[,role[,area]]" lines. Accounts are created
// WITHOUT a password: nobody can log in as them until they open their
// personal invite link and set one. Existing accounts are never touched.
router.post('/users/import', requireSiteAdmin, (req, res) => {
  const report = { created: [], existing: [], invalid: [] };
  const lines = String(req.body.csv || '').split(/\r?\n/);
  const seen = new Set();
  const insert = db.prepare(
    "INSERT INTO users (email, name, password_hash, role, section) VALUES (?, ?, '', ?, ?)"
  );
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',').map((c) => c.trim());
    const name = cols[0] || '';
    const email = (cols[1] || '').toLowerCase();
    if (/^(member\s*)?e-?mail$/.test(email)) continue; // header row
    let role = (cols[2] || 'staff').toLowerCase();
    let section = (cols[3] || '').toLowerCase();
    if (!EMAIL_RE.test(email)) {
      if (line) report.invalid.push(line.slice(0, 120));
      continue;
    }
    if (seen.has(email)) continue; // duplicate inside the file - first row wins
    seen.add(email);
    if (!ALL_ROLES.includes(role)) role = 'staff';
    if (!SECTION_KEYS.includes(section)) section = '';
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      report.existing.push(email);
      continue;
    }
    insert.run(email, name || email.split('@')[0], role, areaFor(role, section));
    report.created.push({ email, name, role, section: role === 'slt' ? section : '' });
  }
  res.render('users', usersLocals(req, { importReport: report }));
});

// One click: every account that has not set a password yet gets a Mailchimp
// email with its personal "create your password" link.
router.post('/users/send-invites', requireSiteAdmin, async (req, res) => {
  let inviteResult;
  try {
    inviteResult = await invites.sendStaffInvites();
  } catch (err) {
    inviteResult = { sent: false, reason: err.message };
  }
  res.render('users', usersLocals(req, { inviteResult }));
});

router.get('/users/new', requireAdmin, (req, res) => {
  res.render('user_form', userFormLocals({ values: { email: '', name: '', role: 'staff', section: '' }, errors: [] }));
});

router.post('/users', requireAdmin, (req, res) => {
  const values = {
    email: (req.body.email || '').trim(),
    name: (req.body.name || '').trim(),
    role: req.body.role,
    section: req.body.section || '',
  };
  const password = req.body.password || '';
  const errors = [];
  if (!EMAIL_RE.test(values.email)) errors.push('A valid email address is required.');
  if (!values.name) errors.push('Name is required.');
  if (!ALL_ROLES.includes(values.role)) errors.push('Invalid role.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (values.email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) {
    errors.push('A user with this email already exists.');
  }
  if (errors.length) return res.status(400).render('user_form', userFormLocals({ values, errors }));

  db.prepare('INSERT INTO users (email, name, password_hash, role, section) VALUES (?, ?, ?, ?, ?)').run(
    values.email,
    values.name,
    bcrypt.hashSync(password, 10),
    values.role,
    areaFor(values.role, values.section)
  );
  res.redirect('/users?created=1');
});

// Change someone's role, or which area an SLT member checks, without
// recreating the account.
router.post('/users/:id/role', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { message: 'User not found.' });
  const role = req.body.role;
  if (!ALL_ROLES.includes(role)) return res.status(400).render('error', { message: 'Invalid role.' });
  const managers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role IN ('admin','principal')").get().c;
  if (['admin', 'principal'].includes(user.role) && !['admin', 'principal'].includes(role) && managers <= 1) {
    return res.status(400).render('error', { message: 'Cannot remove the last admin/principal account.' });
  }
  db.prepare('UPDATE users SET role = ?, section = ? WHERE id = ?').run(
    role,
    areaFor(role, req.body.section || ''),
    user.id
  );
  res.redirect('/users');
});

router.post('/users/:id/password', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('error', { message: 'User not found.' });
  const password = req.body.password || '';
  if (password.length < 8) {
    return res.status(400).render('error', { message: 'Password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  res.redirect('/users');
});

router.post('/users/:id/delete', requireAdmin, (req, res) => {
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
