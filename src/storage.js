// The server's file storage (the uploads folder on the data volume): how
// full the disk is, and a tidy-up that keeps it from filling up. The tidy-up
// runs shortly after every start and each night (src/scheduler.js).
//
// It never removes or visibly changes a picture the app still uses:
//  - Identical files - a saved headshot copied into every article and every
//    week's principal's message - end up as one file on disk under all
//    their names (hard links). Nothing changes for the app.
//  - Files that nothing in the database names any more (left over from a
//    crash or an interrupted upload) are removed once they are a day old.
//  - Portraits, headshots, logos and backgrounds stored as full-size phone
//    originals are scaled down to 1200px, like article photos already are.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { db, getSetting, setSetting } = require('./db');
const { shrunkImage, replaceContent, MAX_SIDE } = require('./uploads');
const { uploadSize } = require('./imagesize');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;
const TIDY = 'storage_tidy';

// Size, free and used bytes of the disk the data folder lives on (on
// Railway: the volume), or null where the platform cannot say.
function diskUsage() {
  try {
    const s = fs.statfsSync(config.dataDir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free, percent: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch {
    return null;
  }
}

// Every stored file: name -> fs.Stats. Temp files (dot names) are skipped.
function listUploads() {
  const files = new Map();
  let names = [];
  try {
    names = fs.readdirSync(config.uploadDir);
  } catch {
    return files;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(config.uploadDir, name));
      if (st.isFile()) files.set(name, st);
    } catch {
      // Removed meanwhile.
    }
  }
  return files;
}

// The stored files the database mentions anywhere: every text value of
// every table is searched for file names, so a picture referenced from a new
// table, a setting or an issue's saved HTML is never taken for unused.
function referencedNames(onDisk) {
  const refs = new Set();
  // A name may sit glued to other text ("/uploads/<name>", JSON): every
  // possible tail of a candidate is tried at the lengths names really have.
  const lengths = [...new Set([...onDisk].map((n) => n.length))];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name: table } of tables) {
    for (const { name: col } of db.prepare(`PRAGMA table_info("${table}")`).all()) {
      const rows = db.prepare(`SELECT "${col}" AS v FROM "${table}" WHERE typeof("${col}") = 'text'`).all();
      for (const { v } of rows) {
        if (onDisk.has(v)) {
          refs.add(v);
          continue;
        }
        for (const m of v.matchAll(/[\w.-]+\.(?:jpe?g|png|webp|gif)/gi)) {
          for (const len of lengths) {
            const tail = m[0].slice(-len);
            if (len <= m[0].length && onDisk.has(tail)) refs.add(tail);
          }
        }
      }
    }
  }
  return refs;
}

// What the stored files are, for the Settings page and the logs. Files that
// share their bytes (hard links) are counted once.
const KINDS = [
  ['Article photos', 'SELECT filename AS f FROM photos'],
  ['Section-head portraits', 'SELECT lead_photo AS f FROM news WHERE lead_photo IS NOT NULL'],
  ["Principal's portraits", 'SELECT photo AS f FROM principal_messages WHERE photo IS NOT NULL'],
  ['Staff headshots', 'SELECT headshot AS f FROM users WHERE headshot IS NOT NULL'],
  ['House logos', 'SELECT logo AS f FROM houses WHERE logo IS NOT NULL'],
];

