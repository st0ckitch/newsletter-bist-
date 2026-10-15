const express = require('express');
const { db } = require('../db');
const { requireLogin, requireLayout, requireReviewer, csrfOk, canEditRecord, canManage } = require('../auth');
const { canReviewSection, isReviewer, canLayout } = require('../roles');
const { SECTION_KEYS, SECTIONS, isSection } = require('../sections');
const { submissionWeekStart, generationWeekStart, issueWeekChoices, cutoffLabel } = require('../appweek');
const { addDays, isValidDateStr } = require('../week');
const { CONTENT_SLOTS, SLOT_LABELS, MAX_ARTICLE_WORDS, wordCount, allowedSlots, defaultSlot, columnRule } = require('../slots');
const { upload, isRealImage, removeFiles, normalizeFiles, copyUpload } = require('../uploads');
const { renderArticlePreview } = require('../newsletter');

const router = express.Router();

// Live preview beside the news form: the draft article rendered with the
// real newsletter template. Reads title/body/photos (data URIs of the
// selected files) from JSON; nothing is stored.
router.post('/news/preview.html', requireLogin, (req, res) => {
  const { title, body, sectionLabel, photos } = req.body || {};
  res.type('html').send(renderArticlePreview({ title, body, sectionLabel, photos }));
});

// Parses the multipart body (multer), then verifies the CSRF token from it
// and that every uploaded file really is an image. On any failure the files
// already written to disk are removed.
const MAX_ARTICLE_PHOTOS = 4;

function photosUpload(req, res, next) {
  upload.fields([
    { name: 'photos', maxCount: MAX_ARTICLE_PHOTOS },
    { name: 'lead_photo', maxCount: 1 },
  ])(req, res, (err) => {
    req.contentPhotos = (req.files && req.files.photos) || [];
    req.leadPhotoFile = ((req.files && req.files.lead_photo) || [])[0] || null;
    const all = [...req.contentPhotos, ...(req.leadPhotoFile ? [req.leadPhotoFile] : [])];
    const cleanup = () => removeFiles(all.map((f) => f.filename));
    req.cleanupUploads = cleanup;
    if (err) {
      cleanup();
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        err.message = `You can attach at most ${MAX_ARTICLE_PHOTOS} photos (plus one section-head portrait).`;
      }
      err.status = 400;
      err.expose = true;
      return next(err);
    }
    if (!csrfOk(req)) {
      cleanup();
      return res.status(403).send('Invalid CSRF token. Go back, reload the page and try again.');
    }
    const fake = all.find((f) => !isRealImage(f));
    if (fake) {
      cleanup();
      const e = new Error(`"${fake.originalname}" is not a valid image file.`);
      e.status = 400;
      e.expose = true;
      return next(e);
    }
    next();
  });
}

// Every member of staff can write for any area - the SLT member responsible
// for that area checks the story before it reaches the newsletter.
function allowedSections() {
  return SECTION_KEYS;
}

function loadNews(req, res, next) {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  if (!canEditRecord(req.user, item)) {
    return res.status(403).render('error', { message: 'You can only edit news items you created.' });
  }
  req.newsItem = item;
  next();
}

// Which issue a story goes into. New stories default to the week accepting
// submissions - next week's once the Thursday deadline has passed - and any
// writer may schedule one for a later issue. After the deadline, the issue
// being proofed stays open to the layout team only. A story's current week
// is always offered, so editing it never moves it by accident.
function weekContext(user) {
  const issueWeek = generationWeekStart();
  const pastCutoff = submissionWeekStart() !== issueWeek;
  const open = issueWeekChoices().filter((w) => !(pastCutoff && w === issueWeek && !canLayout(user)));
  return { issueWeek, pastCutoff, open };
}

