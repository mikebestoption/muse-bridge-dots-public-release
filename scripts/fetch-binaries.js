'use strict';

// Fetch the pinned transcription runtime binaries into resources/bin/.
//
// The executables (ffmpeg ~83 MB, whisper.cpp set) are NOT stored in
// git. This script downloads them from the exact URLs pinned in
// resources/bin/manifest.json and verifies the SHA-256 of the archive
// AND of every extracted file before declaring success — a build made
// without running this (or with a failed verification) simply has no
// binaries to package, and the app's transcription readiness check
// will say so honestly instead of failing mid-transcription.
//
// The five Microsoft runtime DLLs are already in git next to this
// folder's manifest, so they are never fetched and never missing.
//
// Usage: node scripts/fetch-binaries.js [--force]
// Requires: curl (any platform) and an unzip tool (unzip, or tar, or
// PowerShell Expand-Archive on Windows) for the whisper.cpp zip.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'resources', 'bin');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(BIN_DIR, 'manifest.json'), 'utf8'));
const FORCE = process.argv.includes('--force');

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function presentAndValid(file, expected) {
  if (!fs.existsSync(file)) return false;
  if (!expected) return true;
  return sha256File(file) === expected;
}

function download(url, dest) {
  execFileSync('curl', ['-fL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
}

function extractZip(zipPath, destDir) {
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
    return;
  } catch (_) { /* fall through */ }
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
    return;
  } catch (_) { /* fall through */ }
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`], { stdio: 'inherit' });
    return;
  }
  throw new Error('No unzip tool available (tried unzip, tar, PowerShell).');
}

function ensureFile(name, expected, fetchFn) {
  const dest = path.join(BIN_DIR, name);
  if (!FORCE && presentAndValid(dest, expected)) {
    console.log(`ok (cached, hash verified): ${name}`);
    return;
  }
  fetchFn(dest);
  if (!presentAndValid(dest, expected)) {
    throw new Error(`Hash mismatch after download: ${name}`);
  }
  console.log(`ok (downloaded, hash verified): ${name}`);
}

function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // ffmpeg: a single static executable.
  ensureFile('ffmpeg.exe', MANIFEST.ffmpeg.files['ffmpeg.exe'], (dest) => {
    download(MANIFEST.ffmpeg.url, dest);
  });

  // whisper.cpp: a zip of the Release folder; we keep whisper-cli.exe
  // and its DLLs only.
  const whisperFiles = Object.keys(MANIFEST.whisperCpp.files);
  const allPresent = whisperFiles.every((f) =>
    presentAndValid(path.join(BIN_DIR, f), MANIFEST.whisperCpp.files[f]));
  if (FORCE || !allPresent) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mb-whisper-'));
    const zip = path.join(tmp, 'whisper-bin-x64.zip');
    download(MANIFEST.whisperCpp.archiveUrl, zip);
    const zipHash = sha256File(zip);
    if (zipHash !== MANIFEST.whisperCpp.archiveSha256) {
      throw new Error(`whisper.cpp archive hash mismatch: ${zipHash}`);
    }
    extractZip(zip, tmp);
    for (const f of whisperFiles) {
      const from = path.join(tmp, 'Release', f);
      if (!fs.existsSync(from)) throw new Error(`Archive is missing Release/${f}`);
      fs.copyFileSync(from, path.join(BIN_DIR, f));
      if (!presentAndValid(path.join(BIN_DIR, f), MANIFEST.whisperCpp.files[f])) {
        throw new Error(`Hash mismatch after extract: ${f}`);
      }
      console.log(`ok (from verified archive): ${f}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    for (const f of whisperFiles) console.log(`ok (cached, hash verified): ${f}`);
  }

  // The Microsoft runtime DLLs ship in git; verify them too so a
  // damaged checkout can never produce a silently broken installer.
  for (const [name, expected] of Object.entries(MANIFEST.msvcRuntime.files)) {
    if (!presentAndValid(path.join(BIN_DIR, name), expected)) {
      throw new Error(`Bundled runtime DLL missing or hash mismatch: ${name} (it is tracked in git — restore it from the repo).`);
    }
    console.log(`ok (bundled in repo, hash verified): ${name}`);
  }
  console.log('All transcription runtime binaries present and hash-verified.');
}

main();
