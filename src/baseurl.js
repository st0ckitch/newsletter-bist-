// The public address of this app - used to build absolute links in emails
// (invite buttons, reminder buttons, photo and font URLs). APP_BASE_URL wins
// when it points at a real domain; otherwise the app falls back to the last
// public host an authenticated user was seen browsing on (learned below and
// persisted in settings), so emailed links never point at localhost just
// because the variable was forgotten on the host.
const config = require('./config');
const { getSetting, setSetting } = require('./db');

const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

function isPublicUrl(url) {
  return /^https?:\/\//i.test(url || '') && !LOCAL_RE.test(url);
}

function publicBaseUrl() {
  if (isPublicUrl(config.appBaseUrl)) return config.appBaseUrl;
  const learned = getSetting('public_base_url') || '';
  return isPublicUrl(learned) ? learned.replace(/\/+$/, '') : config.appBaseUrl;
}

// Called for signed-in requests only, so a random scanner hitting the box
// with a forged Host header cannot poison the learned address.
function rememberBaseUrl(req) {
  if (isPublicUrl(config.appBaseUrl)) return;
  const host = req.get('host');
  if (!host) return;
  const seen = `${req.protocol}://${host}`.replace(/\/+$/, '');
  if (!isPublicUrl(seen)) return;
  if (getSetting('public_base_url') !== seen) setSetting('public_base_url', seen);
}

module.exports = { publicBaseUrl, rememberBaseUrl, isPublicUrl };
