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

// Extracts {hour, minute, dow} from a simple cron expression ("0 18 * * 4").
// dow is ISO-style 1-7 (Mon-Sun; cron's 0 means Sunday and becomes 7).
// Falls back when the minute/hour fields are not plain integers; a non-plain
// day-of-week field falls back to the fallback's dow.
function parseCronTime(expr, fallback = { hour: 18, minute: 0, dow: 4 }) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length < 2) return fallback;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return fallback;
  }
  let dow = Number(parts[4]);
  if (!Number.isInteger(dow) || dow < 0 || dow > 7) dow = fallback.dow ?? 4;
  else if (dow === 0) dow = 7;
  return { hour, minute, dow };
}

// Monday of the working week a submission made "now" belongs to.
// Before the generation cutoff (day-of-week + time from the generation cron,
// e.g. Thursday 18:00) → this week's Monday. From the cutoff moment until
// Sunday the issue has already been assembled, so submissions roll into next
// week's issue.
function currentWeekStart(tz, date = new Date(), cutoff = null) {
  const p = tzParts(tz, date);
  const cutoffDow = (cutoff && cutoff.dow) || 5;
  if (p.weekday > cutoffDow) return addDays(p.dateStr, 8 - p.weekday);
  if (
    cutoff &&
    p.weekday === cutoffDow &&
    (p.hour > cutoff.hour || (p.hour === cutoff.hour && p.minute >= cutoff.minute))
  ) {
    return addDays(p.dateStr, 8 - p.weekday); // next Monday
  }
  return addDays(p.dateStr, 1 - p.weekday);
}

// Monday of the week whose issue should be (re)generated "now": always the
// Monday of the current calendar week - on Sat/Sun that is the Monday of the
// week that just finished. Never rolls forward, so generating on Friday
// evening or over the weekend rebuilds the finished week, not an empty one.
function issueWeekStart(tz, date = new Date()) {
  const p = tzParts(tz, date);
  return addDays(p.dateStr, 1 - p.weekday);
}

// Generation day of the week that starts on the given Monday (dow ISO 1-7;
// default Friday for backward compatibility - callers pass the cron's dow).
function weekDeadline(weekStart, dow = 5) {
  return addDays(weekStart, dow - 1);
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
  parseCronTime,
  currentWeekStart,
  issueWeekStart,
  weekDeadline,
  formatHuman,
  formatShort,
  formatIssueDate,
  isValidDateStr,
};
