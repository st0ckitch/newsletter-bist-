const express = require('express');
const { db, getSetting } = require('../db');
const { requireLogin, canEditRecord } = require('../auth');
const { todayStr, isValidDateStr } = require('../week');
const { submissionWeekStart } = require('../appweek');

const router = express.Router();

function loadEvent(req, res, next) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).render('error', { message: 'Event not found.' });
  if (!canEditRecord(req.user, event)) {
    return res.status(403).render('error', { message: 'You can only edit events you created.' });
  }
  req.event = event;
  next();
}

function validate(body) {
  const errors = [];
  const title = (body.title || '').trim();
  const event_date = (body.event_date || '').trim();
  const end_date = (body.end_date || '').trim();
  if (!title) errors.push('Title is required.');
  if (!isValidDateStr(event_date)) errors.push('A valid event date is required.');
  if (end_date && !isValidDateStr(end_date)) errors.push('End date is not a valid date.');
  if (end_date && isValidDateStr(event_date) && end_date < event_date) errors.push('End date cannot be before the start date.');
  return {
    errors,
    values: {
      title,
      event_date,
      end_date: end_date || null,
      time_note: (body.time_note || '').trim() || null,
      location: (body.location || '').trim() || null,
    },
  };
}

router.get('/events', requireLogin, (req, res) => {
  const tz = getSetting('timezone');
  const today = todayStr(tz);
  const upcoming = db
    .prepare('SELECT e.*, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.event_date >= ? ORDER BY e.event_date')
    .all(today);
  const past = db
    .prepare('SELECT e.*, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.event_date < ? ORDER BY e.event_date DESC LIMIT 20')
    .all(today);
  res.render('events', { upcoming, past });
});

router.get('/events/new', requireLogin, (req, res) => {
  res.render('event_form', { event: null, errors: [] });
});

router.post('/events', requireLogin, (req, res) => {
  const { errors, values } = validate(req.body);
  if (errors.length) return res.status(400).render('event_form', { event: values, errors });
  db.prepare(
    'INSERT INTO events (title, event_date, end_date, time_note, location, created_by, week_start) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(values.title, values.event_date, values.end_date, values.time_note, values.location, req.user.id, submissionWeekStart());
  res.redirect('/events');
});

// Paste a whole calendar at once: one event per line as
//   YYYY-MM-DD | Title | Location | Time
// (location and time may be left empty; a range start..end in the date part
// covers multi-day events). Re-pasting is safe - an event with the same date
// and title as an existing one is skipped, never duplicated.
router.post('/events/import', requireLogin, (req, res) => {
  const report = { created: 0, existing: 0, invalid: [] };
  const insert = db.prepare(
    'INSERT INTO events (title, event_date, end_date, time_note, location, created_by, week_start) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const raw of String(req.body.lines || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split('|').map((c) => c.trim());
    const [datePart, title, location, timeNote] = [parts[0] || '', parts[1] || '', parts[2] || '', parts[3] || ''];
    const [startDate, endDate] = datePart.split('..').map((d) => d.trim());
    if (!isValidDateStr(startDate) || (endDate && !isValidDateStr(endDate)) || !title) {
      report.invalid.push(line.slice(0, 120));
      continue;
    }
    if (db.prepare('SELECT 1 FROM events WHERE event_date = ? AND title = ?').get(startDate, title)) {
      report.existing += 1;
      continue;
    }
    insert.run(title, startDate, endDate || null, timeNote || null, location || null, req.user.id, submissionWeekStart());
    report.created += 1;
  }
  const tz = getSetting('timezone');
  const today = todayStr(tz);
  const upcoming = db
    .prepare('SELECT e.*, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.event_date >= ? ORDER BY e.event_date')
    .all(today);
  const past = db
    .prepare('SELECT e.*, u.name AS author FROM events e LEFT JOIN users u ON u.id = e.created_by WHERE e.event_date < ? ORDER BY e.event_date DESC LIMIT 20')
    .all(today);
  res.render('events', { upcoming, past, importReport: report });
});

router.get('/events/:id/edit', requireLogin, loadEvent, (req, res) => {
  res.render('event_form', { event: req.event, errors: [] });
});

router.post('/events/:id', requireLogin, loadEvent, (req, res) => {
  const { errors, values } = validate(req.body);
  if (errors.length) return res.status(400).render('event_form', { event: { ...values, id: req.event.id }, errors });
  db.prepare('UPDATE events SET title = ?, event_date = ?, end_date = ?, time_note = ?, location = ? WHERE id = ?').run(
    values.title,
    values.event_date,
    values.end_date,
    values.time_note,
    values.location,
    req.event.id
  );
  res.redirect('/events');
});

router.post('/events/:id/delete', requireLogin, loadEvent, (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.event.id);
  res.redirect('/events');
});

module.exports = router;
