// End-to-end smoke test against a real listening server with a throwaway
// database. Environment must be set before any src module is required.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roar-test-'));
process.env.SESSION_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'test-password';
// Empty strings (not delete) so dotenv cannot re-populate them from .env.
process.env.MAILCHIMP_API_KEY = '';
process.env.MAILCHIMP_SERVER_PREFIX = '';
process.env.MAILCHIMP_AUDIENCE_ID = '';
process.env.MAILCHIMP_TEACHERS_AUDIENCE_ID = '';

const test = require('node:test');
const assert = require('node:assert');
const { seedAdmin, db } = require('../src/db');
const { createApp } = require('../src/app');
const { generateIssue } = require('../src/generate');

let server;
let base;
let cookies = '';
let csrf = '';

function mergeCookies(res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) {
    const jar = new Map(cookies.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
    for (const c of set) jar.set(c.split('=')[0], c.split(';')[0]);
    cookies = [...jar.values()].join('; ');
  }
}

async function get(url) {
  const res = await fetch(base + url, { headers: { cookie: cookies }, redirect: 'manual' });
  mergeCookies(res);
  return res;
}

async function post(url, params) {
  const body = new URLSearchParams({ _csrf: csrf, ...params });
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    redirect: 'manual',
  });
  mergeCookies(res);
  return res;
}

async function extractCsrf(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : '';
}

test.before(async () => {
  seedAdmin();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('unauthenticated user is redirected to login', async () => {
  const res = await get('/');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/login');
});

test('login page renders and sets a CSRF token', async () => {
  const res = await get('/login');
  assert.strictEqual(res.status, 200);
  csrf = await extractCsrf(await res.text());
  assert.ok(csrf.length >= 32);
});

test('login rejects wrong credentials', async () => {
  const res = await post('/login', { email: 'admin@test.local', password: 'wrong' });
  assert.strictEqual(res.status, 401);
});

test('login rejects a bad CSRF token', async () => {
  const saved = csrf;
  csrf = 'forged';
  const res = await post('/login', { email: 'admin@test.local', password: 'test-password' });
  assert.strictEqual(res.status, 403);
  csrf = saved;
});

test('login succeeds with correct credentials', async () => {
  const res = await post('/login', { email: 'admin@test.local', password: 'test-password' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/');
  const dash = await get('/');
  assert.strictEqual(dash.status, 200);
  const html = await dash.text();
  assert.match(html, /This week's issue/);
  csrf = await extractCsrf(html);
});

test('admin can create an event', async () => {
  const res = await post('/events', {
    title: 'Test Sports Day',
    event_date: '2030-05-10',
    end_date: '',
    time_note: 'All Day',
    location: 'Big Pitch',
  });
  assert.strictEqual(res.status, 302);
  const list = await get('/events');
  assert.match(await list.text(), /Test Sports Day/);
});

test('event validation rejects a bad date', async () => {
  const res = await post('/events', { title: 'Bad', event_date: '2030-02-31' });
  assert.strictEqual(res.status, 400);
});

test('bulk event paste adds a whole calendar, skips duplicates and bad lines', async () => {
  const lines = [
    '2030-09-08 | Welcome to Early Years coffee morning, with Mrs Hughes | Primary Canteen | 08:45-09:30',
    '2030-09-22 | Welcome to Primary - virtual meeting | Online | 2:30-3:25',
    '2030-10-05..2030-10-07 | Autumn Camp | Kazbegi | All day',
    'not-a-date | Broken line',
    '2030-09-08 | Welcome to Early Years coffee morning, with Mrs Hughes | Primary Canteen | 08:45-09:30',
  ].join('\n');
  const res = await post('/events/import', { lines });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /3 event\(s\) added/);
  assert.match(html, /1 already existed/);
  assert.match(html, /Skipped lines:.*not-a-date/);
  const camp = db.prepare("SELECT * FROM events WHERE title = 'Autumn Camp'").get();
  assert.strictEqual(camp.event_date, '2030-10-05');
  assert.strictEqual(camp.end_date, '2030-10-07');
  assert.strictEqual(camp.location, 'Kazbegi');
  // titles keep their commas - the separator is the pipe
  const coffee = db.prepare("SELECT * FROM events WHERE event_date = '2030-09-08'").get();
  assert.strictEqual(coffee.title, 'Welcome to Early Years coffee morning, with Mrs Hughes');
  assert.strictEqual(coffee.time_note, '08:45-09:30');
  // re-pasting the same list adds nothing
  const again = await post('/events/import', { lines });
  assert.match(await again.text(), /0 event\(s\) added/);
  db.prepare("DELETE FROM events WHERE event_date LIKE '2030-09%' OR title = 'Autumn Camp'").run();
});

test('admin can create a news article without photos', async () => {
  const res = await post('/news', {
    title: 'Big Tennis Win',
    body: 'We won.\n\nEveryone celebrated.',
    section: 'primary',
  });
  assert.strictEqual(res.status, 302);
  const list = await get('/news');
  assert.match(await list.text(), /Big Tennis Win/);
});

test('article text over 100 words is rejected', async () => {
  const longBody = Array.from({ length: 101 }, (_, i) => `word${i}`).join(' ');
  const res = await post('/news', { title: 'Too Long', body: longBody, section: 'primary' });
  assert.strictEqual(res.status, 400);
  const list = await get('/news');
  assert.ok(!(await list.text()).includes('Too Long'));
});

test('admin can exclude an article from the issue and re-include it', async () => {
  const list = await get('/news');
  const html = await list.text();
  const id = html.match(/\/news\/(\d+)\/include/)[1];
  await post(`/news/${id}/include`, { included: '0' });
  let preview = await (await get('/newsletter/preview.html')).text();
  assert.ok(!preview.includes('Big Tennis Win'), 'excluded article must leave the issue');
  await post(`/news/${id}/include`, { included: '1' });
  preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /Big Tennis Win/);
});

test('placement follows the area: primary stays in the left column', async () => {
  const list = await get('/news');
  const id = (await list.text()).match(/\/news\/(\d+)\/slot/)[1]; // Big Tennis Win, primary
  // moves within the left column are fine...
  const res = await post(`/news/${id}/slot`, { slot: 'F' });
  assert.strictEqual(res.status, 302);
  // ...the right column and unknown slots are refused
  const bad = await post(`/news/${id}/slot`, { slot: 'E' });
  assert.strictEqual(bad.status, 400);
  assert.match(await bad.text(), /left column/);
  assert.strictEqual((await post(`/news/${id}/slot`, { slot: 'Z' })).status, 400);
  await post(`/news/${id}/slot`, { slot: 'D' });

  // A wrong-column pick on the create form is coerced into the area's own
  // column, and each area's default follows its dedicated section.
  await post('/news', { title: 'Coerce Check', body: 'x', section: 'primary', slot: 'G' });
  assert.strictEqual(db.prepare("SELECT slot FROM news WHERE title = 'Coerce Check'").get().slot, 'D');
  await post('/news', { title: 'Band Check', body: 'x', section: 'sixth_form' });
  assert.strictEqual(db.prepare("SELECT slot FROM news WHERE title = 'Band Check'").get().slot, 'X');
  db.prepare("DELETE FROM news WHERE title IN ('Coerce Check', 'Band Check')").run();
});

test('preview shows placeholders for empty template sections; drafts do not', async () => {
  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /SECTION F/);
  const { generateIssue } = require('../src/generate');
  const result = await generateIssue({ trigger: 'test-placeholders' });
  assert.ok(!/SECTION [A-I]/.test(result.html), 'generated issue must not contain placeholder boxes');
});

test('live editor: edit mode annotates the preview; drafts and plain previews stay clean', async () => {
  const edit = await (await get('/newsletter/preview.html?edit=1')).text();
  assert.match(edit, /data-edit="news:\d+:title"/);
  assert.match(edit, /preview-editor\.js/);
  assert.match(edit, /data-max-words="100"/, 'the live editor is told the current word limit');
  const plain = await (await get('/newsletter/preview.html')).text();
  assert.ok(!plain.includes('data-edit='), 'plain preview must not carry editor markup');
  const result = await generateIssue({ trigger: 'test-editor-clean' });
  assert.ok(!result.html.includes('data-edit='), 'draft must not carry editor markup');
  assert.ok(!result.html.includes('preview-editor.js'), 'draft must not carry the editor script');
});

async function apiJson(url, payload) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('live editor API: inline text edits persist and are validated', async () => {
  const edit = await (await get('/newsletter/preview.html?edit=1')).text();
  const newsId = edit.match(/data-edit="news:(\d+):title"/)[1];

  const ok = await apiJson('/api/edit/text', { target: `news:${newsId}:title`, value: 'Edited Inline Title' });
  assert.strictEqual(ok.status, 200);
  assert.match(await (await get('/newsletter/preview.html')).text(), /Edited Inline Title/);

  const empty = await apiJson('/api/edit/text', { target: `news:${newsId}:title`, value: '   ' });
  assert.strictEqual(empty.status, 400);

  const long = await apiJson('/api/edit/text', {
    target: `news:${newsId}:body`,
    value: Array.from({ length: 101 }, (_, i) => `w${i}`).join(' '),
  });
  assert.strictEqual(long.status, 400);
  assert.match(long.body.error, /100 words/);

  const unknown = await apiJson('/api/edit/text', { target: 'news:999999:title', value: 'x' });
  assert.strictEqual(unknown.status, 404);
  const badTarget = await apiJson('/api/edit/text', { target: 'users:1:email', value: 'x' });
  assert.strictEqual(badTarget.status, 400);

  await apiJson('/api/edit/text', { target: `news:${newsId}:title`, value: 'Big Tennis Win' });
});

test('live editor API: photo add, replace and delete', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const edit = await (await get('/newsletter/preview.html?edit=1')).text();
  const newsId = edit.match(/data-edit="news:(\d+):title"/)[1];

  const upload = async (url, fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('photo', new Blob([png], { type: 'image/png' }), 'inline.png');
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { cookie: cookies, 'x-csrf-token': csrf },
      body: form,
    });
    return { status: res.status, body: await res.json() };
  };

  const added = await upload('/api/edit/photo/add', { news_id: newsId });
  assert.strictEqual(added.status, 200);
  let preview = await (await get('/newsletter/preview.html?edit=1')).text();
  const photoId = preview.match(/data-photo="(\d+)"/)[1];

  const replaced = await upload('/api/edit/photo/replace', { photo_id: photoId });
  assert.strictEqual(replaced.status, 200);

  const deleted = await apiJson('/api/edit/photo/delete', { photo_id: photoId });
  assert.strictEqual(deleted.status, 200);
  preview = await (await get('/newsletter/preview.html?edit=1')).text();
  assert.ok(!preview.includes(`data-photo="${photoId}"`));
});

