// Circle partner offers for the bottom of every issue, read from the Circle
// API's newsletter feed: each partner's name, logo and offer badge (the
// yellow tag on circle.bist.ge) - never the offer details, which stay
// members-only. The feed is read every few hours and again before each
// generation; the last good copy is kept in the database, so the preview and
// the draft always have partners to show even if the Circle API is briefly
// unreachable.
const config = require('./config');
const { getSetting, setSetting } = require('./db');
const { imageSize } = require('./imagesize');

const SNAPSHOT = 'circle_partners';
const ERROR = 'circle_partners_error';

function snapshot() {
  try {
    const snap = JSON.parse(getSetting(SNAPSHOT) || 'null');
    return snap && Array.isArray(snap.offers) ? snap : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A logo's pixel size, so the email can give Outlook exact dimensions.
async function logoSize(fetchImpl, url) {
  try {
    const res = await fetchWithTimeout(fetchImpl, url, {}, 10000);
    if (!res.ok) return null;
    return imageSize(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

const httpUrl = (value) => (typeof value === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(value) ? value : null);

async function refreshPartners({ fetchImpl = globalThis.fetch } = {}) {
  const { feedUrl, token } = config.circle;
  if (!feedUrl || !token) return { ok: false, error: 'not configured' };
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      feedUrl,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
      15000
    );
    if (!res.ok) throw new Error(`the Circle API answered with error ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.offers)) throw new Error('the Circle API sent something unexpected');
    // Logo sizes are only looked up for logos not seen before.
    const known = new Map(((snapshot() || {}).offers || []).filter((o) => o.logo && o.w).map((o) => [o.logo, o]));
    const offers = [];
    for (const o of body.offers.slice(0, 200)) {
      if (!o || typeof o.partner !== 'string' || !o.partner.trim()) continue;
      const logo = httpUrl(o.logo);
      const size = logo ? known.get(logo) || (await logoSize(fetchImpl, logo)) : null;
      offers.push({
        partner: o.partner.trim().slice(0, 80),
        badge: String(o.badge || '').trim().slice(0, 30),
        logo,
        w: (size && size.w) || 0,
        h: (size && size.h) || 0,
      });
    }
    const site = (httpUrl(body.site) || '').replace(/\/+$/, '');
    setSetting(SNAPSHOT, JSON.stringify({ site, fetchedAt: new Date().toISOString(), offers }));
    setSetting(ERROR, '');
    console.log(`[partners] ${offers.length} partner offers read from Circle.`);
    return { ok: true, count: offers.length };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'the Circle API did not answer in time' : err.message;
    setSetting(ERROR, JSON.stringify({ at: new Date().toISOString(), error }));
    console.error(`[partners] Could not read the Circle feed: ${error}`);
    return { ok: false, error };
  }
}

// This issue's share of the partners: a window of `perIssue` that moves on
// by that many every week, so every partner comes round in turn and the
// preview and the draft of a week always agree. 0 shows them all.
function partnersForWeek(weekStart, perIssue) {
  const snap = snapshot();
  if (!snap || !snap.offers.length) return null;
  const all = snap.offers;
  const count = perIssue > 0 ? Math.min(perIssue, all.length) : all.length;
  const week = Math.floor(Date.parse(`${weekStart}T00:00:00Z`) / (7 * 86400000));
  const start = (((week * count) % all.length) + all.length) % all.length;
  return {
    site: snap.site,
    total: all.length,
    list: Array.from({ length: count }, (_, i) => all[(start + i) % all.length]),
  };
}

// For the Settings page: what the feed did last.
function partnersStatus() {
  const snap = snapshot();
  let failure = null;
  try {
    failure = JSON.parse(getSetting(ERROR) || 'null');
  } catch {
    failure = null;
  }
  return {
    configured: Boolean(config.circle.feedUrl && config.circle.token),
    count: snap ? snap.offers.length : 0,
    site: snap ? snap.site : '',
    fetchedAt: snap ? snap.fetchedAt : null,
    failure,
  };
}

module.exports = { refreshPartners, partnersForWeek, partnersStatus };
