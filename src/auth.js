const crypto = require('crypto');
const { db } = require('./db');
const roles = require('./roles');

// Loads the logged-in user (if any) and prepares a CSRF token for forms.
function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    req.user =
      db.prepare('SELECT id, email, name, role, section FROM users WHERE id = ?').get(req.session.userId) || null;
    if (!req.user) req.session = null;
  }
  if (req.session && !req.session.csrf) {
    req.session.csrf = crypto.randomBytes(16).toString('hex');
  }
  res.locals.currentUser = req.user || null;
  res.locals.csrf = req.session ? req.session.csrf : '';
  // Views ask "may this person do X?" rather than listing role names.
  res.locals.can = {
    manage: roles.canManage(req.user),
    layout: roles.canLayout(req.user),
    review: roles.isReviewer(req.user),
    approve: roles.canApproveIssue(req.user),
    administer: roles.canAdminister(req.user),
  };
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
const MULTIPART_PATHS = [
  /^\/news$/,
  /^\/news\/\d+$/,
  /^\/principal-message$/,
  /^\/settings\/masthead-photo$/,
  /^\/api\/edit\/photo\/(add|replace)$/,
  /^\/api\/edit\/principal-photo$/,
  /^\/api\/edit\/masthead-photo$/,
];

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

// Managers (SLT, marketing, principal, admin) can edit anything; staff only
// their own records. See src/roles.js for the full capability map.
const { canManage } = roles;

function canEditRecord(user, record) {
  return canManage(user) || (record && record.created_by === user.id);
}

// Route guards built from the capability map, so a role change is a one-line
// edit in src/roles.js.
function requireCapability(check, message) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!check(req.user)) return res.status(403).render('error', { message });
    next();
  };
}

const requireLayout = requireCapability(
  roles.canLayout,
  'Laying out the newsletter is done by marketing, SLT, the principal or an admin.'
);
const requireReviewer = requireCapability(
  roles.isReviewer,
  'Checking stories is done by SLT, the principal or an admin.'
);
const requireApprover = requireCapability(
  roles.canApproveIssue,
  'Only the principal (or an admin) can approve an issue for sending.'
);
const requireAdmin = requireCapability(
  roles.canAdminister,
  'You do not have permission to access this page.'
);
const requireManager = requireCapability(
  roles.canManage,
  'You do not have permission to access this page.'
);

module.exports = {
  attachUser,
  csrfProtection,
  csrfOk,
  verifyCsrf,
  requireLogin,
  requireRole,
  requireLayout,
  requireReviewer,
  requireApprover,
  requireAdmin,
  requireManager,
  canManage,
  canEditRecord,
};
