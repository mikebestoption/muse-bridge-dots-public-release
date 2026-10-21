'use strict';

// Packaging check (v0.4.5): the transcription runtime set must be IN
// the packaged payload — whisper-cli.exe, ffmpeg.exe, the ggml/whisper
// DLLs, and the private Microsoft runtime DLLs (vcruntime140.dll,
// vcruntime140_1.dll, vcruntime140_threads.dll, msvcp140.dll,
// vcomp140.dll) sitting next to the executables. A payload missing
// any of them is exactly the "only errors" build Michael hit, and it
// must never ship.
//
// Usage:
//   node scripts/verify-payload.js             -> checks dist/win-unpacked/resources/bin
//   node scripts/verify-payload.js --dir <dir> -> checks another bin dir
// Exit code 0 = complete set, hashes verified where the manifest pins them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REQUIRED = [
  'ffmpeg.exe',
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'vcruntime140_threads.dll',
  'msvcp140.dll',
  'vcomp140.dll',
  'LICENSE.whisper.txt',
  'LICENSE.ffmpeg.txt',
  'NOTICE.md',
  'manifest.json'
];

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function main() {
  const argIdx = process.argv.indexOf('--dir');
  const dir = argIdx >= 0
    ? process.argv[argIdx + 1]
    : path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'bin');
  let failed = false;
  if (!fs.existsSync(dir)) {
    console.error(`FAIL: payload bin dir does not exist: ${dir}`);
    process.exit(1);
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (_) { /* hash checks are skipped, presence still enforced */ }
  const pinned = {};
  if (manifest) {
    for (const group of ['ffmpeg', 'whisperCpp', 'msvcRuntime']) {
      for (const [name, sha] of Object.entries((manifest[group] && manifest[group].files) || {})) {
        pinned[name] = sha;
      }
    }
  }
  for (const name of REQUIRED) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      console.error(`FAIL: missing from payload: ${name}`);
      failed = true;
      continue;
    }
    if (pinned[name]) {
      const actual = sha256File(file);
      if (actual !== pinned[name]) {
        console.error(`FAIL: hash mismatch in payload: ${name}`);
        failed = true;
        continue;
      }
    }
    console.log(`ok: ${name} (${fs.statSync(file).size} bytes)`);
  }
  if (failed) {
    console.error(`Payload verification FAILED for ${dir}`);
    process.exit(1);
  }
  console.log(`Payload verification PASSED: ${dir}`);
}

main();
