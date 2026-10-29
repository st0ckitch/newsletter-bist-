const express = require('express');
const { db } = require('../db');
const { requireLogin, requireManager, canEditRecord, canManage } = require('../auth');
const { submissionWeekStart, generationWeekStart, cutoffLabel } = require('../appweek');
const { addDays } = require('../week');

// The Primary Awards table: a topic title for the week ("Generosity of
// Spirit Certificate Winners 12.12.25") and one row per class with the
// winning students' names. Every member of staff can add rows and fix their
// own (managers can fix anyone's). Rows and the title belong to one issue,
// so each issue starts with a fresh table; the page has a tab for this week's
// issue and one for next week's, and a tab shows exactly what that week's
// newsletter gets. After the Thursday deadline this week's table is closed to
// staff (managers can still change it) and new rows go to next week's; a
// manager can move a whole table between the two. Class/students are stored
// in the awards table's grade_stage/student_name columns.
const router = express.Router();

function clean(body) {
  const className = (body.class_name || '').trim().slice(0, 120);
  const students = (body.students || '').trim().slice(0, 200);
  const errors = [];
  if (!className) errors.push('The class is required (e.g. "Year 3W").');
  if (!students) errors.push("The students' names are required (e.g. \"Marta, Renee\").");
  return { className, students, errors };
}

// This week's and next week's issue; anything else means the issue that is
// taking submissions right now.
function weeks() {
  const issueWeek = generationWeekStart();
  const submissionWeek = submissionWeekStart();
  return { issueWeek, nextWeek: addDays(issueWeek, 7), submissionWeek, pastCutoff: submissionWeek !== issueWeek };
}

function pickWeek(value) {
  const w = weeks();
  return [w.issueWeek, w.nextWeek].includes(value) ? value : w.submissionWeek;
}

// After the deadline this week's issue is being proofed: only managers may
// still add to it or retitle it.
function canChangeWeek(user, week) {
  const w = weeks();
  return canManage(user) || !(w.pastCutoff && week === w.issueWeek);
}

