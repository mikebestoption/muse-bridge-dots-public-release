'use strict';

// Python setup tests (v0.4.5) — version parsing, launcher detection
// order, install-plan construction per route (winget vs python.org
// fallback vs non-Windows), the approval-card description, and the
// task engine's Windows gate. Nothing here installs anything.
// Run: node tests/pythonSetup.test.js

const assert = require('assert');
const py = require('../src/pythonSetup');
const { describeAction, executeAction, ACTION_TYPES } = require('../src/taskEngine');

function testParse() {
  assert.strictEqual(py.parseVersionOutput('Python 3.12.10'), '3.12.10');
  assert.strictEqual(py.parseVersionOutput('Python 3.9.7\r\n'), '3.9.7');
  assert.strictEqual(py.parseVersionOutput('some noise\nPython 3.11.4\nmore'), '3.11.4');
  assert.strictEqual(py.parseVersionOutput('Python was not found'), null);
  assert.strictEqual(py.parseVersionOutput(''), null);
  assert.strictEqual(py.parseVersionOutput(null), null);
  console.log('  ✓ python version parsing');
}

async function testDetect() {
  // py launcher wins when it answers.
  let calls = [];
  const runPy = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'py') return { code: 0, stdout: 'Python 3.12.10', stderr: '' };
    throw new Error('not found');
  };
  let found = await py.detectPython(runPy, 'win32');
  assert.deepStrictEqual(found, { found: true, version: '3.12.10', launcher: 'py' });
  assert.deepStrictEqual(calls, ['py'], 'stops at the first working launcher');

  // py is a stub that prints the Store nag -> falls through to python.
  calls = [];
  const runStub = async (cmd) => {
    calls.push(cmd);
    if (cmd === 'py') return { code: 0, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' };
    return { code: 0, stdout: 'Python 3.11.9', stderr: '' };
  };
  found = await py.detectPython(runStub, 'win32');
  assert.deepStrictEqual(found, { found: true, version: '3.11.9', launcher: 'python' });
  assert.deepStrictEqual(calls, ['py', 'python']);

  // Nothing anywhere -> not found (both launchers tried).
  const runNone = async () => { throw new Error('ENOENT'); };
  found = await py.detectPython(runNone, 'win32');
  assert.deepStrictEqual(found, { found: false, version: null, launcher: null });

  // Off Windows, python3 is tried first.
  calls = [];
  const runPosix = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: 'Python 3.13.1', stderr: '' };
  };
  found = await py.detectPython(runPosix, 'linux');
  assert.deepStrictEqual(found, { found: true, version: '3.13.1', launcher: 'python3' });

  assert.strictEqual(await py.detectWinget(async () => ({ code: 0, stdout: 'v1.9', stderr: '' })), true);
  assert.strictEqual(await py.detectWinget(async () => ({ code: 1, stdout: '', stderr: '' })), false);
  assert.strictEqual(await py.detectWinget(async () => { throw new Error('ENOENT'); }), false);
  console.log('  ✓ python detection (py -> python order, Store stub, winget)');
}

function testPlans() {
  const winget = py.buildInstallPlan({ platform: 'win32', wingetAvailable: true, downloadsDir: 'C:\\Users\\x\\Downloads' });
  assert.strictEqual(winget.route, 'winget');
  assert.strictEqual(winget.supported, true);
  assert.deepStrictEqual(winget.steps.map((s) => s.command), [
    'winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements'
  ]);
  assert.match(winget.note, /UAC\/admin prompt/);

  const fallback = py.buildInstallPlan({ platform: 'win32', wingetAvailable: false, downloadsDir: 'C:\\Users\\x\\Downloads' });
  assert.strictEqual(fallback.route, 'download');
  assert.strictEqual(fallback.steps.length, 2);
  assert.strictEqual(
    fallback.steps[0].command,
    'curl.exe -L -o "C:\\Users\\x\\Downloads\\python-3.12.10-amd64.exe" "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"'
  );
  assert.strictEqual(
    fallback.steps[1].command,
    '"C:\\Users\\x\\Downloads\\python-3.12.10-amd64.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0'
  );

  const mac = py.buildInstallPlan({ platform: 'darwin', wingetAvailable: false, downloadsDir: '/Volumes/Test/Downloads' });
  assert.strictEqual(mac.supported, false);
  assert.deepStrictEqual(mac.steps, []);
  assert.match(mac.note, /Windows-only/);

  // Card description carries the exact commands the engine will run.
  const desc = py.describeInstallPlan(winget);
  assert.ok(desc.includes('winget install --id Python.Python.3.12'));
  const cardDesc = describeAction({ type: 'install_python', plan: fallback });
  assert.ok(cardDesc.includes('python-3.12.10-amd64.exe'), 'approval card shows the exact fallback commands');
  assert.ok(cardDesc.includes(fallback.note), 'card carries the UAC/admin note');
  assert.strictEqual(
    describeAction({ type: 'install_python' }),
    'Install Python 3.12 (the exact steps will be listed before anything runs)',
    'without a resolved plan the card promises steps before anything runs'
  );
  assert.ok(ACTION_TYPES.includes('install_python'));
  console.log('  ✓ install plans (winget / python.org fallback / Windows-only) + card text');
}

async function testEngineGate() {
  if (process.platform === 'win32') return; // the gate is the non-Windows branch
  const res = await executeAction({ type: 'install_python' }, { shell: {}, homePath: '/tmp' });
  assert.strictEqual(res.ok, false);
  assert.match(res.output, /Windows-only/);
  console.log('  ✓ task engine: install_python refuses off Windows');
}

(async () => {
  testParse();
  await testDetect();
  testPlans();
  await testEngineGate();
  console.log('pythonSetup.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
