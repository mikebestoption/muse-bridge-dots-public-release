'use strict';

// sparkClient vision tests — plain asserts, fetch stubbed (no network).
// Run: node tests/sparkVision.test.js

const assert = require('assert');
const {
  chatCompletion,
  SYSTEM_PROMPT,
  toApiMessages,
  isVisionRejected,
  VisionRejectedError
} = require('../src/sparkClient');

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

(async () => {
  // SYSTEM_PROMPT keeps its export and gains the Teach note.
  assert.ok(typeof SYSTEM_PROMPT === 'string' && SYSTEM_PROMPT.length > 0, 'SYSTEM_PROMPT exported');
  assert.ok(/Teach mode/.test(SYSTEM_PROMPT), 'SYSTEM_PROMPT mentions Teach mode');
  assert.ok(/propose-only/.test(SYSTEM_PROMPT), 'SYSTEM_PROMPT says screenshot advice is propose-only');
  assert.ok(/no autonomous clicking/.test(SYSTEM_PROMPT), 'SYSTEM_PROMPT rules out autonomous clicking');

  // Plain messages: shape unchanged — exactly { role, content } per message.
  const plainIn = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'thanks' }
  ];
  const plainOut = toApiMessages(plainIn);
  assert.deepStrictEqual(plainOut, plainIn, 'no-image messages pass through in shape');
  assert.strictEqual(
    JSON.stringify(plainOut),
    JSON.stringify(plainIn),
    'no-image conversion is byte-identical JSON'
  );
  assert.ok(plainOut.every((m) => !('imageDataUrl' in m)), 'no imageDataUrl key leaks into plain output');

  // Vision message: only that message converts, to the OpenAI vision shape.
  const visionOut = toApiMessages([
    { role: 'user', content: 'before' },
    { role: 'user', content: 'what is this?', imageDataUrl: IMG },
    { role: 'assistant', content: 'after' }
  ]);
  assert.deepStrictEqual(visionOut[0], { role: 'user', content: 'before' }, 'plain neighbour unchanged');
  assert.deepStrictEqual(visionOut[2], { role: 'assistant', content: 'after' }, 'plain neighbour unchanged');
  assert.deepStrictEqual(
    visionOut[1],
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: IMG } }
      ]
    },
    'vision message uses [{text},{image_url}] content'
  );

  // Empty/absent imageDataUrl is not vision.
  assert.deepStrictEqual(
    toApiMessages([{ role: 'user', content: 'x', imageDataUrl: '' }]),
    [{ role: 'user', content: 'x' }],
    'empty imageDataUrl stays plain'
  );
  assert.throws(() => toApiMessages('nope'), TypeError, 'non-array input rejected');

  // isVisionRejected: only 400/422 mentioning image/vision.
  assert.strictEqual(isVisionRejected(400, 'image_url is not supported'), true);
  assert.strictEqual(isVisionRejected(422, 'vision input invalid'), true);
  assert.strictEqual(isVisionRejected(400, 'model not found'), false, 'unrelated 400 is not a vision rejection');
  assert.strictEqual(isVisionRejected(500, 'image exploded'), false, '500 is not a vision rejection');
  assert.strictEqual(isVisionRejected(401, ''), false);

  // chatCompletion with stubbed fetch: capture the request body.
  const realFetch = global.fetch;
  let captured = null;
  try {
    global.fetch = async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'stub reply' } }] })
      };
    };

    // No-image path: body shape identical to the pre-vision client —
    // { model, messages: [system, ...messages] } with plain string content.
    const reply = await chatCompletion({
      apiKey: 'test-key', model: 'muse-spark-1.3', messages: plainIn
    });
    assert.strictEqual(reply, 'stub reply');
    assert.deepStrictEqual(Object.keys(captured), ['model', 'messages'], 'request body keys unchanged');
    assert.deepStrictEqual(
      captured.messages,
      [{ role: 'system', content: SYSTEM_PROMPT }, ...plainIn],
      'no-image request messages unchanged in shape'
    );

    // Vision path: the image message is converted in the actual request.
    await chatCompletion({
      apiKey: 'test-key', model: 'muse-spark-1.3',
      messages: [{ role: 'user', content: 'look', imageDataUrl: IMG }]
    });
    assert.deepStrictEqual(
      captured.messages[1],
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: IMG } }
        ]
      },
      'chatCompletion sends the vision shape'
    );

    // API rejects the image (400 mentioning image): VISION_REJECTED code.
    global.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'Bad request: image input is not supported by this model'
    });
    await assert.rejects(
      () => chatCompletion({
        apiKey: 'test-key', model: 'muse-spark-1.3',
        messages: [{ role: 'user', content: 'look', imageDataUrl: IMG }]
      }),
      (err) => err instanceof VisionRejectedError && err.code === 'VISION_REJECTED' && /rejected image input/.test(err.message),
      'image rejection throws err.code VISION_REJECTED'
    );

    // A non-vision API error keeps the old plain-Error behaviour.
    global.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'server exploded'
    });
    await assert.rejects(
      () => chatCompletion({ apiKey: 'test-key', model: 'muse-spark-1.3', messages: plainIn }),
      (err) => err.code !== 'VISION_REJECTED' && /returned 500/.test(err.message),
      'non-vision errors are unchanged'
    );
  } finally {
    global.fetch = realFetch;
  }

  console.log('sparkVision.test.js: ALL PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
