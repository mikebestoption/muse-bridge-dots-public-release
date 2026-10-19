# Muse Bridge — v0.4.2 (Loops at the top)

**Muse Bridge** is a free, open-source desktop app for Windows,
powered by Muse Spark (Meta Model API). It is published under the
Apache License 2.0 (see `LICENSE`) from the public repository
`mikebestoption/muse-bridge-dots-public-release` — use it with your own
Muse Spark API key (see "Your API key" below), and see `CONTRIBUTING.md`
if you would like to propose an improvement. It has three jobs:

1. **Chat** with Muse Spark — now including screenshots (Teach mode).
2. **Do tasks on the desktop** — but only steps the user approves, one by one.
3. **Bridge ChatGPT (Dot) and Muse** — the two-engine cross-check loop:
   ChatGPT results come in, Muse Spark reviews them; Muse Spark results go
   out as "verify this" packets; Dot's audit feedback comes back and gets logged.

## Changes in 0.4.2

- **🔁 Loops now opens at the top, full-height.** Clicking **Loops**
  used to open its panel underneath the chat and any panel already
  open (e.g. Terminals), squeezed into the small drawer height — the
  builder was hard to use. Now the Loops panel sits directly under
  the chat header, opening it closes the other panels, the chat steps
  aside while Loops is open, and the panel takes the full height
  between the header and the composer (only its body scrolls). Click
  **Close** (or open another panel) and the chat comes back exactly
  as it was. The same applies when a loop builder or run opens from
  an SOP conversion.
- **☀️ New light theme — Best Option colors.** The all-black theme is
  gone. The app is now majority white with easy-on-the-eyes slate
  text, in Best Option's own palette (bestoption.co): site blue
  `#046bd2` for buttons and actions, brand sky `#00aeef` as the
  highlight, soft blue-gray panels — and no orange anywhere. The
  Best Option logo sits at the top of the sidebar, the Best Option
  mark is now the app/taskbar/installer icon, and the publisher is
  **Best Option Funding Inc.**

## Changes in 0.4.1

- **✉️ Ask Muse — ask for features from inside the app.** A new
  **✉️ Ask Muse** panel (left column): pick a kind — **App feature**,
  **New skill**, **Task for Muse**, **Question** — type what you
  want in plain words ("hey, I want you to do such and such"), and hit
  **Send to Muse**. Instead of opening the Muse chat, the app
  files the request in the `requests/` folder of the private
  `mikebestoption-Muse-Bridge` repo, where Muse picks it up,
  does the work, and ships the result back as an ordinary app update.
  The panel tracks every request through its statuses — **Sent →
  Seen by Muse → Muse is building it → Shipped in vX.Y.Z** (or
  **Answered**, for questions, with the answer or a pointer to it) —
  read back from the repo on refresh, cached locally so the list
  still shows offline with a plain "showing the last check" note.
  Requests you sent from your other PC appear here too. The full
  two-sided contract is `docs/REQUESTS-PROTOCOL.md`.
- **One-time setup: a GitHub token.** Sending needs a fine-grained
  GitHub token saved in **⚙ Settings → GitHub token (for Ask Muse)**
  — scoped to only the `mikebestoption-Muse-Bridge` repo,
  Contents: Read and write (the Walkthrough has the click-by-click).
  Like your API key, it is stored OS-encrypted on this PC only, is
  never logged or shown back, and the app uses it for **nothing
  except the `requests/` folder of that one repo** (the client
  refuses every other path in code). **Without a token, nothing is
  faked:** Send saves the request as a local draft with a plain note
  ("Add your GitHub token in Settings to send this to Muse") and a
  **Copy request text** fallback. Sends are idempotent — a retry
  first checks whether the request already landed, so a flaky
  connection can never file a duplicate.

## Changes in 0.4.0

