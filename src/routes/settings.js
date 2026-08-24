const express = require('express');
const cron = require('node-cron');
const { allSettings, setSetting } = require('../db');
const { requireRole } = require('../auth');
const mailchimp = require('../mailchimp');
const scheduler = require('../scheduler');
const config = require('../config');

const router = express.Router();

const EDITABLE = [
  'timezone',
  'monday_reminder_cron',
  'thursday_reminder_cron',
  'friday_generate_cron',
  'newsletter_name',
  'school_name',
  'from_name',
  'reply_to',
  'calendar_url',
  'footer_note',
];

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.get('/settings', requireRole('principal', 'admin'), (req, res) => {
  res.render('settings', {
    settings: allSettings(),
    saved: req.query.saved === '1',
    errors: [],
    mailchimpConfigured: mailchimp.isConfigured(),
    audienceId: config.mailchimp.audienceId,
    teachersAudienceId: config.mailchimp.teachersAudienceId,
    testResult: null,
  });
});

router.post('/settings', requireRole('principal', 'admin'), (req, res) => {
  const errors = [];
  const updates = {};
  for (const key of EDITABLE) {
    if (req.body[key] === undefined) continue;
    updates[key] = String(req.body[key]).trim();
  }
  for (const key of ['monday_reminder_cron', 'thursday_reminder_cron', 'friday_generate_cron']) {
    if (updates[key] !== undefined && !cron.validate(updates[key])) {
      errors.push(`"${updates[key]}" is not a valid cron expression for ${key.replace(/_/g, ' ')}.`);
    }
  }
  if (updates.timezone !== undefined && !isValidTimezone(updates.timezone)) {
    errors.push(`"${updates.timezone}" is not a valid timezone (e.g. Asia/Tbilisi).`);
  }
  if (updates.newsletter_name !== undefined && !updates.newsletter_name) {
    errors.push('Newsletter name is required.');
  }
  if (errors.length) {
    return res.status(400).render('settings', {
      settings: { ...allSettings(), ...updates },
      saved: false,
      errors,
      mailchimpConfigured: mailchimp.isConfigured(),
      audienceId: config.mailchimp.audienceId,
      teachersAudienceId: config.mailchimp.teachersAudienceId,
      testResult: null,
    });
  }
  for (const [key, value] of Object.entries(updates)) setSetting(key, value);
  scheduler.restart();
  res.redirect('/settings?saved=1');
});

router.post('/settings/test-mailchimp', requireRole('principal', 'admin'), async (req, res, next) => {
  try {
    let testResult;
    try {
      const pong = await mailchimp.ping();
      testResult = { ok: true, message: `Mailchimp connection OK: ${(pong && pong.health_status) || 'healthy'}` };
    } catch (err) {
      testResult = { ok: false, message: err.message };
    }
    res.render('settings', {
      settings: allSettings(),
      saved: false,
      errors: [],
      mailchimpConfigured: mailchimp.isConfigured(),
      audienceId: config.mailchimp.audienceId,
      teachersAudienceId: config.mailchimp.teachersAudienceId,
      testResult,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
