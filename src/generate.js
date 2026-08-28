// Weekly aggregation: collects everything submitted for the week, renders the
// newsletter HTML and creates/updates the draft campaign in Mailchimp.
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('./db');
const config = require('./config');
const mailchimp = require('./mailchimp');
const { renderNewsletter } = require('./newsletter');
const { generationWeekStart, generationDay } = require('./appweek');

const SECTION_LABELS = { whole_school: 'Whole School', primary: 'Primary', secondary: 'Secondary' };

function collectWeekData(weekStart) {
  const issueDate = generationDay(weekStart); // the day this week's issue is assembled/sent
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

function photoPublicUrl(photo, baseUrl = config.appBaseUrl) {
  if (photo.mailchimp_url) return photo.mailchimp_url;
  return `${baseUrl}/uploads/${photo.filename}`;
}

// Push photos that have not been uploaded yet to the Mailchimp File Manager so
// the campaign references CDN-hosted images.
async function ensurePhotosUploaded(photos, warnings) {
  const counts = { already: 0, uploaded: 0, failed: 0 };
  if (!mailchimp.isConfigured()) return counts;
  for (const photo of photos) {
    if (photo.mailchimp_url) {
      counts.already += 1;
      continue;
    }
    try {
      const filePath = path.join(config.uploadDir, photo.filename);
      const buffer = fs.readFileSync(filePath);
      const url = await mailchimp.uploadFile(photo.filename, buffer);
      db.prepare('UPDATE photos SET mailchimp_url = ? WHERE id = ?').run(url, photo.id);
      photo.mailchimp_url = url;
      counts.uploaded += 1;
    } catch (err) {
      counts.failed += 1;
      warnings.push(`Photo "${photo.original_name || photo.filename}" could not be uploaded to Mailchimp: ${err.message}`);
    }
  }
  return counts;
}

// baseUrl: absolute (config.appBaseUrl) for the Mailchimp draft - email
// clients need full URLs - and '' for the in-panel preview, so preview
// images and fonts resolve relative to the panel itself and work on any
// host even before APP_BASE_URL is configured.
function buildRenderData(data, { placeholders = false, editable = false, csrf = '', baseUrl = config.appBaseUrl } = {}) {
  const articles = data.news.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    slot: n.slot,
    sectionLabel: SECTION_LABELS[n.section] || '',
    photos: (data.photosByNews[n.id] || []).map((p) => ({ id: p.id, url: photoPublicUrl(p, baseUrl) })),
  }));

  const mastheadPhoto = getSetting('masthead_photo');
  return {
    newsletterName: getSetting('newsletter_name'),
    schoolName: getSetting('school_name'),
    mastheadUrl: mastheadPhoto
      ? getSetting('masthead_photo_mailchimp_url') || `${baseUrl}/uploads/${mastheadPhoto}`
      : null,
    issueDate: data.issueDate,
    quote:
      data.principalMessage && data.principalMessage.quote
        ? { text: data.principalMessage.quote, author: data.principalMessage.quote_author, weekStart: data.weekStart }
        : null,
    events: data.events,
    principalMessage: data.principalMessage
      ? {
          body: data.principalMessage.body,
          weekStart: data.weekStart,
          photoUrl: data.principalMessage.photo
            ? data.principalMessage.photo_mailchimp_url || `${baseUrl}/uploads/${data.principalMessage.photo}`
            : null,
        }
      : null,
    articles,
    footerNote: getSetting('footer_note'),
    calendarUrl: getSetting('calendar_url'),
    fontBase: baseUrl,
    placeholders,
    editable,
    csrf,
  };
}