- **🔁 Loops — build a workflow once, run it any time.** A new Loops
  panel holds named, reusable workflows built step by step, n8n-style:
  **+ Add step**, pick a type, fill in its form, reorder with ↑/↓.
  Step types map onto machinery that already existed — **Ask Muse
  Spark** (a prompt; `{{prev}}` inserts the previous step's output),
  **Desktop task** (one action from the existing protocol: open URL /
  app, list folder, create / append file, run command), **Vault fill**
  (fill_login / fill_totp by entry label), **Manual step** (text shown
  to you; the run waits for your Done ✓ tap), and **Note**
  (documentation only). **▶ Run** executes the steps in order with a
  live checklist and log, plus Pause/Stop. **The approval model is
  unchanged:** task and fill steps propose the standard approval cards
  and never execute without approval; a denied or failed step halts
  the run and offers Skip-and-continue or Stop; a step that needs you
  in person ends the run as *waiting on you*. A reply from a prompt
  step is never executed — only task/fill steps run actions. Every
  loop has a **readable document view** (name, purpose, numbered
  plain-English steps) and an **Export .md** to the Bridge Outbox —
  loops are documented, not just stored. A loop can also be added to
  the **Night Queue** as a job: the queue's one approval covers it,
  manual steps park as *waiting on you*, and the morning summary
  reports the outcome. Loops live in `loops.json` in userData, on
  this PC only.
- **🎬 Teach from video — SOPs from your recordings.** In the Lessons
  panel: paste a **Vimeo link** or drop/pick a **video file** (mp4,
  webm, mov — up to 500 MB, streamed into userData, never loaded whole
  into memory). The app samples frames locally (every ~5 s, first and
  last, max 24) and asks Muse Spark to write a structured **SOP** —
  Title / Goal / What you need first / numbered Steps (exact action,
  where/what exactly, expected result) / Watch-outs — saved to a new
  SOPs library in userData, viewable in-app and exportable as .md.
  **"🔁 Turn into a Loop"** converts an SOP into a draft Loop: each
  SOP step becomes a manual step with its text preserved (steps that
  unambiguously say "open <url>" or "create a file named X" are
  pre-typed as task steps, clearly flagged ⚠ for review). The draft
  opens in the builder for editing; it is never auto-run.
- **The Vimeo boundary, honestly.** Public link metadata (title,
  thumbnail, duration) comes from Vimeo's oEmbed — no token needed.
  Analyzing the *recording itself* from a link needs captions and/or
  a downloadable file, which only Vimeo's API provides: save a
  **Vimeo access token** in Settings (stored encrypted on this PC,
  exactly like your API key) and the app fetches the captions and,
  when the video's owner has downloads enabled, the file for frame
  sampling. **Without a token and without the file, intake saves the
  link + metadata only and says so plainly — an SOP is never faked
  from a thumbnail.** Transcripts come from Vimeo captions, or from
  a transcript file you add to the record (.txt/.md/.vtt); an SOP
  built without one is labeled *"from video frames only (no
  narration transcript)"* in the app, in its export, and in any Loop
  made from it.
- **Deferred from the earlier v0.4 plan, stated plainly:** repo-watch
  of `stage` branches, Standing Orders, and Windows notification
  capture were specced for this version and are **not** in this
  build — Loops + Teach from video took the slot. They remain future
  work, not shipped features.

## Changes in 0.3.4

- **Drag-and-drop attachments, ChatGPT-style.** Drag any file onto the
  app window: a full-window "Drop files to attach" overlay appears,
  and dropping stages the files as removable chips above the composer
  (image thumbnails for screenshots; name + size for documents). The
  📎 button is a styled multi-file picker — the raw native file input
  from v0.3.3 is gone from view — and pasting files from the clipboard
  lands in the same chips. Multiple attachments per message, including
  several screenshots at once.
- **Text documents ride with the message.** Attach a text file
  (.txt, .md, .json, .csv, .log, .xml, .html, .js, .ts, .py, and other
  plain text — unknown types are content-sniffed) and its contents are
  included in the message Muse Spark receives, in a labeled
  `[Attached document: ...]` block, capped at 100 KB per file with the
  truncation stated inside the block. Your chat bubble shows a compact
  document line, not the raw text. Anything that is neither a
  png/jpeg/webp image nor readable text (executables, zips, other
  image formats) is refused with an honest note naming the file —
  never silently swallowed. In Mock mode, attachments stage the same
  way and the mock reply acknowledges them by name.

## Changes in 0.3.3

- **Auto-updater (the bootstrap release).** The app now checks the public
  GitHub Releases feed on launch (and via "Check for updates" in
  Settings), downloads updates in the background with checksum
  verification, and offers one "Restart to update" prompt. The public
  feed needs no credentials in the app. **v0.3.3 is the last manual
  install** — v0.3.4 and later arrive automatically. Installing an update
  never touches your userData: API key, Vault, lessons and history all
  carry over.
