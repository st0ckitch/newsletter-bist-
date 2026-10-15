const path = require('path');
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const { requireLayout, csrfOk } = require('../auth');
const { generationWeekStart } = require('../appweek');
const { upload, isRealImage, removeFiles, normalizePhoto } = require('../uploads');
const { findCroppedPhoto } = require('../restore');

const router = express.Router();

// Restore full photos: the original pictures go in, each is matched to the
// photo the old upload code cropped, and that photo gets the full frame.
// Only the current and upcoming issues are touched - sent ones stay as sent.
router.get('/photos/restore', requireLayout, (req, res) => {
  res.render('photos_restore');
});

// One photo per request (the page sends them one by one, downscaled in the
// browser first).
router.post('/api/photos/restore', requireLayout, (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    const cleanup = () => removeFiles(req.file ? [req.file.filename] : []);
    if (err) {
      cleanup();
      return res.status(400).json({ error: err.message });
    }
    if (!csrfOk(req)) {
      cleanup();
      return res.status(403).json({ error: 'Session expired - reload the page and try again.' });
    }
    if (!req.file || !isRealImage(req.file)) {
      cleanup();
      return res.status(400).json({ error: 'Not a valid image file.' });
    }
    try {
      const candidates = db
        .prepare(
          `SELECT p.id, p.filename, p.news_id, n.title FROM photos p JOIN news n ON n.id = p.news_id
           WHERE n.week_start >= ? ORDER BY p.id`
        )
        .all(generationWeekStart());
      const { photo, reason } = await findCroppedPhoto(path.join(config.uploadDir, req.file.filename), candidates);
      if (!photo) {
        cleanup();
        return res.json({ ok: false, reason });
      }
      const filename = await normalizePhoto(req.file.filename);
      // The same row keeps its place in the article; the CDN copy is
      // re-uploaded on the next generation.
      db.prepare(
        "UPDATE photos SET filename = ?, original_name = ?, mime = 'image/jpeg', normalized = 1, mailchimp_url = NULL WHERE id = ?"
      ).run(filename, req.body.name || req.file.originalname, photo.id);
      removeFiles([photo.filename]);
      const position = db.prepare('SELECT COUNT(*) AS c FROM photos WHERE news_id = ? AND id <= ?').get(photo.news_id, photo.id).c;
      res.json({ ok: true, matched: `“${photo.title}” (photo ${position})` });
    } catch (e) {
      cleanup();
      res.status(400).json({ error: 'Could not read this image.' });
    }
  });
});

module.exports = router;
