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

function csrfOk(req) {
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  return Boolean(req.session && req.session.csrf && token === req.session.csrf);
}

function verifyCsrf(req, res, next) {
  if (!csrfOk(req)) {
    return res.status(403).send('Invalid CSRF token. Go back, reload the page and try again.');
  }
  next();
}

// Only the news routes accept multipart bodies; they parse them with multer
// and then run verifyCsrf themselves. Multipart posts anywhere else would
// slip past the token check (their body is never parsed), so reject them.
const MULTIPART_PATHS = [/^\/news$/, /^\/news\/\d+$/, /^\/principal-message$/];

function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if ((req.get('content-type') || '').startsWith('multipart/form-data')) {
    if (MULTIPART_PATHS.some((re) => re.test(req.path))) return next();
    return res.status(403).send('Unexpected multipart request.');
  }
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

module.exports = { attachUser, csrfProtection, csrfOk, verifyCsrf, requireLogin, requireRole, canManage, canEditRecord };
