// Reminder emails to staff, sent through Mailchimp campaigns targeted at a
// static segment of the teachers audience.
const { db, getSetting } = require('./db');
const config = require('./config');
const mailchimp = require('./mailchimp');
const { renderReminderEmail, escapeHtml } = require('./newsletter');
const { formatHuman } = require('./week');
const { submissionWeekStart, generationDay, generationTimeLabel } = require('./appweek');

// Scheduled reminders are off until real, individual staff addresses are
// configured (group addresses cannot join a Mailchimp audience). The manual
// "Send ... now" buttons bypass this - pressing them is explicit intent.
function autoRemindersEnabled() {
  return getSetting('auto_reminders') === '1';
}

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
    fontBase: config.appBaseUrl,
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
async function sendMondayReminder({ manual = false } = {}) {
  const weekStart = submissionWeekStart();
  if (!manual && !autoRemindersEnabled()) {
    logReminder('monday', weekStart, [], 'skipped', 'Automatic reminders are disabled in Settings.');
    return { sent: false, reason: 'Automatic reminders are disabled in Settings.' };
  }
  const deadline = formatHuman(generationDay(weekStart));
  const genTime = generationTimeLabel();
  const users = [...teachers(), ...principals()];
  const bodyHtml = `
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">Good morning!</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">A new newsletter week has started. Please add your
    <strong>upcoming events, news and photos</strong> for this week's issue of
    <strong>${escapeHtml(getSetting('newsletter_name'))}</strong> in the admin panel.</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">The newsletter is assembled automatically on
    <strong>${escapeHtml(deadline)} at ${escapeHtml(genTime)}</strong> - late submissions will not make it in.</p>`;
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

// Hard-deadline day: strict reminder, only to staff who have not submitted yet.
async function sendThursdayReminder({ manual = false } = {}) {
  const weekStart = submissionWeekStart();
  if (!manual && !autoRemindersEnabled()) {
    logReminder('thursday', weekStart, [], 'skipped', 'Automatic reminders are disabled in Settings.');
    return { sent: false, reason: 'Automatic reminders are disabled in Settings.' };
  }
  const pendingTeachers = teachers().filter((u) => !hasSubmitted(u.id, weekStart));
  const pendingPrincipals = principalHasSubmitted(weekStart) ? [] : principals();
  const users = [...pendingTeachers, ...pendingPrincipals];
  if (!users.length) {
    logReminder('thursday', weekStart, [], 'skipped', 'Everyone has already submitted.');
    return { sent: false, reason: 'Everyone has already submitted - no reminder needed.' };
  }
  const bodyHtml = `
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;"><strong>Today is the hard deadline</strong> for this
    week's issue of <strong>${escapeHtml(getSetting('newsletter_name'))}</strong> - and we have not received your content yet.</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">Please submit your events, news and photos in the
    admin panel <strong>today</strong>. The newsletter is assembled automatically on
    ${escapeHtml(formatHuman(generationDay(weekStart)))} at ${escapeHtml(generationTimeLabel())}; anything missing by
    then will not be included.</p>`;
  return sendReminder({
    type: 'thursday',
    users,
    subject: `🚨 HARD DEADLINE TODAY - ${getSetting('newsletter_name')} newsletter content missing`,
    heading: 'Hard deadline: today',
    headingColor: '#D64541',
    bodyHtml,
    weekStart,
  });
}

// After the scheduled generation: tell the newsletter editor(s) the draft is
// ready to review - include/exclude articles, polish it in the live editor,
// then send it from Mailchimp. Enabled by setting editor_email in Settings.
async function sendEditorNotification(result) {
  const weekStart = (result && result.weekStart) || submissionWeekStart();
  const emails = String(getSetting('editor_email') || '')
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
  if (!emails.length) {
    return { sent: false, reason: 'No editor email configured in Settings.' };
  }
  const name = getSetting('newsletter_name');
  const ok = result && result.status === 'draft_created';
  const warnings = (result && result.warnings) || [];
  const bodyHtml = `
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">This week's issue of
    <strong>${escapeHtml(name)}</strong> (week of ${escapeHtml(weekStart)}) has just been assembled${
      ok ? ' and the <strong>draft campaign is waiting in Mailchimp</strong>' : ', but <strong>no Mailchimp draft could be created</strong> - see the panel for the step-by-step report'
    }.</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;"><strong>Please review it now:</strong> open the admin
    panel to include/exclude articles, fix text and photos directly in the live editor, and regenerate if you change
    anything - then open the draft in Mailchimp and press Send. Nothing is sent automatically.</p>
    ${
      warnings.length
        ? `<p style="margin:0 0 12px 0; font-size:14px; line-height:1.5; color:#B23A32;"><strong>Warnings:</strong><br>${warnings
            .map((w) => `- ${escapeHtml(w)}`)
            .join('<br>')}</p>`
        : ''
    }
    ${
      result && result.campaignWebUrl
        ? `<p style="margin:0 0 12px 0; font-size:14px; line-height:1.5;">Direct link to the Mailchimp draft:<br><a href="${escapeHtml(
            result.campaignWebUrl
          )}">${escapeHtml(result.campaignWebUrl)}</a></p>`
        : ''
    }`;
  if (!mailchimp.isConfigured() || !config.mailchimp.teachersAudienceId) {
    logReminder('editor', weekStart, emails, 'skipped', 'Mailchimp not configured.');
    return { sent: false, reason: 'Mailchimp is not configured (API key / audience ID missing).' };
  }
  return sendReminder({
    type: 'editor',
    users: emails.map((e) => ({ email: e, name: '' })),
    subject: `🗞️ ${name}: this week's draft is ready for your review`,
    heading: 'Newsletter draft ready for review',
    headingColor: '#2F6DA3',
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

module.exports = { sendMondayReminder, sendThursdayReminder, sendEditorNotification, submissionStatus, hasSubmitted };
