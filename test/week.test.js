const test = require('node:test');
const assert = require('node:assert');
const {
  currentWeekStart,
  issueWeekStart,
  parseCronTime,
  weekDeadline,
  addDays,
  todayStr,
  isValidDateStr,
  formatIssueDate,
} = require('../src/week');

const TZ = 'Asia/Tbilisi'; // UTC+4, no DST

test('currentWeekStart returns Monday for a mid-week date', () => {
  // Wed 2026-08-26 12:00 Tbilisi
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-26T08:00:00Z')), '2026-08-24');
});

test('currentWeekStart on Monday returns the same day', () => {
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-24T05:00:00Z')), '2026-08-24');
});

test('currentWeekStart on Friday stays in the current week', () => {
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-28T12:00:00Z')), '2026-08-24');
});

test('weekend submissions roll into the next week', () => {
  // Sat 2026-08-29 in Tbilisi
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-29T10:00:00Z')), '2026-08-31');
  // Sun 2026-08-30
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-30T10:00:00Z')), '2026-08-31');
});

test('timezone offset is respected at day boundaries', () => {
  // Sunday 21:00 UTC = Monday 01:00 in Tbilisi (UTC+4)
  assert.strictEqual(todayStr(TZ, new Date('2026-08-23T21:00:00Z')), '2026-08-24');
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-23T21:00:00Z')), '2026-08-24');
});

test('weekDeadline is the Friday of the week', () => {
  assert.strictEqual(weekDeadline('2026-08-24'), '2026-08-28');
});

const CUTOFF = { hour: 15, minute: 0 };

test('submissions before the Friday cutoff stay in the current week', () => {
  // Fri 2026-08-28 14:59 Tbilisi (10:59 UTC)
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-28T10:59:00Z'), CUTOFF), '2026-08-24');
});

test('submissions at/after the Friday cutoff roll into next week', () => {
  // Fri 15:00 Tbilisi exactly
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-28T11:00:00Z'), CUTOFF), '2026-08-31');
  // Fri 17:00 Tbilisi
  assert.strictEqual(currentWeekStart(TZ, new Date('2026-08-28T13:00:00Z'), CUTOFF), '2026-08-31');
});

test('issueWeekStart never rolls forward', () => {
  // Fri 17:00 Tbilisi - regenerating rebuilds the finished week
  assert.strictEqual(issueWeekStart(TZ, new Date('2026-08-28T13:00:00Z')), '2026-08-24');
  // Sat and Sun still refer to the week that just finished
  assert.strictEqual(issueWeekStart(TZ, new Date('2026-08-29T10:00:00Z')), '2026-08-24');
  assert.strictEqual(issueWeekStart(TZ, new Date('2026-08-30T10:00:00Z')), '2026-08-24');
  // Mid-week: the current week
  assert.strictEqual(issueWeekStart(TZ, new Date('2026-08-26T08:00:00Z')), '2026-08-24');
});

test('parseCronTime extracts hour/minute and falls back on complex fields', () => {
  assert.deepStrictEqual(parseCronTime('0 15 * * 5'), { hour: 15, minute: 0 });
  assert.deepStrictEqual(parseCronTime('30 13 * * 5'), { hour: 13, minute: 30 });
  assert.deepStrictEqual(parseCronTime('*/5 * * * *'), { hour: 15, minute: 0 });
  assert.deepStrictEqual(parseCronTime(''), { hour: 15, minute: 0 });
  assert.deepStrictEqual(parseCronTime(null, { hour: 9, minute: 0 }), { hour: 9, minute: 0 });
});

test('addDays crosses month boundaries', () => {
  assert.strictEqual(addDays('2026-08-31', 1), '2026-09-01');
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
});

test('isValidDateStr', () => {
  assert.ok(isValidDateStr('2026-02-28'));
  assert.ok(!isValidDateStr('2026-02-30'));
  assert.ok(!isValidDateStr('26-02-01'));
  assert.ok(!isValidDateStr(''));
});

test('formatIssueDate uses ordinal suffixes', () => {
  assert.strictEqual(formatIssueDate('2026-06-12'), '12th June, 2026');
  assert.strictEqual(formatIssueDate('2026-06-01'), '1st June, 2026');
  assert.strictEqual(formatIssueDate('2026-06-22'), '22nd June, 2026');
  assert.strictEqual(formatIssueDate('2026-06-03'), '3rd June, 2026');
});
