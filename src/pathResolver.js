'use strict';

// Special-folder path resolution — the APP owns real folder locations
// (from Electron's app.getPath), never the model.
//
// Why this exists: the live model invents paths. Asked to "create a file
// on my desktop", it proposed a path under a guessed profile ("<drive>:\Users\<guessed-name>\Desktop\musebridge.txt") —
// a guessed username. If the guess is wrong, the step fails (or worse,
// lands in the wrong place). The app knows the real Desktop / Documents /
// Downloads / home from the OS — including OneDrive-redirected Desktops,
// because app.getPath('desktop') returns the real location.
//
// resolveActionPaths() rewrites path-bearing action fields onto the real
// folders BEFORE the approval card is rendered and again before execution,
// so what the user approves is exactly the path that runs.
//
// Rules (Windows-aware):
//   "~" / "~/..." / "~\..."                  -> home (with special-folder tail mapped too)
//   <drive>:\Users\<anyone>\Desktop\...     -> the real Desktop folder
//   <drive>:\Users\<anyone>\Documents\...   -> the real Documents folder
//   <drive>:\Users\<anyone>\Downloads\...   -> the real Downloads folder
//   <drive>:\Users\<wrong-name>\...         -> re-rooted onto the real home
//   "Desktop\file.txt" (bare, any case)      -> real Desktop + tail
//   already-correct absolute paths           -> untouched
//   absolute paths outside any profile root  -> untouched (e.g. C:\Work\x)
//
// The module is pure and platform-parametric: pass pathImpl = path.win32
// to get Windows semantics on any host (the unit tests do exactly that on
// Linux). At runtime main passes the host `path` module plus the folders
// from app.getPath().

const path = require('path');

const SPECIAL_KEYS = ['desktop', 'documents', 'downloads'];

function specialKeyOf(name) {
  const n = String(name || '').toLowerCase();
  return SPECIAL_KEYS.includes(n) ? n : null;
}

function splitSegments(s) {
  return String(s).split(/[\\/]+/).filter((seg) => seg.length > 0);
}

// createResolver({ specialFolders, pathImpl })
//   specialFolders: { home, desktop, documents, downloads } (absolute paths)
//   pathImpl: a `path`-compatible module; defaults to the host one.
function createResolver({ specialFolders, pathImpl } = {}) {
  const impl = pathImpl || path;
  const folders = specialFolders || {};
  const home = folders.home || '';
  const caseInsensitive = impl.sep === '\\';
  const eq = (a, b) => (caseInsensitive
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : a === b);
  const homeName = home ? impl.basename(home) : '';

  function joinSpecial(key, tailSegs) {
    const base = folders[key];
    if (!base) return null;
    return tailSegs.length ? impl.join(base, ...tailSegs) : base;
  }

  function resolve(input) {
    if (typeof input !== 'string') return input;
    const raw = input.trim();
    if (!raw) return input;

    // "~" prefix -> home (a special-folder first segment still maps to the
    // real special folder, which may be OneDrive-redirected off home).
    if (raw === '~') return home || raw;
    if (raw.startsWith('~/') || raw.startsWith('~\\')) {
      if (!home) return raw;
      const segs = splitSegments(raw.slice(2));
      if (segs.length) {
        const key = specialKeyOf(segs[0]);
        if (key) {
          const joined = joinSpecial(key, segs.slice(1));
          if (joined) return joined;
        }
      }
      return segs.length ? impl.join(home, ...segs) : home;
    }

    if (!impl.isAbsolute(raw)) {
      // Bare special-folder reference: "Desktop\file.txt", "downloads", ...
      const segs = splitSegments(raw);
      if (segs.length) {
        const key = specialKeyOf(segs[0]);
        if (key) {
          const joined = joinSpecial(key, segs.slice(1));
          if (joined) return joined;
        }
      }
      return raw;
    }

    // UNC paths (\\server\share\...) are never re-rooted.
    if (raw.startsWith('\\\\')) return raw;

    // Absolute path: look for a <root>\Users\<name>\... profile prefix.
    const root = impl.parse(raw).root;
    const segs = splitSegments(raw.slice(root.length));
    if (segs.length >= 2 && String(segs[0]).toLowerCase() === 'users') {
      const profileName = segs[1];
      const tail = segs.slice(2);
      if (tail.length) {
        const key = specialKeyOf(tail[0]);
        if (key) {
          // The special folder always resolves through app.getPath — this
          // is what honors OneDrive redirection, whichever username the
          // model guessed.
          const joined = joinSpecial(key, tail.slice(1));
          if (joined) return joined;
        }
      }
      if (home && homeName && !eq(profileName, homeName)) {
        // A guessed profile root that isn't the real one: re-root the
        // tail onto the real home folder.
        return tail.length ? impl.join(home, ...tail) : home;
      }
      // The real profile root, non-special tail: already correct.
      return raw;
    }

    return raw;
  }

  return { resolve };
}

// Fields of an action that carry a filesystem path worth resolving.
// (URLs, window titles, entry labels and command text are NOT paths —
// run_command's cwd is, its command line is not.)
const PATH_FIELDS = {
  create_file: ['path'],
  append_to_file: ['path'],
  list_folder: ['path'],
  open_app: ['path'],
  run_command: ['cwd']
};

// resolveActionPaths(action, specialFolders, pathImpl)
// Returns a NEW action object with its path fields resolved; the input is
// never mutated, and unknown/non-path actions pass through unchanged.
function resolveActionPaths(action, specialFolders, pathImpl) {
  if (!action || typeof action !== 'object') return action;
  const fields = PATH_FIELDS[action.type];
  if (!fields) return action;
  const { resolve } = createResolver({ specialFolders, pathImpl });
  const out = { ...action };
  for (const field of fields) {
    if (typeof out[field] === 'string' && out[field]) {
      out[field] = resolve(out[field]);
    }
  }
  return out;
}

module.exports = { createResolver, resolveActionPaths, PATH_FIELDS, SPECIAL_KEYS };
