'use strict';

// Teach-mode Lessons library (v0.3.3 spec, section B).
// - A lesson is a screenshot plus Michael's own words: a name, a note about
//   what the shot shows / what to click / what to do, and an optional
//   proposed action mapping (e.g. "open this app").
// - Stored locally ONLY, in the app's userData folder:
//     <userData>/lessons.json          (metadata, never image bytes)
//     <userData>/lessons-images/<id>.<ext>  (one file per lesson image)
// - Lessons never leave the machine on their own: there is no network code
//   here at all. An image only leaves as part of a chat Michael himself
//   sends, via getImageDataUrl(id) called by the chat path.
// - list() returns metadata only — no image bytes, no data URLs.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8 MB decoded

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp'
};

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

// Parse and validate an image data URL. Returns { mime, buffer }.
// Throws a plain Error with a human-readable reason on any problem.
// Never logs the data URL or the decoded bytes.
function parseImageDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== 'string' || imageDataUrl.length === 0) {
    throw new Error('A lesson needs an image (a png, jpeg, or webp data URL).');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(imageDataUrl);
  if (!match) {
    throw new Error('Lesson image must be a png, jpeg, or webp data URL.');
  }
  const mime = match[1];
  const base64 = match[2].replace(/\s+/g, '');
  if (base64.length === 0) {
    throw new Error('Lesson image is empty.');
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw new Error('Lesson image is empty.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Lesson image is too large: ${buffer.length} bytes (max ${MAX_IMAGE_BYTES} bytes / ~8 MB).`
    );
  }
  return { mime, buffer };
}

function createLessonsStore(userDataPath) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new Error('createLessonsStore requires a userData path.');
  }
  const lessonsFile = path.join(userDataPath, 'lessons.json');
  const imagesDir = path.join(userDataPath, 'lessons-images');

  function readRaw() {
    try {
      if (fs.existsSync(lessonsFile)) {
        const parsed = JSON.parse(fs.readFileSync(lessonsFile, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {
      // Corrupt lessons file: fall back to an empty library rather than crashing.
    }
    return [];
  }

  function writeRaw(lessons) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(lessonsFile, JSON.stringify(lessons, null, 2), 'utf8');
  }

  function toPublic(lesson) {
    return {
      id: lesson.id,
      name: lesson.name,
      note: lesson.note,
      actionMapping: lesson.actionMapping,
      imageFile: lesson.imageFile,
      createdAt: lesson.createdAt
    };
  }

  function makeId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  }

  function list() {
    return readRaw().map(toPublic);
  }

  function add({ name, note, actionMapping, imageDataUrl } = {}) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('A lesson needs a name.');
    }
    // Validate the image BEFORE writing anything, so a rejected image
    // leaves no partial lesson or orphan file behind.
    const { mime, buffer } = parseImageDataUrl(imageDataUrl);

    const id = makeId();
    const imageFile = `${id}${MIME_TO_EXT[mime]}`;
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, imageFile), buffer);

    const lesson = {
      id,
      name: name.trim(),
      note: typeof note === 'string' ? note : '',
      actionMapping: typeof actionMapping === 'string' ? actionMapping : '',
      imageFile,
      createdAt: new Date().toISOString()
    };
    const lessons = readRaw();
    lessons.push(lesson);
    writeRaw(lessons);
    return toPublic(lesson);
  }

  function remove(id) {
    const lessons = readRaw();
    const idx = lessons.findIndex((l) => l.id === id);
    if (idx === -1) return false;
    const [removed] = lessons.splice(idx, 1);
    writeRaw(lessons);
    if (removed && removed.imageFile) {
      try {
        // imageFile is a basename we generated; basename() guards traversal.
        fs.unlinkSync(path.join(imagesDir, path.basename(removed.imageFile)));
      } catch (_) { /* image already gone: removal of the lesson still counts */ }
    }
    return true;
  }

  // Text block summarising lessons for inclusion as chat context, in the
  // same spirit as Standing Orders: prepended context, reference only.
  // Most recent lessons win when the library exceeds maxLessons.
  function getContext(maxLessons = 10) {
    const limit = Number.isFinite(maxLessons) ? Math.floor(maxLessons) : 10;
    if (limit <= 0) return '';
    const lessons = readRaw().slice(-limit);
    if (lessons.length === 0) return '';
    const lines = [
      'Teach lessons Michael saved from screenshots (reference only — advise and propose, never act autonomously):'
    ];
    lessons.forEach((lesson, i) => {
      lines.push(`${i + 1}. ${lesson.name}`);
      if (lesson.note) lines.push(`   Note: ${lesson.note}`);
      if (lesson.actionMapping) lines.push(`   Action mapping: ${lesson.actionMapping}`);
    });
    return lines.join('\n');
  }

  // The full data URL for one lesson's image, for Michael to send with a
  // chat message. Returns null when the lesson or its image is missing.
  function getImageDataUrl(id) {
    const lesson = readRaw().find((l) => l.id === id);
    if (!lesson || !lesson.imageFile) return null;
    const file = path.join(imagesDir, path.basename(lesson.imageFile));
    const mime = EXT_TO_MIME[path.extname(file).toLowerCase()];
    if (!mime) return null;
    try {
      const buffer = fs.readFileSync(file);
      return `data:${mime};base64,${buffer.toString('base64')}`;
    } catch (_) {
      return null;
    }
  }

  return { list, add, remove, getContext, getImageDataUrl };
}

module.exports = { createLessonsStore, MAX_IMAGE_BYTES };
