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
  footerNote: 'Robert Snowden — Principal\nSimon Rooney — Head of Primary',
  calendarUrl: 'https://bist.ge/calendar',
};

test('renderNewsletter includes all template sections', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /THE ROAR/);
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

test('slots map onto the two columns: left column (events, D) before right column (principal, E)', () => {
  const html = renderNewsletter(baseData);
  const events = html.indexOf('Upcoming Events');
  const slotD = html.indexOf('Tennis &lt;win&gt;');
  const principal = html.indexOf('PRINCIPAL&#39;S MESSAGE');
  const slotE = html.indexOf('Khachapuri Baking');
  assert.ok(events !== -1 && slotD !== -1 && principal !== -1 && slotE !== -1);
  assert.ok(events < slotD, 'events open the left column');
  assert.ok(slotD < principal, 'left column renders before the right column');
  assert.ok(principal < slotE, "principal's message opens the right column");
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
  assert.match(html, /&ndash;4/);
  const cross = renderNewsletter({
    ...baseData,
    events: [{ title: 'Book Fair', event_date: '2026-08-31', end_date: '2026-09-02', time_note: null, location: null }],
  });
  assert.ok(!cross.includes('&ndash;2'));
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