- **Teach mode — learn from screenshots.** Attach a screenshot to any
  chat message (paste from the clipboard, drag-drop, or the file
  picker); it is sent to Muse Spark in vision format with your message.
  If the API ever rejects image input, the app says so plainly and sends
  your text on its own — the image is never silently dropped. "Save as
  lesson" stores a screenshot plus your own words about what it shows /
  what to click / what to do, **locally on your PC only**; lesson notes
  ride along as context in later chats, and a lesson may carry a proposed
  action mapping that future proposals can reference — still through the
  normal approval cards. Teach v1 is see, remember, advise, propose:
  there is deliberately **no autonomous clicking** in this release.
- **Open source.** Source published under Apache-2.0 with `LICENSE`
  (Copyright 2026 Michael Rodriguez), a public README/CONTRIBUTING, and a
  pre-publish scrub audit of the whole tree (no keys, no personal paths
  or data, no private-repository references) whose report is part of the
  build record (`npm run scrub`).

## Changes in 0.3.2

- **Panels scroll on small screens; footer actions are always reachable.**
  On a smaller display (or with Windows display scaling at 125–150%) the
  Settings dialog was taller than the window: clipped at the top and
  bottom, no scrollbar, and Save was unreachable. Every dialog and panel
  now follows one pattern — the container is capped at the viewport
  height, its middle content region scrolls (`overflow-y: auto`), and the
  header plus footer actions (Save settings, the Night Queue's
  "Approve this queue & run it", each panel's Close) stay pinned and
  clickable at all times. Covers Settings, Run tests with Dot, Vault,
  Terminals, Night Queue and Audits. Verified headless at 1280×720 and
  1024×640: Save's bounding box inside the viewport, body scrolls,
  footer does not move.

## Changes in 0.3.1

- **Special folders are resolved by the OS, not guessed by the model.**
  Live Muse Spark proposed a path under a
  username it invented (`<drive>:\Users\<invented-name>\Desktop\musebridge.txt`) — and the step failed. The app now resolves every
  proposed path against the real folders from the OS
  (`app.getPath('home' | 'desktop' | 'documents' | 'downloads')`) before
  the approval card is rendered and again before execution:
  `~\...`, bare `Desktop\...`, and any `<drive>:\Users\<anyone>\Desktop|Documents|Downloads\...`
  are re-rooted onto the real folders — which also handles
  OneDrive-redirected Desktops. What the card shows is the path that runs.
- **EPERM-proof folder creation.** `create_file` / `append_to_file` no
  longer run a blind recursive mkdir over the parent chain (on Windows
  that died with `EPERM: operation not permitted, mkdir 'C:\Users\<name>'`
  at the profile root). The new `ensureDir` skips existing directories and
  only fails when a directory truly doesn't exist and can't be created.

## Run it in dev

```bash
npm install
npm start
```

Node 18+ and an internet connection (for live mode) are all you need.
Packaging: `npm run dist` (Windows portable .exe + zip + NSIS setup),
`npm run dist:linux` (Linux zip).

## Portable vs installed (v0.3)

Two Windows tracks, same app (`appId com.michael.musebridge`, product
name "Muse Bridge"):

- **Portable** (`MuseBridge-<version>-portable.exe`) — no install, run
  the file.
- **Installed** (`MuseBridge-<version>-setup.exe`) — an NSIS installer:
  per-user (no admin prompt), installs into
  `%LOCALAPPDATA%\Programs\Muse Bridge` (folder changeable in the
  installer), creates a Start Menu shortcut named **Muse Bridge** (so
  Windows Search finds it) plus a desktop shortcut, and registers a
  normal uninstall entry (Settings → Apps → Installed apps).

Because both tracks share the same appId/productName, the installed
build reads the **exact same userData folder** as the portable builds —
a saved Spark API key, Vault, sessions and history carry over untouched.
Switching from portable to installed: just run the setup; your key and
vault are already there. Delete the old .exe. Upgrades after that = run
the newer setup over the top, nothing to uninstall first.

## Your API key

- Create a Meta Model API key at **dev.meta.ai** (new accounts get free credit).
- Paste it into the app under **Settings**. That is the only place it ever goes.
- The app stores it **only on your PC**: encrypted with Electron `safeStorage`
  (backed by Windows DPAPI) inside the app's own settings file. If OS
  encryption is unavailable, the key is kept in memory for that session only
  and never written to disk.
- The key is never in the source code, never logged, and is sent only to
  `https://api.meta.ai/v1/chat/completions` from the app's main process.
- Choose the model in Settings: `muse-spark-1.3` (default) or `muse-spark-1.1`.

## Mock mode

With no key, the app runs in **Mock mode** — the banner says so, and every
reply is labeled `[Mock mode — add your Meta Model API key in Settings for
live Muse Spark]`. Mock mode still demonstrates the whole flow: it
understands requests like "list my Downloads folder", "open https://…",
"create a file called notes.txt", "run command: whoami", "copy from chatgpt",
"paste to chatgpt: …", and returns structured reviews of imported ChatGPT
results. The Dot test runner also simulates a Dot run in mock mode (clearly
labeled SIMULATED).

## The approval gate (desktop tasks)

The assistant can only **propose** steps. Each proposal appears as an
approval card showing the exact action — path, URL, text, or full command
line. **Nothing executes until you click "Approve & run" for that step.**
Deny runs nothing. Results are logged back into the chat. All execution
happens in Electron's main process; the page itself has no Node access.

Action types: `open_url`, `open_app`, `list_folder`, `create_file`,
`append_to_file`, `run_command`, plus the two Windows clipboard-bridge
actions below.

## Hands guards — the app never types over you (v0.3)

Four action types physically type into a window: `paste_to_app`,
`copy_from_app`, `fill_login`, `fill_totp`. Those are the app's **hands**.
Everything else — chat, file tasks, Bridge/GitHub work, shell jobs — is the
app's **brain**, and brain steps are never guarded: they run fine while the
screen is locked or the session is switched to another user.

Before any hands step types a single keystroke, the guard checks two
things on Windows, using one fixed PowerShell probe (it reads only OS
state — no user data is passed into it):

1. **Idle time** — `GetLastInputInfo`: how long since the last mouse or
   keyboard input.
2. **Input desktop** — `OpenInputDesktop` + `GetUserObjectInformation`:
   the interactive input desktop is named `Default`. Locked session →
   the input desktop is `Winlogon`. Switched away / disconnected (fast
   user switching) → this session cannot open the input desktop at all.
   Both mean "not typable". (This probe was chosen over looking for a
   LogonUI process because it answers the real question — *can this
   process type into the visible desktop?* — for both cases at once.)

What happens then:

- **Night Queue hands steps:** if you were active within the **Hands idle
  threshold** (Settings, default **30 s**), the step *waits* — the queue
  status shows "⏸ Waiting — you're using the PC" and the wait is written
  to the night log — polling every ~5 s until you've been idle for the
  threshold. If you're still using the PC when the **Hands max wait**
  (Settings, default **30 min**) runs out, the step **parks** as
  *waiting on you* with reason **"user active on the PC"** and the queue
  continues with its remaining (brain) jobs.
- **Locked / switched-away session:** hands steps **park immediately** as
  *waiting on you* with reason **"session locked or switched away"** —
  they are never marked failed and never forced. Brain steps in the same
  queue keep running regardless.
- **Steps you approve by hand (approval cards):** after you click
  Approve, the card counts down **"Will type in 3… 2… 1…"** — it needs
  ~3 s of continuous hands-off time; if you start typing, the countdown
  restarts. The Deny button becomes **Stop** during the countdown and
  cancels cleanly: nothing is typed. If the session is locked at that
  moment, you get the parked message instead of an error.
- **Switching users vs. locking vs. logging out:** fast user switching
  (e.g. to a second Windows account) and locking keep the app alive in
  the background — brain work continues, hands steps park. **Logging the
  account out closes the app entirely**, like quitting any program;
  nothing runs until it's launched again after logging back in.
- **Non-Windows:** the probes report "unknown", which is treated as
  typable — behavior exactly as before v0.3 (that's the path mock/Linux
  verification runs on). If a Windows probe itself hard-fails, the
  reading is also "unknown" → typable; the typing scripts still fail
  honestly if their target window can't be focused.

The decision logic is a pure function in `src/sessionGuard.js`
(PROCEED / WAIT / PARK / CANCELLED), unit-tested across the full matrix
with injected fake probes — see `tests/sessionGuard.test.js`.

## The Bridge — clipboard fast path + folder durable path

There is **no direct ChatGPT↔Muse API channel and no automatic sync with
your ChatGPT account** — ChatGPT doesn't offer one. The bridge works the way
your existing two-engine workflow already does: through shared files and the
clipboard.

**Clipboard bridge (fast path):**
- **Import from clipboard** — copy a ChatGPT answer, click this, and decide:
  review it with Muse Spark, log it as a Dot test result, or both.
- **Copy for ChatGPT** — puts the last Muse Spark answer on your clipboard
  as a paste-ready "verify this" brief.
- **Automated (Windows only) approved task steps:**
  - `copy_from_app` — focuses a window by title (e.g. "ChatGPT"), Ctrl+A,
    Ctrl+C, and returns the copied text.
  - `paste_to_app` — puts exact text on the clipboard, focuses the window by
    title, and Ctrl+V's it.
  These run via PowerShell + SendKeys, go through the **same approval card**
  as every other step (exact target window and exact text shown first), and
  the window title / text travel to PowerShell via environment variables,
  never interpolated into a script. On non-Windows they refuse with a clear
  "Windows only" message — use the manual clipboard buttons there instead.
  *Status: implemented and unit-checked, but NOT live-tested on Windows in
  v0.1 (the build machine is Linux). First real run: watch it focus the
  ChatGPT window before approving.*

**Bridge folder (durable path):** default `Documents/MuseBridge`
(changeable in Settings):

```
MuseBridge/
  Inbox/       ← drop ChatGPT results (.md/.txt/.json) here; click to import
  Outbox/      ← "Package for ChatGPT" / "Package for Muse" packets,
                 Dot test packets
  NightRuns/   ← night-log.md + morning-summary-*.md
  test-log.md  ← every Dot verdict ever logged
```

**Dot test runner ("Run tests with Dot"):** describe what to test → the app
builds a packet (What to check / Where / Expected result, with the current
conversation as the material) → send it to Dot by clipboard copy or Outbox
file → import Dot's reply → verdicts (claim / PASS-FAIL-UNVERIFIED /
evidence) are shown in the chat and appended to `test-log.md`. Mock mode can
simulate the whole loop end to end.

