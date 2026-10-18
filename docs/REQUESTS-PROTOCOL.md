# Ask Muse — Requests Protocol (v0.4.1)

The contract between **Muse Bridge** (the desktop app) and **Muse's
side** (the assistant that builds features and ships releases) for the
in-app "✉️ Ask Muse" channel. Michael types a request in the app;
the app files it in this repository; Muse works it; the outcome
flows back as a status file and, for shipped work, as a normal app
release.

- **Repository:** `mikebestoption/mikebestoption-Muse-Bridge` (private).
- **Folder:** `requests/` at the repository root. Nothing outside this
  folder is part of the protocol.
- **Transport:** the GitHub Contents API. The app uses Michael's
  fine-grained token (Settings → "GitHub token (for Ask Muse)"),
  scoped to this one repo, Contents: Read and write. The app calls
  ONLY: `GET /contents/requests`, `GET /contents/requests/<path>`,
  `PUT /contents/requests/<path>`. No other endpoints, no other repos.

---

## 1. Request files (written by the app, immutable)

**Path:** `requests/<id>.md`
**Commit message:** `Ask Muse: <id>`

**Id:** `REQ-<yyyymmdd>-<hhmmss>-<slug>`

- Date/time is **America/New_York** local time at the moment of
  sending.
- `<slug>` is the request's first line, lowercased, non-alphanumerics
  collapsed to `-`, max 40 chars (`request` if empty).
- If the id is already taken (same second, same first line), the app
  suffixes `-2`, `-3`, …

**Content:** a header block of `key: value` lines, a line containing
only `---`, then Michael's text **verbatim** — exactly what he typed,
no additions, no telemetry:

```markdown
id: REQ-20261018-051500-add-a-dark-mode-toggle
created: 2026-10-18T09:15:00.000Z
machine: MICHAEL-LAPTOP
app: 0.4.1
type: feature
status: new
---
Hey, I want you to add a dark-mode toggle to the app…
```

Header keys:

| key       | meaning                                                        |
|-----------|----------------------------------------------------------------|
| `id`      | the request id (matches the filename)                          |
| `created` | ISO 8601 UTC timestamp of composition                          |
| `machine` | hostname of the PC the request was composed on                 |
| `app`     | Muse Bridge version that sent it                               |
| `type`    | one of `feature` \| `skill` \| `task` \| `question`            |
| `status`  | always `new` at send time; never changes (see §2)              |

**Request files are immutable once created.** Neither side edits or
deletes them; all state lives in the status file (§2). A request with
no status file is, by definition, not yet seen by Muse.

Types:

- `feature` — a change to Muse Bridge itself. Ships as a release.
- `skill` — a new reusable skill/capability for Muse. Ships as a
  release if it changes the app, otherwise answered in status.
- `task` — work for Muse that is not an app change (research, a
  document, a check). The status note reports the outcome and where
  the result lives.
- `question` — answered in the status file (§2, `answered`).

## 2. Status files (written by Muse's side only)

**Path:** `requests/<id>/status.md` — a folder named exactly the
request id.
**Commit message:** `Ask Muse status: <id> <status>`

**Content:** header lines, a line containing only `---`, then a
free-text note in plain words:

```markdown
status: shipped
version: 0.4.2
updated: 2026-10-18T14:03:11.000Z
---
Added the dark-mode toggle in Settings → Appearance. It ships in
v0.4.2 — your app will offer the update on its next launch.
```

| key       | meaning                                                              |
|-----------|----------------------------------------------------------------------|
| `status`  | one of the vocabulary in §3 (required)                               |
| `version` | the release that shipped the work, `x.y.z` with no leading `v` (required when `status: shipped`) |
| `updated` | ISO 8601 UTC timestamp of this status write                          |
| note      | what happened, where the result lives, or the answer itself        |

**The app never writes status files.** It reads them read-only and
shows the latest one per request. Status writes replace the whole
file (PUT with the current `sha`); the note should always describe
the *current* state completely, not append a diary.

## 3. Status vocabulary

| status     | written when                                                                 | app shows            |
|------------|------------------------------------------------------------------------------|----------------------|
| *(none)*   | request filed, not yet picked up                                             | **Sent to Muse**   |
| `seen`     | Muse's watcher has picked the request up and logged it                     | **Seen by Muse**   |
| `building` | work is actively in progress                                                 | **Muse is building it** |
| `shipped`  | the work is live — for app changes, the release in `version:` is published with assets verified | **Shipped in vX.Y.Z** |
| `answered` | a `question` (or non-app `task`/`skill`) is complete; the note carries the answer or says where it was answered (e.g. "answered in your Muse chat") | **Answered** |

Local-only states the app may show but Muse's side will never write:
`draft` (composed on a PC with no token saved; never left that PC)
and `send-failed` (the PUT failed; the app keeps the text and offers
a retry that first checks whether the file already landed, so a
retry never creates a duplicate under a second id).

## 4. Muse's side — the operating contract

1. **Poll.** The watcher lists `requests/` (suggested cadence: every
   ~15 minutes while active, and as part of the 2:30 AM nightly loop
   summary). Any `REQ-*.md` with no `requests/<id>/status.md` is new
   work.
2. **Mark seen.** On first pickup, write `status.md` with
   `status: seen` and a one-line note ("Picked up — will build
   tonight" is enough). Do this before starting the work, so the app
   shows Michael the request landed.
3. **Work it** under the usual rules (Oct 13 code standard for app
   changes; approval gates unchanged for anything outward-facing).
   While a build is actively running, set `status: building`.
4. **Close it out.**
   - App change → publish the release first (assets verified by
     read-back, as usual), **then** write `status: shipped` with the
     exact `version:` and a note saying what changed and that the
     app will offer the update.
   - Question → `status: answered`, the note carrying the answer
     itself, or "answered in your Muse chat" when the answer was
     given there.
   - Task/skill with no app change → `status: answered` (or
     `shipped` if a release carries it), note saying what was done
     and where the result lives.
5. **Never** edit the request file, never write a status for a
   request that does not exist, and never put credentials, tokens, or
   personal data beyond what the request itself contains into a
   status note — status files ride back into the app and are shown
   verbatim.
6. **Report in chat too.** The nightly 2:30 AM summary and the normal
   chat reporting still cover request work; the status file is the
   in-app mirror, not a replacement for telling Michael.

## 5. The app's side — guarantees

- Sends are **idempotent**: before every PUT the app GETs the target
  path; a file that already landed is treated as sent, never
  duplicated under a new id.
- No token → the request is saved as a **local draft** with the
  honest note "Add your GitHub token in Settings to send this to
  Muse", plus a "Copy request text" fallback. The app never fakes
  a send.
- GitHub unreachable at refresh → the panel shows the **last cached
  list** with an "offline — showing the last check" note. Never an
  error wall, never an empty list that pretends nothing exists.
- The token is stored exactly like the Meta API key (OS-encrypted in
  `settings.json`, session-only when encryption is unavailable),
  never logged, never rendered back, and used for no endpoint other
  than the three listed above.
- Requests composed on another PC (or by hand, in this exact format)
  are discovered on refresh and shown alongside this machine's, with
  their statuses.
