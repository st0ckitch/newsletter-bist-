const express = require('express');
const { db, getSetting } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { currentWeekStart } = require('../week');
const { generateIssue, collectWeekData, buildRenderData } = require('../generate');
const { renderNewsletter } = require('../newsletter');
const reminders = require('../reminders');

const router = express.Router();

// Live preview of the current week's newsletter, exactly as it would be
// rendered right now (embedded in the dashboard and on the preview page).
router.get('/newsletter/preview.html', requireLogin, (req, res) => {
  const tz = getSetting('timezone');
  const weekStart = req.query.week || currentWeekStart(tz);
  const html = renderNewsletter(buildRenderData(collectWeekData(weekStart)));
  res.type('html').send(html);
});

router.get('/newsletter/preview', requireLogin, (req, res) => {
  const tz = getSetting('timezone');
  const weekStart = req.query.week || currentWeekStart(tz);
  res.render('preview', { weekStart });
});

router.get('/newsletter/issues', requireLogin, (req, res) => {
  const issues = db.prepare('SELECT id, week_start, generated_at, campaign_id, campaign_web_url, status, warnings FROM issues ORDER BY week_start DESC').all();
  res.render('issues', {
    issues: issues.map((i) => ({ ...i, warnings: JSON.parse(i.warnings || '[]') })),
    generated: req.query.generated === '1',
  });
});

router.get('/newsletter/issues/:id.html', requireLogin, (req, res) => {
  const issue = db.prepare('SELECT html FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).render('error', { message: 'Issue not found.' });
  res.type('html').send(issue.html);
});

// Manual "aggregate now": renders and creates/updates the Mailchimp draft.
router.post('/newsletter/generate', requireRole('principal', 'admin'), async (req, res, next) => {
  try {
    await generateIssue({ trigger: `manual (${req.user.email})` });
    res.redirect('/newsletter/issues?generated=1');
  } catch (err) {
    next(err);
  }
});

// Manual reminder triggers for testing / chasing people outside the schedule.
router.post('/reminders/monday', requireRole('principal', 'admin'), async (req, res, next) => {
  try {
    const result = await reminders.sendMondayReminder();
    res.render('message', {
      title: 'Monday reminder',
      message: result.sent ? `Reminder sent to: ${result.recipients.join(', ')}` : `Not sent: ${result.reason}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reminders/thursday', requireRole('principal', 'admin'), async (req, res, next) => {
  try {
    const result = await reminders.sendThursdayReminder();
    res.render('message', {
      title: 'Thursday deadline reminder',
      message: result.sent ? `Reminder sent to: ${result.recipients.join(', ')}` : `Not sent: ${result.reason}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