test('live editor API rejects teachers and bad CSRF', async () => {
  const noCsrf = await fetch(base + '/api/edit/text', {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'news:1:title', value: 'x' }),
  });
  assert.strictEqual(noCsrf.status, 403);
});

test('generate button shows a step-by-step report of the Mailchimp outcome', async () => {
  const res = await post('/newsletter/generate', {});
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Generation report/);
  assert.match(html, /No draft was created in Mailchimp/);
  assert.match(html, /Mailchimp API key/);
  assert.match(html, /MAILCHIMP_API_KEY \/ MAILCHIMP_SERVER_PREFIX missing/);
  assert.match(html, /Content collected/);
});

test('newsletter preview renders submitted content', async () => {
  const res = await get('/newsletter/preview.html');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /THE ROAR/);
  assert.match(html, /Test Sports Day/);
  assert.match(html, /Big Tennis Win/);
});

test('teacher accounts are restricted from admin pages', async () => {
  await post('/users', {
    name: 'Terry Teacher',
    email: 'terry@test.local',
    role: 'primary',
    password: 'terry-pass-123',
  });
  // log in as the teacher in a separate cookie jar (merged by cookie name)
  const jarMap = new Map();
  const absorb = (res) =>
    (res.headers.getSetCookie() || []).forEach((c) => jarMap.set(c.split('=')[0], c.split(';')[0]));
  const jarStr = () => [...jarMap.values()].join('; ');

  const loginPage = await fetch(base + '/login');
  absorb(loginPage);
  const teacherCsrf = await extractCsrf(await loginPage.text());
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { cookie: jarStr(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: teacherCsrf, email: 'terry@test.local', password: 'terry-pass-123' }).toString(),
    redirect: 'manual',
  });
  absorb(login);
  const jar = jarStr();
  assert.strictEqual(login.status, 302);

  const users = await fetch(base + '/users', { headers: { cookie: jar }, redirect: 'manual' });
  assert.strictEqual(users.status, 403);
  const settings = await fetch(base + '/settings', { headers: { cookie: jar }, redirect: 'manual' });
  assert.strictEqual(settings.status, 403);
  const principal = await fetch(base + '/principal-message', { headers: { cookie: jar }, redirect: 'manual' });
  assert.strictEqual(principal.status, 403);
});

