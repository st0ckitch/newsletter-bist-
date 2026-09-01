// Staff account invitations. An imported account has no password
// (password_hash = ''): it cannot log in until its owner opens their
// personal /invite/<token> link - emailed through Mailchimp - and sets one.
//
// Only a SHA-256 of each token is stored; the raw token lives solely in the
// emailed link. Mailchimp delivers a personal link to every recipient from a
// single campaign through an INVITE merge field on the teachers audience.
const crypto = require('crypto');
const { db, getSetting } = require('./db');
const config = require('./config');
const mailchimp = require('./mailchimp');
const { renderReminderEmail, escapeHtml } = require('./newsletter');

const TOKEN_TTL_DAYS = 30;
const MERGE_TAG = 'INVITE';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Accounts that have never set a password.
function pendingInvitees() {
  return db.prepare("SELECT * FROM users WHERE password_hash = '' ORDER BY name").all();
}

// The subset that has never even been emailed an invite - what the default
// send button targets, so adding one new person emails one new person.
function neverInvited() {
  return db.prepare("SELECT * FROM users WHERE password_hash = '' AND invite_sent_at IS NULL ORDER BY name").all();
}

// Generates and stores a fresh token for each pending account; returns the
// raw tokens so the caller can put them into the emails. Re-issuing simply
// invalidates any earlier link.
function issueTokens(users = pendingInvitees()) {
  const stamp = db.prepare(
    "UPDATE users SET invite_token_hash = ?, invite_sent_at = datetime('now') WHERE id = ?"
  );
  return users.map((user) => {
    const token = crypto.randomBytes(24).toString('base64url');
    stamp.run(hashToken(token), user.id);
    return { user, token, link: `${config.appBaseUrl}/invite/${token}` };
  });
}

// The /invite/<token> lookup: valid only for an un-activated account whose
// stored hash matches and whose invite is not older than TOKEN_TTL_DAYS.
function findByToken(token) {
  if (!token || token.length < 20 || token.length > 64) return null;
  const user = db.prepare("SELECT * FROM users WHERE invite_token_hash = ? AND password_hash = ''").get(hashToken(token));
  if (!user) return null;
  if (user.invite_sent_at) {
    const age = Date.now() - new Date(`${user.invite_sent_at}Z`).getTime();
    if (age > TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
  }
  return user;
}

// Sets the password and burns the token.
function activate(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ?, invite_token_hash = NULL WHERE id = ?').run(passwordHash, userId);
}

function inviteEmailHtml() {
  const name = getSetting('newsletter_name');
  const school = getSetting('school_name');
  const bodyHtml = `
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">Hi *|FNAME|*,</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">You now have an account on the
    <strong>${escapeHtml(name)}</strong> newsletter panel - the place where ${escapeHtml(school)} staff add the
    news stories and upcoming events that go into the weekly newsletter to parents.</p>
    <p style="margin:0 0 12px 0; font-size:15px; line-height:1.5;">Press the button below to
    <strong>create your password</strong> - it takes under a minute and signs you straight in. The link is personal
    to you, so please do not forward this email.</p>`;
  return renderReminderEmail({
    heading: 'Set up your newsletter account',
    headingColor: '#1d3061',
    bodyHtml,
    buttonUrl: `${config.appBaseUrl}/invite/*|${MERGE_TAG}|*`,
    buttonLabel: 'Create your password',
    schoolName: school,
    fontBase: config.appBaseUrl,
  });
}

// One Mailchimp campaign to the given accounts (default: everyone who has
// never been emailed an invite): each member is upserted with their personal
// token in the INVITE merge field, and the email's button links to
// /invite/*|INVITE|*. Pass an explicit list to target one person, or every
// pending account for a reminder round.
async function sendStaffInvites(users = neverInvited()) {
  const pending = users.filter((u) => u.password_hash === '');
  if (!pending.length) {
    return { sent: false, reason: 'Nobody to invite - everyone selected already has a password or has been emailed.' };
  }
  if (!mailchimp.isConfigured() || !config.mailchimp.teachersAudienceId) {
    return { sent: false, reason: 'Mailchimp is not configured (API key / audience ID missing).' };
  }
  await mailchimp.ensureMergeField(config.mailchimp.teachersAudienceId, MERGE_TAG, 'Newsletter invite token');
  const issued = issueTokens(pending);
  const mergeFieldsByEmail = {};
  for (const { user, token } of issued) mergeFieldsByEmail[user.email] = { [MERGE_TAG]: token };
  const result = await mailchimp.sendToEmails({
    listId: config.mailchimp.teachersAudienceId,
    emails: issued.map(({ user }) => user.email),
    subject: `🔑 Your ${getSetting('newsletter_name')} account - create your password`,
    title: `Staff invites ${new Date().toISOString().slice(0, 16)}`,
    html: inviteEmailHtml(),
    fromName: getSetting('from_name'),
    replyTo: getSetting('reply_to') || config.admin.email,
    memberNames: Object.fromEntries(issued.map(({ user }) => [user.email, user.name])),
    mergeFieldsByEmail,
    tags: ['newsletter-staff'],
  });
  return { sent: true, sentTo: result.sentTo, failed: result.failed };
}

module.exports = { pendingInvitees, neverInvited, issueTokens, findByToken, activate, sendStaffInvites, inviteEmailHtml };
