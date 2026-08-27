const express = require('express');
const cron = require('node-cron');
const { allSettings, getSetting, setSetting } = require('../db');
const { requireRole, csrfOk } = require('../auth');
const { upload, isRealImage, removeFiles } = require('../uploads');
const mailchimp = require('../mailchimp');
const scheduler = require('../scheduler');
const config = require('../config');

const router = express.Router();

function settingsLocals(overrides = {}) {
  return {
    settings: allSettings(),
    saved: false,
    errors: [],
    mailchimpConfigured: mailchimp.isConfigured(),
    audienceId: config.mailchimp.audienceId,
    teachersAudienceId: config.mailchimp.teachersAudienceId,
    testResult: null,
    mastheadPhoto: getSetting('masthead_photo') || null,
    ...overrides,
  };
}

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
  res.render('settings', settingsLocals({ saved: req.query.saved === '1' }));
});

// Masthead background image (behind "THE ROAR" in the header). Stored as a
// setting; the CDN copy is re-uploaded on the next generation.
router.post('/settings/masthead-photo', requireRole('principal', 'admin'), (req, res, next) => {
  upload.single('masthead')(req, res, (err) => {
    const cleanup = () => removeFiles(req.file ? [req.file.filename] : []);
    if (err) {
      cleanup();
      err.status = 400;
      err.expose = true;
      return next(err);
    }
    if (!csrfOk(req)) {
      cleanup();
      return res.status(403).send('Invalid CSRF token. Go back, reload the page and try again.');
    }
    if (!req.file) {
      return res.status(400).render('settings', { ...settingsLocals(), errors: ['Choose an image file to upload.'] });
    }
    if (!isRealImage(req.file)) {
      cleanup();
      return res
        .status(400)
        .render('settings', { ...settingsLocals(), errors: [`"${req.file.originalname}" is not a valid image file.`] });
    }
    const old = getSetting('masthead_photo');
    if (old) removeFiles([old]);
    setSetting('masthead_photo', req.file.filename);
    setSetting('masthead_photo_mailchimp_url', '');
    setSetting('masthead_is_demo', '');
    res.redirect('/settings?saved=1');
  });
});

router.post('/settings/masthead-photo/delete', requireRole('principal', 'admin'), (req, res) => {
  const old = getSetting('masthead_photo');
  if (old) removeFiles([old]);
  setSetting('masthead_photo', '');
  setSetting('masthead_photo_mailchimp_url', '');
  setSetting('masthead_is_demo', '');
  res.redirect('/settings?saved=1');
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
    return res.status(400).render('settings', settingsLocals({ settings: { ...allSettings(), ...updates }, errors }));
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
      // Also prove that image hosting works: newsletter photos are uploaded
      // to the File Manager so receivers load them from the Mailchimp CDN.
      let fileNote;
      try {
        const url = await mailchimp.testFileManager();
        fileNote = `File Manager upload OK - photos will be hosted on the Mailchimp CDN (${new URL(url).hostname}).`;
      } catch (err) {
        fileNote = `BUT the File Manager upload failed: ${err.message} - images would break in sent emails.`;
      }
      testResult = {
        ok: !fileNote.startsWith('BUT'),
        message: `Mailchimp connection OK (${(pong && pong.health_status) || 'healthy'}). ${fileNote}`,
      };
    } catch (err) {
      testResult = { ok: false, message: err.message };
    }
    res.render('settings', settingsLocals({ testResult }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
