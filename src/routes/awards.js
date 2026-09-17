const express = require('express');
const { db } = require('../db');
const { requireLogin, canEditRecord } = require('../auth');
const { submissionWeekStart, generationWeekStart } = require('../appweek');

// The Primary Awards table: a topic title for the week ("Generosity of
// Spirit Certificate Winners 12.12.25") and one row per class with the
// winning students' names. Every member of staff can add rows and fix their
// own (managers can fix anyone's); rows belong to a week, like news stories,
// so each issue starts with a fresh table. Class/students are stored in the
// awards table's grade_stage/student_name columns.
const router = express.Router();

function clean(body) {
  const className = (body.class_name || '').trim().slice(0, 120);
  const students = (body.students || '').trim().slice(0, 200);
  const errors = [];
  if (!className) errors.push('The class is required (e.g. "Year 3W").');
  if (!students) errors.push("The students' names are required (e.g. \"Marta, Renee\").");
  return { className, students, errors };
}

function awardsLocals(req, extra = {}) {
  const issueWeek = generationWeekStart();
  const submissionWeek = submissionWeekStart();
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS author FROM awards a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.week_start >= ? ORDER BY a.week_start, a.id`
    )
    .all(issueWeek)
    .map((r) => ({ ...r, canEdit: canEditRecord(req.user, r) }));
  const topicRow = db.prepare('SELECT title FROM award_topics WHERE week_start = ?').get(submissionWeek);
  return {
    rows,
    topic: topicRow ? topicRow.title : '',
    issueWeek,
    submissionWeek,
    errors: [],
    ...extra,
  };
}

router.get('/awards', requireLogin, (req, res) => {
  res.render('awards', awardsLocals(req));
});

// The week's topic title, shown in gold above the table in the newsletter.
router.post('/awards/topic', requireLogin, (req, res) => {
  const title = (req.body.title || '').trim().slice(0, 160);
  db.prepare('INSERT OR REPLACE INTO award_topics (week_start, title) VALUES (?, ?)').run(submissionWeekStart(), title);
  res.redirect('/awards');
});

router.post('/awards', requireLogin, (req, res) => {
  const { className, students, errors } = clean(req.body);
  if (errors.length) return res.status(400).render('awards', awardsLocals(req, { errors }));
  db.prepare(
    "INSERT INTO awards (week_start, award, grade_stage, student_name, award_title, created_by) VALUES (?, '', ?, ?, '', ?)"
  ).run(submissionWeekStart(), className, students, req.user.id);
  res.redirect('/awards');
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
  res.redirect('/awards');
});

router.post('/awards/:id', requireLogin, loadAward, (req, res) => {
  const { className, students, errors } = clean(req.body);
  if (errors.length) return res.status(400).render('awards', awardsLocals(req, { errors }));
  db.prepare('UPDATE awards SET grade_stage = ?, student_name = ? WHERE id = ?').run(className, students, req.award.id);
  res.redirect('/awards');
});

module.exports = router;