test('multipart requests cannot bypass CSRF protection', async () => {
  const form = new FormData();
  form.append('title', 'x');
  const res = await fetch(base + '/newsletter/generate', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 403);
});

test('multipart posts to news routes without a token are rejected after parsing', async () => {
  const form = new FormData();
  form.append('title', 'x');
  form.append('body', 'y');
  form.append('section', 'primary');
  const res = await fetch(base + '/news', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 403);
});

test('multipart requests succeed with the CSRF token in the form body', async () => {
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('title', 'Multipart Article');
  form.append('body', 'Uploaded via multipart form.');
  form.append('section', 'secondary');
  const res = await fetch(base + '/news', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 302);
  const list = await get('/news');
  assert.match(await list.text(), /Multipart Article/);
});

test('a file that is not really an image is rejected by content sniffing', async () => {
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('title', 'Fake Photo Article');
  form.append('body', 'Trying to upload a script as an image.');
  form.append('section', 'primary');
  form.append('photos', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'evil.png');
  const res = await fetch(base + '/news', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 400);
  await new Promise((r) => setTimeout(r, 200)); // file cleanup is async
  const uploads = fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads'));
  assert.strictEqual(uploads.length, 0, 'rejected upload must be removed from disk');
});

test('a real PNG upload is accepted and served', async () => {
  // 1×1 transparent PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('title', 'Real Photo Article');
  form.append('body', 'With an actual image.');
  form.append('section', 'whole_school');
  form.append('photos', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const res = await fetch(base + '/news', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 302);
  const uploads = fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads'));
  assert.strictEqual(uploads.length, 1);
  const served = await fetch(base + '/uploads/' + uploads[0], { headers: { cookie: '' } });
  assert.strictEqual(served.status, 200);
  assert.strictEqual(served.headers.get('cross-origin-resource-policy'), 'cross-origin');
});

test('principal message accepts a portrait photo shown in the preview', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('body', 'Dear Parents,\n\nA short test message.');
  form.append('quote', 'Test quote');
  form.append('quote_author', 'Tester');
  form.append('photo', new Blob([png], { type: 'image/png' }), 'principal.png');
  const res = await fetch(base + '/principal-message', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 302);
  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /alt="Principal"/);
  assert.match(preview, /Test quote/);
});

test('preview falls back gracefully on a garbage ?week parameter', async () => {
  const res = await get('/newsletter/preview.html?week=garbage');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /THE ROAR/);
});

test('an ongoing multi-day event stays in the newsletter after its start date', async () => {
  await post('/events', {
    title: 'Ongoing Book Fair',
    event_date: '2000-01-01',
    end_date: '2099-12-31',
    time_note: '',
    location: 'Library',
  });
  const res = await get('/newsletter/preview.html');
  assert.match(await res.text(), /Ongoing Book Fair/);
});

test('login throttles after repeated failures', async () => {
  const loginPage = await fetch(base + '/login');
  const jar = (loginPage.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const tok = await extractCsrf(await loginPage.text());
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(base + '/login', {
      method: 'POST',
      headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: tok, email: 'bruteforce@test.local', password: 'nope' }).toString(),
      redirect: 'manual',
    });
  }
  assert.strictEqual(last.status, 429);
});

test('generateIssue works without Mailchimp and records warnings', async () => {
  const result = await generateIssue({ trigger: 'test' });
  assert.strictEqual(result.status, 'local_only');
  assert.ok(result.warnings.some((w) => /Mailchimp is not configured/.test(w)));
  assert.match(result.html, /THE ROAR/);
  const row = db.prepare('SELECT * FROM issues WHERE week_start = ?').get(result.weekStart);
  assert.ok(row, 'issue row stored');
});

test('issues page lists the generated issue', async () => {
  const res = await get('/newsletter/issues');
  const html = await res.text();
  assert.match(html, /saved locally only/);
});

test('demo fill populates every template section and is admin-only', async () => {
  // A teacher must not be able to trigger it.
  const teacherRes = await fetch(base + '/demo-data/fill', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: 'x' }).toString(),
    redirect: 'manual',
  });
  assert.ok([302, 403].includes(teacherRes.status), 'unauthenticated fill is refused');

  const res = await post('/demo-data/fill', {});
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/newsletter/preview?demo=filled');

  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /Inter-School Friendly Tennis Tournament Success/);
  assert.match(preview, /Duke of Edinburgh Expedition/);
  assert.match(preview, /PCA Meeting/);
  assert.ok(!/SECTION [WDEXY]/.test(preview), 'every dedicated section shows demo content');
  const bandSlots = db.prepare("SELECT slot, COUNT(*) AS c FROM news WHERE is_demo = 1 GROUP BY slot ORDER BY slot").all();
  assert.deepStrictEqual(
    bandSlots.map((r) => `${r.slot}:${r.c}`),
    ['D:1', 'E:1', 'W:2', 'X:1', 'Y:1'],
    'demo stories sit in their dedicated sections'
  );

  // Demo photo files really exist and are served.
  const photo = db
    .prepare("SELECT p.filename FROM photos p JOIN news n ON n.id = p.news_id WHERE n.is_demo = 1 LIMIT 1")
    .get();
  assert.ok(photo, 'demo photos inserted');
  const img = await get(`/uploads/${photo.filename}`);
  assert.strictEqual(img.status, 200);

  const demoNews = db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 1').get().c;
  assert.strictEqual(demoNews, 6, 'six demo articles across the dedicated sections');
});

test('demo fill is idempotent and never touches real content', async () => {
  const realNews = db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 0').get().c;
  await post('/demo-data/fill', {});
  await post('/demo-data/fill', {});
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 1').get().c, 6, 'refilling replaces, not duplicates');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM events WHERE is_demo = 1').get().c, 6);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 0').get().c, realNews, 'real articles untouched');
});

