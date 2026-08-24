const crypto = require('crypto');
const { db } = require('./db');

// Loads the logged-in user (if any) and prepares a CSRF token for forms.
function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    req.user = db.prepare('SELECT id, email, name, role FROM users WHERE id = ?').get(req.session.userId) || null;
    if (!req.user) req.session = null;
  }
  if (req.session && !req.session.csrf) {
    req.session.csrf = crypto.randomBytes(16).toString('hex');
  }
  res.locals.currentUser = req.user || null;
  res.locals.csrf = req.session ? req.session.csrf : '';
  next();
}

function verifyCsrf(req, res, next) {
  // Multipart forms put the token in the query string (the body is not parsed
  // until multer runs inside the route); regular forms use a hidden field.
  const token = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
  if (!req.session || !req.session.csrf || token !== req.session.csrf) {
    return res.status(403).send('Invalid CSRF token. Go back, reload the page and try again.');
  }
  next();
}

// Every mutating request is checked, multipart included.
function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return verifyCsrf(req, res, next);
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.status(403).render('error', { message: 'You do not have permission to access this page.' });
    next();
  };
}

// Managers can edit anything; teachers only their own records.
function canManage(user) {
  return user && (user.role === 'admin' || user.role === 'principal');
}

function canEditRecord(user, record) {
  return canManage(user) || (record && record.created_by === user.id);
}

module.exports = { attachUser, csrfProtection, verifyCsrf, requireLogin, requireRole, canManage, canEditRecord };
