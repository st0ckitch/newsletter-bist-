const test = require('node:test');
const assert = require('node:assert');
const { renderNewsletter, renderReminderEmail, escapeHtml, textToHtml, WIDTHS } = require('../src/newsletter');

const baseData = {
  newsletterName: 'The Roar',
  schoolName: 'British International School of Tbilisi',
  issueDate: '2026-08-28',
  quote: { text: 'Dream big', author: 'Someone' },
  events: [
    { title: 'Sports Day', event_date: '2026-08-31', end_date: null, time_note: 'All Day', location: 'Big Pitch' },
    { title: 'Overnight Trip', event_date: '2026-09-03', end_date: '2026-09-04', time_note: null, location: null },
  ],
  principalMessage: { body: 'Dear Parents,\n\nWelcome back.' },
  articles: [
    {
      title: 'Tennis <win>',
      body: 'We won & celebrated.',
      slot: 'D',
      sectionLabel: 'Whole School',
      photos: ['http://x/a.jpg', 'http://x/b.jpg', 'http://x/c.jpg'],
    },
    { title: 'Khachapuri Baking', body: 'Foundation students baked.', slot: 'E', sectionLabel: 'Primary', photos: [] },
  ],
  footerNote: 'Robert Snowden - Principal\nSimon Rooney - Head of Primary',
  calendarUrl: 'https://bist.ge/calendar',
};

test('renderNewsletter includes all template sections', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /THE ROAR/);
  assert.match(html, /FiraGO/);
  assert.match(html, /font-weight:800/);
  assert.match(html, /font-weight:300/);
  assert.match(html, /NEWSLETTER BY/);
  assert.match(html, /Dream big/);
  assert.match(html, /Upcoming Events/);
  assert.match(html, /Sports Day/);
  assert.match(html, /PRINCIPAL&#39;S MESSAGE/);
  assert.match(html, /Welcome back\./);
  assert.match(html, /Khachapuri Baking/);
  assert.match(html, /28th August, 2026/);
  assert.match(html, /bist\.ge\/calendar/);
});

test('layout order: calendar and principal fixed on top, then the article columns', () => {
  const html = renderNewsletter(baseData);
  const events = html.indexOf('Upcoming Events');
  // The desktop copy of the principal block (the mobile-only copy legitimately
  // renders earlier in the source, before the fixed top block).
  const principal = html.indexOf('PRINCIPAL&#39;S MESSAGE', html.indexOf('class="desk-principal"'));
  const slotD = html.indexOf('Tennis &lt;win&gt;');
  const slotE = html.indexOf('Khachapuri Baking');
  assert.ok(events !== -1 && slotD !== -1 && principal !== -1 && slotE !== -1);
  assert.ok(events < principal, 'the calendar sits beside (before) the principal in the top block');
  assert.ok(principal < slotD, 'the fixed top block renders before any article column');
  assert.ok(slotD < slotE, 'left column (D) renders before the right column (E)');
});

test('principal portrait renders beside the message when provided', () => {
  const html = renderNewsletter({
    ...baseData,
    principalMessage: { body: 'Dear Parents', photoUrl: 'http://x/principal.jpg' },
  });
  assert.match(html, /alt="Principal"/);
  assert.match(html, /principal\.jpg/);
  const without = renderNewsletter(baseData);
  assert.ok(!/alt="Principal"/.test(without));
});

test('footer staff directory renders names and titles', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /Robert Snowden/);
  assert.match(html, /Principal</);
  assert.match(html, /Head of Primary/);
});

test('renderNewsletter escapes user content', () => {
  const html = renderNewsletter(baseData);
  assert.ok(!html.includes('<win>'), 'raw HTML from user content must not appear');
  assert.ok(html.includes('Tennis &lt;win&gt;'));
  assert.ok(html.includes('We won &amp; celebrated.'));
});

test('photos render as hero + pair grid at column widths', () => {
  const html = renderNewsletter(baseData);
  const imgs = html.match(/<img /g) || [];
  assert.strictEqual(imgs.length, 3);
  assert.ok(html.indexOf('a.jpg') < html.indexOf('b.jpg'));
  assert.match(html, new RegExp(`width="${WIDTHS.CARD_TEXT_W}"`));
  assert.match(html, new RegExp(`width="${WIDTHS.PAIR_W}"`));
});

