// Shared photo-upload plumbing: multer storage, content sniffing, cleanup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');
const { forgetUploadSize } = require('./imagesize');

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + MIME_EXT[file.mimetype]),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (MIME_EXT[file.mimetype]) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP or GIF images can be uploaded.'));
  },
});

// Magic-byte check so a renamed non-image (or spoofed Content-Type) is
// rejected regardless of what the client claims.
const MAGIC_CHECKS = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

function isRealImage(file) {
  try {
    const fd = fs.openSync(path.join(config.uploadDir, file.filename), 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const check = MAGIC_CHECKS[file.mimetype];
    return Boolean(check && check(buf));
  } catch {
    return false;
  }
}

function removeFiles(filenames) {
  for (const name of filenames) {
    if (!name) continue;
    fs.unlink(path.join(config.uploadDir, name), (err) => {
      if (err && err.code !== 'ENOENT') console.error('[uploads] Could not delete photo file:', err.message);
    });
  }
}

// Article photos keep their WHOLE frame - nothing is ever cropped, so no
// face, head or team photo gets cut off. Each upload is turned upright (EXIF
// orientation baked in), scaled to fit within 1200x1200 and re-encoded as a
// JPEG, which also strips EXIF/GPS metadata. The newsletter lays photos out
// by their real shape (see renderPhotos). Returns the new filename; on any
// processing error the original file is kept untouched.
const sharp = require('sharp');

async function normalizePhoto(filename) {
  const src = path.join(config.uploadDir, filename);
  try {
    const out = await sharp(src)
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    const newName = `${crypto.randomBytes(16).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(config.uploadDir, newName), out);
    removeFiles([filename]);
    return newName;
  } catch (err) {
    console.error('[uploads] Photo normalization failed, keeping original:', err.message);
    return filename;
  }
}

// Multer file objects in, same objects out with filename/mimetype updated.
async function normalizeFiles(files) {
  for (const f of files || []) {
    const newName = await normalizePhoto(f.filename);
    if (newName !== f.filename) {
      f.filename = newName;
      f.mimetype = 'image/jpeg';
    }
  }
  return files;
}

// A hard link where the disk allows it (the same bytes under a second
// name, taking no extra space), else a real copy.
function linkOrCopy(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

// Copy an uploaded file to a fresh random name (same extension). Used when
// an article reuses a person's saved headshot: the article gets its own copy,
// so deleting the article never removes the shared headshot (and later
// headshot updates do not rewrite already-sent issues). The copy is a hard
// link - nothing ever rewrites a stored file in place, so the names stay
// independent while sharing one file's worth of disk. Returns null when the
// file is missing or cannot be copied: the caller simply goes without.
function copyUpload(filename) {
  if (!filename) return null;
  const src = path.join(config.uploadDir, filename);
  if (!fs.existsSync(src)) return null;
  const ext = path.extname(filename) || '.jpg';
  const newName = crypto.randomBytes(16).toString('hex') + ext;
  try {
    linkOrCopy(src, path.join(config.uploadDir, newName));
  } catch (err) {
    console.error('[uploads] Could not copy photo file:', err.message);
    return null;
  }
  return newName;
}

// Portraits, headshots, logos and the masthead keep their own format (a
// logo's transparency survives) but, like article photos, are scaled to fit
// within 1200x1200 - full-size phone originals run to several MB each, and
// the server's storage is small.
const MAX_SIDE = 1200;
const BIG_FILE = 1024 * 1024;
const ENCODERS = {
  jpeg: (img) => img.jpeg({ quality: 82, mozjpeg: true }),
  png: (img) => img.png({ compressionLevel: 9, adaptiveFiltering: true }),
  webp: (img) => img.webp({ quality: 82 }),
};

// The smaller version of an image file as a buffer, or null when it is
// already small enough (or unreadable, animated, or would barely shrink).
async function shrunkImage(filePath) {
  let input;
  try {
    input = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  try {
    const meta = await sharp(input).metadata();
    const encode = ENCODERS[meta.format];
    if (!encode || (meta.pages || 1) > 1) return null;
    if (Math.max(meta.width || 0, meta.height || 0) <= MAX_SIDE && input.length <= BIG_FILE) return null;
    const out = await encode(
      sharp(input).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    ).toBuffer();
    return out.length < input.length * 0.9 ? out : null;
  } catch {
    return null;
  }
}

const tempName = (kind) => `.${crypto.randomBytes(8).toString('hex')}.${kind}`;

// Puts new bytes under each of the given names (a temp file, then atomic
// renames), so names that shared one file share the new one too and no
// name is ever left half-written.
function replaceContent(names, buffer) {
  const tmp = path.join(config.uploadDir, tempName('tmp'));
  try {
    fs.writeFileSync(tmp, buffer);
    for (const name of names) {
      const swap = path.join(config.uploadDir, tempName('swap'));
      linkOrCopy(tmp, swap);
      fs.renameSync(swap, path.join(config.uploadDir, name));
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  forgetUploadSize(names);
}

// A just-uploaded picture scaled down in place (same name). Never fails: on
// any problem the upload is kept as it came.
async function shrinkUpload(filename) {
  if (!filename) return filename;
  const out = await shrunkImage(path.join(config.uploadDir, filename));
  if (out) {
    try {
      replaceContent([filename], out);
    } catch (err) {
      console.error('[uploads] Could not shrink photo:', err.message);
    }
  }
  return filename;
}

module.exports = {
  upload,
  isRealImage,
  removeFiles,
  MIME_EXT,
  normalizePhoto,
  normalizeFiles,
  copyUpload,
  linkOrCopy,
  shrunkImage,
  replaceContent,
  shrinkUpload,
  MAX_SIDE,
};
