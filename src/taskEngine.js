'use strict';

// Desktop task engine — runs ONLY in the Electron main process.
// Actions arrive one at a time, only after the user approved that exact step
// in the UI (the renderer cannot execute anything on its own), or — in Night
// Queue mode — only as a job the user approved by name in the queue list.
//
// Allowed action types:
//   open_url       { url }
//   open_app       { name } or { path }
//   list_folder    { path }
//   create_file    { path, content }   (fails if the file already exists)
//   append_to_file { path, content }
//   run_command    { command, cwd? }   (exact command line the user approved)
//   copy_from_app  { targetTitle }     (WINDOWS ONLY: focus window by title,
//                                       Ctrl+A / Ctrl+C, return clipboard text)
//   paste_to_app   { targetTitle, text } (WINDOWS ONLY: put text on clipboard,
//                                       focus window by title, Ctrl+V)
//   fill_login     { entryLabel, targetWindowTitle? } (WINDOWS ONLY: unlock
//                                       vault entry by LABEL only, focus the
//                                       window, type username, Tab, password,
//                                       Enter. The action itself never carries
//                                       a secret; main fetches it from the
//                                       vault at execution moment.)
//   fill_totp      { entryLabel, targetWindowTitle? } (WINDOWS ONLY: generate
//                                       the current authenticator code in main
//                                       at execution moment and type it.)
//   wait_for_user  { reason }          (no execution: the step needs the human,
//                                       e.g. hardware security key touch or a
//                                       phone prompt. Returns waitForUser.)

const fs = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
const { resolveActionPaths } = require('./pathResolver');

