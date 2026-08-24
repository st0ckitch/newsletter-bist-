// Reminder emails to staff, sent through Mailchimp campaigns targeted at a
// static segment of the teachers audience.
const { db, getSetting } = require('./db');
const config = require('./config');
const mailchimp = require('./mailchimp');
const { renderReminderEmail, escapeHtml } = require('./newsletter');
const { weekDeadline, formatHuman } = require('./week');
const { submissionWeekStart } = require('./appweek');

function teachers() {
  return db.prepare("SELECT * FROM users WHERE role IN ('primary','secondary') ORDER BY name").all();
}

function principals() {
  return db.prepare("SELECT * FROM users WHERE role = 'principal' ORDER BY name").all();
}

function hasSubmitted(userId, weekStart) {
  const news = db.prepare('SELECT 1 FROM news WHERE created_by = ? AND week_start = ? LIMIT 1').get(userId, weekStart);
  if (news) return true;
  const event = db.prepare('SELECT 1 FROM events WHERE created_by = ? AND week_start = ? LIMIT 1').get(userId, weekStart);
  return Boolean(event);
}

function principalHasSubmitted(weekStart) {
  return Boolean(db.prepare('SELECT 1 FROM principal_messages WHERE week_start = ?').get(weekStart));
}

function logReminder(type, weekStart, recipients, status, detail) {
  db.prepare('INSERT INTO reminder_log (type, week_start, recipients, status, detail) VALUES (?, ?, ?, ?, ?)').run(
    type,
    weekStart,
    JSON.stringify(recipients),
    status,
    detail || null
  );
}

async function sendReminder({ type, users, subject, heading, headingColor, bodyHtml, weekStart }) {
  const emails = users.map((u) => u.email);
  if (!emails.length) {
    logReminder(type, weekStart, [], 'skipped', 'No recipients.');
    return { sent: false, reason: 'No recipients.' };
  }
  if (!mailchimp.isConfigured() || !config.mailchimp.teachersAudienceId) {
    logReminder(type, weekStart, emails, 'skipped', 'Mailchimp not configured.');
    return { sent: false, reason: 'Mailchimp is not configured (API key / audience ID missing).' };
  }
  const html = renderReminderEmail({
    heading,
    headingColor,
    bodyHtml,
    buttonUrl: config.appBaseUrl,
    buttonLabel: 'Open the newsletter admin panel',
    schoolName: getSetting('school_name'),
  });
  const memberNames = Object.fromEntries(users.map((u) => [u.email, u.name]));
  try {
    const result = await mailchimp.sendToEmails({
      listId: config.mailchimp.teachersAudienceId,
      emails,
      subject,
      title: `${type} reminder ${weekStart} (${new Date().toISOString().slice(0, 16)})`,
      html,
      fromName: getSetting('from_name'),
      replyTo: getSetting('reply_to') || config.admin.email,
      memberNames,
      tags: ['newsletter-staff'],
    });
    const detail = result.failed.length
      ? `Could not reach: ${result.failed.map((f) => `${f.email} (${f.error})`).join('; ')}`
      : null;
    logReminder(type, weekStart, result.sentTo, result.failed.length ? 'partial' : 'sent', detail);
    return { sent: true, recipients: result.sentTo, failed: result.failed };
  } catch (err) {
    logReminder(type, weekStart, emails, 'error', err.message);
    return { sent: false, reason: err.message };
  }
}

// Monday: friendly nudge to every primary/secondary teacher and the principal.
async function sendMondayReminder() {
  const weekStart = submissionWeekStart();
  const deadline = formatHuman(weekDeadline(weekStart));
  const users = [...teachers(), ...principals()];
  const bodyHtml = `
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">Good morning!</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">A new newsletter week has started. Please add your
    <strong>upcoming events, news and photos</strong> for this week's issue of
    <strong>${escapeHtml(getSetting('newsletter_name'))}</strong> in the admin panel.</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;"><strong>Hard deadline: Thursday.</strong>
    The newsletter is assembled automatically on ${escapeHtml(deadline)} at 15:00, so late submissions will not make it in.</p>`;
  return sendReminder({
    type: 'monday',
    users,
    subject: `📝 ${getSetting('newsletter_name')}: please submit this week's newsletter content`,
    heading: 'Newsletter content needed',
    headingColor: '#3E7CB1',
    bodyHtml,
    weekStart,
  });
}

// Thursday: strict reminder, only to staff who have not submitted anything yet.
async function sendThursdayReminder() {
  const weekStart = submissionWeekStart();
  const pendingTeachers = teachers().filter((u) => !hasSubmitted(u.id, weekStart));
  const pendingPrincipals = principalHasSubmitted(weekStart) ? [] : principals();
  const users = [...pendingTeachers, ...pendingPrincipals];
  if (!users.length) {
    logReminder('thursday', weekStart, [], 'skipped', 'Everyone has already submitted.');
    return { sent: false, reason: 'Everyone has already submitted — no reminder needed.' };
  }
  const bodyHtml = `
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;"><strong>Today is the hard deadline</strong> for this
    week's issue of <strong>${escapeHtml(getSetting('newsletter_name'))}</strong> — and we have not received your content yet.</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">Please submit your events, news and photos in the
    admin panel <strong>today</strong>. The newsletter is assembled automatically tomorrow at 15:00; anything missing by
    then will not be included.</p>`;
  return sendReminder({
    type: 'thursday',
    users,
    subject: `🚨 HARD DEADLINE TODAY — ${getSetting('newsletter_name')} newsletter content missing`,
    heading: 'Hard deadline: today',
    headingColor: '#D64541',
    bodyHtml,
    weekStart,
  });
}

// Data for the dashboard: who has and has not submitted this week.
function submissionStatus(weekStart) {
  const rows = db
    .prepare("SELECT * FROM users WHERE role IN ('primary','secondary','principal') ORDER BY role, name")
    .all();
  return rows.map((u) => ({
    ...u,
    submitted: u.role === 'principal' ? principalHasSubmitted(weekStart) : hasSubmitted(u.id, weekStart),
  }));
}

module.exports = { sendMondayReminder, sendThursdayReminder, submissionStatus, hasSubmitted };