// Generates the issue for the given week (defaults to the current week):
// renders HTML, creates or updates the Mailchimp draft campaign, and records
// the result in the issues table. Never sends the campaign - staff review the
// draft in Mailchimp and press send themselves.
async function generateIssue({ weekStart, trigger = 'manual' } = {}) {
  weekStart = weekStart || generationWeekStart();
  const warnings = [];
  // Step-by-step diagnostic shown on the generation report page, so it is
  // obvious whether the draft really landed in Mailchimp and why not if it
  // did not.
  const steps = [];
  const step = (ok, label, detail) => steps.push({ ok, label, detail: detail || null });
  const data = collectWeekData(weekStart);

  if (!data.principalMessage) warnings.push("No principal's message was submitted this week.");
  if (data.news.length === 0) warnings.push('No news articles were submitted this week.');
  if (data.events.length === 0) warnings.push('There are no upcoming events on or after the issue date.');

  step(
    true,
    'Content collected',
    `${data.news.length} article(s), ${data.events.length} upcoming event(s), principal's message ${
      data.principalMessage ? 'present' : 'MISSING'
    }, week of ${weekStart}`
  );
  step(
    mailchimp.isConfigured(),
    'Mailchimp API key',
    mailchimp.isConfigured()
      ? `configured (server "${config.mailchimp.serverPrefix}")`
      : 'MAILCHIMP_API_KEY / MAILCHIMP_SERVER_PREFIX missing in .env'
  );
  step(
    Boolean(config.mailchimp.audienceId),
    'Parents audience ID',
    config.mailchimp.audienceId || 'MAILCHIMP_AUDIENCE_ID missing in .env - run: npm run mailchimp:setup'
  );
  // Email clients need absolute URLs for the webfonts and for any photo that
  // is not on the Mailchimp CDN - a localhost base means those break in the
  // sent email.
  const basePublic = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.appBaseUrl);
  step(
    basePublic,
    'Public app URL (APP_BASE_URL)',
    basePublic
      ? config.appBaseUrl
      : `${config.appBaseUrl} - not reachable from the internet. Set APP_BASE_URL to your public URL (e.g. https://your-app.up.railway.app) so fonts and photos load in the email.`
  );
  if (mailchimp.isConfigured()) {
    try {
      const pong = await mailchimp.ping();
      step(true, 'Mailchimp API connection', `reachable (${(pong && pong.health_status) || 'healthy'})`);
    } catch (err) {
      step(false, 'Mailchimp API connection', err.message);
    }
  }

  const allPhotos = Object.values(data.photosByNews).flat();
  const photoCounts = await ensurePhotosUploaded(allPhotos, warnings);
  if (allPhotos.length || (data.principalMessage && data.principalMessage.photo)) {
    step(
      photoCounts.failed === 0,
      'Photos on the Mailchimp CDN',
      mailchimp.isConfigured()
        ? `${photoCounts.uploaded} uploaded now, ${photoCounts.already} already hosted, ${photoCounts.failed} failed (of ${allPhotos.length})`
        : 'skipped - Mailchimp not configured, photos will use local links'
    );
  }

  // The principal's portrait moves to the Mailchimp CDN the same way.
  const pm = data.principalMessage;
  if (mailchimp.isConfigured() && pm && pm.photo && !pm.photo_mailchimp_url) {
    try {
      const buffer = fs.readFileSync(path.join(config.uploadDir, pm.photo));
      const url = await mailchimp.uploadFile(pm.photo, buffer);
      db.prepare('UPDATE principal_messages SET photo_mailchimp_url = ? WHERE id = ?').run(url, pm.id);
      pm.photo_mailchimp_url = url;
    } catch (err) {
      warnings.push(`The principal's photo could not be uploaded to Mailchimp: ${err.message}`);
    }
  }
  // The masthead background image is CDN-hosted the same way.
  const mastheadPhoto = getSetting('masthead_photo');
  if (mailchimp.isConfigured() && mastheadPhoto && !getSetting('masthead_photo_mailchimp_url')) {
    try {
      const buffer = fs.readFileSync(path.join(config.uploadDir, mastheadPhoto));
      const url = await mailchimp.uploadFile(mastheadPhoto, buffer);
      setSetting('masthead_photo_mailchimp_url', url);
    } catch (err) {
      warnings.push(`The masthead background image could not be uploaded to Mailchimp: ${err.message}`);
    }
  }

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
    warnings.push('Mailchimp is not configured - the draft was saved locally but no Mailchimp campaign was created.');
    step(false, 'Draft campaign in Mailchimp', 'NOT created - Mailchimp is not configured');
  } else if (!config.mailchimp.audienceId) {
    warnings.push('MAILCHIMP_AUDIENCE_ID is not set - no Mailchimp campaign was created.');
    step(false, 'Draft campaign in Mailchimp', 'NOT created - MAILCHIMP_AUDIENCE_ID is not set');
  } else {
    const subject = `${getSetting('newsletter_name')} - ${getSetting('school_name')} Weekly Newsletter`;
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
      step(
        true,
        'Draft campaign in Mailchimp',
        `${existing && campaignId === existing.campaign_id ? 'existing draft updated' : 'created'} (campaign id ${campaignId}) - review and send it from Mailchimp`
      );
    } catch (err) {
      warnings.push(`Mailchimp draft creation failed: ${err.message}`);
      step(false, 'Draft campaign in Mailchimp', `FAILED - ${err.message}`);
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
  return { weekStart, issueDate: data.issueDate, html, status, campaignId, campaignWebUrl, warnings, steps };
}

module.exports = { generateIssue, collectWeekData, buildRenderData, SECTION_LABELS };