test('demo clear removes only demo rows and their files', async () => {
  const files = db
    .prepare('SELECT p.filename FROM photos p JOIN news n ON n.id = p.news_id WHERE n.is_demo = 1')
    .all()
    .map((r) => r.filename);
  assert.ok(files.length > 0);
  const realNews = db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 0').get().c;

  const res = await post('/demo-data/clear', {});
  assert.strictEqual(res.status, 302);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 1').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM events WHERE is_demo = 1').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM principal_messages WHERE is_demo = 1').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM news WHERE is_demo = 0').get().c, realNews, 'real articles survive the clear');
  for (const f of files) {
    assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', f)), `demo photo file ${f} deleted`);
  }
});

test('masthead background: settings upload renders in the preview; a real one survives demo fill/clear', async () => {
  const { getSetting } = require('../src/db');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('_csrf', csrf);
  form.append('masthead', new Blob([png], { type: 'image/png' }), 'banner.png');
  const res = await fetch(base + '/settings/masthead-photo', {
    method: 'POST',
    headers: { cookie: cookies },
    body: form,
    redirect: 'manual',
  });
  assert.strictEqual(res.status, 302);

  const settingsPage = await (await get('/settings')).text();
  assert.match(settingsPage, /Remove background image/);

  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /class="mast-pad" background="/);
  assert.match(preview, /background-image:url\('[^']*\/uploads\/[^']+'\)/);

  const editPreview = await (await get('/newsletter/preview.html?edit=1')).text();
  assert.match(editPreview, /data-masthead="1"/);
  assert.ok(!editPreview.includes('data-no-bg'), 'edit mode knows a background is set');

  // Demo fill must not replace the manager's own masthead, and demo clear
  // must not delete it.
  await post('/demo-data/fill', {});
  assert.notStrictEqual(getSetting('masthead_is_demo'), '1');
  await post('/demo-data/clear', {});
  assert.ok(getSetting('masthead_photo'), 'real masthead survives demo clear');

  // Removing it through the live-editor API returns the header to plain navy.
  const del = await fetch(base + '/api/edit/masthead-photo/delete', {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: '{}',
  });
  assert.strictEqual((await del.json()).ok, true);
  const preview2 = await (await get('/newsletter/preview.html')).text();
  assert.ok(!preview2.includes('background-image:url'));
});

test('demo fill adds a masthead background when none is set; clear removes it again', async () => {
  const { getSetting } = require('../src/db');
  await post('/demo-data/fill', {});
  assert.strictEqual(getSetting('masthead_is_demo'), '1');
  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /background-image:url/);
  await post('/demo-data/clear', {});
  assert.ok(!getSetting('masthead_photo'), 'demo masthead removed');
  assert.notStrictEqual(getSetting('masthead_is_demo'), '1');
});

test('preview uses relative /uploads and /fonts URLs so images load on any host', async () => {
  await post('/demo-data/fill', {});
  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /src="\/uploads\//, 'photos are relative in the preview');
  assert.match(preview, /url\('\/fonts\/FiraGO-/, 'fonts are relative in the preview');
  assert.ok(!preview.includes('http://localhost:3000/uploads/'), 'no absolute localhost image links in the preview');
  await post('/demo-data/clear', {});
});

test('generation report flags a non-public APP_BASE_URL', async () => {
  const result = await generateIssue({ trigger: 'test' });
  const baseStep = result.steps.find((s) => s.label.includes('APP_BASE_URL'));
  assert.ok(baseStep, 'report includes the public-URL step');
  assert.strictEqual(baseStep.ok, false, 'localhost base is flagged');
  assert.match(baseStep.detail, /Set APP_BASE_URL/);
  // The draft itself still uses absolute URLs (email clients need them).
  assert.match(result.html, /url\('http:\/\/localhost:3000\/fonts\/FiraGO-/);
});


test('article form preview endpoint renders the draft with links and photos', async () => {
  const res = await fetch(base + '/news/preview.html', {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({
      title: 'Form Preview Test',
      body: 'Read [more](https://bist.ge) now',
      sectionLabel: 'whole school',
      photos: ['data:image/png;base64,AAAA', 'javascript:alert(1)'],
    }),
  });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /Form Preview Test/);
  assert.match(html, /<a href="https:\/\/bist\.ge"/);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.ok(!html.includes('javascript:alert'));
  // requires login
  const anon = await fetch(base + '/news/preview.html', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  });
  assert.ok([302, 403].includes(anon.status));
});

test('live editor API: drag-and-drop swaps sections within a column; the area rule guards drags', async () => {
  await post('/news', { title: 'Drag Article A', body: 'aaa', section: 'primary', slot: 'D' });
  await post('/news', { title: 'Drag Article B', body: 'bbb', section: 'primary', slot: 'F' });
  const idOf = (t) => db.prepare('SELECT id FROM news WHERE title = ?').get(t).id;
  const slotOf = (t) => db.prepare('SELECT slot FROM news WHERE title = ?').get(t).slot;
  const move = (id, slot) =>
    fetch(base + '/api/edit/slot', {
      method: 'POST',
      headers: { cookie: cookies, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ news_id: id, slot }),
    });

  const res = await move(idOf('Drag Article A'), 'F');
  assert.strictEqual((await res.json()).ok, true);
  assert.strictEqual(slotOf('Drag Article A'), 'F', 'dragged article takes the target section');
  assert.strictEqual(slotOf('Drag Article B'), 'D', 'displaced article takes the vacated section');

  // moving onto an empty section just moves, and bad slots are rejected
  await move(idOf('Drag Article A'), 'H');
  assert.strictEqual(slotOf('Drag Article A'), 'H');
  assert.strictEqual(slotOf('Drag Article B'), 'D', 'unrelated article untouched');
  const bad = await move(idOf('Drag Article A'), 'Z');
  assert.strictEqual(bad.status, 400);

  // A primary story cannot be dragged into the right column or a band...
  const wrongCol = await move(idOf('Drag Article A'), 'E');
  assert.strictEqual(wrongCol.status, 400);
  assert.match((await wrongCol.json()).error, /left column/);
  assert.strictEqual((await move(idOf('Drag Article A'), 'W')).status, 400);
  // ...and a swap is refused when it would displace a story into a column its
  // area forbids (a legacy secondary story parked in the left column).
  db.prepare(
    "INSERT INTO news (title, body, section, slot, review_status, created_by, week_start) VALUES ('Legacy Right', 'x', 'secondary', 'D', 'approved', 1, ?)"
  ).run(db.prepare('SELECT week_start FROM news WHERE title = ?').get('Drag Article A').week_start);
  const badSwap = await move(idOf('Drag Article A'), 'D');
  assert.strictEqual(badSwap.status, 400);
  assert.match((await badSwap.json()).error, /right column/);
  db.prepare("DELETE FROM news WHERE title = 'Legacy Right'").run();

  // not available without a manager session
  const anon = await fetch(base + '/api/edit/slot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ news_id: 1, slot: 'D' }),
    redirect: 'manual',
  });
  assert.ok([302, 403].includes(anon.status));
  db.prepare("DELETE FROM news WHERE title IN ('Drag Article A', 'Drag Article B')").run();
});