const ACTION_TYPES = [
  'open_url', 'open_app', 'list_folder', 'create_file', 'append_to_file',
  'run_command', 'copy_from_app', 'paste_to_app',
  'fill_login', 'fill_totp', 'wait_for_user'
];
const FORBIDDEN_NAME_CHARS = /[;&|`$<>\n\r"]/;

function expandHome(p, homePath) {
  if (!p) return p;
  if (p === '~') return homePath;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homePath, p.slice(2));
  return p;
}

// ensureDir(dir, fsImpl) — create dir (and parents) unless it already
// exists, tolerating Windows' EPERM/EEXIST quirk: a recursive mkdir that
// walks a chain whose upper segments are existing system/profile folders
// (e.g. 'C:\Users\<name>') can throw EPERM for a segment it was never
// allowed to create, even though the target directory is perfectly fine.
// So: skip mkdir entirely when the directory is already there, and if
// mkdir still throws, re-check existence before believing the failure —
// fail only when the directory truly doesn't exist and can't be created.
async function ensureDir(dir, fsImpl) {
  const fsp = fsImpl || fs.promises;
  if (!dir) return;
  try {
    const st = await fsp.stat(dir);
    if (st.isDirectory()) return;
  } catch (_) { /* missing or unreadable — fall through and try to create */ }
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    let exists = false;
    try { exists = (await fsp.stat(dir)).isDirectory(); } catch (_) { exists = false; }
    if (!exists) throw err;
  }
}

function runShellCommand(command, cwd) {
  return new Promise((resolve) => {
    exec(command, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, cwd: cwd || undefined }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: `Command failed (${err.message}).\n${stderr || ''}`.trim() });
      } else {
        resolve({ ok: true, output: (stdout || '(no output)').trim() });
      }
    });
  });
}

// ---- Windows clipboard bridge (PowerShell + SendKeys) ----
// The PowerShell script is a FIXED constant. The window title and paste text
// travel through environment variables only, so nothing the assistant or user
// typed is ever interpolated into the script itself.
const PS_COPY_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$title = $env:MSD_TARGET_TITLE',
  '$shell = New-Object -ComObject WScript.Shell',
  'if (-not $shell.AppActivate($title)) { Write-Error "WINDOW_NOT_FOUND: $title"; exit 2 }',
  'Start-Sleep -Milliseconds 600',
  '[System.Windows.Forms.SendKeys]::SendWait("^a")',
  'Start-Sleep -Milliseconds 200',
  '[System.Windows.Forms.SendKeys]::SendWait("^c")',
  'Start-Sleep -Milliseconds 400',
  '$text = Get-Clipboard -Raw',
  'if ($null -eq $text) { $text = "" }',
  '[Console]::Out.Write($text)'
].join('\n');

const PS_PASTE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$title = $env:MSD_TARGET_TITLE',
  'Set-Clipboard -Value $env:MSD_PASTE_TEXT',
  '$shell = New-Object -ComObject WScript.Shell',
  'if (-not $shell.AppActivate($title)) { Write-Error "WINDOW_NOT_FOUND: $title"; exit 2 }',
  'Start-Sleep -Milliseconds 600',
  '[System.Windows.Forms.SendKeys]::SendWait("^v")',
  'Start-Sleep -Milliseconds 200',
  'Write-Output "PASTED"'
].join('\n');

function runPowerShell(script, extraEnv) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...extraEnv } },
      (err, stdout, stderr) => {
        if (err) {
          const notFound = (stderr || '').includes('WINDOW_NOT_FOUND');
          resolve({
            ok: false,
            output: notFound
              ? `Could not find a window with title containing "${extraEnv.MSD_TARGET_TITLE}". Is that app open?`
              : `Clipboard bridge failed: ${(stderr || err.message).trim()}`
          });
        } else {
          resolve({ ok: true, output: stdout });
        }
      }
    );
  });
}

function windowsOnly() {
  return {
    ok: false,
    output: `Windows only — copy_from_app / paste_to_app use PowerShell + SendKeys and cannot run on ${process.platform}. Use the manual clipboard buttons on this platform instead.`
  };
}

function windowsOnlyFill(kind) {
  return {
    ok: false,
    output: `Windows only — ${kind} types into a focused window with PowerShell + SendKeys and cannot run on ${process.platform}. Nothing was filled.`
  };
}

// ---- Vault filling (PowerShell + SendKeys) ----
// The script is a FIXED constant. Username, password, code and window title
// travel through environment variables ONLY (never command-line arguments).
// Nothing in this script — and nothing the caller logs — contains a secret:
// results speak only about the entry LABEL and the window title.
// SendKeys meta-characters in credentials are escaped inside the script.
const PS_FILL_LOGIN_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'function Esc([string]$s) { $s = $s -replace \'\\{\', \'{{}\'; $s = $s -replace \'\\}\', \'{}}\'; $s = $s -replace \'([+^%~()])\', \'{$1}\'; return $s }',
  '$title = $env:MSD_TARGET_TITLE',
  '$shell = New-Object -ComObject WScript.Shell',
  'if (-not $shell.AppActivate($title)) { Write-Error "WINDOW_NOT_FOUND: $title"; exit 2 }',
  'Start-Sleep -Milliseconds 600',
  '[System.Windows.Forms.SendKeys]::SendWait((Esc $env:MSD_FILL_USERNAME))',
  'Start-Sleep -Milliseconds 150',
  '[System.Windows.Forms.SendKeys]::SendWait("{TAB}")',
  'Start-Sleep -Milliseconds 150',
  '[System.Windows.Forms.SendKeys]::SendWait((Esc $env:MSD_FILL_PASSWORD))',
  'Start-Sleep -Milliseconds 150',
  '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
  'Write-Output "FILLED"'
].join('\n');

const PS_FILL_CODE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$title = $env:MSD_TARGET_TITLE',
  '$shell = New-Object -ComObject WScript.Shell',
  'if (-not $shell.AppActivate($title)) { Write-Error "WINDOW_NOT_FOUND: $title"; exit 2 }',
  'Start-Sleep -Milliseconds 600',
  '[System.Windows.Forms.SendKeys]::SendWait($env:MSD_FILL_CODE)',
  'Write-Output "FILLED"'
].join('\n');

// ctx.vaultFill (provided by main, backed by the Vault):
//   unlocked() -> bool
//   login(label) -> { username, password, targetTitle } | null
//   totpCode(label) -> { code, targetTitle } | null   (generated in main,
//   at the moment this runs — never at proposal time)
async function executeAction(action, ctx) {
  const { shell, homePath } = ctx;
  if (!action || !ACTION_TYPES.includes(action.type)) {
    return { ok: false, output: `Unknown or disallowed action type: ${action && action.type}` };
  }

  // The app owns special-folder paths, not the model: when main supplies
  // the OS folders, rewrite any model-guessed profile path onto the real
  // Desktop/Documents/Downloads/home before anything runs. (Idempotent —
  // an already-resolved path resolves to itself.)
  if (ctx.specialFolders) {
    action = resolveActionPaths(action, ctx.specialFolders, ctx.pathImpl);
  }

  try {
    switch (action.type) {
      case 'open_url': {
        const url = String(action.url || '');
        if (!/^https?:\/\//i.test(url)) return { ok: false, output: 'Only http/https URLs can be opened.' };
        await shell.openExternal(url);
        return { ok: true, output: `Opened ${url} in your default browser.` };
      }

      case 'open_app': {
        if (action.path) {
          const target = expandHome(String(action.path), homePath);
          const errMsg = await shell.openPath(target);
          if (errMsg) return { ok: false, output: `Could not open ${target}: ${errMsg}` };
          return { ok: true, output: `Opened ${target}.` };
        }
        const name = String(action.name || '').trim();
        if (!name) return { ok: false, output: 'No app name or path given.' };
        if (FORBIDDEN_NAME_CHARS.test(name)) {
          return { ok: false, output: 'App name contains characters that are not allowed.' };
        }
        if (process.platform === 'win32') {
          return runShellCommand(`start "" "${name}"`);
        }
        return await new Promise((resolve) => {
          const child = spawn(name, [], { detached: true, stdio: 'ignore' });
          child.on('error', (e) => resolve({ ok: false, output: `Could not start ${name}: ${e.message}` }));
          child.on('spawn', () => {
            child.unref();
            resolve({ ok: true, output: `Started ${name}.` });
          });
        });
      }

      case 'list_folder': {
        const folder = expandHome(String(action.path || homePath), homePath);
        const entries = await fs.promises.readdir(folder, { withFileTypes: true });
        const lines = entries.slice(0, 200).map((e) => `${e.isDirectory() ? '[folder]' : '[file]  '} ${e.name}`);
        const extra = entries.length > 200 ? `\n… and ${entries.length - 200} more` : '';
        return {
          ok: true,
          output: `${folder} — ${entries.length} item(s):\n${lines.join('\n')}${extra}`
        };
      }

      case 'create_file': {
        const file = expandHome(String(action.path || ''), homePath);
        if (!file) return { ok: false, output: 'No file path given.' };
        await ensureDir(path.dirname(file), ctx.fsImpl);
        await fs.promises.writeFile(file, String(action.content || ''), { flag: 'wx' });
        return { ok: true, output: `Created ${file}.` };
      }

      case 'append_to_file': {
        const file = expandHome(String(action.path || ''), homePath);
        if (!file) return { ok: false, output: 'No file path given.' };
        await ensureDir(path.dirname(file), ctx.fsImpl);
        await fs.promises.appendFile(file, String(action.content || ''), 'utf8');
        return { ok: true, output: `Appended to ${file}.` };
      }

      case 'run_command': {
        const command = String(action.command || '').trim();
        if (!command) return { ok: false, output: 'No command given.' };
        const cwd = action.cwd ? expandHome(String(action.cwd), homePath) : undefined;
        return runShellCommand(command, cwd);
      }

      case 'copy_from_app': {
        if (process.platform !== 'win32') return windowsOnly();
        const targetTitle = String(action.targetTitle || '').trim();
        if (!targetTitle) return { ok: false, output: 'No target window title given.' };
        const res = await runPowerShell(PS_COPY_SCRIPT, { MSD_TARGET_TITLE: targetTitle });
        if (!res.ok) return res;
        return { ok: true, output: `Copied from "${targetTitle}":\n${res.output}` };
      }

      case 'paste_to_app': {
        if (process.platform !== 'win32') return windowsOnly();
        const targetTitle = String(action.targetTitle || '').trim();
        if (!targetTitle) return { ok: false, output: 'No target window title given.' };
        const res = await runPowerShell(PS_PASTE_SCRIPT, {
          MSD_TARGET_TITLE: targetTitle,
          MSD_PASTE_TEXT: String(action.text || '')
        });
        if (!res.ok) return res;
        return { ok: true, output: `Pasted ${String(action.text || '').length} characters into "${targetTitle}".` };
      }

      case 'fill_login': {
        const label = String(action.entryLabel || '').trim();
        if (!label) return { ok: false, output: 'No vault entry label given.' };
        if (!ctx.vaultFill) return { ok: false, output: 'Vault is not available in this build.' };
        if (!ctx.vaultFill.unlocked()) {
          return { ok: false, waitForUser: true, output: 'Vault locked — unlock to fill. Nothing was typed.' };
        }
        const secret = ctx.vaultFill.login(label);
        if (!secret) return { ok: false, output: `No vault entry labeled "${label}".` };
        const targetTitle = String(action.targetWindowTitle || secret.targetTitle || '').trim();
        if (!targetTitle) {
          return { ok: false, output: `No target window title for "${label}" — add one to the vault entry or the step.` };
        }
        if (process.platform !== 'win32') return windowsOnlyFill('fill_login');
        // Secrets live only in this child process's environment, briefly.
        const res = await runPowerShell(PS_FILL_LOGIN_SCRIPT, {
          MSD_TARGET_TITLE: targetTitle,
          MSD_FILL_USERNAME: secret.username,
          MSD_FILL_PASSWORD: secret.password
        });
        if (!res.ok) return res;
        return { ok: true, output: `Login filled for "${label}" in window "${targetTitle}".` };
      }

      case 'fill_totp': {
        const label = String(action.entryLabel || '').trim();
        if (!label) return { ok: false, output: 'No vault entry label given.' };
        if (!ctx.vaultFill) return { ok: false, output: 'Vault is not available in this build.' };
        if (!ctx.vaultFill.unlocked()) {
          return { ok: false, waitForUser: true, output: 'Vault locked — unlock to fill. Nothing was typed.' };
        }
        // Generated HERE, at execution moment, in the main process.
        const generated = ctx.vaultFill.totpCode(label);
        if (!generated) return { ok: false, output: `No authenticator secret saved on the vault entry "${label}".` };
        const targetTitle = String(action.targetWindowTitle || generated.targetTitle || '').trim();
        if (!targetTitle) {
          return { ok: false, output: `No target window title for "${label}" — add one to the vault entry or the step.` };
        }
        if (process.platform !== 'win32') return windowsOnlyFill('fill_totp');
        const res = await runPowerShell(PS_FILL_CODE_SCRIPT, {
          MSD_TARGET_TITLE: targetTitle,
          MSD_FILL_CODE: generated.code
        });
        if (!res.ok) return res;
        return { ok: true, output: `Authenticator code filled for "${label}" in window "${targetTitle}".` };
      }

      case 'wait_for_user': {
        const reason = String(action.reason || 'User action needed').trim();
        return { ok: false, waitForUser: true, output: `Waiting on you: ${reason}` };
      }

      default:
        return { ok: false, output: 'Unhandled action type.' };
    }
  } catch (err) {
    return { ok: false, output: `Error: ${err.message}` };
  }
}

// Human-readable one-line summary shown on the approval card.
function describeAction(action) {
  if (!action) return '(empty step)';
  switch (action.type) {
    case 'open_url': return `Open URL: ${action.url}`;
    case 'open_app': return `Open app: ${action.path || action.name}`;
    case 'list_folder': return `List folder: ${action.path}`;
    case 'create_file': return `Create file: ${action.path}`;
    case 'append_to_file': return `Append to file: ${action.path}`;
    case 'run_command': return `Run command${action.cwd ? ` in ${action.cwd}` : ''}: ${action.command}`;
    case 'copy_from_app': return `Copy ALL text from window "${action.targetTitle}" (focus it, Ctrl+A, Ctrl+C)`;
    case 'paste_to_app': return `Paste text into window "${action.targetTitle}" (focus it, Ctrl+V)`;
    case 'fill_login': return `Fill login for vault entry "${action.entryLabel}"${action.targetWindowTitle ? ` in window "${action.targetWindowTitle}"` : ''} (password typed from the vault — never shown)`;
    case 'fill_totp': return `Fill authenticator code for vault entry "${action.entryLabel}"${action.targetWindowTitle ? ` in window "${action.targetWindowTitle}"` : ''} (code generated at run time — never shown)`;
    case 'wait_for_user': return `Wait for you: ${action.reason || 'user action needed'}`;
    default: return `${action.type}`;
  }
}

module.exports = { executeAction, describeAction, ACTION_TYPES, ensureDir };
