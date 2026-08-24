// Weekly aggregation: collects everything submitted for the week, renders the
// newsletter HTML and creates/updates the draft campaign in Mailchimp.
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('./db');
const config = require('./config');
const mailchimp = require('./mailchimp');
const { renderNewsletter } = require('./newsletter');
const { weekDeadline } = require('./week');
const { generationWeekStart } = require('./appweek');

const SECTION_LABELS = { whole_school: 'Whole School', primary: 'Primary', secondary: 'Secondary' };

function collectWeekData(weekStart) {
  const issueDate = weekDeadline(weekStart); // the Friday of that week
  // Upcoming events, including multi-day events that are already running.
  const events = db
    .prepare('SELECT * FROM events WHERE event_date >= ? OR (end_date IS NOT NULL AND end_date >= ?) ORDER BY event_date, created_at')
    .all(issueDate, issueDate);
  // Only articles the admin kept included make the issue.
  const news = db.prepare('SELECT * FROM news WHERE week_start = ? AND included = 1 ORDER BY created_at').all(weekStart);
  const photosByNews = {};
  for (const n of news) {
    photosByNews[n.id] = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(n.id);
  }
  const principalMessage = db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(weekStart) || null;
  return { weekStart, issueDate, events, news, photosByNews, principalMessage };
}

function photoPublicUrl(photo) {
  if (photo.mailchimp_url) return photo.mailchimp_url;
  return `${config.appBaseUrl}/uploads/${photo.filename}`;
}

// Push photos that have not been uploaded yet to the Mailchimp File Manager so
// the campaign references CDN-hosted images.
async function ensurePhotosUploaded(photos, warnings) {
  if (!mailchimp.isConfigured()) return;
  for (const photo of photos) {
    if (photo.mailchimp_url) continue;
    try {
      const filePath = path.join(config.uploadDir, photo.filename);
      const buffer = fs.readFileSync(filePath);
      const url = await mailchimp.uploadFile(photo.filename, buffer);
      db.prepare('UPDATE photos SET mailchimp_url = ? WHERE id = ?').run(url, photo.id);
      photo.mailchimp_url = url;
    } catch (err) {
      warnings.push(`Photo "${photo.original_name || photo.filename}" could not be uploaded to Mailchimp: ${err.message}`);
    }
  }
}

function buildRenderData(data, { placeholders = false } = {}) {
  const articles = data.news.map((n) => ({
    title: n.title,
    body: n.body,
    slot: n.slot,
    sectionLabel: SECTION_LABELS[n.section] || '',
    photos: (data.photosByNews[n.id] || []).map(photoPublicUrl),
  }));

  return {
    newsletterName: getSetting('newsletter_name'),
    schoolName: getSetting('school_name'),
    issueDate: data.issueDate,
    quote:
      data.principalMessage && data.principalMessage.quote
        ? { text: data.principalMessage.quote, author: data.principalMessage.quote_author }
        : null,
    events: data.events,
    principalMessage: data.principalMessage,
    articles,
    footerNote: getSetting('footer_note'),
    calendarUrl: getSetting('calendar_url'),
    placeholders,
  };
}

// Generates the issue for the given week (defaults to the current week):
// renders HTML, creates or updates the Mailchimp draft campaign, and records
// the result in the issues table. Never sends the campaign — staff review the
// draft in Mailchimp and press send themselves.
async function generateIssue({ weekStart, trigger = 'manual' } = {}) {
  weekStart = weekStart || generationWeekStart();
  const warnings = [];
  const data = collectWeekData(weekStart);

  if (!data.principalMessage) warnings.push("No principal's message was submitted this week.");
  if (data.news.length === 0) warnings.push('No news articles were submitted this week.');
  if (data.events.length === 0) warnings.push('There are no upcoming events on or after the issue date.');

  const allPhotos = Object.values(data.photosByNews).flat();
  await ensurePhotosUploaded(allPhotos, warnings);
  const localPhotos = allPhotos.filter((p) => !p.mailchimp_url);
  if (localPhotos.length && mailchimp.isConfigured()) {
    warnings.push(
      `${localPhotos.length} photo(s) are not on the Mailchimp CDN; the draft links to ${config.appBaseUrl}/uploads/… ` +
        'which must be publicly reachable for parents to see them.'
    );
  }

  const html = renderNewsletter(buildRenderData(data));

  let campaignId = null;
  let campaignWebUrl = null;
  let status = 'local_only';

  if (!mailchimp.isConfigured()) {
    warnings.push('Mailchimp is not configured — the draft was saved locally but no Mailchimp campaign was created.');
  } else if (!config.mailchimp.audienceId) {
    warnings.push('MAILCHIMP_AUDIENCE_ID is not set — no Mailchimp campaign was created.');
  } else {
    const subject = `${getSetting('newsletter_name')} — ${getSetting('school_name')} Weekly Newsletter`;
    const title = `${getSetting('newsletter_name')} ${data.issueDate}`;
    const existing = db
      .prepare('SELECT * FROM issues WHERE week_start = ? AND campaign_id IS NOT NULL ORDER BY id DESC')
      .get(weekStart);
    try {
      if (existing) {
        // Re-generation: try to refresh the existing draft in place.
        try {
          await mailchimp.setCampaignContent(existing.campaign_id, html);
          campaignId = existing.campaign_id;
          campaignWebUrl = existing.campaign_web_url;
        } catch (err) {
          warnings.push(`Existing draft could not be updated (${err.message}); a new draft was created instead.`);
        }
      }
      if (!campaignId) {
        const campaign = await mailchimp.createCampaign({
          listId: config.mailchimp.audienceId,
          subject,
          title,
          fromName: getSetting('from_name'),
          replyTo: getSetting('reply_to') || config.admin.email,
        });
        await mailchimp.setCampaignContent(campaign.id, html);
        campaignId = campaign.id;
        campaignWebUrl = mailchimp.campaignEditUrl(campaign);
      }
      status = 'draft_created';
    } catch (err) {
      warnings.push(`Mailchimp draft creation failed: ${err.message}`);
    }
  }

  const existingRow = db.prepare('SELECT id FROM issues WHERE week_start = ?').get(weekStart);
  if (existingRow) {
    db.prepare(
      `UPDATE issues SET generated_at = datetime('now'), campaign_id = COALESCE(?, campaign_id),
       campaign_web_url = COALESCE(?, campaign_web_url), html = ?, status = ?, warnings = ? WHERE id = ?`
    ).run(campaignId, campaignWebUrl, html, status, JSON.stringify(warnings), existingRow.id);
  } else {
    db.prepare(
      'INSERT INTO issues (week_start, campaign_id, campaign_web_url, html, status, warnings) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(weekStart, campaignId, campaignWebUrl, html, status, JSON.stringify(warnings));
  }

  console.log(
    `[generate] Issue for week ${weekStart} generated (${trigger}); status=${status}` +
      (warnings.length ? `; warnings: ${warnings.join(' | ')}` : '')
  );
  return { weekStart, issueDate: data.issueDate, html, status, campaignId, campaignWebUrl, warnings };
}

module.exports = { generateIssue, collectWeekData, buildRenderData, SECTION_LABELS };