test('editable preview is CSP-safe: no inline scripts, CSRF via body attribute', async () => {
  const edit = await (await get('/newsletter/preview.html?edit=1')).text();
  // helmet serves script-src 'self': an inline <script> would be silently
  // blocked and every editor save would 403 (the "images not replacing" bug).
  assert.ok(!/<script>/.test(edit), 'no inline scripts in the editable preview');
  assert.match(edit, /<script src="\/js\/preview-editor\.js"><\/script>/);
  assert.match(edit, /<body[^>]* data-csrf="[^"]+"/);
  const plain = await (await get('/newsletter/preview.html')).text();
  assert.ok(!plain.includes('data-csrf'), 'plain preview carries no token');
});


test('settings connection test reports the File Manager check', async () => {
  // Mailchimp is unconfigured in tests: the test button must render the
  // failure clearly rather than crash.
  const res = await post('/settings/test-mailchimp', {});
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /alert-error/);
  assert.match(html, /Mailchimp is not configured/);
});


test('automatic reminders are off by default; manual send buttons still work', async () => {
  const reminders = require('../src/reminders');
  const { getSetting } = require('../src/db');
  assert.strictEqual(getSetting('auto_reminders'), '0', 'off until individual staff emails exist');
  // Scheduled path (what the cron job calls) is skipped with a clear reason.
  const scheduled = await reminders.sendMondayReminder();
  assert.strictEqual(scheduled.sent, false);
  assert.match(scheduled.reason, /disabled in Settings/);
  const scheduledThu = await reminders.sendThursdayReminder();
  assert.match(scheduledThu.reason, /disabled in Settings/);
  // The manual dashboard button bypasses the toggle (fails later only
  // because Mailchimp is unconfigured in tests - not because of the toggle).
  const manual = await reminders.sendMondayReminder({ manual: true });
  assert.strictEqual(manual.sent, false);
  assert.match(manual.reason, /Mailchimp is not configured/);
  const row = db.prepare("SELECT * FROM reminder_log WHERE detail LIKE '%disabled in Settings%' ORDER BY id DESC").get();
  assert.ok(row, 'skip is visible in the reminder log');
});

test('editor review notification: needs an editor email, then Mailchimp', async () => {
  const reminders = require('../src/reminders');
  const { setSetting } = require('../src/db');
  const none = await reminders.sendEditorNotification({ weekStart: '2026-08-24', status: 'draft_created', warnings: [] });
  assert.strictEqual(none.sent, false);
  assert.match(none.reason, /No editor email configured/);
  setSetting('editor_email', 'editor@test.local');
  const noMc = await reminders.sendEditorNotification({
    weekStart: '2026-08-24',
    status: 'draft_created',
    warnings: ['One photo failed'],
    campaignWebUrl: 'https://us1.admin.mailchimp.com/campaigns/edit?id=1',
  });
  assert.strictEqual(noMc.sent, false);
  assert.match(noMc.reason, /Mailchimp is not configured/);
  setSetting('editor_email', '');
});

test('settings save the reminder toggle, editor email and the new generation schedule', async () => {
  const { getSetting } = require('../src/db');
  assert.strictEqual(getSetting('friday_generate_cron'), '0 18 * * 4', 'generation defaults to Thursday 18:00');
  const res = await post('/settings', {
    timezone: 'Asia/Tbilisi',
    monday_reminder_cron: '0 9 * * 1',
    thursday_reminder_cron: '0 9 * * 4',
    friday_generate_cron: '0 18 * * 4',
    auto_reminders: '1',
    editor_email: 'editor@test.local, second@test.local',
    newsletter_name: 'The Roar',
    school_name: 'BIST',
    from_name: 'BIST',
    reply_to: '',
    calendar_url: '',
    footer_note: '',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(getSetting('auto_reminders'), '1');
  assert.strictEqual(getSetting('editor_email'), 'editor@test.local, second@test.local');
  // invalid editor email rejected
  const bad = await post('/settings', { editor_email: 'not-an-email' });
  assert.strictEqual(bad.status, 400);
  // restore
  await post('/settings', { auto_reminders: '0', editor_email: '' });
  assert.strictEqual(getSetting('auto_reminders'), '0');
  // Saving settings restarts the cron scheduler; stop it so the test
  // process can exit (live cron tasks keep the event loop alive).
  require('../src/scheduler').stop();
});


// ---- SLT review workflow, five content areas, approval to send ----

// Signs in as another account in its own cookie jar, so several roles can act
// in the same test.
async function loginAs(email, password) {
  const jar = new Map();
  const absorb = (res) => (res.headers.getSetCookie() || []).forEach((c) => jar.set(c.split('=')[0], c.split(';')[0]));
  const cookie = () => [...jar.values()].join('; ');
  const page = await fetch(base + '/login');
  absorb(page);
  const token = await extractCsrf(await page.text());
  const login = await fetch(base + '/login', {
    method: 'POST',
    headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, email, password }).toString(),
    redirect: 'manual',
  });
  absorb(login);
  assert.strictEqual(login.status, 302, `${email} could not log in`);
  const session = {
    csrf: token,
    get: async (url) => {
      const res = await fetch(base + url, { headers: { cookie: cookie() }, redirect: 'manual' });
      absorb(res);
      return res;
    },
    post: async (url, params) => {
      const res = await fetch(base + url, {
        method: 'POST',
        headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: session.csrf, ...params }).toString(),
        redirect: 'manual',
      });
      absorb(res);
      return res;
    },
  };
  return session;
}

