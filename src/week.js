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

// Extracts {hour, minute} from a simple cron expression ("30 14 * * 5").
// Falls back when the minute/hour fields are not plain integers.
function parseCronTime(expr, fallback = { hour: 15, minute: 0 }) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length < 2) return fallback;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    return fallback;
  }
  return { hour, minute };
}

// Monday of the working week a submission made "now" belongs to.
// Mon–Thu → this week's Monday. After the Friday generation cutoff (and on
// Sat/Sun) the issue has already been assembled, so submissions roll into
// next week's issue.
function currentWeekStart(tz, date = new Date(), cutoff = null) {
  const p = tzParts(tz, date);
  if (p.weekday >= 6) return addDays(p.dateStr, 8 - p.weekday);
  if (
    cutoff &&
    p.weekday === 5 &&
    (p.hour > cutoff.hour || (p.hour === cutoff.hour && p.minute >= cutoff.minute))
  ) {
    return addDays(p.dateStr, 3); // next Monday
  }
  return addDays(p.dateStr, 1 - p.weekday);
}

// Monday of the week whose issue should be (re)generated "now": always the
// Monday of the current calendar week — on Sat/Sun that is the Monday of the
// week that just finished. Never rolls forward, so generating on Friday
// evening or over the weekend rebuilds the finished week, not an empty one.
function issueWeekStart(tz, date = new Date()) {
  const p = tzParts(tz, date);
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
  parseCronTime,
  currentWeekStart,
  issueWeekStart,
  weekDeadline,
  formatHuman,
  formatShort,
  formatIssueDate,
  isValidDateStr,
};
