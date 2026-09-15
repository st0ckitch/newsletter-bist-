const express = require('express');
const { db } = require('../db');
const { requireLogin, canEditRecord } = require('../auth');
const { submissionWeekStart, generationWeekStart } = require('../appweek');

// The Primary Awards table: every member of staff can add students here and
// fix their own rows (managers can fix anyone's). Rows belong to a week,
// like news stories, so each issue starts with a fresh table.
const router = express.Router();

const FIELDS = ['award', 'grade_stage', 'student_name', 'award_title'];

function clean(body) {
  const values = {};
  for (const f of FIELDS) values[f] = (body[f] || '').trim().slice(0, 120);
  const errors = [];
  if (!values.award) errors.push('The award is required (e.g. "Star of the Week").');
  if (!values.student_name) errors.push("The student's name is required.");
  return { values, errors };
}

function awardsLocals(req, extra = {}) {
  const issueWeek = generationWeekStart();
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS author FROM awards a
       LEFT JOIN users u ON u.id = a.created_by
       WHERE a.week_start >= ? ORDER BY a.week_start, a.id`
    )
    .all(issueWeek)
    .map((r) => ({ ...r, canEdit: canEditRecord(req.user, r) }));
  return {
    rows,
    issueWeek,
    submissionWeek: submissionWeekStart(),
    errors: [],
    ...extra,
  };
}

router.get('/awards', requireLogin, (req, res) => {
  res.render('awards', awardsLocals(req));
});

router.post('/awards', requireLogin, (req, res) => {
  const { values, errors } = clean(req.body);
  if (errors.length) return res.status(400).render('awards', awardsLocals(req, { errors }));
  db.prepare(
    'INSERT INTO awards (week_start, award, grade_stage, student_name, award_title, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(submissionWeekStart(), values.award, values.grade_stage, values.student_name, values.award_title, req.user.id);
  res.redirect('/awards');
});

function loadAward(req, res, next) {
  const row = db.prepare('SELECT * FROM awards WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).render('error', { message: 'Award row not found.' });
  if (!canEditRecord(req.user, row)) {
    return res.status(403).render('error', { message: 'You can only change award rows you added yourself.' });
  }
  req.award = row;
  next();
}

router.post('/awards/:id/delete', requireLogin, loadAward, (req, res) => {
  db.prepare('DELETE FROM awards WHERE id = ?').run(req.award.id);
  res.redirect('/awards');
});

router.post('/awards/:id', requireLogin, loadAward, (req, res) => {
  const { values, errors } = clean(req.body);
  if (errors.length) return res.status(400).render('awards', awardsLocals(req, { errors }));
  db.prepare('UPDATE awards SET award = ?, grade_stage = ?, student_name = ?, award_title = ? WHERE id = ?').run(
    values.award,
    values.grade_stage,
    values.student_name,
    values.award_title,
    req.award.id
  );
  res.redirect('/awards');
});

module.exports = router;