## Audit Signal — how Muse KNOWS Dot needs to audit something

Every result, chat answer, job and terminal output carries an audit status:

`Not requested` → **NEEDS DOT AUDIT** → `Audit sent to Dot` → `Verdict back` → `Fixes queued`

- **Flagging:** "🚩 Flag last answer" (sidebar), "🚩 Flag output for Dot
  audit" (each terminal session), a per-job **Needs Dot audit** toggle in the
  Night Queue list, and a Settings default that flags new Night Queue jobs
  automatically. A finished Night job that was flagged enters the queue on
  its own.
- **Muse can see it:** flagged items land in the **Audits panel**, and a red
  badge counts what's waiting — in the sidebar, in the chat header, and in
  the Terminals/Audits header. No flag, no badge: Muse is never guessing
  whether Dot has work.
- **Sending:** each flagged item auto-packages the verify-this audit packet
  (What to check / Where / Expected result / the result itself). One click
  copies it for Dot and saves it to the Bridge Outbox; status flips to
  `Audit sent to Dot`.
- **Verdict back:** import Dot's reply (clipboard attach on the item, or the
  normal clipboard/Inbox import — an imported verdict also auto-attaches to
  the oldest sent item). Status flips to `Verdict back`, the verdict lines
  attach to the **original** item, and everything is written to
  `test-log.md` like any Dot test.
