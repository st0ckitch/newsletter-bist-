const express = require('express');
const { db, getSetting } = require('../db');
const { requireRole } = require('../auth');
const { currentWeekStart, weekDeadline, formatHuman } = require('../week');

const router = express.Router();

router.get('/principal-message', requireRole('principal', 'admin'), (req, res) => {
  const tz = getSetting('timezone');
  const weekStart = currentWeekStart(tz);
  const message = db.prepare('SELECT * FROM principal_messages WHERE week_start = ?').get(weekStart) || null;
  res.render('principal', {
    message,
    weekStart,
    deadlineHuman: formatHuman(weekDeadline(weekStart)),
    saved: req.query.saved === '1',
    errors: [],
  });
});

router.post('/principal-message', requireRole('principal', 'admin'), (req, res) => {
  const tz = getSetting('timezone');
  const weekStart = currentWeekStart(tz);
  const body = (req.body.body || '').trim();
  const quote = (req.body.quote || '').trim() || null;
  const quote_author = (req.body.quote_author || '').trim() || null;
  if (!body) {
    return res.status(400).render('principal', {
      message: { body, quote, quote_author },
      weekStart,
      deadlineHuman: formatHuman(weekDeadline(weekStart)),
      saved: false,
      errors: ['The message text is required.'],
    });
  }
  db.prepare(
    `INSERT INTO principal_messages (week_start, body, quote, quote_author, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_start) DO UPDATE SET body = excluded.body, quote = excluded.quote,
       quote_author = excluded.quote_author, created_by = excluded.created_by, updated_at = datetime('now')`
  ).run(weekStart, body, quote, quote_author, req.user.id);
  res.redirect('/principal-message?saved=1');
});

module.exports = router;
