// Staff photos from the school website's team page (bist.ge/our-team): each
// team member's portrait is matched to a staff account by name and saved as
// that person's headshot, so it appears in the article form's "saved staff
// headshot" picker. Only accounts without a headshot get one. A clear match
// (the full name, or the school email name) is saved straight away; a loose
// one (same surname and first initial - Keti and Ketevan) is only suggested,
// for a one-click check on the Import staff photos page. Nothing is guessed.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const { db, getSetting, setSetting } = require('./db');

const RESULT = 'staff_photos_import';
const HEADSHOT_SIDE = 800;

function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

const words = (s) => normalizeKey(s).split(' ').filter(Boolean);

const decode = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#8217;|&rsquo;|&#039;|&#39;/g, "'")
    .replace(/&amp;|&#038;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Words in a photo's file name that are not part of anyone's name.
const FILE_NOISE = new Set(['bist', 'scaled', 'min', 'ph', 'portrait', 'placeholder', 'photo', 'img', 'image', 'jpg', 'png']);

// "Tamuna-Smith-scaled-2.jpg" -> ["tamuna", "smith"]: the site often
// files a photo under the name people actually use.
function fileNameWords(url) {
  let base = String(url).split('/').pop() || '';
  try {
    base = decodeURIComponent(base);
  } catch {
    // A stray % in the name: use it as it is.
  }
  base = base.replace(/\.[a-z]+$/i, '');
  const list = words(base.replace(/-\d+x\d+$/, '')).filter((w) => w.length > 1 && !FILE_NOISE.has(w));
  return list.length >= 2 ? list.slice(0, 2) : null;
}

// The widest-enough picture from an <img>: the smallest srcset entry at
// least 600px wide (headshots never need more), else the src itself.
function pickPhoto(tag) {
  const src = (/\ssrc="([^"]+)"/.exec(tag) || [])[1] || null;
  const srcset = (/\ssrcset="([^"]+)"/.exec(tag) || [])[1] || '';
  const options = srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .map(([url, w]) => ({ url, w: parseInt(w, 10) }))
    .filter((o) => o.url && o.w >= 600)
    .sort((a, b) => a.w - b.w);
  return (options[0] && options[0].url) || src;
}

// The team page is an Elementor loop: one block per person with the photo
// and two headings, the name and the job title.
function parseTeamPage(html) {
  const people = new Map();
  for (const block of String(html).split(/<div data-elementor-type="loop-item"/).slice(1)) {
    const id = (/e-loop-item-(\d+)/.exec(block) || [])[1];
    const img = (/<img\b[^>]*>/.exec(block) || [])[0];
    const headings = [...block.matchAll(/<h[1-6][^>]*class="[^"]*elementor-heading-title[^"]*"[^>]*>([\s\S]*?)<\/h[1-6]>/g)].map((m) =>
      decode(m[1])
    );
    if (!id || people.has(id) || !img || !headings[0]) continue;
    const photo = pickPhoto(img);
    if (!photo || !/^https?:\/\//.test(photo)) continue;
    const file = (/\ssrc="([^"]+)"/.exec(img) || [])[1] || photo;
    people.set(id, { id, name: headings[0], role: headings[1] && headings[1] !== headings[0] ? headings[1] : '', photo, file });
  }
  return [...people.values()];
}

const placeholder = (p) => /placeholder/i.test(p.file || p.photo);

function personVariants(p) {
  const list = [words(p.name)];
  const fromFile = fileNameWords(p.file || p.photo);
  if (fromFile) list.push(fromFile);
  return list.filter((v) => v.length >= 2);
}

function userVariants(u) {
  const list = [words(u.name)];
  const local = String(u.email || '').split('@')[0];
  if (/[._-]/.test(local)) list.push(words(local.replace(/[._-]+/g, ' ')));
  return list.filter((v) => v.length >= 2);
}

const subset = (a, b) => a.every((t) => b.includes(t));

// 'name' / 'email' are clear; 'loose' (surname + initial, also an email
// like t.surname) only suggests - Tina and Tamar Smith both fit it.
function matchLevel(user, person) {
  const uv = userVariants(user);
  const pv = personVariants(person);
  for (const u of uv) {
    for (const p of pv) {
      const common = u.filter((t) => p.includes(t)).length;
      if (common >= 2 && (subset(u, p) || subset(p, u))) return 'name';
    }
  }
  const emailKey = normalizeKey(String(user.email || '').split('@')[0]).replace(/ /g, '');
  const site = words(person.name);
  if (emailKey.length >= 5 && site.length >= 2) {
    const first = site[0];
    const last = site[site.length - 1];
    if ([site.join(''), first + last, last + first].includes(emailKey)) return 'email';
    if (emailKey === first[0] + last && last.length >= 4) return 'loose';
  }
  for (const u of uv) {
    for (const p of pv) {
      if (u[u.length - 1] === p[p.length - 1] && p[p.length - 1].length >= 4 && u[0][0] === p[0][0]) return 'loose';
    }
  }
  return null;
}

