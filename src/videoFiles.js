'use strict';

// Staged video files (Muse Bridge v0.4.0).
// A video Michael hands the app — dropped/selected on this PC, or
// downloaded from Vimeo with his token — is copied INTO userData so
// frame sampling has a stable local source:
//   <userData>/video-temp/index.json   (id -> { file, name, size, source })
//   <userData>/video-temp/<id>.<ext>   (the video bytes)
// Copies STREAM (fs streams, never a whole-file read into memory) and
// are capped at 500 MB. Nothing here uploads anything anywhere.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v'];

function createVideoStore(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createVideoStore requires a userData path.');
  }
  const dir = path.join(userDataPath, 'video-temp');
  const indexFile = path.join(dir, 'index.json');

  function readIndex() {
    try {
      if (fs.existsSync(indexFile)) {
        const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (_) { /* corrupt index -> start fresh */ }
    return {};
  }

  function writeIndex(index) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf8');
  }

  function makeId() {
    return `vid-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  }

  function newTarget(ext) {
    const safeExt = VIDEO_EXTS.includes(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : '.mp4';
    const id = makeId();
    fs.mkdirSync(dir, { recursive: true });
    return { id, absPath: path.join(dir, `${id}${safeExt}`) };
  }

  // Register a file that already lives at absPath (e.g. a finished
  // download written by the caller into newTarget()'s path).
  function register(id, absPath, { name, size, source }) {
    const index = readIndex();
    index[id] = {
      file: path.basename(absPath),
      name: typeof name === 'string' ? name : '',
      size: Number.isFinite(size) ? size : 0,
      source: source || 'file',
      createdAt: new Date().toISOString()
    };
    writeIndex(index);
    return { id, name: index[id].name, size: index[id].size };
  }

  // Stream-copy a local file into the store. Rejects non-video
  // extensions and anything over the cap BEFORE copying (stat first),
  // and counts bytes while streaming as a backstop.
  async function stageCopy(sourcePath) {
    const ext = path.extname(String(sourcePath || '')).toLowerCase();
    if (!VIDEO_EXTS.includes(ext)) {
      throw new Error(`Not a video file (${ext || 'no extension'}) — use mp4, webm, mov, or m4v.`);
    }
    const stat = await fs.promises.stat(sourcePath);
    if (!stat.isFile()) throw new Error('That is not a file.');
    if (stat.size > MAX_VIDEO_BYTES) {
      throw new Error(`That video is ${Math.round(stat.size / (1024 * 1024))} MB — the limit is 500 MB.`);
    }
    const { id, absPath } = newTarget(ext);
    let copied = 0;
    const counter = new (require('stream').Transform)({
      transform(chunk, _enc, cb) {
        copied += chunk.length;
        if (copied > MAX_VIDEO_BYTES) {
          cb(new Error('Video exceeds the 500 MB limit.'));
          return;
        }
        cb(null, chunk);
      }
    });
    try {
      await pipeline(fs.createReadStream(sourcePath), counter, fs.createWriteStream(absPath));
    } catch (err) {
      try { fs.unlinkSync(absPath); } catch (_) { /* partial copy cleanup */ }
      throw err;
    }
    return register(id, absPath, { name: path.basename(sourcePath), size: copied, source: 'file' });
  }

  function getPath(id) {
    const index = readIndex();
    const entry = index[id];
    if (!entry || !entry.file) return null;
    const abs = path.join(dir, path.basename(entry.file));
    return fs.existsSync(abs) ? abs : null;
  }

  function list() {
    const index = readIndex();
    return Object.entries(index).map(([id, e]) => ({ id, name: e.name, size: e.size, source: e.source }));
  }

  return { stageCopy, newTarget, register, getPath, list, dir };
}

module.exports = { createVideoStore, MAX_VIDEO_BYTES, VIDEO_EXTS };
