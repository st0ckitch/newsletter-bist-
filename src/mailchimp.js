// Thin client for the Mailchimp Marketing API v3.
// https://mailchimp.com/developer/marketing/guides/quick-start/
const crypto = require('crypto');
const config = require('./config');

function isConfigured() {
  return Boolean(config.mailchimp.apiKey && config.mailchimp.serverPrefix);
}

function baseUrl() {
  return `https://${config.mailchimp.serverPrefix}.api.mailchimp.com/3.0`;
}

class MailchimpError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'MailchimpError';
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new MailchimpError('Mailchimp is not configured (set MAILCHIMP_API_KEY and MAILCHIMP_SERVER_PREFIX).', 0);
  }
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`anystring:${config.mailchimp.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response body */
  }
  if (!res.ok) {
    const detail = json ? json.detail || json.title : text.slice(0, 300);
    throw new MailchimpError(`Mailchimp API ${method} ${path} failed (${res.status}): ${detail}`, res.status, json);
  }
  return json;
}

const subscriberHash = (email) => crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

async function ping() {
  return request('GET', '/ping');
}

// Add or update a member of an audience (used to keep teachers subscribed so
// reminder campaigns can reach them).
async function upsertMember(listId, email, name, tags = []) {
  await request('PUT', `/lists/${listId}/members/${subscriberHash(email)}`, {
    email_address: email,
    status_if_new: 'subscribed',
    merge_fields: name ? { FNAME: name } : {},
  });
  if (tags.length) {
    await request('POST', `/lists/${listId}/members/${subscriberHash(email)}/tags`, {
      tags: tags.map((t) => ({ name: t, status: 'active' })),
    });
  }
}

// Static segment = an explicit list of email addresses inside an audience.
// Members that are not part of the audience are silently dropped by Mailchimp,
// so upsert the members first.
async function createStaticSegment(listId, name, emails) {
  const seg = await request('POST', `/lists/${listId}/segments`, {
    name: name.slice(0, 100),
    static_segment: emails,
  });
  return seg.id;
}

async function createCampaign({ listId, segmentId, subject, title, fromName, replyTo }) {
  const recipients = { list_id: listId };
  if (segmentId) recipients.segment_opts = { saved_segment_id: segmentId };
  return request('POST', '/campaigns', {
    type: 'regular',
    recipients,
    settings: {
      subject_line: subject,
      title,
      from_name: fromName,
      reply_to: replyTo,
      auto_footer: false,
    },
  });
}

async function setCampaignContent(campaignId, html) {
  return request('PUT', `/campaigns/${campaignId}/content`, { html });
}

async function sendCampaign(campaignId) {
  return request('POST', `/campaigns/${campaignId}/actions/send`);
}

async function getCampaign(campaignId) {
  return request('GET', `/campaigns/${campaignId}`);
}

// Upload an image to the Mailchimp File Manager; returns a URL hosted on the
// Mailchimp CDN, safe to reference from campaign HTML.
async function uploadFile(name, buffer) {
  const file = await request('POST', '/file-manager/files', {
    name,
    file_data: buffer.toString('base64'),
  });
  return file.full_size_url;
}

// Send one-off email to a specific set of addresses: upsert them into the
// teachers audience, build a static segment, create a campaign for that
// segment and send it.
async function sendToEmails({ listId, emails, subject, title, html, fromName, replyTo, memberNames = {}, tags = [] }) {
  for (const email of emails) {
    await upsertMember(listId, email, memberNames[email], tags);
  }
  const segmentId = await createStaticSegment(listId, title, emails);
  const campaign = await createCampaign({ listId, segmentId, subject, title, fromName, replyTo });
  await setCampaignContent(campaign.id, html);
  await sendCampaign(campaign.id);
  return campaign;
}

function campaignEditUrl(campaign) {
  if (!campaign || !campaign.web_id) return null;
  return `https://${config.mailchimp.serverPrefix}.admin.mailchimp.com/campaigns/edit?id=${campaign.web_id}`;
}

module.exports = {
  isConfigured,
  ping,
  upsertMember,
  createStaticSegment,
  createCampaign,
  setCampaignContent,
  sendCampaign,
  getCampaign,
  uploadFile,
  sendToEmails,
  campaignEditUrl,
  MailchimpError,
};
