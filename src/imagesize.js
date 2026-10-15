// Pixel size of an image read straight from its file header - JPEG, PNG,
// GIF or WebP - so the newsletter can lay photos out by their real shape
// while rendering synchronously. Upload names are random and never reused,
// so sizes are cached by name.
const fs = require('fs');
const path = require('path');
const config = require('./config');

function jpegSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Start-of-frame markers carry the size; DHT/JPG/DAC (c4/c8/cc) do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function imageSize(b) {
  if (!b || b.length < 30) return null;
  if (b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (b.subarray(1, 4).toString('latin1') === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

const cache = new Map();

// {w, h} of a file in the uploads folder, or null when unreadable.
function uploadSize(filename) {
  if (!filename || filename.includes('/') || filename.includes('\\')) return null;
  if (cache.has(filename)) return cache.get(filename);
  let size = null;
  try {
    const fd = fs.openSync(path.join(config.uploadDir, filename), 'r');
    try {
      // The size sits in the first few KB unless a big EXIF block comes first.
      for (const len of [64 * 1024, 1024 * 1024]) {
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, 0);
        size = imageSize(buf.subarray(0, read));
        if (size || read < len) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    size = null;
  }
  const valid = size && size.w > 0 && size.h > 0 ? size : null;
  if (valid) cache.set(filename, valid);
  return valid;
}

// {w, h} of a base64 data: URI (the news form's live preview), or null.
function dataUriSize(uri) {
  const m = /^data:image\/[a-z+]+;base64,/i.exec(uri || '');
  if (!m) return null;
  const size = imageSize(Buffer.from(uri.slice(m[0].length, m[0].length + 90000), 'base64'));
  return size && size.w > 0 && size.h > 0 ? size : null;
}

module.exports = { imageSize, uploadSize, dataUriSize };
