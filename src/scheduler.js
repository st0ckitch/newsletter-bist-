// Cron scheduling for the three automated jobs, in the school's timezone:
//  - Monday reminder to fill in content
//  - Thursday hard-deadline reminder to those who have not submitted
//  - Friday 15:00 aggregation + Mailchimp draft creation
const cron = require('node-cron');
const { getSetting } = require('./db');
const reminders = require('./reminders');
const { generateIssue } = require('./generate');

let jobs = [];

function schedule(expr, tz, name, fn) {
  if (!cron.validate(expr)) {
    console.error(`[scheduler] Invalid cron expression for ${name}: "${expr}" — job not scheduled.`);
    return;
  }
  const task = cron.schedule(
    expr,
    async () => {
      console.log(`[scheduler] Running job: ${name}`);
      try {
        const result = await fn();
        if (result && result.reason) console.log(`[scheduler] ${name}: ${result.reason}`);
      } catch (err) {
        console.error(`[scheduler] Job ${name} failed:`, err);
      }
    },
    { timezone: tz }
  );
  jobs.push(task);
  console.log(`[scheduler] Scheduled ${name}: "${expr}" (${tz})`);
}

function start() {
  stop();
  const tz = getSetting('timezone');
  schedule(getSetting('monday_reminder_cron'), tz, 'monday-reminder', () => reminders.sendMondayReminder());
  schedule(getSetting('thursday_reminder_cron'), tz, 'thursday-deadline-reminder', () =>
    reminders.sendThursdayReminder()
  );
  schedule(getSetting('friday_generate_cron'), tz, 'friday-generate-draft', () => generateIssue({ trigger: 'cron' }));
}

function stop() {
  for (const job of jobs) job.stop();
  jobs = [];
}

// Called after settings are saved so new cron expressions take effect
// without a restart.
function restart() {
  console.log('[scheduler] Restarting scheduled jobs with updated settings.');
  start();
}

module.exports = { start, stop, restart };
