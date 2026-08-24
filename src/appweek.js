// Settings-aware week helpers. The submission week rolls forward once the
// Friday generation cutoff (taken from the friday_generate_cron setting) has
// passed, so nothing can land in an already-generated issue; the generation
// week never rolls forward, so regenerating late on Friday or over the
// weekend rebuilds the finished week.
const { getSetting } = require('./db');
const { currentWeekStart, issueWeekStart, parseCronTime } = require('./week');

function submissionWeekStart(date = new Date()) {
  const tz = getSetting('timezone');
  const cutoff = parseCronTime(getSetting('friday_generate_cron'));
  return currentWeekStart(tz, date, cutoff);
}

function generationWeekStart(date = new Date()) {
  return issueWeekStart(getSetting('timezone'), date);
}

module.exports = { submissionWeekStart, generationWeekStart };
