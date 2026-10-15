// Bringing back photos the old upload code cropped. Until 15 October 2026
// every camera-shaped upload (width/height between 0.6 and 1.6) was cut to
// 4:3 - keeping the top of portraits and the middle of wide shots - and only
// the cropped copy was kept. Given an original picture, recreate that exact
// crop and compare it with the stored photos: a match is the photo to swap
// for the full frame, so nobody has to work out which photo is which.
const path = require('path');
const sharp = require('sharp');
const config = require('./config');
const { uploadSize } = require('./imagesize');

// The old crop's size and anchor for a width x height picture, or null for
// the shapes it left whole.
function legacyCrop(w, h) {
  const ratio = w / h;
  if (ratio < 0.6 || ratio > 1.6) return null;
  const cw = Math.max(1, Math.min(w, Math.floor((h * 4) / 3), 1200));
  const ch = Math.max(1, Math.floor((cw * 3) / 4));
  return { cw, ch, position: Math.floor((h * 4) / 3) >= w ? 'top' : 'centre' };
}

// A small greyscale thumbnail: the same picture gives near-identical values
// whatever its size or JPEG quality; different pictures differ a lot.
function fingerprint(input) {
  return sharp(input).greyscale().resize(64, 48, { fit: 'fill' }).raw().toBuffer();
}

// Mean difference per pixel, 0-255.
function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// The same picture through different resizes/compressions scores about 0-2;
// unrelated photos score 25 and up.
const MATCH_LIMIT = 6;

// Stored files never change under the same name, so their thumbnails are kept.
const stored = new Map();
function storedFingerprint(filename) {
  if (!stored.has(filename)) {
    stored.set(filename, fingerprint(path.join(config.uploadDir, filename)).catch(() => null));
  }
  return stored.get(filename);
}

// Which of the candidate photos ({id, filename, ...}) is the old crop of the
// picture in `originalPath`? Resolves to {photo} or {reason}.
async function findCroppedPhoto(originalPath, candidates) {
  const upright = await sharp(originalPath).rotate().toBuffer();
  const { width, height } = await sharp(upright).metadata();
  const crop = legacyCrop(width, height);
  if (!crop || Math.abs(width / height - 4 / 3) < 0.01) {
    return { reason: 'nothing was ever cut off a photo of this shape, so there is nothing to restore' };
  }
  const mine = await fingerprint(
    await sharp(upright).resize(crop.cw, crop.ch, { fit: 'cover', position: crop.position }).toBuffer()
  );
  let best = null;
  for (const photo of candidates) {
    const size = uploadSize(photo.filename);
    if (!size || Math.abs(size.w / size.h - crop.cw / crop.ch) > 0.02) continue;
    const theirs = await storedFingerprint(photo.filename);
    if (!theirs) continue;
    const d = distance(mine, theirs);
    if (!best || d < best.d) best = { photo, d };
  }
  if (!best || best.d > MATCH_LIMIT) {
    return { reason: 'no cropped photo in the current or upcoming issues matches it (already restored, or not in the newsletter)' };
  }
  return { photo: best.photo };
}

module.exports = { legacyCrop, findCroppedPhoto };
