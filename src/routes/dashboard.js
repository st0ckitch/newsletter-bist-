const express = require('express');
const { db, getSetting } = require('../db');
const { requireLogin, canManage } = require('../auth');
const { isReviewer, canReviewSection, canLayout, canApproveIssue } = require('../roles');
const { SECTIONS } = require('../sections');
const { formatHuman, todayStr } = require('../week');
const { submissionWeekStart, generationDay, generationTimeLabel } = require('../appweek');
const { submissionStatus } = require('../reminders');
const mailchimp = require('../mailchimp');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const tz = getSetting('timezone');
  const weekStart = submissionWeekStart();
  const deadline = generationDay(weekStart);
  const today = todayStr(tz);

  const events = db
    .prepare('SELECT e.*, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.event_date >= ? ORDER BY e.event_date LIMIT 12')
    .all(today);
  const news = db
    .prepare('SELECT n.*, u.name AS author FROM news n LEFT JOIN users u ON u.id = n.created_by WHERE n.week_start = ? ORDER BY n.created_at DESC')
    .all(weekStart);
  const principalMessage = db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(weekStart) || null;
  const issue = db.prepare('SELECT * FROM issues WHERE week_start = ?').get(weekStart) || null;
  const reminderLog = db.prepare('SELECT * FROM reminder_log ORDER BY id DESC LIMIT 8').all();

  // Stories waiting for a check, narrowed to the areas this person covers.
  const awaitingReview = isReviewer(req.user)
    ? db
        .prepare(
          `SELECT n.*, u.name AS author FROM news n LEFT JOIN users u ON u.id = n.created_by
           WHERE n.review_status = 'pending' ORDER BY n.created_at DESC LIMIT 25`
        )
        .all()
        .filter((n) => canReviewSection(req.user, n.section))
    : [];

  res.render('dashboard', {
    weekStart,
    deadline,
    deadlineHuman: formatHuman(deadline),
    generateTime: generationTimeLabel(),
    weekStartHuman: formatHuman(weekStart),
    events,
    news,
    principalMessage,
    issue,
    issueWarnings: issue ? JSON.parse(issue.warnings || '[]') : [],
    submissions: submissionStatus(weekStart),
    reminderLog,
    isManager: canManage(req.user),
    isLayout: canLayout(req.user),
    canApprove: canApproveIssue(req.user),
    awaitingReview,
    sectionLabels: SECTIONS,
    myArea: req.user.section ? SECTIONS[req.user.section] || req.user.section : null,
    mailchimpConfigured: mailchimp.isConfigured(),
  });
});

module.exports = router;