- **Fixes queued:** if any verdict is FAIL, one click turns the failed items
  into a fix job in the Night Queue list — which still only runs when you
  approve the queue. Status becomes `Fixes queued`.
- **Mock mode** simulates the full cycle (flag → package → simulated Dot
  verdict, labeled SIMULATED (mock) → verdict back → fixes queued).

## Terminals (multiple sessions)

The **Terminals** panel holds named sessions — e.g. "Builder — Spark",
"Tester — Dot", "Researcher". Each session has its own engine/role label,
working folder, job queue and scrolling log, and runs independently:

- **Chat jobs** go to Muse Spark and answer in that session's log. If the
  assistant proposes desktop steps there, they are **not** run from a
  terminal — terminals never execute proposals; use the main-chat approval
  cards for that.
- **Shell jobs** pause the session and show an approval card *inside that
  session's panel* with the exact command and folder. Approve & run, or skip.
- Start / Pause / Stop per session. Sessions and queues are saved locally.

## Night Queue (overnight / unattended mode)

**Default: OFF. There is no free-roam autonomy in this app, by design.**

- Before sleeping, assemble the queue: chat jobs, exact-command shell jobs,
  and Dot test jobs — each one written out in full, in a list you can read.
- One explicit tap — **"Approve this queue & run it"** — is the only way
  anything runs unattended. That approval covers **exactly those jobs, as
  written, in that order**. Nothing else. It is not a blanket authorization.