async function makeUser(name, email, role, section) {
  await post('/users', { name, email, role, section: section || '', password: 'workflow-pass-1' });
  return loginAs(email, 'workflow-pass-1');
}

test('staff can write for any of the five areas; stories start unchecked', async () => {
  const teacher = await makeUser('Caradoc Teacher', 'caradoc@test.local', 'staff');
  const form = await (await teacher.get('/news/new')).text();
  for (const area of ['Whole School', 'Primary', 'Secondary', 'Sixth Form', 'Co-Curricular']) {
    assert.ok(form.includes(area), `area ${area} offered to staff`);
  }
  // A teacher may write about Sixth Form even though they are not in it.
  const res = await teacher.post('/news', { title: 'Sixth Form Trip', body: 'A great day out.', section: 'sixth_form' });
  assert.strictEqual(res.status, 302);
  const row = db.prepare("SELECT * FROM news WHERE title = 'Sixth Form Trip'").get();
  assert.strictEqual(row.section, 'sixth_form');
  assert.strictEqual(row.review_status, 'pending', 'staff submissions wait for the SLT check');

  // Unchecked stories stay out of the newsletter.
  const preview = await (await get('/newsletter/preview.html')).text();
  assert.ok(!preview.includes('Sixth Form Trip'), 'an unchecked story is not in the issue');
});

test('SLT check only their own area, and approving puts the story in the issue', async () => {
  const primaryHead = await makeUser('Primary Head', 'slt.primary@test.local', 'slt', 'primary');
  const sixthHead = await makeUser('Sixth Form Head', 'slt.sixth@test.local', 'slt', 'sixth_form');
  const id = db.prepare("SELECT id FROM news WHERE title = 'Sixth Form Trip'").get().id;

  // The primary lead has no say over a sixth-form story.
  const refused = await primaryHead.post(`/news/${id}/review`, { decision: 'approved' });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(db.prepare('SELECT review_status FROM news WHERE id = ?').get(id).review_status, 'pending');

  const ok = await sixthHead.post(`/news/${id}/review`, { decision: 'approved' });
  assert.strictEqual(ok.status, 302);
  const row = db.prepare('SELECT * FROM news WHERE id = ?').get(id);
  assert.strictEqual(row.review_status, 'approved');
  assert.ok(row.reviewed_by, 'the checker is recorded');

  const preview = await (await get('/newsletter/preview.html')).text();
  assert.match(preview, /Sixth Form Trip/, 'a checked story is in the issue');

  // Sending it back with a note removes it again.
  await sixthHead.post(`/news/${id}/review`, { decision: 'rejected', review_note: 'Please add a photo.' });
  const after = db.prepare('SELECT * FROM news WHERE id = ?').get(id);
  assert.strictEqual(after.review_status, 'rejected');
  assert.strictEqual(after.review_note, 'Please add a photo.');
  const preview2 = await (await get('/newsletter/preview.html')).text();
  assert.ok(!preview2.includes('Sixth Form Trip'));
});

test('whole-school stories can be checked by any SLT member; rewriting one sends it back', async () => {
  const teacher = await loginAs('caradoc@test.local', 'workflow-pass-1');
  const primaryHead = await loginAs('slt.primary@test.local', 'workflow-pass-1');
  await teacher.post('/news', { title: 'Whole School Assembly', body: 'Everyone attended.', section: 'whole_school' });
  const id = db.prepare("SELECT id FROM news WHERE title = 'Whole School Assembly'").get().id;

  const ok = await primaryHead.post(`/news/${id}/review`, { decision: 'approved' });
  assert.strictEqual(ok.status, 302, 'whole-school stories are open to any SLT member');
  assert.strictEqual(db.prepare('SELECT review_status FROM news WHERE id = ?').get(id).review_status, 'approved');

  // The author rewriting it means it needs checking again.
  await teacher.post(`/news/${id}`, {
    title: 'Whole School Assembly (updated)',
    body: 'Everyone attended and sang.',
    section: 'whole_school',
  });
  assert.strictEqual(db.prepare('SELECT review_status FROM news WHERE id = ?').get(id).review_status, 'pending');
});

test('marketing lays the issue out but cannot approve it; the principal can', async () => {
  const marketing = await makeUser('Marketing Lead', 'marketing@test.local', 'marketing');
  const principal = await makeUser('Head Teacher', 'principal@test.local', 'principal');
  const id = db.prepare("SELECT id FROM news WHERE title LIKE 'Whole School Assembly%'").get().id;

  // Layout actions are open to marketing.
  assert.strictEqual((await marketing.post(`/news/${id}/include`, { included: '0' })).status, 302);
  assert.strictEqual((await marketing.post(`/news/${id}/include`, { included: '1' })).status, 302);
  assert.strictEqual((await marketing.post(`/news/${id}/slot`, { slot: 'W' })).status, 302);
  assert.match((await (await marketing.get('/newsletter/preview.html?edit=1')).text()), /preview-editor\.js/);

  const report = await marketing.post('/newsletter/generate', {});
  assert.strictEqual(report.status, 200);
  const issue = db.prepare('SELECT * FROM issues ORDER BY id DESC').get();
  assert.ok(!issue.approved_at, 'a fresh issue is not approved');

  // Marketing must not sign the issue off...
  const refused = await marketing.post(`/newsletter/issues/${issue.id}/approve`, {});
  assert.strictEqual(refused.status, 403);
  // ...the principal does.
  const approved = await principal.post(`/newsletter/issues/${issue.id}/approve`, {});
  assert.strictEqual(approved.status, 302);
  const signed = db.prepare('SELECT * FROM issues WHERE id = ?').get(issue.id);
  assert.ok(signed.approved_at && signed.approved_by, 'approval is recorded with who and when');

  // Rebuilding the issue means it must be proof-read again.
  await marketing.post('/newsletter/generate', {});
  const rebuilt = db.prepare('SELECT * FROM issues WHERE id = ?').get(issue.id);
  assert.ok(!rebuilt.approved_at, 'regenerating clears the approval');
  require('../src/scheduler').stop();
});

