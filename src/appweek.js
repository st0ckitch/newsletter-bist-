// Settings-aware week helpers. The submission week rolls forward once the
// generation cutoff (day + time taken from the friday_generate_cron setting,
// default Thursday 18:00) has passed, so nothing can land in an
// already-generated issue; the generation week never rolls forward, so
// regenerating after the cutoff or over the weekend rebuilds the finished
// week.
const { getSetting } = require('./db');
const { currentWeekStart, issueWeekStart, parseCronTime, weekDeadline } = require('./week');

function generationCron() {
  return parseCronTime(getSetting('friday_generate_cron'));
}

function submissionWeekStart(date = new Date()) {
  const tz = getSetting('timezone');
  return currentWeekStart(tz, date, generationCron());
}

function generationWeekStart(date = new Date()) {
  return issueWeekStart(getSetting('timezone'), date);
}

// The calendar day the given week's issue is assembled (the cron's weekday).
function generationDay(weekStart) {
  return weekDeadline(weekStart, generationCron().dow);
}

// "18:00" - the generation time, for copy in emails and the panel.
function generationTimeLabel() {
  const c = generationCron();
  return `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
}

module.exports = { submissionWeekStart, generationWeekStart, generationDay, generationTimeLabel };
