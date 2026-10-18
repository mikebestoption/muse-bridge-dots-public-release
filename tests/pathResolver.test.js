'use strict';

// v0.3.1 — special-folder path resolution + EPERM-proof ensureDir.
// The win32 resolver rules are exercised with path.win32 semantics on any
// host (that's the point of the injectable pathImpl). The real-world
// failure: the model proposed a path under a guessed profile
// ("<drive>:\Users\<guessed-name>\Desktop\musebridge.txt"), and
// create_file died with "EPERM: operation not permitted, mkdir '<profile root>'".
// Run: node tests/pathResolver.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResolver, resolveActionPaths } = require('../src/pathResolver');
const { ensureDir, executeAction } = require('../src/taskEngine');

(async () => {
  // ---- win32 resolver, plain (non-redirected) folders ----
  const win = path.win32;
  const folders = {
    home: 'C:\\Users\\TestUser',
    desktop: 'C:\\Users\\TestUser\\Desktop',
    documents: 'C:\\Users\\TestUser\\Documents',
    downloads: 'C:\\Users\\TestUser\\Downloads'
  };
  const { resolve } = createResolver({ specialFolders: folders, pathImpl: win });

  // Guessed username (the original bug, verbatim shape): re-rooted onto the
  // REAL Desktop from the OS.
  assert.strictEqual(
    resolve('c:\\Users\\TestUser\\Desktop\\musebridge.txt'),
    'C:\\Users\\TestUser\\Desktop\\musebridge.txt',
    'right username, lowercase drive: canonicalized to the OS folder path'
  );
  assert.strictEqual(
    resolve('C:\\Users\\Mike\\Desktop\\musebridge.txt'),
    'C:\\Users\\TestUser\\Desktop\\musebridge.txt',
    'guessed-user Desktop path is re-rooted onto the real Desktop'
  );
  assert.strictEqual(
    resolve('C:\\Users\\SomebodyElse\\Documents\\notes.md'),
    'C:\\Users\\TestUser\\Documents\\notes.md',
    'guessed-user Documents path is re-rooted onto the real Documents'
  );
  assert.strictEqual(
    resolve('C:\\Users\\SomebodyElse\\Downloads\\a.zip'),
    'C:\\Users\\TestUser\\Downloads\\a.zip',
    'guessed-user Downloads path is re-rooted onto the real Downloads'
  );

  // Guessed profile root, non-special tail: re-rooted onto the real home.
  assert.strictEqual(
    resolve('C:\\Users\\Mike\\Pictures\\cat.jpg'),
    'C:\\Users\\TestUser\\Pictures\\cat.jpg',
    'guessed-user home tail is re-rooted onto the real home'
  );
  assert.strictEqual(
    resolve('C:\\Users\\Mike'),
    'C:\\Users\\TestUser',
    'bare guessed profile root resolves to the real home'
  );

  // "~" expansion.
  assert.strictEqual(resolve('~'), 'C:\\Users\\TestUser', 'bare ~ resolves to home');
  assert.strictEqual(resolve('~/notes.txt'), 'C:\\Users\\TestUser\\notes.txt', '~/... resolves under home');
  assert.strictEqual(resolve('~\\notes.txt'), 'C:\\Users\\TestUser\\notes.txt', '~\\... resolves under home');
  assert.strictEqual(resolve('~/Desktop/x.txt'), 'C:\\Users\\TestUser\\Desktop\\x.txt', '~/Desktop maps through the special folder');

  // Bare special-folder references (any case, either separator).
  assert.strictEqual(resolve('Desktop\\musebridge.txt'), 'C:\\Users\\TestUser\\Desktop\\musebridge.txt', 'bare Desktop\\ resolves');
  assert.strictEqual(resolve('desktop/musebridge.txt'), 'C:\\Users\\TestUser\\Desktop\\musebridge.txt', 'lowercase bare desktop/ resolves');
  assert.strictEqual(resolve('Downloads'), 'C:\\Users\\TestUser\\Downloads', 'bare Downloads (no tail) resolves to the folder itself');
  assert.strictEqual(resolve('Documents\\Reports\\q3.md'), 'C:\\Users\\TestUser\\Documents\\Reports\\q3.md', 'bare Documents with subpath resolves');

  // Already-correct paths are untouched, byte for byte.
  assert.strictEqual(
    resolve('C:\\Users\\TestUser\\Desktop\\musebridge.txt'),
    'C:\\Users\\TestUser\\Desktop\\musebridge.txt',
    'already-correct Desktop path untouched'
  );
  assert.strictEqual(
    resolve('C:\\Users\\TestUser\\Pictures\\cat.jpg'),
    'C:\\Users\\TestUser\\Pictures\\cat.jpg',
    'real-profile non-special path untouched'
  );

  // Non-special absolute paths are untouched.
  assert.strictEqual(resolve('C:\\Work\\file.txt'), 'C:\\Work\\file.txt', 'unrelated absolute path untouched');
  assert.strictEqual(resolve('D:\\Data\\Desktop\\x.txt'), 'D:\\Data\\Desktop\\x.txt', 'Desktop under a non-profile root untouched');
  assert.strictEqual(resolve('\\\\server\\share\\Users\\Mike\\Desktop\\x.txt'), '\\\\server\\share\\Users\\Mike\\Desktop\\x.txt', 'UNC path untouched');

  // Plain relative paths (no special first segment) pass through.
  assert.strictEqual(resolve('notes.txt'), 'notes.txt', 'bare filename untouched');
  assert.strictEqual(resolve(''), '', 'empty string untouched');

  // ---- OneDrive-redirected Desktop is honored ----
  const oneDriveFolders = {
    home: 'C:\\Users\\TestUser',
    desktop: 'C:\\Users\\TestUser\\OneDrive\\Desktop',
    documents: 'C:\\Users\\TestUser\\Documents',
    downloads: 'C:\\Users\\TestUser\\Downloads'
  };
  const od = createResolver({ specialFolders: oneDriveFolders, pathImpl: win });
  assert.strictEqual(
    od.resolve('C:\\Users\\Mike\\Desktop\\musebridge.txt'),
    'C:\\Users\\TestUser\\OneDrive\\Desktop\\musebridge.txt',
    'guessed-user Desktop lands on the OneDrive Desktop'
  );
  assert.strictEqual(
    od.resolve('C:\\Users\\TestUser\\Desktop\\musebridge.txt'),
    'C:\\Users\\TestUser\\OneDrive\\Desktop\\musebridge.txt',
    'even a right-username Desktop path follows the OneDrive redirect'
  );
  assert.strictEqual(
    od.resolve('Desktop\\musebridge.txt'),
    'C:\\Users\\TestUser\\OneDrive\\Desktop\\musebridge.txt',
    'bare Desktop follows the OneDrive redirect'
  );

  // ---- resolveActionPaths: whole actions ----
  const rawAction = { type: 'create_file', path: 'C:\\Users\\Mike\\Desktop\\musebridge.txt', content: 'hi', label: 'Create musebridge.txt' };
  const resolved = resolveActionPaths(rawAction, folders, win);
  assert.strictEqual(resolved.path, 'C:\\Users\\TestUser\\Desktop\\musebridge.txt', 'create_file path resolved');
  assert.strictEqual(resolved.content, 'hi', 'other fields preserved');
  assert.strictEqual(rawAction.path, 'C:\\Users\\Mike\\Desktop\\musebridge.txt', 'input action is not mutated');

  const urlAction = { type: 'open_url', url: 'https://example.com/Desktop' };
  assert.strictEqual(resolveActionPaths(urlAction, folders, win), urlAction, 'non-path action passes through by reference');

  const cmdAction = { type: 'run_command', command: 'echo C:\\Users\\Mike', cwd: 'Desktop' };
  const resolvedCmd = resolveActionPaths(cmdAction, folders, win);
  assert.strictEqual(resolvedCmd.cwd, 'C:\\Users\\TestUser\\Desktop', 'run_command cwd resolved');
  assert.strictEqual(resolvedCmd.command, 'echo C:\\Users\\Mike', 'run_command command line is NOT rewritten');

  // ---- ensureDir: EPERM tolerance via injected fs ----
  // Simulates the Windows failure: first stat says missing, recursive
  // mkdir throws EPERM walking the profile root, but the directory
  // actually exists — ensureDir must NOT fail.
  {
    let statCalls = 0;
    const fakeFs = {
      stat: async () => {
        statCalls += 1;
        if (statCalls === 1) {
          const e = new Error('ENOENT: no such file or directory');
          e.code = 'ENOENT';
          throw e;
        }
        return { isDirectory: () => true };
      },
      mkdir: async () => {
        const e = new Error("EPERM: operation not permitted, mkdir 'C:\\Users\\TestUser'");
        e.code = 'EPERM';
        throw e;
      }
    };
    await ensureDir('C:\\Users\\TestUser', fakeFs); // must resolve, not throw
    assert.ok(statCalls >= 2, 'ensureDir re-checked existence after the EPERM');
  }
  // Genuinely un-creatable: mkdir throws and the dir still isn't there →
  // the original error must surface.
  {
    const fakeFs = {
      stat: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
      mkdir: async () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    };
    await assert.rejects(() => ensureDir('C:\\Nope\\Never', fakeFs), /EPERM/, 'ensureDir fails when the directory truly cannot exist');
  }
  // Already-existing dir: mkdir must not even be attempted.
  {
    let mkdirCalls = 0;
    const fakeFs = {
      stat: async () => ({ isDirectory: () => true }),
      mkdir: async () => { mkdirCalls += 1; }
    };
    await ensureDir('C:\\Users\\TestUser', fakeFs);
    assert.strictEqual(mkdirCalls, 0, 'ensureDir skips mkdir when the directory exists');
  }
  // Real fs: creates a nested chain.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ensuredir-'));
    const nested = path.join(dir, 'a', 'b', 'c');
    await ensureDir(nested);
    assert.ok(fs.statSync(nested).isDirectory(), 'ensureDir creates nested directories with the real fs');
  }

  // ---- executeAction end-to-end with specialFolders (posix host) ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-resolve-e2e-'));
    const special = {
      home: dir,
      desktop: path.join(dir, 'Desktop'),
      documents: path.join(dir, 'Documents'),
      downloads: path.join(dir, 'Downloads')
    };
    const created = await executeAction(
      { type: 'create_file', path: 'Desktop/from-bare-name.txt', content: 'hello' },
      { shell: {}, homePath: dir, specialFolders: special }
    );
    assert.strictEqual(created.ok, true, `create_file via bare Desktop path works: ${created.output}`);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'Desktop', 'from-bare-name.txt'), 'utf8'),
      'hello',
      'file landed in the OS Desktop folder, not a model-guessed one'
    );
    // And the EPERM scenario shape: creating directly under an existing
    // parent chain must not try to recreate it.
    const again = await executeAction(
      { type: 'append_to_file', path: path.join(dir, 'Desktop', 'from-bare-name.txt'), content: '!' },
      { shell: {}, homePath: dir, specialFolders: special }
    );
    assert.strictEqual(again.ok, true, 'append under an existing chain works');
  }

  console.log('pathResolver.test.js: ALL PASS');
})().catch((err) => { console.error(err); process.exit(1); });
