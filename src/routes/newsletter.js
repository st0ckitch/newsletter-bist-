const express = require('express');
const { db } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { isValidDateStr } = require('../week');
const { submissionWeekStart } = require('../appweek');
const { generateIssue, collectWeekData, buildRenderData } = require('../generate');
const { renderNewsletter } = require('../newsletter');
const { fillDemoData, clearDemoData, hasDemoData } = require('../demo-data');
const reminders = require('../reminders');

const router = express.Router();

// Live preview of the current week's newsletter, exactly as it would be
// rendered right now (embedded in the dashboard and on the preview page).
router.get('/newsletter/preview.html', requireLogin, (req, res) => {
  const weekStart = isValidDateStr(req.query.week) ? req.query.week : submissionWeekStart();
  // The preview always shows the template's structure: empty sections render
  // as labelled placeholders. With ?edit=1, managers get the live editor -
  // click any text or photo to change it in place. The generated Mailchimp
  // draft contains neither placeholders nor editor markup.
  const editable = req.query.edit === '1' && ['principal', 'admin'].includes(req.user.role);
  const html = renderNewsletter(
    // baseUrl '' keeps preview images and fonts relative to this panel, so
    // they load on any host regardless of the APP_BASE_URL setting.
    buildRenderData(collectWeekData(weekStart), { placeholders: true, editable, csrf: req.session.csrf, baseUrl: '' })
  );
  res.type('html').send(html);
});

router.get('/newsletter/preview', requireLogin, (req, res) => {
  const weekStart = isValidDateStr(req.query.week) ? req.query.week : submissionWeekStart();
  res.render('preview', {
    weekStart,
    hasDemo: hasDemoData(),
    demo: ['filled', 'cleared'].includes(req.query.demo) ? req.query.demo : null,
  });
});

// Showcase mode: one click fills every template section (quote, events, all
// six article slots with photos, principal's message with portrait) with
// sample content; the second button removes exactly that again. Content staff
// wrote themselves is never modified by either.
router.post('/demo-data/fill', requireRole('principal', 'admin'), (req, res) => {
  fillDemoData(req.user.id);
  res.redirect('/newsletter/preview?demo=filled');
});

router.post('/demo-data/clear', requireRole('principal', 'admin'), (req, res) => {
  clearDemoData();
  res.redirect('/newsletter/preview?demo=cleared');
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

// Manual "aggregate now": renders, creates/updates the Mailchimp draft and
// shows a step-by-step report of exactly what happened.
router.post('/newsletter/generate', requireRole('principal', 'admin'), async (req, res, next) => {
  try {
    const result = await generateIssue({ trigger: `manual (${req.user.email})` });
    res.render('generate_report', { result });
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
