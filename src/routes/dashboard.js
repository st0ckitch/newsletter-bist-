const express = require('express');
const { db, getSetting } = require('../db');
const { requireLogin, canManage } = require('../auth');
const { weekDeadline, formatHuman, todayStr } = require('../week');
const { submissionWeekStart } = require('../appweek');
const { submissionStatus } = require('../reminders');
const mailchimp = require('../mailchimp');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const tz = getSetting('timezone');
  const weekStart = submissionWeekStart();
  const deadline = weekDeadline(weekStart);
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

  res.render('dashboard', {
    weekStart,
    deadline,
    deadlineHuman: formatHuman(deadline),
    weekStartHuman: formatHuman(weekStart),
    events,
    news,
    principalMessage,
    issue,
    issueWarnings: issue ? JSON.parse(issue.warnings || '[]') : [],
    submissions: submissionStatus(weekStart),
    reminderLog,
    isManager: canManage(req.user),
    mailchimpConfigured: mailchimp.isConfigured(),
  });
});

module.exports = router;