test('empty data renders without placeholders by default', () => {
  const html = renderNewsletter({
    newsletterName: 'The Roar',
    schoolName: 'BIST',
    issueDate: '2026-08-28',
    quote: null,
    events: [],
    principalMessage: null,
    articles: [],
  });
  assert.match(html, /THE ROAR/);
  assert.ok(!/Upcoming Events/.test(html));
  assert.ok(!/SECTION [A-I]/.test(html));
});

test('placeholder mode keeps every empty template section visible', () => {
  const html = renderNewsletter({
    newsletterName: 'The Roar',
    schoolName: 'BIST',
    issueDate: '2026-08-28',
    quote: null,
    events: [],
    principalMessage: null,
    articles: [],
    placeholders: true,
  });
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    assert.match(html, new RegExp(`SECTION ${letter}`), `placeholder for section ${letter}`);
  }
});

test('placeholder mode fills a slot once an article is assigned to it', () => {
  const html = renderNewsletter({
    ...baseData,
    placeholders: true,
  });
  assert.ok(!/SECTION D/.test(html), 'slot D is filled');
  assert.ok(!/SECTION E/.test(html), 'slot E is filled');
  assert.match(html, /SECTION F/);
  assert.ok(!/SECTION B/.test(html), 'events present');
  assert.ok(!/SECTION C/.test(html), 'principal present');
});

test('multi-day events show a range; month-boundary ranges spell out the end month', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /-4/);
  const cross = renderNewsletter({
    ...baseData,
    events: [{ title: 'Book Fair', event_date: '2026-08-31', end_date: '2026-09-02', time_note: null, location: null }],
  });
  assert.ok(!cross.includes('-2'));
  assert.match(cross, /Until 2 September/);
});

