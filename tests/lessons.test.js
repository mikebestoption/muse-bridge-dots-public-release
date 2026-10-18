'use strict';

// Teach-mode Lessons library tests — fake 1x1 screenshot only, tmp dir only.
// Run: node tests/lessons.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLessonsStore, MAX_IMAGE_BYTES } = require('../src/lessons');

// Well-known 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;
const JPEG_URL = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`;

(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-lessons-'));
  try {
    const store = createLessonsStore(dir);

    // Empty library.
    assert.deepStrictEqual(store.list(), [], 'new store lists no lessons');
    assert.strictEqual(store.getContext(), '', 'no lessons -> empty context');
    assert.strictEqual(store.getImageDataUrl('nope'), null, 'unknown id -> null image');
    assert.strictEqual(store.remove('nope'), false, 'removing unknown id returns false');

    // Add + roundtrip.
    const lesson = store.add({
      name: 'Open the fills window',
      note: 'The blue Fills button is top-right.',
      actionMapping: 'open this app',
      imageDataUrl: PNG_URL
    });
    assert.ok(typeof lesson.id === 'string' && lesson.id.length > 0, 'lesson has an id');
    assert.strictEqual(lesson.name, 'Open the fills window');
    assert.strictEqual(lesson.note, 'The blue Fills button is top-right.');
    assert.strictEqual(lesson.actionMapping, 'open this app');
    assert.ok(lesson.imageFile.endsWith('.png'), 'png lesson saved as .png');
    assert.ok(lesson.createdAt && !Number.isNaN(Date.parse(lesson.createdAt)), 'createdAt is a timestamp');
    assert.deepStrictEqual(
      Object.keys(lesson).sort(),
      ['actionMapping', 'createdAt', 'id', 'imageFile', 'name', 'note'],
      'returned lesson carries exactly the public fields'
    );
    assert.ok(!JSON.stringify(lesson).includes(PNG_B64), 'returned lesson has no image bytes');

    // Image landed on disk, in the subfolder, byte-identical.
    const imagePath = path.join(dir, 'lessons-images', lesson.imageFile);
    assert.ok(fs.existsSync(imagePath), 'image file saved under lessons-images/');
    assert.ok(fs.readFileSync(imagePath).equals(Buffer.from(PNG_B64, 'base64')), 'saved image bytes match');

    // Metadata landed in lessons.json, without image bytes.
    const rawJson = fs.readFileSync(path.join(dir, 'lessons.json'), 'utf8');
    assert.ok(!rawJson.includes(PNG_B64), 'lessons.json has no image bytes');

    // list(): same public shape, no image bytes.
    const listed = store.list();
    assert.strictEqual(listed.length, 1, 'list returns the lesson');
    assert.deepStrictEqual(listed[0], lesson, 'list entry matches the added lesson');
    assert.ok(!JSON.stringify(listed).includes(PNG_B64), 'list has no image bytes');

    // A second store over the same folder sees the same library (persistence).
    const reopened = createLessonsStore(dir);
    assert.strictEqual(reopened.list().length, 1, 'lessons persist across store instances');
    assert.strictEqual(reopened.getImageDataUrl(lesson.id), PNG_URL, 'image data URL roundtrips');

    // jpeg is accepted too, with a .jpg file.
    const jpegLesson = store.add({
      name: 'JPEG shot', note: '', actionMapping: '', imageDataUrl: JPEG_URL
    });
    assert.ok(jpegLesson.imageFile.endsWith('.jpg'), 'jpeg lesson saved as .jpg');
    assert.strictEqual(store.getImageDataUrl(jpegLesson.id), JPEG_URL, 'jpeg data URL roundtrips');

    // getContext(): name + note + actionMapping, capped at the most recent N.
    const ctx = store.getContext();
    assert.ok(ctx.includes('Open the fills window'), 'context includes lesson name');
    assert.ok(ctx.includes('The blue Fills button is top-right.'), 'context includes note');
    assert.ok(ctx.includes('open this app'), 'context includes action mapping');
    assert.ok(!ctx.includes(PNG_B64), 'context has no image bytes');
    const ctxOne = store.getContext(1);
    assert.ok(ctxOne.includes('JPEG shot'), 'getContext(1) keeps the most recent lesson');
    assert.ok(!ctxOne.includes('Open the fills window'), 'getContext(1) drops older lessons');
    assert.strictEqual(store.getContext(0), '', 'getContext(0) is empty');

    // Rejections: non-image / wrong type / missing — and nothing is stored.
    const before = store.list().length;
    assert.throws(() => store.add({ name: 'x', imageDataUrl: 'data:text/plain;base64,aGk=' }), /png, jpeg, or webp/, 'text data URL rejected');
    assert.throws(() => store.add({ name: 'x', imageDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }), /png, jpeg, or webp/, 'gif data URL rejected');
    assert.throws(() => store.add({ name: 'x', imageDataUrl: 'https://example.test/shot.png' }), /png, jpeg, or webp/, 'plain URL rejected');
    assert.throws(() => store.add({ name: 'x', imageDataUrl: '' }), /needs an image/, 'missing image rejected');
    assert.throws(() => store.add({ name: 'x' }), /needs an image/, 'absent image rejected');
    assert.throws(() => store.add({ imageDataUrl: PNG_URL }), /needs a name/, 'missing name rejected');

    // Oversize: >8 MB decoded is rejected before anything is written.
    const bigUrl = `data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')}`;
    assert.throws(() => store.add({ name: 'big', imageDataUrl: bigUrl }), /too large/, 'oversize image rejected');
    assert.strictEqual(store.list().length, before, 'rejected adds store nothing');

    // remove(): entry and image file both go.
    assert.strictEqual(store.remove(lesson.id), true, 'remove returns true');
    assert.strictEqual(store.list().length, before - 1, 'lesson removed from list');
    assert.ok(!fs.existsSync(imagePath), 'image file deleted on remove');
    assert.strictEqual(store.getImageDataUrl(lesson.id), null, 'removed lesson has no image');
    assert.strictEqual(store.remove(lesson.id), false, 'second remove returns false');

    console.log('lessons.test.js: ALL PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
