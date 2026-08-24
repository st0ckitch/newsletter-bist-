// Date helpers that work in the school's timezone regardless of server timezone.
// All dates are exchanged as 'YYYY-MM-DD' strings.

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function tzParts(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? 0 : parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function todayStr(tz, date = new Date()) {
  return tzParts(tz, date).dateStr;
}

// Monday of the working week a submission made "now" belongs to.
// Mon–Fri → this week's Monday. Sat/Sun → next Monday (the Friday 15:00
// cutoff has passed, so weekend submissions roll into next week's issue).
function currentWeekStart(tz, date = new Date()) {
  const p = tzParts(tz, date);
  if (p.weekday >= 6) return addDays(p.dateStr, 8 - p.weekday);
  return addDays(p.dateStr, 1 - p.weekday);
}

// Friday of the week that starts on the given Monday.
function weekDeadline(weekStart) {
  return addDays(weekStart, 4);
}

function formatHuman(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// e.g. "12th June, 2026" for the newsletter footer
function formatIssueDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const month = dt.toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const suffix =
    d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
  return `${d}${suffix} ${month}, ${y}`;
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

module.exports = {
  tzParts,
  addDays,
  todayStr,
  currentWeekStart,
  weekDeadline,
  formatHuman,
  formatShort,
  formatIssueDate,
  isValidDateStr,
};