function shortDate(week) {
  const [y, m, d] = week.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function awardsLocals(req, week, extra = {}) {
  const w = weeks();
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS author FROM awards a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.week_start = ? ORDER BY a.sort_order, a.id`
    )
    .all(week)
    .map((r) => ({ ...r, canEdit: canEditRecord(req.user, r) }));
  const topicRow = db.prepare('SELECT title FROM award_topics WHERE week_start = ?').get(week);
  const tabs = [
    { week: w.issueWeek, label: "This week's issue", date: shortDate(w.issueWeek), note: w.pastCutoff ? 'deadline passed' : '' },
    { week: w.nextWeek, label: "Next week's issue", date: shortDate(w.nextWeek), note: '' },
  ];
  const other = tabs.find((t) => t.week !== week);
  return {
    week,
    tabs,
    rows,
    topic: topicRow ? topicRow.title : '',
    isThisWeek: week === w.issueWeek,
    pastCutoff: w.pastCutoff,
    cutoff: cutoffLabel(),
    canChange: canChangeWeek(req.user, week),
    isManager: canManage(req.user),
    other,
    // The Mailchimp draft is a snapshot: changes after it was made only
    // reach it when it is generated again.
    draftGenerated: week === w.issueWeek && Boolean(db.prepare('SELECT 1 FROM issues WHERE week_start = ?').get(week)),
    moved: Number(req.query.moved) || 0,
    errors: [],
    ...extra,
  };
}

const CLOSED =
  'This week\'s issue has already been put together, so its certificates table is closed - add new rows on the "Next week\'s issue" tab, or ask marketing to add a late one.';

router.get('/awards', requireLogin, (req, res) => {
  res.render('awards', awardsLocals(req, pickWeek(req.query.week)));
});

// The week's topic title, shown in gold above the table in the newsletter.
router.post('/awards/topic', requireLogin, (req, res) => {
  const week = pickWeek(req.body.week);
  if (!canChangeWeek(req.user, week)) return res.status(403).render('error', { message: CLOSED });
  const title = (req.body.title || '').trim().slice(0, 160);
  db.prepare('INSERT OR REPLACE INTO award_topics (week_start, title) VALUES (?, ?)').run(week, title);
  res.redirect(`/awards?week=${week}`);
});

router.post('/awards', requireLogin, (req, res) => {
  const week = pickWeek(req.body.week);
  if (!canChangeWeek(req.user, week)) return res.status(403).render('error', { message: CLOSED });
  const { className, students, errors } = clean(req.body);
  if (errors.length) return res.status(400).render('awards', awardsLocals(req, week, { errors }));
  const last = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM awards WHERE week_start = ?').get(week).m;
  db.prepare(
    "INSERT INTO awards (week_start, award, grade_stage, student_name, award_title, created_by, sort_order) VALUES (?, '', ?, ?, '', ?, ?)"
  ).run(week, className, students, req.user.id, last + 10);
  res.redirect(`/awards?week=${week}`);
});

// A whole table - rows and, if the other issue has none yet, its title -
// moved between this week's and next week's issue. Fixes a table that was
// filled in after the deadline but belongs in the issue being proofed.
router.post('/awards/move', requireManager, (req, res) => {
  const w = weeks();
  const from = req.body.from;
  const to = req.body.to;
  if (![w.issueWeek, w.nextWeek].includes(from) || ![w.issueWeek, w.nextWeek].includes(to) || from === to) {
    return res.status(400).render('error', { message: "Choose this week's or next week's issue." });
  }
  const rows = db.prepare('SELECT id FROM awards WHERE week_start = ? ORDER BY sort_order, id').all(from);
  const last = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM awards WHERE week_start = ?').get(to).m;
  const move = db.prepare('UPDATE awards SET week_start = ?, sort_order = ? WHERE id = ?');
  rows.forEach((r, i) => move.run(to, last + (i + 1) * 10, r.id));
  const fromTopic = db.prepare('SELECT title FROM award_topics WHERE week_start = ?').get(from);
  const toTopic = db.prepare('SELECT title FROM award_topics WHERE week_start = ?').get(to);
  if (fromTopic && fromTopic.title && !(toTopic && toTopic.title)) {
    db.prepare('INSERT OR REPLACE INTO award_topics (week_start, title) VALUES (?, ?)').run(to, fromTopic.title);
    db.prepare('DELETE FROM award_topics WHERE week_start = ?').run(from);
  }
  res.redirect(`/awards?week=${to}&moved=${rows.length}`);
});

// Drag-and-drop ordering of the table: the body carries the full id list
// in the new top-to-bottom order. Only current/upcoming weeks are touched.
router.post('/awards/reorder', requireLogin, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const issueWeek = generationWeekStart();
  const set = db.prepare('UPDATE awards SET sort_order = ? WHERE id = ? AND week_start >= ?');
  ids.forEach((id, i) => set.run((i + 1) * 10, id, issueWeek));
  res.json({ ok: true });
});

function loadAward(req, res, next) {
  const row = db.prepare('SELECT * FROM awards WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).render('error', { message: 'Awards row not found.' });
  if (!canEditRecord(req.user, row)) {
    return res.status(403).render('error', { message: 'You can only change rows you added yourself.' });
  }
  req.award = row;
  next();
}

router.post('/awards/:id/delete', requireLogin, loadAward, (req, res) => {
  db.prepare('DELETE FROM awards WHERE id = ?').run(req.award.id);
  res.redirect(`/awards?week=${req.award.week_start}`);
});

router.post('/awards/:id', requireLogin, loadAward, (req, res) => {
  const { className, students, errors } = clean(req.body);
  if (errors.length) return res.status(400).render('awards', awardsLocals(req, pickWeek(req.award.week_start), { errors }));
  db.prepare('UPDATE awards SET grade_stage = ?, student_name = ? WHERE id = ?').run(className, students, req.award.id);
  res.redirect(`/awards?week=${req.award.week_start}`);
});

module.exports = router;