function labelWeek(week, ctx) {
  const [y, m, d] = week.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (week < ctx.issueWeek) return { value: week, label: `Past issue - week of ${date}`, short: `Past - ${date}` };
  if (week === ctx.issueWeek) {
    return {
      value: week,
      label: `This week's issue - week of ${date}${ctx.pastCutoff ? ' (deadline passed)' : ''}`,
      short: `This week - ${date}`,
    };
  }
  if (week === addDays(ctx.issueWeek, 7)) {
    return { value: week, label: `Next week's issue - week of ${date}`, short: `Next week - ${date}` };
  }
  return { value: week, label: `Issue for the week of ${date}`, short: `Week of ${date}` };
}

function weekChoices(ctx, currentWeek) {
  const weeks = ctx.open.slice();
  if (currentWeek && !weeks.includes(currentWeek)) weeks.push(currentWeek);
  return weeks.sort().map((w) => labelWeek(w, ctx));
}

// A story moved to another issue joins the end of its section there.
function moveToWeek(id, slot, week) {
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM news WHERE week_start = ? AND slot = ? AND id != ?')
    .get(week, slot, id).m;
  db.prepare('UPDATE news SET week_start = ?, sort_order = ? WHERE id = ?').run(week, maxOrder + 10, id);
}

// Confirmation after a story changes issue. The Mailchimp draft is a
// snapshot: if this week's was already generated, it only reflects the move
// once it is generated again.
function movedNotice(id, fromWeek, ctx) {
  const item = db.prepare('SELECT title, week_start, review_status, included FROM news WHERE id = ?').get(id);
  if (!item) return null;
  const touchesIssue = item.week_start === ctx.issueWeek || fromWeek === ctx.issueWeek;
  return {
    title: item.title,
    label: labelWeek(item.week_start, ctx).label,
    regenerate: touchesIssue && Boolean(db.prepare('SELECT 1 FROM issues WHERE week_start = ?').get(ctx.issueWeek)),
    pending: item.review_status !== 'approved',
    excluded: !item.included,
  };
}

function validate(body, user, existing) {
  const errors = [];
  const title = (body.title || '').trim();
  const bodyText = (body.body || '').trim();
  const section = body.section;
  if (!title) errors.push('Title is required.');
  if (!bodyText) errors.push('The article text is required.');
  const words = wordCount(bodyText);
  // Some writers (flagged on the Users page) may run as long as they need.
  // An article one of them already made longer stays editable by everyone -
  // capped writers can fix or shorten it, they just cannot grow it further.
  const allowance = Math.max(MAX_ARTICLE_WORDS, existing ? wordCount(existing.body || '') : 0);
  if (words > allowance && !user.no_word_limit) {
    errors.push(
      allowance > MAX_ARTICLE_WORDS
        ? `This article already runs to ${allowance} words (written over the cap). You can edit or shorten it, but not make it longer - currently ${words} words.`
        : `Article text is limited to ${MAX_ARTICLE_WORDS} words - currently ${words}. Please shorten it.`
    );
  }
  if (!isSection(section)) errors.push('Choose the area this story belongs to.');
  // Template placement belongs to whoever lays the issue out; the area only
  // sets the default position, any content section is a valid choice.
  const slot = canLayout(user) && CONTENT_SLOTS.includes(body.slot) ? body.slot : null;
  const weeks = weekChoices(weekContext(user), existing && existing.week_start).map((c) => c.value);
  const week = weeks.includes(body.week) ? body.week : existing ? existing.week_start : submissionWeekStart();
  return { errors, values: { title, body: bodyText, section, slot, week } };
}

function savePhotos(newsId, files) {
  const insert = db.prepare('INSERT INTO photos (news_id, filename, original_name, mime, normalized) VALUES (?, ?, ?, ?, 1)');
  for (const f of files || []) insert.run(newsId, f.filename, f.originalname, f.mimetype);
}

// A saved staff headshot (Users page) picked from the form's dropdown. The
// article gets its OWN copy of the file, so deleting the article - or later
// replacing the person's headshot - never touches other articles.
function headshotCopy(leadUserId) {
  const id = parseInt(leadUserId, 10);
  if (!id) return null;
  const person = db.prepare('SELECT headshot FROM users WHERE id = ? AND headshot IS NOT NULL').get(id);
  return person ? copyUpload(person.headshot) : null;
}

