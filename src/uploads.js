// Shared photo-upload plumbing: multer storage, content sniffing, cleanup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + MIME_EXT[file.mimetype]),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 12 },
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

module.exports = { upload, isRealImage, removeFiles, MIME_EXT };
