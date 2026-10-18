# Contributing to Muse Bridge

Muse Bridge is open source under the Apache License 2.0 (see `LICENSE`).
You are welcome to use it with your own Muse Spark API key and to propose
improvements. The rules below are strict on purpose — this app can propose
and, with its owner's approval, execute desktop actions, so the review bar
is high.

## How contributions work

- **You cannot write to this repository.** Fork it, work on your fork, and
  open a pull request (PR) against `main`.
- **Nothing merges unreviewed.** Every PR is reviewed by Muse (the
  maintainer's reviewer) to the standard below, and merged only by the
  maintainer. There is no auto-merge, for anyone.
- One logical change per PR. Small, single-purpose PRs review fast; a PR
  that mixes a feature, a refactor, and a version bump will be sent back
  to be split.

## The review standard (what your PR is checked against)

1. **Full check passes.** `npm run check` (syntax on every shipped file)
   and `npm test` (the whole suite, not just tests near your change) must
   pass with zero errors. Say so in the PR description, with output.
2. **Self-review the complete diff** before opening the PR, as if you were
   reviewing a teammate's PR — ordering, startup/module-load code, and
   every hunk.
3. **No suppression hacks.** No blanket `as any`-style casts, no disabling
   checks, no commented-out code, no temporary workarounds left in.
   No copy-paste duplication where a shared helper belongs.
4. **The approval gate is sacred.** The assistant proposes; the human
   approves; only then does anything execute, in the main process. A PR
   that weakens, bypasses, or auto-approves that gate will be closed.
5. **Secrets never move.** API keys, Vault passwords, TOTP secrets and
   codes must never reach the renderer, chat history, logs, Bridge
   packets, or a commit. If your change touches the Vault, settings, or
   the Spark client, extend `tests/noSecrets.test.js` to prove it.
6. **No personal data in the tree.** No real names in paths, no local
   usernames, no email addresses, no machine-specific absolute paths in
   code, tests, fixtures, or docs. Special folders are resolved from the
   OS at runtime (see `src/pathResolver.js`) — never hard-coded.
7. **Honest failure.** If a capability can't work (an API rejects an
   input, a platform lacks a feature), the app says so plainly. No silent
   drops, no fake success, no mock results presented as real — mock mode
   labels itself, always.
8. **Tests for new behavior.** Pure logic goes in a `src/` module with a
   plain-node test in `tests/`, wired into `npm test`.

## Getting started

```bash
npm install
npm run check
npm test
npm start        # dev run; with no API key the app runs in labeled Mock mode
```

Get a Muse Spark API key at https://dev.meta.ai and paste it into the
app under Settings — it is stored only on your machine, encrypted by
your operating system. Never put a key in code, a test, or an issue.

## Reporting issues

Open an issue with: your OS, the app version (Settings shows it), what
you did, what you expected, and what happened. **Redact screenshots and
logs first** — never post an API key, a Vault entry, or personal paths.