test('escapeHtml covers the special characters', () => {
  assert.strictEqual(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('textToHtml splits paragraphs and line breaks', () => {
  const html = textToHtml('One\n\nTwo\nthree');
  assert.strictEqual((html.match(/<p /g) || []).length, 2);
  assert.match(html, /Two<br>three/);
});

test('renderReminderEmail renders heading, button and school name', () => {
  const html = renderReminderEmail({
    heading: 'Hard deadline: today',
    headingColor: '#C4432E',
    bodyHtml: '<p>Submit now</p>',
    buttonUrl: 'https://example.com',
    buttonLabel: 'Open panel',
    schoolName: 'BIST',
  });
  assert.match(html, /Hard deadline: today/);
  assert.match(html, /https:\/\/example\.com/);
  assert.match(html, /Open panel/);
  assert.match(html, /BIST/);
});

test('mobile: media query stacks the columns and stretches photos full-width', () => {
  const html = renderNewsletter(baseData);
  // The stylesheet rules phones get (<=640px)...
  assert.match(html, /@media only screen and \(max-width: 640px\)/);
  assert.match(html, /\.col \{ display: block !important; width: 100% !important; \}/);
  assert.match(html, /\.gutter \{ display: none !important; \}/);
  assert.match(html, /\.ph-hero, \.ph-pair \{ width: 100% !important; max-width: 100% !important; \}/);
  assert.match(html, /\.atext p \{ font-size: 16px !important;/);
  assert.match(html, /\.mast-title \{ font-size: 34px !important;/);
  // ...and the class hooks those rules target.
  assert.match(html, /class="sheet"/);
  assert.match(html, /class="ph-hero"/);
  assert.match(html, /class="ph-pair"/);
  assert.match(html, /class="atext"/);
  assert.match(html, /class="mast-title"/);
  assert.match(html, /class="dir-cell"/);
  // Email-client mobile hardening.
  assert.match(html, /x-apple-disable-message-reformatting/);
  assert.match(html, /-webkit-text-size-adjust:100%/);
});

test('mobile: desktop/tablet keeps the fixed two-column geometry', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /class="col" width="318"/);
  assert.match(html, /class="gutter" width="16"/);
  assert.match(html, /width="680"/);
});

test('mobile: reminder email carries the fluid sheet rules too', () => {
  const html = renderReminderEmail({
    heading: 'Reminder',
    headingColor: '#3E7CB1',
    bodyHtml: '<p>Hi</p>',
    buttonUrl: 'https://example.com',
    buttonLabel: 'Open',
    schoolName: 'BIST',
  });
  assert.match(html, /@media only screen and \(max-width: 640px\)/);
  assert.match(html, /class="sheet"/);
});

test('masthead background image renders email-safe with the navy fallback', () => {
  const withBg = renderNewsletter({ ...baseData, mastheadUrl: 'http://x/mast.png' });
  assert.match(withBg, /class="mast-pad" background="http:\/\/x\/mast\.png"/);
  assert.match(withBg, /background-image:url\('http:\/\/x\/mast\.png'\)/);
  assert.match(withBg, /background-size:cover/);
  assert.match(withBg, /background-color:#0d1b3e/);

  const plain = renderNewsletter(baseData);
  assert.ok(!plain.includes('background-image:url'), 'no background image when none is set');
  assert.ok(!plain.includes('data-masthead'), 'no editor annotation outside edit mode');

  const editable = renderNewsletter({ ...baseData, mastheadUrl: 'http://x/mast.png', editable: true });
  assert.match(editable, /data-masthead="1"/);
  assert.ok(!editable.includes('data-no-bg'), 'has a background, so no empty-state flag');
  const editableEmpty = renderNewsletter({ ...baseData, editable: true });
  assert.match(editableEmpty, /data-masthead="1" data-no-bg="1"/);
});

test('mobile: principal message stacks first, before events; desktop keeps it in the right column', () => {
  const html = renderNewsletter(baseData);
  const mob = html.indexOf('class="mob-principal"');
  const events = html.indexOf('Upcoming Events');
  const desk = html.indexOf('class="desk-principal"');
  assert.ok(mob !== -1 && desk !== -1, 'both principal copies present');
  assert.ok(mob < events, 'mobile principal copy comes before the events block in source order');
  // Hidden everywhere by default (incl. mso-hide for Outlook); the media query flips visibility.
  assert.match(html, /class="mob-principal" style="display:none; max-height:0; overflow:hidden; mso-hide:all;"/);
  assert.match(html, /\.mob-principal \{ display: block !important;/);
  assert.match(html, /\.desk-principal \{ display: none !important; \}/);
  // No principal message and no placeholders -> neither copy renders (the
  // CSS rules stay in the stylesheet; only the class= usages disappear).
  const none = renderNewsletter({ ...baseData, principalMessage: null });
  assert.ok(!none.includes('class="mob-principal"') && !none.includes('class="desk-principal"'));
});

test('article text: bare URLs and [text](url) become safe styled links', () => {
  const html = textToHtml('See [our site](https://bist.ge/news) and https://example.com/page?a=1&b=2. Also [x](javascript:alert(1))');
  assert.match(html, /<a href="https:\/\/bist\.ge\/news"[^>]*>our site<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com\/page\?a=1&amp;b=2"[^>]*>[^<]+<\/a>\./);
  assert.ok(!/href="javascript/.test(html), 'non-http schemes never become links');
  assert.match(html, /text-decoration:underline/);
  const plain = textToHtml('No links here.');
  assert.ok(!plain.includes('<a '), 'plain text stays plain');
});

test('drag-and-drop annotations only in editable previews', () => {
  const withIds = baseData.articles.map((a, i) => ({ ...a, id: i + 1 }));
  const editable = renderNewsletter({ ...baseData, articles: withIds, placeholders: true, editable: true });
  assert.match(editable, /data-slot-block="D"/);
  assert.match(editable, /data-drag-bar="/);
  const draft = renderNewsletter(baseData);
  assert.ok(!draft.includes('data-slot-block') && !draft.includes('data-drag-bar'), 'drafts carry no drag markup');
});

test('renderArticlePreview renders the draft article and filters photo sources', () => {
  const { renderArticlePreview } = require('../src/newsletter');
  const html = renderArticlePreview({
    title: 'Preview <Test>',
    body: 'Read [more](https://bist.ge) now',
    photos: ['data:image/png;base64,AAAA', 'javascript:alert(1)', '/uploads/x.png'],
  });
  assert.match(html, /Preview &lt;Test&gt;/);
  assert.match(html, /<a href="https:\/\/bist\.ge"/);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.match(html, /\/uploads\/x\.png/);
  assert.ok(!html.includes('javascript:alert'), 'unsafe photo sources dropped');
});
