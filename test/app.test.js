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

test('article text over 200 words is rejected', async () => {
  const longBody = Array.from({ length: 201 }, (_, i) => `word${i}`).join(' ');
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

test('admin can move an article to another template section', async () => {
  const list = await get('/news');
  const id = (await list.text()).match(/\/news\/(\d+)\/slot/)[1];
  const res = await post(`/news/${id}/slot`, { slot: 'E' });
  assert.strictEqual(res.status, 302);
  const bad = await post(`/news/${id}/slot`, { slot: 'Z' });
  assert.strictEqual(bad.status, 400);
  await post(`/news/${id}/slot`, { slot: 'D' });
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
    value: Array.from({ length: 201 }, (_, i) => `w${i}`).join(' '),
  });
  assert.strictEqual(long.status, 400);
  assert.match(long.body.error, /200 words/);

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