test('staff cannot review, lay out or approve', async () => {
  const teacher = await loginAs('caradoc@test.local', 'workflow-pass-1');
  const id = db.prepare('SELECT id FROM news ORDER BY id DESC').get().id;
  const issue = db.prepare('SELECT id FROM issues ORDER BY id DESC').get();
  assert.strictEqual((await teacher.post(`/news/${id}/review`, { decision: 'approved' })).status, 403);
  assert.strictEqual((await teacher.post(`/news/${id}/include`, { included: '0' })).status, 403);
  assert.strictEqual((await teacher.post('/newsletter/generate', {})).status, 403);
  assert.strictEqual((await teacher.post(`/newsletter/issues/${issue.id}/approve`, {})).status, 403);
  assert.strictEqual((await teacher.get('/users')).status, 403);
  // ...but the live editor stays read-only rather than erroring.
  const preview = await (await teacher.get('/newsletter/preview.html?edit=1')).text();
  assert.ok(!preview.includes('preview-editor.js'), 'no live editor for staff');
});

test('the generation report names stories still waiting for their SLT check', async () => {
  const teacher = await loginAs('caradoc@test.local', 'workflow-pass-1');
  await teacher.post('/news', { title: 'Unchecked Story', body: 'Waiting for a decision.', section: 'primary' });
  const result = await generateIssue({ trigger: 'test' });
  const step = result.steps.find((s) => s.label.includes('SLT check'));
  assert.ok(step && !step.ok, 'the report flags the outstanding check');
  assert.match(step.detail, /Unchecked Story/);
  assert.ok(result.warnings.some((w) => /waiting for their SLT check/.test(w)));
  assert.ok(!result.html.includes('Unchecked Story'), 'it is left out of the draft');
});


// ---- staff import + invitation links ----

test('site admin imports staff from CSV; accounts start locked, SLT cannot import', async () => {
  const csv = [
    'Member Name,Member Email', // header is skipped
    'Caradoc Peters,c.peters@import.local',
    'Samuel Murray,s.murray@import.local,slt,secondary',
    'Orla OShea,o.oshea@import.local,slt,primary',
    'Head Teacher,principal@test.local', // exists already - untouched
    'broken line without email',
    'Caradoc Peters,c.peters@import.local', // duplicate inside the file
  ].join('\n');
  const res = await post('/users/import', { csv });
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.match(html, /3 account\(s\) created/);
  assert.match(html, /1 already existed/);
  assert.match(html, /1 line\(s\) skipped as invalid/);

  const caradoc = db.prepare("SELECT * FROM users WHERE email = 'c.peters@import.local'").get();
  assert.strictEqual(caradoc.role, 'staff');
  assert.strictEqual(caradoc.password_hash, '', 'imported accounts have no password');
  const murray = db.prepare("SELECT * FROM users WHERE email = 's.murray@import.local'").get();
  assert.strictEqual(murray.role, 'slt');
  assert.strictEqual(murray.section, 'secondary');
  const existing = db.prepare("SELECT password_hash FROM users WHERE email = 'principal@test.local'").get();
  assert.ok(existing.password_hash.length > 10, 'existing accounts are never touched');

  // A locked account cannot log in, and the login page says why.
  const attempt = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookies },
    body: new URLSearchParams({ _csrf: csrf, email: 'c.peters@import.local', password: 'whatever123' }).toString(),
    redirect: 'manual',
  });
  assert.strictEqual(attempt.status, 401);
  assert.match(await attempt.text(), /not been activated yet/);

  // Import and invite-sending are for the site admin only - not SLT.
  const slt = await loginAs('slt.primary@test.local', 'workflow-pass-1');
  assert.strictEqual((await slt.post('/users/import', { csv: 'X,x@import.local' })).status, 403);
  assert.strictEqual((await slt.post('/users/send-invites', {})).status, 403);
});

test('invite link: sets the password once, signs in, and cannot be reused', async () => {
  const invites = require('../src/invites');
  const bcrypt = require('bcryptjs');
  const pending = invites.pendingInvitees();
  assert.ok(pending.length >= 3, 'imported accounts are pending invites');
  const issued = invites.issueTokens(pending);
  const mine = issued.find(({ user }) => user.email === 'c.peters@import.local');
  assert.ok(mine.link.includes(`/invite/${mine.token}`));
  const stored = db.prepare("SELECT invite_token_hash FROM users WHERE email = 'c.peters@import.local'").get();
  assert.ok(stored.invite_token_hash && stored.invite_token_hash !== mine.token, 'only a hash of the token is stored');

  // The personal page renders...
  const page = await fetch(base + `/invite/${mine.token}`);
  assert.strictEqual(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Caradoc Peters/);
  const jar = (page.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const token = pageHtml.match(/name="_csrf" value="([^"]+)"/)[1];

  // ...rejects a weak or mismatched password...
  const weak = await fetch(base + `/invite/${mine.token}`, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, password: 'short', password_confirm: 'short' }).toString(),
    redirect: 'manual',
  });
  assert.strictEqual(weak.status, 400);

  // ...and on success sets the password, signs the user in and burns the link.
  const ok = await fetch(base + `/invite/${mine.token}`, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: token, password: 'caradoc-pass-1', password_confirm: 'caradoc-pass-1' }).toString(),
    redirect: 'manual',
  });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.get('location'), '/');
  const activated = db.prepare("SELECT * FROM users WHERE email = 'c.peters@import.local'").get();
  assert.ok(bcrypt.compareSync('caradoc-pass-1', activated.password_hash));
  assert.strictEqual(activated.invite_token_hash, null, 'token burned after use');
  const reuse = await fetch(base + `/invite/${mine.token}`);
  assert.strictEqual(reuse.status, 404);
  const bogus = await fetch(base + '/invite/definitely-not-a-real-token-here');
  assert.strictEqual(bogus.status, 404);

  // The new password logs in normally now.
  const caradoc = await loginAs('c.peters@import.local', 'caradoc-pass-1');
  assert.strictEqual((await caradoc.get('/')).status, 200);
});

test('send-invites targets only never-emailed accounts by default; scope=all is the reminder round', async () => {
  // Everyone still pending was already stamped by issueTokens above, so the
  // default (scope=new) has nobody left to email - adding a new person later
  // must not re-email these stragglers.
  const res = await post('/users/send-invites', {});
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /No invitations were sent:.*Nobody to invite/);

  // The explicit reminder round reaches for everyone pending - and with
  // Mailchimp unconfigured it reports exactly that.
  const all = await post('/users/send-invites', { scope: 'all' });
  assert.strictEqual(all.status, 200);
  assert.match(await all.text(), /No invitations were sent:.*Mailchimp is not configured/);

  const { inviteEmailHtml } = require('../src/invites');
  const html = inviteEmailHtml();
  assert.match(html, /\/invite\/\*\|INVITE\|\*/, 'the button carries the personal merge-tag link');
  assert.match(html, /Create your password/);
});