// Who gets which photo. Every account is considered, so a person already
// matched to someone with a headshot is never offered to anyone else.
function planMatches(users, people) {
  const usable = people.filter((p) => !placeholder(p));
  const clear = new Map();
  const loose = new Map();
  for (const u of users) {
    const levels = usable.map((p) => [p, matchLevel(u, p)]).filter(([, l]) => l);
    const strong = levels.filter(([, l]) => l !== 'loose').map(([p]) => p);
    if (strong.length === 1) clear.set(u.id, strong[0]);
    else if (!strong.length) {
      const weak = levels.map(([p]) => p);
      if (weak.length === 1) loose.set(u.id, weak[0]);
    }
  }
  const claims = new Map();
  for (const [uid, p] of clear) claims.set(p.id, (claims.get(p.id) || []).concat(uid));
  const taken = new Set([...claims.keys()]);
  const plan = { add: [], suggest: [], unclear: [] };
  for (const u of users) {
    if (u.headshot) continue;
    const p = clear.get(u.id);
    if (p && claims.get(p.id).length === 1) plan.add.push({ user: u, person: p });
    else if (p) plan.unclear.push({ user: u, reason: `${p.name} on the website matches more than one account` });
    else if (loose.has(u.id) && !taken.has(loose.get(u.id).id)) plan.suggest.push({ user: u, person: loose.get(u.id) });
  }
  return plan;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'newsletter-admin' } });
  } finally {
    clearTimeout(timer);
  }
}

// Downloads a portrait, makes it a headshot-sized JPEG (transparency on
// white) and stores it as the account's headshot if it still has none.
async function saveHeadshot(userId, photoUrl, { overwrite = false } = {}) {
  const res = await fetchWithTimeout(photoUrl, 30000);
  if (!res.ok) throw new Error(`the photo could not be downloaded (${res.status})`);
  const input = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(input).metadata();
  if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 120) throw new Error('the photo is too small');
  const out = await sharp(input)
    .rotate()
    .resize(HEADSHOT_SIDE, HEADSHOT_SIDE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
  const filename = `${crypto.randomBytes(16).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(config.uploadDir, filename), out);
  const old = db.prepare('SELECT headshot FROM users WHERE id = ?').get(userId);
  const done = db
    .prepare(`UPDATE users SET headshot = ? WHERE id = ?${overwrite ? '' : ' AND headshot IS NULL'}`)
    .run(filename, userId);
  if (!done.changes) {
    fs.rmSync(path.join(config.uploadDir, filename), { force: true });
    return false;
  }
  if (overwrite && old && old.headshot) fs.rmSync(path.join(config.uploadDir, old.headshot), { force: true });
  return true;
}

function lastImport() {
  try {
    return JSON.parse(getSetting(RESULT) || 'null');
  } catch {
    return null;
  }
}

const entry = ({ user, person }) => ({
  userId: user.id,
  userName: user.name,
  siteName: person.name,
  role: person.role,
  photo: person.photo,
});

async function importStaffPhotos() {
  const source = config.staffPhotosUrl;
  const result = { at: new Date().toISOString(), source, ok: false, people: 0, added: [], suggestions: [], unclear: [], missing: [], failed: [] };
  try {
    if (!source) throw new Error('no team page is configured');
    const res = await fetchWithTimeout(source, 30000);
    if (!res.ok) throw new Error(`the team page answered ${res.status}`);
    const people = parseTeamPage(await res.text());
    if (!people.length) throw new Error('no team members were found on the page');
    result.people = people.length;
    const users = db.prepare('SELECT id, name, email, headshot FROM users ORDER BY name').all();
    const plan = planMatches(users, people);
    for (const m of plan.add) {
      try {
        if (await saveHeadshot(m.user.id, m.person.photo)) result.added.push(entry(m));
      } catch (err) {
        result.failed.push({ ...entry(m), error: err.message });
      }
    }
    result.suggestions = plan.suggest.map(entry);
    result.unclear = plan.unclear.map(({ user, reason }) => ({ userId: user.id, userName: user.name, reason }));
    const handled = new Set([...plan.add, ...plan.suggest].map((m) => m.user.id).concat(plan.unclear.map((u) => u.user.id)));
    result.missing = users.filter((u) => !u.headshot && !handled.has(u.id)).map((u) => u.name);
    result.ok = true;
  } catch (err) {
    result.error = err.message;
  }
  setSetting(RESULT, JSON.stringify(result));
  if (result.ok) {
    console.log(
      `[staff-photos] ${result.people} people on ${source}: ${result.added.length} headshots added` +
        (result.added.length ? ` (${result.added.map((a) => `${a.userName} <- ${a.siteName}`).join('; ')})` : '') +
        `, ${result.suggestions.length} to check` +
        (result.suggestions.length ? ` (${result.suggestions.map((a) => `${a.userName} ~ ${a.siteName}`).join('; ')})` : '') +
        `, ${result.failed.length} failed, ${result.missing.length} accounts without a headshot not on the page.`
    );
  } else {
    console.error(`[staff-photos] Import from ${source || '(none)'} failed: ${result.error}`);
  }
  return result;
}

// A suggested (loose) match confirmed by an admin on the import page.
async function useSuggestion(userId) {
  const result = lastImport();
  const s = result && result.suggestions.find((x) => x.userId === userId);
  if (!s) return { ok: false, error: 'That suggestion is no longer open - check the website again.' };
  try {
    const saved = await saveHeadshot(s.userId, s.photo);
    result.suggestions = result.suggestions.filter((x) => x !== s);
    if (saved) result.added.push(s);
    setSetting(RESULT, JSON.stringify(result));
    return saved ? { ok: true, name: s.userName } : { ok: false, error: `${s.userName} already has a headshot.` };
  } catch (err) {
    return { ok: false, error: `Could not save the photo: ${err.message}` };
  }
}

// Runs the import once by itself (the first start after it was added);
// after that, only from the Import staff photos page.
function importOnce() {
  if (!config.staffPhotosUrl || getSetting(RESULT)) return Promise.resolve(null);
  return importStaffPhotos().catch((err) => console.error('[staff-photos] Import failed:', err.message));
}

module.exports = { importStaffPhotos, importOnce, useSuggestion, lastImport, parseTeamPage, planMatches, matchLevel };
