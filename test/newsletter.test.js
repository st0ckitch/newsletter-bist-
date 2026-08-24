const test = require('node:test');
const assert = require('node:assert');
const { renderNewsletter, renderReminderEmail, escapeHtml, textToHtml } = require('../src/newsletter');

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
  sections: [
    {
      key: 'primary',
      label: 'Primary',
      items: [{ title: 'Tennis <win>', body: 'We won & celebrated.', photos: ['http://x/a.jpg', 'http://x/b.jpg', 'http://x/c.jpg'] }],
    },
  ],
  footerNote: '',
};

test('renderNewsletter includes all core sections', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /THE ROAR/);
  assert.match(html, /Dream big/);
  assert.match(html, /THE WEEK AHEAD/i);
  assert.match(html, /Sports Day/);
  assert.match(html, /Principal&#39;s Message/i);
  assert.match(html, /Welcome back\./);
  assert.match(html, /PRIMARY/);
  assert.match(html, /28th August, 2026/);
});

test('renderNewsletter escapes user content', () => {
  const html = renderNewsletter(baseData);
  assert.ok(!html.includes('<win>'), 'raw HTML from user content must not appear');
  assert.ok(html.includes('Tennis &lt;win&gt;'));
  assert.ok(html.includes('We won &amp; celebrated.'));
});

test('renderNewsletter lays out photos as hero + grid', () => {
  const html = renderNewsletter(baseData);
  const imgs = html.match(/<img /g) || [];
  assert.strictEqual(imgs.length, 3);
  assert.ok(html.indexOf('a.jpg') < html.indexOf('b.jpg'));
});

test('renderNewsletter omits empty sections gracefully', () => {
  const html = renderNewsletter({
    newsletterName: 'The Roar',
    schoolName: 'BIST',
    issueDate: '2026-08-28',
    quote: null,
    events: [],
    principalMessage: null,
    sections: [],
  });
  assert.match(html, /THE ROAR/);
  assert.ok(!/THE WEEK AHEAD/i.test(html));
  assert.ok(!/School News/i.test(html));
});

test('multi-day events show a range', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /&ndash;4/);
});

test('a multi-day event across a month boundary spells out the end month', () => {
  const html = renderNewsletter({
    ...baseData,
    events: [{ title: 'Book Fair', event_date: '2026-08-31', end_date: '2026-09-02', time_note: null, location: null }],
  });
  assert.ok(!html.includes('&ndash;2'), 'must not render a bare "31–2" range');
  assert.match(html, /Until 2 September/);
});

test('photo widths fit inside the 482px article content area', () => {
  const html = renderNewsletter(baseData);
  assert.match(html, /width="482"/);
  assert.match(html, /width="231"/);
  assert.ok(!/width="536"/.test(html));
  assert.ok(!/width="258"/.test(html));
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