function formLocals(req, extra) {
  const ctx = weekContext(req.user);
  const item = extra.item;
  return {
    weekOptions: weekChoices(ctx, extra.currentWeek || null),
    selectedWeek: (item && (item.week || item.week_start)) || submissionWeekStart(),
    pastCutoff: ctx.pastCutoff,
    cutoff: cutoffLabel(),
    moved: null,
    sections: allowedSections(),
    savedHeadshots: db.prepare('SELECT id, name, headshot FROM users WHERE headshot IS NOT NULL ORDER BY name').all(),
    sectionLabels: SECTIONS,
    isManager: canLayout(req.user),
    slotLabels: SLOT_LABELS,
    contentSlots: CONTENT_SLOTS,
    sectionSlots: Object.fromEntries(allowedSections().map((s) => [s, CONTENT_SLOTS])),
    maxWords: req.user.no_word_limit ? 0 : MAX_ARTICLE_WORDS,
    ...extra,
  };
}

router.get('/news', requireLogin, (req, res) => {
  const weekStart = submissionWeekStart();
  const issueWeek = generationWeekStart();
  const showAll = req.query.all === '1';
  const all = db
    .prepare(
      `SELECT n.*, u.name AS author, r.name AS reviewer,
              (SELECT COUNT(*) FROM photos p WHERE p.news_id = n.id) AS photo_count
       FROM news n
       LEFT JOIN users u ON u.id = n.created_by
       LEFT JOIN users r ON r.id = n.reviewed_by
       ORDER BY n.created_at DESC LIMIT 300`
    )
    .all()
    .map((n) => ({ ...n, canReview: canReviewSection(req.user, n.section) }));
  // By default only the current issue and upcoming submissions show; older
  // weeks stay one click away so last year's stories never clutter the list.
  const rows = showAll ? all : all.filter((n) => n.week_start >= issueWeek);
  const olderCount = all.filter((n) => n.week_start < issueWeek).length;
  const ctx = weekContext(req.user);
  const fromWeek = isValidDateStr(req.query.from) ? req.query.from : null;
  res.render('news', {
    rows,
    weekStart,
    issueWeek,
    showAll,
    olderCount,
    weekOptionsFor: (n) => weekChoices(ctx, n.week_start),
    moved: req.query.moved ? movedNotice(req.query.moved, fromWeek, ctx) : null,
    isManager: canLayout(req.user),
    isReviewer: isReviewer(req.user),
    sectionLabels: SECTIONS,
    slotLabels: SLOT_LABELS,
    contentSlots: CONTENT_SLOTS,
    slotsFor: () => CONTENT_SLOTS,
  });
});

router.get('/news/new', requireLogin, (req, res) => {
  res.render('news_form', formLocals(req, { item: null, photos: [], errors: [] }));
});

router.post('/news', requireLogin, photosUpload, async (req, res) => {
  const { errors, values } = validate(req.body, req.user);
  if (errors.length) {
    req.cleanupUploads();
    return res.status(400).render('news_form', formLocals(req, { item: values, photos: [], errors }));
  }
  // A story written by the person who would check it needs no second look.
  const selfChecked = canReviewSection(req.user, values.section);
  const info = db
    .prepare(
      `INSERT INTO news (title, body, section, slot, review_status, reviewed_by, reviewed_at, created_by, week_start)
       VALUES (?, ?, ?, ?, ?, ?, ${selfChecked ? "datetime('now')" : 'NULL'}, ?, ?)`
    )
    .run(
      values.title,
      values.body,
      values.section,
      values.slot || defaultSlot(values.section),
      selfChecked ? 'approved' : 'pending',
      selfChecked ? req.user.id : null,
      req.user.id,
      values.week
    );
  await normalizeFiles(req.contentPhotos);
  savePhotos(info.lastInsertRowid, req.contentPhotos);
  // An uploaded portrait wins; otherwise a saved staff headshot picked from
  // the dropdown is copied in as this article's own lead photo.
  const newLead = req.leadPhotoFile ? req.leadPhotoFile.filename : headshotCopy(req.body.lead_user_id);
  if (newLead) {
    db.prepare('UPDATE news SET lead_photo = ? WHERE id = ?').run(newLead, info.lastInsertRowid);
  }
  // Filed somewhere other than the default issue: confirm where it went.
  res.redirect(values.week === submissionWeekStart() ? '/news' : `/news?moved=${info.lastInsertRowid}`);
});