- If any job's assistant reply tries to go outside its approved text (e.g.
  proposes new desktop steps), **that job is stopped and the whole queue
  halts** for your review. Nothing extra ever runs.
- Everything is written to `Bridge/NightRuns/night-log.md` as it happens,
  and a **morning summary** (`morning-summary-*.md`) lists each job as
  done / stopped / failed, ready with your coffee.
- **v0.2:** queue steps can be **Fill login** / **Fill 2FA code** (the job
  text is the vault entry label — that label + site is what your queue
  approval names; the log records only "Login filled for X" /
  "Authenticator code filled for X", never a value). A step that needs you
  in person (`wait_for_user` — hardware security key, phone prompt — or a
  fill against a locked vault) **parks** instead of halting: status
  *waiting on you*, the queue continues, and the summary lists it with
  its reason. Out-of-scope proposals still stop + halt, as in v0.1.
- Honest limits: the queue runs only while the app stays open; a Dot test
  job at night exports its packet to Outbox (in mock mode it also simulates
  Dot's verdicts) — a real Dot run still needs ChatGPT, which has no
  unattended channel.
- **v0.4:** a job can be a whole **Loop** (see "Changes in 0.4.0" above) —
  the queue approval covers its steps; manual steps park the job as
  *waiting on you*; a failed step stops that job and the queue moves on.
- The one-off interactive approval gate is unchanged by all of this.

## The Vault — passwords + 2FA, filled for you (v0.2)

The Vault is a LastPass-style store **inside the app**, built for the tasks
that used to be manual only because a password had to be typed.

- **Crypto:** one encrypted file (`vault.json` in userData), AES-256-GCM,
  key derived from your **master password** with scrypt. A wrong master
  password — or a tampered file — fails decryption cleanly. The vault
  starts locked, auto-locks after inactivity (Settings, default 10 min),
  and there is **no plaintext export**, ever.
- **The master password is unrecoverable by design.** It is never stored;
  if you forget it, the vault's contents are lost and you start the vault
  over. There is no reset and no back door — that is the point.
- **Entries** hold label, username, password, an optional authenticator
  (TOTP) secret, URL, window title, notes. The list you see shows label +
  username only; revealing a secret takes an unlocked vault + an explicit
  click, and the reveal lives only in the Vault panel.
- **What the AI can see:** entry **labels and usernames only** (so it can
  propose "fill the login for GitHub"). **What it can never see:**
  passwords, TOTP secrets, and codes — they do not exist anywhere the
  renderer, the model, chat history, Bridge packets, or any log can reach.
  (A test in `tests/noSecrets.test.js` serializes the proposed action, the
  approval card, execution results, chat history, and night logs from a
  simulated fill and asserts none of them contain the password, the code,
  or the secret.)
- **Filling:** `fill_login` and `fill_totp` are ordinary approval-gated
  task steps. The card shows label + username + target window — never the
  secret. Approved steps run in the main process: PowerShell focuses the
  window by title and SendKeys types the username / password / code
  (credential values travel to the PowerShell child through environment
  variables only — never command-line arguments, never logs, never an IPC
  reply). The TOTP code (RFC 6238, Google-Authenticator compatible) is
  generated in the main process **at execution moment**, not when proposed.
  If the vault is locked, the fill refuses: *"Vault locked — unlock to
  fill."* Filling is Windows-only (SendKeys); elsewhere you get an honest
  refusal.
- **The trade-off, plainly:** a password manager that holds **both** your
  password **and** your authenticator secret in one vault is more
  convenient and less separated than keeping your second factor in a
  separate app on your phone. Anyone who gets your unlocked vault session
  gets both factors. The master password, the auto-lock, and approving
  every fill are the controls that carry that risk — use a strong master
  password and keep the auto-lock short.
- **Hardware security keys & phone prompts cannot be automated.** A step
  that needs a key touch or a phone approval is declared (or detected) as
  `wait_for_user`: in the Night Queue that job **parks** (status
  *waiting on you*) and the queue continues with the rest; the morning
  summary lists parked jobs with their reasons. There is deliberately no
  WebAuthn bypass, virtual authenticator, or presence spoofing anywhere
  in this app.

## Where your data lives

- Chat history: `history.json` in the app's userData folder on your PC.
- Settings (model, Bridge path, encrypted key, optional encrypted Vimeo
  token): same folder.
- Sessions / night queue: same folder.
- Loops: `loops.json`, same folder (fill steps carry vault entry labels
  only — never secrets).
- SOPs: `sops.json`, same folder; staged video files live under
  `video-temp/` in the same folder. Both stay on this PC.
- Ask Muse: `requests-local.json`, same folder — this machine's
  request drafts + the cached status list. The requests themselves
  live in the private repo's `requests/` folder once sent.
- Vault: `vault.json`, same folder — a single AES-256-GCM/scrypt-encrypted
  blob. It never leaves that folder and is excluded from this repo.
- Nothing is uploaded anywhere except your chat messages going to the Meta
  Model API when you have a key set, and — only when you use Ask Muse
  with a GitHub token saved — the request files you send. (Vault labels +
  usernames ride along as planning context; secrets never do.)

## Known limits (v0.3.1)

- ChatGPT bridge is file- and clipboard-based — no automatic ChatGPT sync exists.
- `copy_from_app` / `paste_to_app` window automation is Windows-only and
  was not live-tested on Windows for v0.1 (see above).
- `fill_login` / `fill_totp` SendKeys typing is likewise Windows-only and
  was NOT live-tested on a real Windows machine for v0.2 — vault crypto,
  TOTP vectors, the no-secrets guarantee, the approval cards and the
  locked-vault refusal were all verified headlessly; the actual typing
  into a real Windows window gets its first live run on Michael's PC.
  Some apps/fields (e.g. hardened banking apps) block synthetic keystrokes
  entirely — those stay manual.
- Hardware security keys (WebAuthn/FIDO) and phone approval prompts can
  never be filled by software; those steps park as *waiting on you*.
- The v0.3 hands guards (idle probe + input-desktop probe) are unit-tested
  with injected fakes and verified headlessly on Linux (non-Windows
  passthrough), but the Windows probes themselves — including fast user
  switching to a second account — were NOT live-tested on a real Windows
  session for v0.3.
- The NSIS setup (`MuseBridge-<version>-setup.exe`, 0.3.0 and 0.3.1)
  ships, but it was not produced by electron-builder: the Linux build
  VM's wine cannot
  execute 32-bit PE binaries (a fresh wine prefix never provisions
  syswow64, and the standalone 32-bit loader segfaults), and
  electron-builder's NSIS build has one wine step (generating the
  uninstaller from the 32-bit template). The shipped setup was compiled
  from a hand-written NSIS script (`installer-native.nsi`) using the
  native Linux `makensis`, with identical install behavior: per-user
  install into `%LOCALAPPDATA%\Programs\Muse Bridge`, Start Menu +
  desktop shortcuts named **Muse Bridge**, an HKCU uninstall entry in
  Settings → Apps, and the same appId/userData carry-over (API key and
  Vault survive uninstall/reinstall). From 0.3.3 the setup first closes a
  running Muse Bridge (window or system tray), so upgrading over a running
  copy no longer fails with "Error opening file for writing" on locked DLLs
  such as d3dcompiler_47.dll. Its payload was verified complete
  (archive listing plus a byte-identical extraction diff against
  `win-unpacked`). The electron-builder NSIS configuration remains
  committed for future builds on Windows (or a Linux box with a working
  wine).
- Request/response chat (no token streaming yet).
- The approval gate is enforced in the app's UI flow: the renderer can only
  ask the main process to execute, and it only asks after your click.
