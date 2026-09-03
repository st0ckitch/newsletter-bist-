const express = require('express');
const { db } = require('../db');
const { requireLogin, requireLayout, requireApprover } = require('../auth');
const { canLayout, canApproveIssue } = require('../roles');
const { isValidDateStr } = require('../week');
const { submissionWeekStart, generationWeekStart } = require('../appweek');
const { generateIssue, collectWeekData, buildRenderData } = require('../generate');
const { renderNewsletter } = require('../newsletter');
const { fillDemoData, clearDemoData, hasDemoData } = require('../demo-data');
const reminders = require('../reminders');

const router = express.Router();

// Live preview of the current week's newsletter, exactly as it would be
// rendered right now (embedded in the dashboard and on the preview page).
router.get('/newsletter/preview.html', requireLogin, (req, res) => {
  // Default to the week whose issue is being assembled/proofed. After the
  // Thursday cutoff the submission week rolls to next Monday, but the team
  // keeps proofing THIS week's issue through the weekend - the preview must
  // not go blank at 18:00 on Thursday.
  const weekStart = isValidDateStr(req.query.week) ? req.query.week : generationWeekStart();
  // The preview always shows the template's structure: empty sections render
  // as labelled placeholders. With ?edit=1, managers get the live editor -
  // click any text or photo to change it in place. The generated Mailchimp
  // draft contains neither placeholders nor editor markup.
  const editable = req.query.edit === '1' && canLayout(req.user);
  const html = renderNewsletter(
    // baseUrl '' keeps preview images and fonts relative to this panel, so
    // they load on any host regardless of the APP_BASE_URL setting.
    buildRenderData(collectWeekData(weekStart), { placeholders: true, editable, csrf: req.session.csrf, baseUrl: '' })
  );
  res.type('html').send(html);
});

router.get('/newsletter/preview', requireLogin, (req, res) => {
  const weekStart = isValidDateStr(req.query.week) ? req.query.week : generationWeekStart();
  res.render('preview', {
    weekStart,
    issueWeek: generationWeekStart(),
    submissionWeek: submissionWeekStart(),
    hasDemo: hasDemoData(),
    demo: ['filled', 'cleared'].includes(req.query.demo) ? req.query.demo : null,
  });
});

// Showcase mode: one click fills every template section (quote, events, all
// six article slots with photos, principal's message with portrait) with
// sample content; the second button removes exactly that again. Content staff
// wrote themselves is never modified by either.
router.post('/demo-data/fill', requireLayout, (req, res) => {
  fillDemoData(req.user.id);
  res.redirect('/newsletter/preview?demo=filled');
});

router.post('/demo-data/clear', requireLayout, (req, res) => {
  clearDemoData();
  res.redirect('/newsletter/preview?demo=cleared');
});

router.get('/newsletter/issues', requireLogin, (req, res) => {
  const issues = db
    .prepare(
      `SELECT i.id, i.week_start, i.generated_at, i.campaign_id, i.campaign_web_url, i.status, i.warnings,
              i.approved_at, u.name AS approved_by_name
       FROM issues i LEFT JOIN users u ON u.id = i.approved_by ORDER BY i.week_start DESC`
    )
    .all();
  res.render('issues', {
    issues: issues.map((i) => ({ ...i, warnings: JSON.parse(i.warnings || '[]') })),
    generated: req.query.generated === '1',
    approved: req.query.approved === '1',
    canApprove: canApproveIssue(req.user),
  });
});

// The principal's final proof-read. Nothing is sent by the tool - approval
// records that the issue has been checked and tells marketing they may press
// Send in Mailchimp. Regenerating the issue clears it again.
router.post('/newsletter/issues/:id/approve', requireApprover, async (req, res, next) => {
  try {
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(req.params.id);
    if (!issue) return res.status(404).render('error', { message: 'Issue not found.' });
    db.prepare("UPDATE issues SET approved_by = ?, approved_at = datetime('now') WHERE id = ?").run(
      req.user.id,
      issue.id
    );
    const notified = await reminders.sendApprovalNotification({
      ...issue,
      approverName: req.user.name,
    });
    if (!notified.sent) console.log(`[approve] Approval email not sent: ${notified.reason}`);
    res.redirect('/newsletter/issues?approved=1');
  } catch (err) {
    next(err);
  }
});

router.get('/newsletter/issues/:id.html', requireLogin, (req, res) => {
  const issue = db.prepare('SELECT html FROM issues WHERE id = ?').get(req.params.id);
  if (!issue) return res.status(404).render('error', { message: 'Issue not found.' });
  res.type('html').send(issue.html);
});

// Manual "aggregate now": renders, creates/updates the Mailchimp draft and
// shows a step-by-step report of exactly what happened.
router.post('/newsletter/generate', requireLayout, async (req, res, next) => {
  try {
    const result = await generateIssue({ trigger: `manual (${req.user.email})` });
    const issue = db.prepare('SELECT id FROM issues WHERE week_start = ?').get(result.weekStart);
    res.render('generate_report', {
      result,
      issueId: issue ? issue.id : null,
      canApprove: canApproveIssue(req.user),
    });
  } catch (err) {
    next(err);
  }
});

// Manual reminder triggers for testing / chasing people outside the schedule.
router.post('/reminders/monday', requireLayout, async (req, res, next) => {
  try {
    const result = await reminders.sendMondayReminder({ manual: true });
    res.render('message', {
      title: 'Monday reminder',
      message: result.sent ? `Reminder sent to: ${result.recipients.join(', ')}` : `Not sent: ${result.reason}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reminders/thursday', requireLayout, async (req, res, next) => {
  try {
    const result = await reminders.sendThursdayReminder({ manual: true });
    res.render('message', {
      title: 'Thursday deadline reminder',
      message: result.sent ? `Reminder sent to: ${result.recipients.join(', ')}` : `Not sent: ${result.reason}`,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