router.get('/news/:id/edit', requireLogin, loadNews, (req, res) => {
  const photos = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(req.newsItem.id);
  const fromWeek = isValidDateStr(req.query.moved_from) ? req.query.moved_from : null;
  res.render(
    'news_form',
    formLocals(req, {
      item: req.newsItem,
      currentWeek: req.newsItem.week_start,
      photos,
      errors: [],
      moved: fromWeek ? movedNotice(req.newsItem.id, fromWeek, weekContext(req.user)) : null,
    })
  );
});

router.post('/news/:id', requireLogin, loadNews, photosUpload, async (req, res) => {
  const { errors, values } = validate(req.body, req.user, req.newsItem);
  const existingCount = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE news_id = ?').get(req.newsItem.id).c;
  // Only when NEW photos arrive: an article that exceeded the cap before the
  // cap existed can still have its text edited freely.
  if (req.contentPhotos.length && existingCount + req.contentPhotos.length > MAX_ARTICLE_PHOTOS) {
    errors.push(
      `An article can hold at most ${MAX_ARTICLE_PHOTOS} photos - it already has ${existingCount}. Remove some below before adding more.`
    );
  }
  if (errors.length) {
    req.cleanupUploads();
    const photos = db.prepare('SELECT * FROM photos WHERE news_id = ? ORDER BY id').all(req.newsItem.id);
    return res.status(400).render(
      'news_form',
      formLocals(req, { item: { ...values, id: req.newsItem.id }, currentWeek: req.newsItem.week_start, photos, errors })
    );
  }
  // Rewriting a checked story sends it back for review, unless the person
  // editing is the one who would check it anyway. Only content counts:
  // moving the story to another issue or section needs no second check.
  const old = req.newsItem;
  const contentChanged =
    values.title !== old.title ||
    values.body !== old.body ||
    values.section !== old.section ||
    req.contentPhotos.length > 0 ||
    Boolean(req.leadPhotoFile || req.body.lead_user_id) ||
    req.body.remove_lead_photo === '1';
  const recheck = contentChanged && old.review_status === 'approved' && !canReviewSection(req.user, values.section);
  const slot = values.slot || old.slot || defaultSlot(values.section);
  db.prepare(
    `UPDATE news SET title = ?, body = ?, section = ?, slot = ?, updated_at = datetime('now')
     ${recheck ? ", review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL" : ''}
     WHERE id = ?`
  ).run(
    values.title,
    values.body,
    values.section,
    // Keep the existing placement - manual layout survives area changes.
    slot,
    req.newsItem.id
  );
  if (values.week !== old.week_start) moveToWeek(old.id, slot, values.week);
  await normalizeFiles(req.contentPhotos);
  savePhotos(req.newsItem.id, req.contentPhotos);
  const newLead = req.leadPhotoFile ? req.leadPhotoFile.filename : headshotCopy(req.body.lead_user_id);
  if (newLead) {
    // A new head-of-grade portrait (uploaded, or a saved staff headshot)
    // replaces the old one; the CDN copy is refreshed on the next generation.
    removeFiles([req.newsItem.lead_photo]);
    db.prepare('UPDATE news SET lead_photo = ?, lead_photo_mailchimp_url = NULL WHERE id = ?').run(
      newLead,
      req.newsItem.id
    );
  } else if (req.body.remove_lead_photo === '1' && req.newsItem.lead_photo) {
    removeFiles([req.newsItem.lead_photo]);
    db.prepare('UPDATE news SET lead_photo = NULL, lead_photo_mailchimp_url = NULL WHERE id = ?').run(req.newsItem.id);
  }
  res.redirect(
    values.week !== old.week_start ? `/news/${old.id}/edit?moved_from=${old.week_start}` : `/news/${old.id}/edit`
  );
});