function storageReport() {
  const files = listUploads();
  const kindOf = new Map();
  for (const [label, sql] of KINDS) {
    for (const { f } of db.prepare(sql).all()) if (f && !kindOf.has(f)) kindOf.set(f, label);
  }
  const masthead = getSetting('masthead_photo');
  if (masthead && !kindOf.has(masthead)) kindOf.set(masthead, 'Masthead background');
  const refs = referencedNames(new Set(files.keys()));
  const groups = new Map();
  const seen = new Set();
  let bytes = 0;
  for (const [name, st] of files) {
    const label = kindOf.get(name) || (refs.has(name) ? 'Other pictures' : 'Unused files');
    const g = groups.get(label) || { label, files: 0, bytes: 0 };
    g.files += 1;
    const inode = `${st.dev}:${st.ino}`;
    if (!seen.has(inode)) {
      seen.add(inode);
      g.bytes += st.size;
      bytes += st.size;
    }
    groups.set(label, g);
  }
  return {
    disk: diskUsage(),
    files: files.size,
    bytes,
    kinds: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

const mb = (n) => `${(n / MB).toFixed(1)} MB`;

function describeReport(r) {
  const disk = r.disk ? `disk ${mb(r.disk.used)} of ${mb(r.disk.total)} used (${r.disk.percent}%)` : 'disk size unknown';
  const kinds = r.kinds.map((k) => `${k.label} ${k.files} (${mb(k.bytes)})`).join(', ');
  return `${disk}; ${r.files} files, ${mb(r.bytes)}${kinds ? `: ${kinds}` : ''}`;
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function tidyStorage({ now = Date.now() } = {}) {
  const dir = config.uploadDir;
  const at = (name) => path.join(dir, name);
  const result = { removed: 0, removedBytes: 0, shared: 0, sharedBytes: 0, shrunk: 0, shrunkBytes: 0 };
  const before = diskUsage();

  // Temp files left by an interrupted replace.
  for (const name of fs.readdirSync(dir)) {
    if (!/^\.[0-9a-f]{16}\.(tmp|swap)$/.test(name)) continue;
    try {
      if (now - fs.statSync(at(name)).mtimeMs > HOUR) fs.rmSync(at(name), { force: true });
    } catch {
      // Gone already.
    }
  }

  // 1. Unused files, a day old (a hard link's ctime is when it was made, so
  // a copy that is seconds old is never taken for an old file).
  let files = listUploads();
  const refs = referencedNames(new Set(files.keys()));
  for (const [name, st] of files) {
    if (refs.has(name) || now - Math.max(st.mtimeMs, st.ctimeMs) < DAY) continue;
    try {
      fs.unlinkSync(at(name));
      result.removed += 1;
      if (st.nlink === 1) result.removedBytes += st.size;
    } catch (err) {
      console.error('[storage] Could not remove unused file:', err.message);
    }
  }

  // 2. Identical files share one copy on disk.
  files = listUploads();
  const bySize = new Map();
  for (const [name, st] of files) {
    if (!st.size) continue;
    const list = bySize.get(st.size) || [];
    list.push([name, st]);
    bySize.set(st.size, list);
  }
  for (const [size, list] of bySize) {
    if (new Set(list.map(([, st]) => st.ino)).size < 2) continue;
    const byHash = new Map();
    for (const [name, st] of list) {
      try {
        const h = sha(at(name));
        const group = byHash.get(h) || [];
        group.push([name, st]);
        byHash.set(h, group);
      } catch {
        // Unreadable: leave it alone.
      }
    }
    for (const group of byHash.values()) {
      const [keepName, keepSt] = group[0];
      const freed = new Set();
      for (const [name, st] of group.slice(1)) {
        if (st.ino === keepSt.ino) continue;
        const swap = at(`.${crypto.randomBytes(8).toString('hex')}.swap`);
        try {
          fs.linkSync(at(keepName), swap);
          fs.renameSync(swap, at(name));
          result.shared += 1;
          freed.add(st.ino);
        } catch (err) {
          fs.rmSync(swap, { force: true });
          if (err.code !== 'ENOENT') console.error('[storage] Could not share identical file:', err.message);
        }
      }
      result.sharedBytes += freed.size * size;
    }
  }

  // 3. Oversized pictures scaled down - one file at a time, under all the
  // names that share it. Article photos are already at most 1200px.
  files = listUploads();
  const byInode = new Map();
  for (const [name, st] of files) {
    const key = `${st.dev}:${st.ino}`;
    const entry = byInode.get(key) || { names: [], st };
    entry.names.push(name);
    byInode.set(key, entry);
  }
  for (const { names, st } of byInode.values()) {
    const dims = uploadSize(names[0]);
    if (dims && Math.max(dims.w, dims.h) <= MAX_SIDE && st.size <= MB) continue;
    const out = await shrunkImage(at(names[0]));
    if (!out) continue;
    try {
      replaceContent(names, out);
      result.shrunk += 1;
      result.shrunkBytes += st.size - out.length;
    } catch (err) {
      console.error('[storage] Could not scale down a picture:', err.message);
    }
  }

  const after = diskUsage();
  const summary = {
    at: new Date(now).toISOString(),
    ...result,
    freed: result.removedBytes + result.sharedBytes + result.shrunkBytes,
    disk: after || before,
  };
  try {
    setSetting(TIDY, JSON.stringify(summary));
  } catch {
    // A full disk can refuse even this; the log line still tells.
  }
  console.log(
    `[storage] Tidy-up freed ${mb(summary.freed)}: ${result.removed} unused files removed, ` +
      `${result.shared} identical copies shared, ${result.shrunk} oversized pictures scaled down.`
  );
  return summary;
}

function lastTidy() {
  try {
    return JSON.parse(getSetting(TIDY) || 'null');
  } catch {
    return null;
  }
}

// Logged around the start-up tidy-up, so the logs show where the space goes.
async function startupTidy() {
  try {
    console.log(`[storage] Before tidy-up: ${describeReport(storageReport())}`);
    await tidyStorage();
    console.log(`[storage] After tidy-up: ${describeReport(storageReport())}`);
  } catch (err) {
    console.error('[storage] Tidy-up failed:', err.message);
  }
}

module.exports = { diskUsage, storageReport, describeReport, tidyStorage, startupTidy, lastTidy, referencedNames };