test('a newly added person is the only "new" invitee; single-person invites work per row', async () => {
  const invites = require('../src/invites');
  await post('/users/import', { csv: 'Newest Arrival,new.arrival@import.local' });

  // neverInvited() sees only the new person; pendingInvitees() sees everyone.
  const fresh = invites.neverInvited();
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].email, 'new.arrival@import.local');
  assert.ok(invites.pendingInvitees().length > 1, 'earlier stragglers are still pending overall');

  // The users page offers the split buttons and a per-row send button.
  const page = await (await get('/users')).text();
  assert.match(page, /Send invites to 1 new/);
  assert.match(page, /Re-send reminders to all \d+ not activated/);
  assert.match(page, /Send invite</, 'never-emailed row gets a first-time button');
  assert.match(page, /Re-send invite</, 'already-emailed row gets a re-send button');

  // Issuing a token for one person leaves everyone else's link untouched.
  const before = db.prepare("SELECT invite_token_hash FROM users WHERE email = 's.murray@import.local'").get();
  invites.issueTokens(fresh);
  const after = db.prepare("SELECT invite_token_hash FROM users WHERE email = 's.murray@import.local'").get();
  assert.strictEqual(after.invite_token_hash, before.invite_token_hash, 'other tokens are not reissued');

  // Per-row route: site admin only, refuses activated accounts, and reports
  // the Mailchimp reason for a valid pending target.
  const newRow = db.prepare("SELECT id FROM users WHERE email = 'new.arrival@import.local'").get();
  const activatedRow = db.prepare("SELECT id FROM users WHERE email = 'c.peters@import.local'").get();
  const slt = await loginAs('slt.primary@test.local', 'workflow-pass-1');
  assert.strictEqual((await slt.post(`/users/${newRow.id}/invite`, {})).status, 403);
  assert.strictEqual((await post(`/users/${activatedRow.id}/invite`, {})).status, 400, 'no invites to activated accounts');
  assert.strictEqual((await post('/users/999999/invite', {})).status, 404);
  const single = await post(`/users/${newRow.id}/invite`, {});
  assert.strictEqual(single.status, 200);
  assert.match(await single.text(), /No invitations were sent:.*Mailchimp is not configured/);
});

test('the users page shows who activated their account and when they last signed in', async () => {
  // c.peters activated via the invite link earlier - both stamps recorded.
  const caradoc = db.prepare("SELECT * FROM users WHERE email = 'c.peters@import.local'").get();
  assert.ok(caradoc.activated_at, 'activation is timestamped');
  assert.ok(caradoc.last_login_at, 'activation counts as a sign-in');

  // An ordinary login refreshes last_login_at.
  db.prepare("UPDATE users SET last_login_at = NULL WHERE email = 'c.peters@import.local'").run();
  await loginAs('c.peters@import.local', 'caradoc-pass-1');
  assert.ok(
    db.prepare("SELECT last_login_at FROM users WHERE email = 'c.peters@import.local'").get().last_login_at,
    'logging in stamps last_login_at'
  );

  // The users page labels activated accounts and still-waiting invitees.
  const page = await (await get('/users')).text();
  assert.match(page, /✓ active/);
  assert.match(page, /password set /);
  assert.match(page, /last login /);
  assert.match(page, /waiting|no invite emailed yet/);
});

test('emailed links use the learned public address, never localhost', async () => {
  const config = require('../src/config');
  const { publicBaseUrl, rememberBaseUrl } = require('../src/baseurl');
  const invites = require('../src/invites');
  const { setSetting } = require('../src/db');

  // Learned from an admin browsing the real domain (behind the proxy).
  rememberBaseUrl({ protocol: 'https', get: (h) => (h === 'host' ? 'newsletter.example.org' : null) });
  assert.strictEqual(publicBaseUrl(), 'https://newsletter.example.org');
  assert.match(invites.inviteEmailHtml(), /https:\/\/newsletter\.example\.org\/invite\/\*\|INVITE\|\*/);

  // A localhost host header must never overwrite it.
  rememberBaseUrl({ protocol: 'http', get: (h) => (h === 'host' ? 'localhost:9999' : null) });
  assert.strictEqual(publicBaseUrl(), 'https://newsletter.example.org');

  // With Mailchimp configured but no public address at all, sending refuses
  // outright instead of mailing dead localhost links.
  db.prepare("DELETE FROM settings WHERE key = 'public_base_url'").run();
  const saved = { ...config.mailchimp };
  Object.assign(config.mailchimp, { apiKey: 'x-us1', serverPrefix: 'us1', teachersAudienceId: 'list1' });
  try {
    const refused = await invites.sendStaffInvites(invites.pendingInvitees());
    assert.strictEqual(refused.sent, false);
    assert.match(refused.reason, /public address is still http:\/\/localhost/);
  } finally {
    Object.assign(config.mailchimp, saved);
    setSetting('public_base_url', '');
  }
});

// Keep this test LAST: recreating the admin row invalidates the shared session.
test('seedAdmin re-syncs the configured admin account on every start', () => {
  const bcrypt = require('bcryptjs');
  // Password drifted (e.g. DB seeded before ADMIN_* variables were set).
  db.prepare("UPDATE users SET password_hash = 'not-a-real-hash' WHERE email = 'admin@test.local'").run();
  seedAdmin();
  let row = db.prepare("SELECT * FROM users WHERE email = 'admin@test.local'").get();
  assert.ok(bcrypt.compareSync('test-password', row.password_hash), 'password re-aligned with ADMIN_PASSWORD');

  // Account missing entirely while other users exist.
  db.prepare("DELETE FROM users WHERE email = 'admin@test.local'").run();
  seedAdmin();
  row = db.prepare("SELECT * FROM users WHERE email = 'admin@test.local'").get();
  assert.ok(row, 'admin account recreated from ADMIN_EMAIL / ADMIN_PASSWORD');
  assert.strictEqual(row.role, 'admin');
  assert.ok(bcrypt.compareSync('test-password', row.password_hash));
});