// SLT sign-off: each SLT member checks the stories in their own area
// (whole-school stories can be checked by any of them); the principal and
// admins can check anything. Only checked stories reach the newsletter.
router.post('/news/:id/review', requireReviewer, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  if (!canReviewSection(req.user, item.section)) {
    return res.status(403).render('error', {
      message: `Stories in "${SECTIONS[item.section] || item.section}" are checked by the SLT member responsible for that area.`,
    });
  }
  const decision = req.body.decision;
  if (!['approved', 'rejected', 'pending'].includes(decision)) {
    return res.status(400).render('error', { message: 'Unknown review decision.' });
  }
  const note = (req.body.review_note || '').trim().slice(0, 500) || null;
  db.prepare(
    "UPDATE news SET review_status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?"
  ).run(decision, req.user.id, note, item.id);
  res.redirect(req.body.back === 'dashboard' ? '/' : '/news');
});

// Curation: choose whether a checked story makes this week's issue.
router.post('/news/:id/include', requireLayout, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  db.prepare('UPDATE news SET included = ? WHERE id = ?').run(req.body.included === '1' ? 1 : 0, item.id);
  res.redirect('/news');
});

// Placement: move an article to another template section.
router.post('/news/:id/slot', requireLayout, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  if (!CONTENT_SLOTS.includes(req.body.slot)) {
    return res.status(400).render('error', { message: 'Invalid template section.' });
  }
  const maxOrder = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM news WHERE week_start = ? AND slot = ?')
    .get(item.week_start, req.body.slot).m;
  db.prepare('UPDATE news SET slot = ?, sort_order = ? WHERE id = ?').run(req.body.slot, maxOrder + 10, item.id);
  res.redirect('/news');
});

// Move a story to another issue - e.g. back into this week's after it
// missed the Thursday deadline and rolled into next week's.
router.post('/news/:id/week', requireLayout, (req, res) => {
  const item = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).render('error', { message: 'News item not found.' });
  const allowed = weekChoices(weekContext(req.user), item.week_start).map((c) => c.value);
  if (!allowed.includes(req.body.week)) {
    return res.status(400).render('error', { message: 'Choose one of the issues offered in the list.' });
  }
  if (req.body.week !== item.week_start) moveToWeek(item.id, item.slot, req.body.week);
  res.redirect(`/news?moved=${item.id}&from=${item.week_start}`);
});

router.post('/news/:id/delete', requireLogin, loadNews, (req, res) => {
  const files = db.prepare('SELECT filename FROM photos WHERE news_id = ?').all(req.newsItem.id);
  db.prepare('DELETE FROM news WHERE id = ?').run(req.newsItem.id);
  removeFiles(files.map((f) => f.filename).concat(req.newsItem.lead_photo || []));
  res.redirect('/news');
});

router.post('/photos/:id/delete', requireLogin, (req, res) => {
  const photo = db.prepare('SELECT p.*, n.created_by FROM photos p JOIN news n ON n.id = p.news_id WHERE p.id = ?').get(req.params.id);
  if (!photo) return res.status(404).render('error', { message: 'Photo not found.' });
  if (!canEditRecord(req.user, photo)) {
    return res.status(403).render('error', { message: 'You can only delete photos from your own news items.' });
  }
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  removeFiles([photo.filename]);
  res.redirect(`/news/${photo.news_id}/edit`);
});

module.exports = router;
