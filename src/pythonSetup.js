'use strict';

// Python setup (Muse Bridge v0.4.5) — detection + install planning.
//
// Detection runs `py --version`, then `python --version` (plus
// `python3` off Windows) and parses "Python X.Y.Z". The install is
// planned here as exact command lines, shown verbatim on the standard
// approval card, and executed by the task engine only after Michael
// approves — this module never runs anything itself.
//
// Routes (Windows): winget when available, else the official
// python.org installer, per-user and quiet. If Windows raises a UAC
// or admin prompt, that click is Michael's — the plan says so.
// Nothing here is coupled to transcription (whisper.cpp is native;
// Python is a general runtime convenience).

const PYTHON_WINGET_ID = 'Python.Python.3.12';
const PYTHON_VERSION = '3.12.10';
const PYTHON_INSTALLER_NAME = `python-${PYTHON_VERSION}-amd64.exe`;
const PYTHON_INSTALLER_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_INSTALLER_NAME}`;

function parseVersionOutput(text) {
  const m = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  if (!m) return null;
  return `${parseInt(m[1], 10)}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`;
}

// run(cmd, args) -> Promise<{ code, stdout, stderr }> (injected).
async function detectPython(run, platform) {
  const candidates = platform === 'win32'
    ? [['py', ['--version']], ['python', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];
  for (const [cmd, args] of candidates) {
    try {
      const res = await run(cmd, args);
      const version = parseVersionOutput(`${res.stdout || ''}\n${res.stderr || ''}`);
      if (version) return { found: true, version, launcher: cmd };
    } catch (_) { /* not on PATH — try the next candidate */ }
  }
  return { found: false, version: null, launcher: null };
}

async function detectWinget(run) {
  try {
    const res = await run('winget', ['--version']);
    return res.code === 0;
  } catch (_) {
    return false;
  }
}

function quote(p) {
  return `"${String(p).replace(/"/g, '')}"`;
}

// The install plan: exact steps the approval card shows and the task
// engine runs, in order. downloadsDir is only used by the fallback.
function buildInstallPlan({ platform, wingetAvailable, downloadsDir }) {
  if (platform !== 'win32') {
    return {
      route: 'unsupported',
      supported: false,
      steps: [],
      note: 'One-click Python install is Windows-only in this version. On this platform, install Python from python.org or your package manager — the app will detect it here.'
    };
  }
  if (wingetAvailable) {
    return {
      route: 'winget',
      supported: true,
      steps: [
        {
          label: `Install Python 3.12 with winget (${PYTHON_WINGET_ID})`,
          command: `winget install --id ${PYTHON_WINGET_ID} -e --accept-source-agreements --accept-package-agreements`
        }
      ],
      note: 'Runs only after you approve the card. If Windows shows a UAC/admin prompt during the install, that click is yours — the app cannot (and should not) click it for you.'
    };
  }
  const dir = downloadsDir || '';
  const installerPath = dir ? `${dir}\\${PYTHON_INSTALLER_NAME}` : PYTHON_INSTALLER_NAME;
  return {
    route: 'download',
    supported: true,
    steps: [
      {
        label: `Download the official Python ${PYTHON_VERSION} installer from python.org`,
        command: `curl.exe -L -o ${quote(installerPath)} "${PYTHON_INSTALLER_URL}"`
      },
      {
        label: 'Run it per-user and quiet (adds Python to your PATH, no admin needed)',
        command: `${quote(installerPath)} /quiet InstallAllUsers=0 PrependPath=1 Include_test=0`
      }
    ],
    note: 'Runs only after you approve the card. The installer is per-user (InstallAllUsers=0), so no admin prompt is expected; if Windows shows one anyway, that click is yours.'
  };
}

// One-line card summary built from the same plan the engine runs.
function describeInstallPlan(plan) {
  if (!plan || !plan.supported) return 'Install Python (not available on this platform)';
  const lines = plan.steps.map((s) => s.command);
  return `Install Python — ${plan.route === 'winget' ? 'winget' : 'python.org installer'}:\n${lines.join('\n')}`;
}

module.exports = {
  PYTHON_WINGET_ID,
  PYTHON_VERSION,
  PYTHON_INSTALLER_NAME,
  PYTHON_INSTALLER_URL,
  parseVersionOutput,
  detectPython,
  detectWinget,
  buildInstallPlan,
  describeInstallPlan
};
