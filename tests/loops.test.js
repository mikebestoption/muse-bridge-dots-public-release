'use strict';

// Loops tests (v0.4.0) — store CRUD + step ordering, documentation
// rendering, {{prev}} substitution, SOP-independent runner behavior,
// and THE approval gate: with fakes, a task step must NOT execute when
// its approval resolves false. Tmp dirs only, no network.
// Run: node tests/loops.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/loopsCore');
const { createLoopsStore } = require('../src/loops');
const { createLoopRunner } = require('../src/loopRunner');

function sampleLoopData() {
  return {
    name: 'Morning checks',
    description: 'Open the dashboard, then ask Spark to summarize.',
    steps: [
      { type: 'note', text: 'Runs weekday mornings.' },
      { type: 'task', action: { type: 'open_url', url: 'https://example.com/dashboard' } },
      { type: 'prompt', text: 'Summarize this: {{prev}}' },
      { type: 'fill', fillKind: 'fill_login', entryLabel: 'Test Bank' },
      { type: 'instruction', text: 'Check the printed report on the desk.' }
    ]
  };
}

function testStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-loops-'));
  try {
    const store = createLoopsStore(dir);
    assert.deepStrictEqual(store.list(), [], 'new store lists no loops');
    assert.strictEqual(store.get('nope'), null, 'unknown id -> null');
    assert.strictEqual(store.remove('nope'), false, 'removing unknown id returns false');

    const loop = store.create(sampleLoopData());
    assert.ok(loop.id.startsWith('loop-'), 'loop id has the loop- prefix');
    assert.strictEqual(loop.name, 'Morning checks');
    assert.strictEqual(loop.steps.length, 5, 'all five step types stored');
    assert.ok(loop.createdAt && loop.updatedAt, 'timestamps set');
    // Steps normalized: ids assigned, fill step keeps label only.
    for (const s of loop.steps) assert.ok(s.id, 'every step has an id');
    const fill = loop.steps.find((s) => s.type === 'fill');
    assert.deepStrictEqual(
      Object.keys(fill).sort(),
      ['entryLabel', 'fillKind', 'id', 'type'],
      'fill step carries label + kind only — no secret-shaped fields'
    );

    // Persistence across store instances.
    const reopened = createLoopsStore(dir);
    assert.strictEqual(reopened.list().length, 1, 'loops persist');
    assert.strictEqual(reopened.get(loop.id).name, 'Morning checks');

    // Update + reorder via update.
    const data = sampleLoopData();
    data.name = 'Morning checks v2';
    data.steps = core.moveStep(data.steps, 4, 0); // instruction first
    const updated = store.update(loop.id, data);
    assert.strictEqual(updated.name, 'Morning checks v2');
    assert.strictEqual(updated.steps[0].type, 'instruction', 'reorder persisted (moveStep + update)');
    assert.ok(updated.updatedAt >= loop.updatedAt, 'updatedAt refreshed');

    // On-disk file is loops.json and round-trips.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'loops.json'), 'utf8'));
    assert.strictEqual(raw.length, 1);
    assert.strictEqual(raw[0].steps[0].type, 'instruction');

    // Validation failures throw and store nothing.
    assert.throws(() => store.create({ name: '', steps: [] }), /needs a name/);
    assert.throws(() => store.create({ name: 'x', steps: [{ type: 'bogus' }] }), /unknown step type/);
    assert.throws(
      () => store.create({ name: 'x', steps: [{ type: 'task', action: { type: 'fill_login', entryLabel: 'y' } }] }),
      /needs one of these actions/,
      'task steps cannot smuggle a hands action past the step-type split'
    );
    assert.throws(
      () => store.create({ name: 'x', steps: [{ type: 'fill', fillKind: 'fill_login', entryLabel: ' ' }] }),
      /needs the vault entry label/
    );
    assert.throws(() => store.update('nope', sampleLoopData()), /no longer exists/);
    assert.strictEqual(store.list().length, 1, 'failed creates stored nothing');

    // Remove.
    assert.strictEqual(store.remove(loop.id), true);
    assert.strictEqual(store.list().length, 0);
    console.log('  ✓ loops store: CRUD, persistence, reorder, validation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testCore() {
  // moveStep ordering.
  const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(core.moveStep(steps, 0, 2).map((s) => s.id), ['b', 'c', 'a']);
  assert.deepStrictEqual(core.moveStep(steps, 2, 0).map((s) => s.id), ['c', 'a', 'b']);
  assert.deepStrictEqual(core.moveStep(steps, 9, 0).map((s) => s.id), ['a', 'b', 'c'], 'out-of-range from is a no-op');
  assert.deepStrictEqual(steps.map((s) => s.id), ['a', 'b', 'c'], 'moveStep does not mutate its input');

  // {{prev}} substitution.
  assert.strictEqual(core.applyPrev('Sum: {{prev}}!', 'ABC'), 'Sum: ABC!');
  assert.strictEqual(core.applyPrev('{{ prev }} and {{prev}}', 'x'), 'x and x');
  assert.strictEqual(core.applyPrev('no placeholder', 'x'), 'no placeholder');
  assert.strictEqual(core.applyPrev('{{prev}}', null), '');

  // stepToAction: task passes through with a label; fill builds the
  // guarded action from the label only; other types -> null.
  const taskAction = core.stepToAction({ type: 'task', action: { type: 'list_folder', path: '/tmp' } }, 'L');
  assert.strictEqual(taskAction.type, 'list_folder');
  assert.ok(taskAction.label.includes('Loop "L"'), 'task action labeled with the loop name');
  const fillAction = core.stepToAction({ type: 'fill', fillKind: 'fill_totp', entryLabel: 'Bank', targetWindowTitle: 'Bank — Sign in' }, 'L');
  assert.deepStrictEqual(fillAction, {
    type: 'fill_totp', entryLabel: 'Bank', targetWindowTitle: 'Bank — Sign in',
    label: 'Loop "L": Fill authenticator code for Bank'
  });
  assert.strictEqual(core.stepToAction({ type: 'prompt', text: 'hi' }), null);
  assert.strictEqual(core.stepToAction({ type: 'note', text: 'hi' }), null);

  // Plain-English descriptions + the doc view.
  const loop = { ...sampleLoopData(), steps: core.validateLoopData(sampleLoopData()).steps, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z' };
  const md = core.loopToMarkdown(loop);
  assert.ok(md.startsWith('# Loop: Morning checks'), 'doc starts with the loop name');
  assert.ok(md.includes('1. **Note**'), 'doc numbers the steps');
  assert.ok(md.includes('Open URL: https://example.com/dashboard'), 'doc describes the task step');
  assert.ok(md.includes('vault entry "Test Bank"'), 'doc names the fill entry label');
  assert.ok(md.includes('never bypasses approvals'), 'doc states the approval model');
  console.log('  ✓ loops core: moveStep, {{prev}}, stepToAction, doc markdown');
}

function makeDeps(overrides) {
  const calls = { chat: [], approvals: [], executions: [], instructions: [] };
  const deps = {
    mode: 'interactive',
    sleep: () => Promise.resolve(),
    chat: async (prompt) => { calls.chat.push(prompt); return { text: `reply to: ${prompt}` }; },
    requestApproval: async (action) => { calls.approvals.push(action); return true; },
    executeTask: async (action) => { calls.executions.push(action); return { ok: true, output: `did ${action.type}` }; },
    waitInstruction: async (step) => { calls.instructions.push(step); return 'done'; },
    onEvent: () => {},
    ...overrides
  };
  return { deps, calls };
}

async function testRunnerOrderAndPrev() {
  const loop = { name: 'Order', steps: core.validateLoopData(sampleLoopData()).steps };
  const { deps, calls } = makeDeps();
  const events = [];
  deps.onEvent = (e) => events.push(e);
  const runner = createLoopRunner({ loop, deps });
  const result = await runner.start();
  assert.strictEqual(result.status, 'done', 'clean run finishes done');
  assert.deepStrictEqual(result.steps.map((s) => s.status), ['done', 'done', 'done', 'done', 'done']);
  // {{prev}} received the open_url step's execution output.
  assert.strictEqual(calls.chat.length, 1);
  assert.strictEqual(calls.chat[0], 'Summarize this: did open_url', '{{prev}} substituted with previous step output');
  // Approvals were requested for exactly the task + fill steps, in order.
  assert.deepStrictEqual(calls.approvals.map((a) => a.type), ['open_url', 'fill_login']);
  assert.deepStrictEqual(calls.executions.map((a) => a.type), ['open_url', 'fill_login']);
  assert.strictEqual(calls.instructions.length, 1, 'instruction step waited for the user');
  assert.ok(events.some((e) => e.type === 'run' && e.status === 'done'), 'run-done event emitted');
  console.log('  ✓ runner: step order, {{prev}} chaining, per-step approvals');
}

async function testRunnerApprovalGate() {
  const loop = { name: 'Gate', steps: core.validateLoopData(sampleLoopData()).steps };
  let executions = 0;
  const { deps } = makeDeps({
    requestApproval: async () => false, // user denies EVERY card
    executeTask: async () => { executions += 1; return { ok: true, output: 'must never happen' }; }
  });
  const runner = createLoopRunner({ loop, deps });
  const startPromise = runner.start();
  // First denial halts the run; decide skip twice (task + fill steps).
  for (let n = 0; n < 2; n++) {
    // Wait until the runner is halted, then skip.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(runner.getState().status, 'halted', 'run halts on a denied approval');
    assert.strictEqual(runner.decide('skip'), true, 'decide accepted while halted');
  }
  const result = await startPromise;
  assert.strictEqual(executions, 0, 'THE GATE: a denied step NEVER executes');
  assert.deepStrictEqual(
    result.steps.map((s) => s.status),
    ['done', 'denied', 'done', 'denied', 'done'],
    'denied steps keep their status; the run continued past them on Skip'
  );
  assert.strictEqual(result.status, 'failed', 'a run with denied steps reports failed, not done');
  console.log('  ✓ runner: APPROVAL GATE — denied task/fill steps never execute');
}

async function testRunnerHaltStopAndFailure() {
  const loop = { name: 'Fail', steps: core.validateLoopData(sampleLoopData()).steps };
  const { deps } = makeDeps({
    executeTask: async () => ({ ok: false, output: 'boom' })
  });
  const runner = createLoopRunner({ loop, deps });
  const startPromise = runner.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(runner.getState().status, 'halted', 'a failed step halts the run');
  runner.decide('stop');
  const result = await startPromise;
  assert.strictEqual(result.status, 'stopped');
  assert.strictEqual(result.steps[1].status, 'failed');
  assert.strictEqual(result.steps[2].status, 'pending', 'steps after the halt never ran');
  console.log('  ✓ runner: failed step halts; Stop ends the run');
}

async function testRunnerWaitForUserAndStop() {
  const loop = { name: 'Park', steps: core.validateLoopData(sampleLoopData()).steps };
  const { deps } = makeDeps({
    executeTask: async () => ({ ok: false, waitForUser: true, output: 'Vault locked — unlock to fill. Nothing was typed.' })
  });
  const result = await createLoopRunner({ loop, deps }).start();
  assert.strictEqual(result.status, 'waiting_on_user', 'waitForUser execution parks the run');
  assert.strictEqual(result.steps[1].status, 'waiting_on_user');
  assert.strictEqual(result.steps[2].status, 'pending', 'later steps did not run past the park');

  // Stop before start-of-step execution: approval resolves true but
  // stop was requested while waiting -> nothing executes.
  let executions = 0;
  const gate = makeDeps({
    requestApproval: async () => true,
    executeTask: async () => { executions += 1; return { ok: true, output: 'x' }; }
  });
  const runner = createLoopRunner({ loop, deps: gate.deps });
  const p = runner.start();
  runner.stop();
  const stopped = await p;
  assert.strictEqual(stopped.status, 'stopped');
  assert.strictEqual(executions, 0, 'stop requested before execution -> nothing executed');
  console.log('  ✓ runner: waitForUser parks; Stop prevents execution');
}

async function testRunnerInstructionAndPromptActions() {
  const loop = {
    name: 'Manual',
    steps: [
      { id: 'i1', type: 'instruction', text: 'Touch the security key.' },
      { id: 'p1', type: 'prompt', text: 'Plan something.' },
      { id: 'i2', type: 'instruction', text: 'Second manual step.' }
    ]
  };
  // Instruction 'park' (Night Queue mode) ends the run waiting_on_user.
  const park = makeDeps({ waitInstruction: async () => 'park' });
  const parked = await createLoopRunner({ loop, deps: park.deps }).start();
  assert.strictEqual(parked.status, 'waiting_on_user');
  assert.strictEqual(parked.reason, 'Touch the security key.');

  // A prompt reply proposing actions is noted, never executed.
  let executions = 0;
  const proposer = makeDeps({
    chat: async () => ({ text: 'Sure!', actions: [{ type: 'run_command', command: 'whoami' }] }),
    executeTask: async () => { executions += 1; return { ok: true, output: 'x' }; }
  });
  const done = await createLoopRunner({ loop, deps: proposer.deps }).start();
  assert.strictEqual(done.status, 'done');
  assert.ok(done.steps[1].output.includes('not run inside a Loop'), 'proposed actions noted as not run');
  assert.strictEqual(executions, 0, 'prompt-step proposals never execute');
  console.log('  ✓ runner: instruction park; prompt proposals never execute');
}

(async () => {
  testStore();
  testCore();
  await testRunnerOrderAndPrev();
  await testRunnerApprovalGate();
  await testRunnerHaltStopAndFailure();
  await testRunnerWaitForUserAndStop();
  await testRunnerInstructionAndPromptActions();
  console.log('loops.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
