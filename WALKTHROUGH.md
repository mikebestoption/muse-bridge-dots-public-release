# Muse Bridge — Walkthrough

A step-by-step guide for Michael. No technical background needed.
Every button name below is written **exactly** as it appears in the app.

**What Muse Bridge is, in one sentence:** an app on your Windows PC where
you chat with Muse Spark, let it do small jobs on your computer (only with
your approval, step by step), and pass work back and forth between Muse
Spark and ChatGPT (Dot) so each one can check the other's work.
**New in v0.2 — the Vault (Section 12):** save each password and 2FA
secret once, and the app fills logins and codes for you — that's what
lets a pre-approved Night Queue run as a 24/7 employee.
**New in v0.3 — hands guards + a real installer:** typing steps now wait
for you to stop using the PC and park instead of typing into a locked or
switched session (Sections 11 and 14), and there's a normal Windows
installer (Option A below) alongside the portable file.

---

## 1. Download and install on Windows

There are three files. You only need one of them.

**Option A — the installer (recommended; like a normal Windows app):**

1. Download **MuseBridge-0.3.0-setup.exe** and double-click it.
2. If Windows shows a blue "Windows protected your PC" screen, that is
   because this version is not code-signed yet. Click **More info**,
   then **Run anyway**.
3. Follow the installer. It installs **just for your user account** —
   no admin password, nothing system-wide — into
   `C:\Users\<you>\AppData\Local\Programs\Muse Bridge`. You can change
   the folder on the installer's directory page.
4. Done: **Muse Bridge** now appears in your Start Menu (press the
   Windows key and type "Muse Bridge" to find it), there's a desktop
   shortcut, and it uninstalls the normal way —
   **Settings → Apps → Installed apps → Muse Bridge → Uninstall**.

**Option B — the portable app (nothing to install):**

1. Download **MuseBridge-0.3.0-portable.exe**.
2. Double-click it. It opens. That's it — there is no installer.
3. Same SmartScreen note as above: **More info** → **Run anyway**.
4. Optional: right-click the file → **Send to → Desktop (create shortcut)**
   so you can open it from your desktop.

**Option C — the zip:**

1. Download **Muse Bridge-0.3.0-win.zip**.
2. Right-click it → **Extract All…** → pick a folder.
3. Open the folder and double-click **Muse Bridge.exe**.

**Switching from portable to installed (or upgrading):** all three
options are the *same app* and read the *same data folder*, so your API
key, Vault, sessions and chat history carry over untouched. Just run
the setup; your key and vault are already there. Delete the old .exe.
Upgrades after that = run the newer setup over the top, nothing to
uninstall first. (Same rule between portable versions: just replace the
file.)

## 2. First launch — what you are looking at

1. Double-click the app. The main window opens.
2. On the **left side** is the control column: New chat, Settings,
   Terminals, Night Queue, the Clipboard bridge, the Dot test runner,
   Audits, and the Bridge Inbox.
3. In the **middle** is the chat. At the top of the chat is a header that
   says **Muse**, and — once you flag work for Dot — a red badge counting
   how many things are waiting for Dot's audit.
4. Just under the left column header you will see a yellow banner:
   **"Mock mode — add your Meta Model API key in Settings"**. That is
   normal on first launch. Read the next section.

## 3. Mock mode vs live mode

- **Mock mode** = practice mode. The app answers with pretend replies, and
  every reply starts with `[Mock mode — add your Meta Model API key in
  Settings for live Muse Spark]`. Everything still works — tasks,
  approvals, the bridge, Dot test packets, audits, the Night Queue — so you
  can learn the whole app with zero risk and zero cost.
- **Live mode** = the real Muse Spark is answering. The banner turns green
  and says **"● Live — Muse Spark (muse-spark-1.3)"**.

You switch to live by adding your API key (next section). You can use mock
mode as long as you like.

## 4. Add your Meta Model API key (turns on live Muse Spark)

**First, get the key (one time only):**

1. Open your browser and go to **dev.meta.ai**.
2. Sign in / create the developer account.
3. Find the **Model API** area and create an API key. (New accounts get
   free starting credit.)
4. Copy the key. **Treat it like a password** — never paste it into a chat,
   an email, or a document.

**Then, put it in the app:**

1. In Muse Bridge, click **⚙ Settings** (left column).
2. Paste the key into the box labeled **Meta Model API key**.
3. Leave **Model** on **muse-spark-1.3** (the newer one). You can switch
   to **muse-spark-1.1** here later if you ever want to compare.
4. Click **Save**.
5. Check the banner: green **"● Live"** means you are connected to the
   real Muse Spark.

**Where the key lives:** only on your PC, locked by Windows itself
(encrypted). The app never sends it anywhere except to Meta's API when you
chat. To remove it: **⚙ Settings → Remove key → Save** is not needed —
**Remove key** takes effect right away and the app goes back to mock mode.

## 5. Send your first chat

1. Click into the big box at the bottom that says
   **"Message Muse Spark…"**.
2. Type a question, for example: `What can you do on my desktop?`
3. Press **Enter** (or click **Send**). Use **Shift+Enter** if you want a
   new line without sending.
4. Muse Spark's answer appears in the middle, labeled **MUSE SPARK**.
   Your messages are labeled **YOU**.
5. Your conversation is saved on your PC automatically — close the app and
   it is still there when you come back. **+ New chat** wipes it and
   starts fresh.

## 6. Let it do a task on your desktop (the approval rule)

**The golden rule of this app: Muse Spark can suggest a task, but it can
never just do it. You approve every single step, after reading exactly what
it is.**

Example — see what's in your Downloads folder:

1. Type: `list my Downloads folder` and press **Enter**.
2. Muse Spark answers — and under the answer a **gold approval card**
   appears. It says **"⚠ Approval needed"** and shows the exact step,
   including the exact folder path.
3. Read the card. If it is what you wanted, click **Approve & run**.
4. The result appears right on the card and in the chat (the list of files).
5. If you don't like what the card says, click **Deny**. Nothing runs.
   Denying is always safe and always free.

Other things you can ask for the same way (try them in mock mode first):

- `open https://example.com` — opens a link in your browser.
- `create a file called notes.txt` — makes a file in your home folder.
- `run command: whoami` — runs that exact command. **Read command cards
  extra carefully** — only approve commands you understand or asked for.
- `open notepad` — opens an app.

If a step fails, the card says so in plain words (for example, the folder
doesn't exist). Nothing is hidden from you.

## 7. The clipboard bridge — ChatGPT ⇄ Muse, both ways

ChatGPT and Muse cannot talk to each other directly — there is no such
connection anywhere. Muse Bridge bridges them using something you already
know: **copy and paste**.

### 7a. Bring a ChatGPT result INTO Muse (for review)

1. In ChatGPT, select Dot's answer and copy it (**Ctrl+C**).
2. Switch to Muse Bridge and click **⬇ Import from clipboard**
   (left column, under "Clipboard bridge").
3. A card appears showing the start of what you copied. You get two
   choices:
   - **Review with Muse Spark** — Muse Spark reads Dot's answer and
     tells you what looks correct, what looks wrong, and what is
     unverified.
   - **Log as Dot test result** — use this when the text you copied IS
     Dot's verdict on something (see Sections 8 and 9).
4. Pick one. That's the whole flow.

### 7b. Send a Muse result OUT to ChatGPT

1. Have a chat so Muse Spark has given an answer you want checked.
2. Click **⬆ Copy for ChatGPT** (left column).
3. Switch to your ChatGPT window and paste (**Ctrl+V**). What lands is not
   just the answer — it is a ready-made **"Verify this" brief**: the
   result, what to check, and the exact reply format Dot should use.
4. Dot answers in ChatGPT. Bring the reply back with step 7a.

### 7c. The automatic version (Windows only, still approval-gated)

On Windows, Muse Spark can also propose two special steps:

- **copy_from_app** — "copy from chatgpt": the app brings your ChatGPT
  window to the front, selects all, copies, and brings the text back.
- **paste_to_app** — "paste to chatgpt: (your text)": puts the text on the
  clipboard, brings ChatGPT to the front, and pastes.

These appear on the **same gold approval cards** as every other task, and
the card shows the **exact window name and the exact text** before anything
happens. Nothing about this is automatic until you click
**Approve & run**. (Honest note: this part was built and checked on a Linux
build machine, so its first live run happens on your PC — watch it the
first time and make sure it focuses the right window.)

### 7d. The file version (the durable path — the Bridge folder)

For anything you want to keep:

1. Click **📦 Package for ChatGPT** — the conversation is saved as a file
   in the Bridge **Outbox** (see Section 11 for where that folder is).
2. Click **📦 Package for Muse** — same idea, formatted for Muse.
3. Anything Dot gives you as a file, drop into the Bridge **Inbox**. It
   shows up in the left column under **Bridge — Inbox**; click the file
   name and you get the same review/log card as the clipboard import.

## 8. Run a test with Dot, end to end

This is your QA loop: Muse does work → Dot audits it → you see the
verdicts in one place.

1. First, get a result into the chat (any chat answer will do).
2. Click **🧪 Run tests with Dot** (left column).
3. In the box labeled **What should Dot test?**, describe it plainly, for
   example: `Check every total and date in the result above.`
4. Send the packet to Dot, either way:
   - **Copy packet for Dot** — then paste into ChatGPT (**Ctrl+V**). Or:
   - **Export packet to Outbox** — the packet file lands in the Bridge
     Outbox for you to hand over.
   (In mock mode there is also **Simulate Dot run (mock)** — a pretend Dot
   reply, clearly labeled SIMULATED, so you can watch the rest of the flow
   work.)
5. Dot replies in ChatGPT in a checklist format: one line per check —
   **PASS / FAIL / UNVERIFIED** — with evidence.
6. Copy Dot's reply, come back, click **⬇ Import from clipboard**, and on
   the card click **Log as Dot test result**.
7. The verdicts appear in the chat as a list, AND they are written into
   **test-log.md** in your Bridge folder — your permanent audit history.

## 9. Flag a result "Needs Dot audit" — and read the verdict

Use this when you don't want to run the full test flow right now, but you
want the app (and Muse) to **remember** that Dot still owes you an audit
on something.

1. After any Muse Spark answer, click
   **🚩 Flag last answer: NEEDS DOT AUDIT** (left column, under "Audits").
2. Look at the top of the chat: a red badge appears —
   **"🔍 1 NEED DOT AUDIT"**. The same count shows in the left column.
   That badge is how Muse knows Dot has work waiting.
3. Click **🔍 Open Audits panel**. Your flagged item is listed with a red
   **NEEDS DOT AUDIT** label and the full text of the result.
4. When you are ready, click **📤 Package & copy for Dot** on the item.
   The audit packet goes onto your clipboard and into the Outbox, and the
   item's label turns yellow: **Audit sent to Dot**. (If you only want the
   file, click **Export packet only**.)
5. Paste into ChatGPT, let Dot answer, copy Dot's reply.
6. Back on the item, click **⬇ Attach verdict from clipboard**.
   The label turns green: **Verdict back**, and Dot's verdict lines are
   attached under the original result. (You can also use
   **Simulate Dot verdict (mock)** to see this work in mock mode.)
7. **If anything FAILED:** a button appears —
   **🔧 Queue fixes for … failed item(s)**. One click turns Dot's failed
   points into a fix job in the Night Queue list, and the label becomes
   **Fixes queued**. The fix still only runs when you approve the queue
   (Section 10) — nothing fixes itself behind your back.

You can also flag other things the same way: each terminal session has a
**🚩 Flag output for Dot audit** button, and each Night Queue job has a
**Needs Dot audit** checkbox next to it. In **⚙ Settings** you can also
turn on the default so every new Night Queue job is flagged automatically.

Audit labels you will see: **Not requested** (the normal state of
everything) → **NEEDS DOT AUDIT** → **Audit sent to Dot** → **Verdict
back** → **Fixes queued**.

## 10. Set up multiple terminals

Terminals are separate workspaces — like giving different jobs their own
desks. Each one has a name, a job label, its own folder, its own queue,
and its own scrolling log, and they run independently.

1. Click **🖥 Terminals** (left column). The Terminals drawer opens at the
   bottom.
2. Click **+ New session**. A card appears (the app suggests names like
   "Builder — Spark", "Tester — Dot", "Researcher").
3. You can rename the session, change its label, and type a **working
   folder** — the folder its file/command jobs will run in.
4. Add jobs: pick **Chat job** or **Shell job**, type the job, click
   **Add job**. It joins that session's queue.
   - A **chat job** is a question/instruction for Muse Spark; the answer
     lands in that session's log.
   - A **shell job** is an exact command. When its turn comes, the session
     **pauses and shows an approval card inside its own panel** with the
     exact command and folder. Click **Approve & run** or **Skip**.
5. **▶ Start** runs the queue. **⏸ Pause** holds it. **■ Stop** stops it.
6. The label on the card always tells you the state: **RUNNING**,
   **PAUSED**, **AWAITING** (waiting on your approval), **STOPPED**,
   **IDLE**. That is how you can always tell which terminal is doing what.
7. Sessions and their queues are saved — close the app and they are still
   there tomorrow.
8. **Delete session** removes one. **Close** hides the drawer (nothing
   stops).

## 11. The Night Queue — set it up before bed, read the summary with coffee

**The most important section. Read the rule first:**

> The Night Queue is **OFF by default** and it is **not** a free-roam
> robot. It runs **only** the exact jobs on the list you reviewed, in
> order, after **one** tap from you. If anything tries to step outside
> that list, the job **stops** and the whole queue **halts** for you.
> Your tap approves that list — nothing else, ever.

**Before bed:**

1. Click **🌙 Night Queue** (left column). The badge next to it says
   **OFF**.
2. Add each job: pick the type, type the job, click **Add job**.
   - **Chat job** — a question or research task for Muse Spark.
   - **Shell job (exact command)** — type the *exact* command. What you
     type is literally what will run. (You can also give it a working
     folder.)
   - **Dot test job** — describe what Dot should test. Overnight, this
     prepares the test packet into the Outbox (in mock mode it also runs
     the simulated Dot verdicts). A real Dot run still needs ChatGPT in
     the morning — there is no way around that, and the app will not
     pretend otherwise.
3. **Read the full list back.** Every job is numbered. Use **Remove** on
   anything you don't want. Tick **Needs Dot audit** on any job whose
   result Dot should check in the morning.
4. When the list is exactly right, click
   **Approve this queue & run it**.
5. The badge turns **RUNNING**. Leave the app open (the queue runs inside
   the app; closing the app stops the queue) and go to bed.

**What happens overnight:** jobs run top to bottom. Every step is written
to a log as it happens. If a chat job's answer tries to propose extra
desktop steps — things that were **not** on your list — that job is marked
**STOPPED**, the queue halts, and nothing else runs until you look at it.

**The hands guard (new in v0.3):** jobs that *type* — Fill login,
Fill 2FA code — never type over you and never type into a PC you aren't
sitting at:

- If anyone used the mouse or keyboard in the last **30 seconds**
  (**⚙ Settings → Hands idle threshold**), the step **waits**. You'll
  see "⏸ Waiting — you're using the PC" in the queue status and in
  **night-log.md**. It checks again every few seconds.
- If the PC is *still* in use after **30 minutes**
  (**⚙ Settings → Hands max wait**), the step parks as **WAITING_ON_USER**
  with the reason **"user active on the PC"** and the queue moves on.
- If the screen is **locked**, or the PC has been **switched to another
  user** (say Kelly's account), the step parks right away with the reason
  **"session locked or switched away"**. It is *not* marked failed —
  switch back / unlock in the morning and re-run just that job.
- Chat, file and shell jobs (the "brain" jobs) don't type, so the guard
  never pauses them — they run even while the PC is locked or switched.

**New job types (v0.2):** the dropdown also has **Fill login** /
**Fill 2FA code** (job text = a Vault entry label — Section 12f) and
**Wait for me** (job text = the reason a step needs you in person —
Section 12g). Those **Wait for me** jobs park instead of stopping the
queue: everything after them still runs.

**In the morning:**

1. Open the **🌙 Night Queue** panel. Each job shows **DONE**, **STOPPED**,
   **FAILED** or **WAITING_ON_USER**, with a short note. Parked jobs
   appear in the summary under **"Parked — waiting on you"** with their
   reason — do the manual step, then re-run just that job.
2. The full morning summary is saved as a file:
   **Bridge folder → NightRuns → morning-summary-(date).md**, and the
   complete detail is in **NightRuns → night-log.md**.
3. A summary also appears in the chat.
4. **Clear finished** tidies the list when you are done with it.
5. Mid-run, **Stop queue** stops everything after the current job.

## 12. The Vault — save a password once, never type it again

The Vault is why tasks that used to need you sitting there typing a
password can now run while you sleep. You save each login **once**, the
way you would in LastPass. From then on, Muse Bridge fills it for you —
password and 2FA code — in a browser window, on the desktop, wherever
the login form is.

> **Read this first — the one rule of the Vault:** your **master
> password cannot be recovered.** Not by the app, not by Muse, not by
> anyone. If you forget it, everything in the vault is locked forever
> and you start the vault over. Pick something strong that you will
> remember, and consider keeping it on paper somewhere safe at home.

### 12a. Create the vault

1. In the left column, under **Vault**, click **🔐 Open Vault panel**.
2. Type a **Master password** (at least 8 characters — a sentence you
   remember works best), type it again in **Repeat it**.
3. Click **Create vault**. It starts **unlocked**, and the Vault badge in
   the left column says **UNLOCKED**.

### 12b. Add an entry (including the 2FA secret)

1. In the unlocked Vault panel, fill in **Add an entry**:
   - **Label** — the name you will call it: `GitHub`, `Twilio`,
     `ChatGPT`. Muse Spark refers to entries by this label only.
   - **Username** — your usual login name/email.
   - **Password** — the site's password.
   - **Authenticator (TOTP) secret** — optional, see step 2 below.
   - **URL** — optional, for your own reference.
   - **Target window title** — optional but recommended: part of the
     title of the window where the login happens (for a browser tab,
     the page title — e.g. `Sign in` or the site name). This is how the
     app finds the right window to type into.
   - **Notes** — optional, anything for yourself.
2. **To save the 2FA secret:** the next time you set up (or reset)
   two-factor on that site, when it shows a QR code, look for the option
   like **"Can't scan it?"** / **"Enter a setup key"** — the site will
   show a text key (letters and numbers). Paste that key into
   **Authenticator (TOTP) secret**. From then on, Muse Bridge can
   generate and type the same 6-digit codes your authenticator app
   shows. (If the site already has 2FA set up and won't show the key
   again, turn 2FA off and back on once to get a fresh setup key.)
3. Click **Add entry**. The list shows **label + username only** —
   passwords are never displayed in the list.
4. To check or change one later: **Show password** / **Show current
   code** reveal a value for 15 seconds (your explicit click, vault
   unlocked), **Edit** changes fields (leave Password blank to keep the
   saved one), **Delete** removes the entry.

### 12c. Fill a login

1. Open the window with the login form (browser tab, app — whatever it
   is) and click into the **username field**.
2. In chat, say: **"fill the login for GitHub"** (use your entry's
   label). Or in the Vault panel, click **Fill login** on the entry.
3. An approval card appears showing the **entry label, username, and
   target window — never the password.** Click **Approve & run**.
4. The app focuses that window and types username → Tab → password →
   Enter. Keep your hands off the keyboard for those couple of seconds.

### 12d. Fill a 2FA code

1. When the site asks for the 6-digit code, click into the code field.
2. In chat, say: **"enter the authenticator code for GitHub"** — or
   **Fill 2FA code** on the entry in the Vault panel.
3. Approve the card (it shows the entry and window — **never the code**).
   The app works out the current code **at that moment** and types it.

### 12e. Locking

- **🔒 Lock now** in the Vault panel locks it instantly.
- It **auto-locks** after some idle minutes — set how many in
  **⚙ Settings → Vault auto-lock** (default 10; 0 = never — not
  recommended).
- While locked, **nothing can be filled**. A fill step says "Vault
  locked — unlock to fill," and the assistant can't see your entries
  at all (not even their names).

### 12f. The Vault in the Night Queue

1. In the **🌙 Night Queue** panel, the job-type dropdown now has
   **Fill login** and **Fill 2FA code**. For these, the job text is
   just the **entry label** (e.g. `GitHub`), and the second box is the
   window title if you want to override the entry's saved one.
2. Your one **Approve this queue & run it** tap names each entry + site
   — that approval covers exactly those fills, nothing else. The night
   log records only lines like *"Login filled for GitHub"* — never a
   password, never a code.
3. **Before bed, leave the vault unlocked** (and the auto-lock long
   enough) if the queue has fills in it. If the vault is locked when a
   fill comes up, that job **parks as WAITING ON YOU** and the queue
   carries on with the other jobs.

### 12g. "Waiting on you: security key" — what it means

Some sign-ins ask for a **hardware security key** (tap your key) or a
**phone prompt** (tap Yes on your phone). **No software can do those
for you** — that is the entire point of them, and Muse Bridge does not
try to fake them. Instead:

- Add a **Wait for me** job to the queue at that spot (job text = the
  reason, e.g. `Tap the security key for the bank site`), or the app
  declares it when a chat job asks for one.
- Overnight, that job **parks** with status **WAITING_ON_USER** and the
  queue **continues with everything else** — one key tap no longer
  blocks the whole night's work.
- The **morning summary** has a **"Parked — waiting on you"** section
  listing each parked job and its reason. Do the tap, then re-run that
  job.

## 13. Teach mode — show Spark your screen, attach documents

Teach mode lets Muse Spark *see* what you see, and *read* what you
hand it — so you can show it what to click, what to open, and what to
do. It never clicks anything by itself: anything it suggests still
comes back to you as a normal approval card (Section 6).

### 13a. Attach a screenshot or a document

Three ways, all equivalent:

1. **Drag & drop** — drag any file from Explorer or your desktop
   onto the Muse Bridge window. A big dashed **"Drop files to
   attach"** frame appears over the whole window; let go to attach.
   Change your mind mid-drag? Press **Esc** (or drag the file back
   out) and nothing is attached.
2. **Paste** — copy an image (e.g. after **Win+Shift+S**) or copy
   files in Explorer, click into the message box, and press
   **Ctrl+V**.
3. **The 📎 button** — click it and pick one or more files.

Attached files appear as **chips** above the message box: a thumbnail
for images, the file name + size for documents. Click the **×** on a
chip to remove it. Nothing is sent until you press **Send** — and you
can attach several files to one message (up to 6; at most 4 images).

What can be attached:

- **Screenshots** — png, jpeg, or webp images (up to ~8 MB each).
  They are sent with your message in vision format, so Spark can
  describe them, read screens, and advise from them.
- **Text documents** — .txt, .md, .json, .csv, .log, .xml, .html,
  code files (.js, .ts, .py, …), and other plain text (the app
  sniffs the contents when the type is unclear). The document's text
  is included in your message inside a labeled block, up to
  **100 KB per file**; a bigger file is cut at 100 KB and the block
  says so. Your chat bubble just shows a compact "📄 name" line —
  the full text travels with the message, and stays in the chat
  history so follow-up questions can use it.
- **Anything else** (executables, zip files, gif/bmp images, …)
  cannot be read yet: the app refuses it with a status note naming
  the file. Nothing is ever silently dropped.

In **Mock mode** attachments stage exactly the same way; the mock
reply acknowledges them by name and type, and tells you Mock mode
can't actually see or read them.

### 13b. Save a screenshot as a lesson

After sending a message with a screenshot, a **📸 Save as lesson**
form appears under your message. Give it a name (e.g. "Elevate login
screen") and, in your own words, what the shot shows, what to click,
and what to do; optionally add a proposed action mapping ("open
Elevate — fills go in this window"). **Save lesson on this PC**
stores the screenshot + your words **only on this PC** — lessons are
never uploaded anywhere; a lesson's notes ride along as context in
later chats so Spark remembers what you taught it, and its screenshot
is only sent again when you attach it yourself from the **📸 Lessons**
panel (left column), which can also delete lessons.

## 14. Loops — build a workflow once, run it any time

A **Loop** is a workflow you build once, step by step — the same idea
as an n8n workflow, inside the app. Open the **🔁 Loops** panel in the
left column.

### 14a. Build a loop

1. Click **+ New loop**, give it a **name** and a **description** (the
   description heads the loop's document — write what it's *for*).
2. Click **+ Add step**, pick a step type, and fill in its form:
   - **Ask Muse Spark** — a text prompt. The reply becomes the step's
     output. Write `{{prev}}` anywhere in the prompt to insert the
     previous step's output (e.g. "Summarize this: {{prev}}").
   - **Desktop task** — ONE desktop action: open a URL or an app, list
     a folder, create a file, append to a file, or run a command,
     with the exact fields that action needs.
   - **Vault fill** — fill a login or an authenticator code from a
     Vault entry, chosen **by label** (start typing and the app
     suggests your entry labels). The secret never appears here — the
     app fetches it from the vault when the step runs, as always.
   - **Manual step** — instructions for *you*. When the run reaches
     it, the run waits until you tap **Done ✓** (or Skip).
   - **Note** — documentation only. Never runs.
3. Reorder steps with **↑ / ↓**, change a step's type with its
   dropdown, delete with **✕**.
4. Click **Save loop** (or **Create loop**). Loops are stored on this
   PC only.

### 14b. Run a loop

Click **▶ Run** on the loop's card. You get a live checklist — every
step flips from ○ to ▶ to ✓ (or ✗ / ⛔ / ⏸) with its output under it,
plus a run log and **⏸ Pause** / **■ Stop** controls.

The approval rule does not change inside a loop:

- **Desktop task** and **Vault fill** steps show the same approval
  card you'd get in chat (in the run view), with the exact action —
  nothing executes until you **Approve & run** it.
- If you **Deny** a step, or a step fails, the run **halts** and asks:
  **Skip this step & continue**, or **Stop the run**.
- If a step needs you in person (locked vault, locked screen, a
  hardware key), the run ends as **waiting on you** with the reason.
  Handle it and run the loop again.
- A reply from an **Ask Muse Spark** step is only ever text. If it
  proposes desktop actions, the run notes that and does **not** run
  them — inside a loop, only the steps you built can act, each
  through its own approval.

### 14c. Document a loop

Every loop documents itself. Click **📄 Doc** on its card to read it:
the name, your description, and the numbered steps in plain English.
**⬇ Export .md** writes that document into the Bridge **Outbox**
(Section 17), so it can be shared, archived, or handed to Dot/Muse
like any other packet.

### 14d. Run a loop overnight

On the loop's card, **🌙 Add to Night Queue** adds it as a job. When
you approve the queue and it runs (Section 11):

- The queue's one approval covers the loop's task/fill steps (main's
  queue-mode guards still apply — typing steps wait out your idle
  threshold, and park instead of typing over you).
- **Manual steps park the job** as *waiting on you* — a loop that
  needs your hands at 3 AM waits for morning, and the rest of the
  queue keeps going.
- A failed step stops that job (the queue continues), and the morning
  summary reports the loop's step-by-step outcome; the full step log
  is in `night-log.md`.

## 15. Teach from video — an SOP from your recording

You record yourself doing a task on the computer (you use **Vimeo**).
Teach-from-video turns that recording into a written **SOP** —
Standard Operating Procedure: exactly what to click, open, and do,
step by step — and then, if you want, into a **Loop**.

Open **📸 Lessons & SOPs** (left column). The **🎬 Teach from video**
box is at the top.

### 15a. Add a recording

Two ways:

1. **Vimeo link** — paste the video's `vimeo.com/…` link and click
   **Add Vimeo link**. The app saves the link + its public title,
   thumbnail, and length.
2. **Video file** — click **🎬 Choose a video file…**, or just drop
   the file anywhere in the app window. mp4, webm, or mov, up to
   **500 MB**. The file is *streamed* into the app's data folder (it
   is never loaded whole into memory).

Either way you get a card in the **📋 SOPs from video** list.

**What a link alone can and cannot do — plainly:** a link gives the
app the title and thumbnail, *not* the recording. To analyze the
recording itself from a link, the app needs the captions and/or a
downloadable file from Vimeo's API, and that needs **your Vimeo
access token**: **⚙ Settings → Vimeo access token** → paste → Save.
(It's stored encrypted on this PC, like your API key, and sent only
to Vimeo.) With a token, adding a link also fetches the captions and
— when the video's owner has downloads enabled — the file itself.
Without a token, add the video file (or a transcript file, next
section) — the card will tell you exactly what's missing, and the app
will **never** invent an SOP from a thumbnail.

### 15b. Generate the SOP

Click **✨ Generate SOP** on the card. The app:

1. Samples frames from the recording — first frame, then every ~5
   seconds, plus the last moment (at most 24 frames).
2. Collects the transcript: Vimeo captions when a token fetched them,
   or a transcript file you add with **📝 Add transcript file**
   (.txt, .md, or .vtt). No transcript? The SOP is still written from
   the frames, and it is **labeled** *"from video frames only (no
   narration transcript)"* — on the card, in the export, everywhere.
3. Asks Muse Spark to write the SOP in a fixed structure: **Goal**,
   **What you need first**, numbered **Steps** (the exact action,
   where/what exactly, the expected result), and **Watch-outs**.

In **Mock mode** you get a clearly-labeled placeholder SOP built from
your transcript sentences — useful for trying the flow, not a real
analysis.

**📄 View SOP** reads it in place; **⬇ Export .md** writes it to the
Bridge Outbox.

### 15c. Turn the SOP into a Loop

Click **🔁 Turn into a Loop** on a generated SOP. The app builds a
**draft Loop** and opens it in the Loop builder (Section 14):

- "What you need first" becomes a **Note** step at the top;
  "Watch-outs" become a **Note** at the bottom.
- Each SOP step becomes a **Manual step** with its text (including the
  expected result) preserved word for word — *except* a step that
  unambiguously says **open <a URL>** or **create a file named X**:
  those are pre-typed as **Desktop task** steps and flagged
  **⚠ auto-converted — review**.
- Review every step, convert or edit whatever you like, then **Save
  loop**. The draft is **never auto-run** — it runs only when you run
  it, under the normal approval rules.

## 16. 🎙 Transcripts — speech-to-text on your own PC (and the 🐍 Python card)

**What it is, in one sentence:** the app can now turn recordings —
audio files and the sound inside videos — into text, entirely on
your own PC: no AI tokens, nothing uploaded, works offline.

### Transcribe something

1. In chat, attach a recording with the 📎 button (audio:
   mp3/wav/m4a/ogg/flac/webm; video: mp4/webm/mov/mkv).
2. The file appears as a chip with a **🎙** button. Tap it.
3. The app transcribes on this PC. Long recordings go in 5-minute
   parts — the chip shows "part x of y — covered 47:10 of 62:10" so
   you can watch it march to the end. **⏹** cancels; parts already
   finished stay saved in the library (see below).
4. When it finishes, the chip becomes **"<name> — transcript"**, a
   document you can send with your next message, exactly like an
   attached document. The transcript is ALSO saved in the library
   automatically.

The first time, the app needs its **speech model** — one download,
then never again. If no model is downloaded yet, the chip offers
**⬇** and the Transcripts panel explains the choice:

- **Fast (base, ~150 MB)** — short clips, voice notes, quick checks.
- **Meeting quality (large-v3-turbo, ~1.6 GB)** — **recommended for
  meetings** and anything long. It hears the whole meeting far more
  completely. (A middle "Balanced (small, ~490 MB)" option exists
  too.)

Every download is **verified** against the model's known fingerprint
before it is trusted; a download that fails the check is deleted, and
a half-finished download is never treated as complete. In
**Settings → Transcription** you can switch models and set the
language: **Auto-detect** (default), English, or Spanish — the models
understand both. Note: transcripts have **no speaker labels** — the
engine hears words, not who said them, and the app will never fake
names. Each 5-minute part carries its timestamp instead.

### Nothing half-done, ever

Every transcript states its coverage at the top:
**"Transcribed 62:10 of 62:10"**. If a part fails, the transcript is
labeled **PARTIAL**, names the exact missing ranges ("missing
20:00–25:00", also shown as a gap line inside the text), and the
library card offers **↻ Retry missing parts** — which re-runs ONLY
the gaps. If the app closes mid-meeting, the partial transcript is
still in the library when you come back, ready to resume.

### The Transcripts library

Open **📸 Lessons & SOPs** — the **🎙 Transcripts** section sits
under the video SOPs. Each card shows the coverage, where the
recording came from, the model used, the language heard, and the
word count, with **📄 View transcript**, **Copy**, **⬇ Export .txt**
(to the Bridge Outbox), **↻ Retry missing parts** when needed, and
**Delete**. Transcripts are data on your PC only — they leave the
machine only inside a message you send or a file you export.

### Teach from video hears the words now

When you click **📝 Generate SOP** on a recording (Section 15), the
app first transcribes its narration on this PC, so the SOP is built
from the frames AND what was said. Recordings longer than ~15
minutes use the Meeting quality model automatically when it is
downloaded. The old "from video frames only" label now appears only
for recordings that truly have no audio; a silent recording says
"no speech detected"; and if transcription itself cannot run, the
SOP is NOT generated — you get the plain reason and a fix, never a
mislabeled SOP.

### If transcription "only errors" — the setup check

The Transcripts section opens with a **Transcription setup** box
that proves everything with real runs: engine files present (the app
bundles its own Microsoft runtime DLLs privately — no system install,
no admin prompts), ffmpeg starts, the whisper engine starts, the
model is present and verified, working space is writable, and disk
space is sane. A failed check explains itself in plain words and
offers its **Fix**: download/re-download the model, or **🔧 Repair
engine files** (the app restores its own bundled copies). As a last
resort it can offer Microsoft's official VC++ runtime install —
through a normal approval card, never silently. The raw technical
detail is under each check's **details** button. And to be clear:
transcription needs **no Python, no pip, no other installers** —
after the one-time model download it needs nothing else at all.

### The 🐍 Python card (Settings)

Separately, **Settings → 🐍 Python** shows whether Python is
installed on the PC (and its version). **Install Python** does not
install anything by itself: it builds the exact install (winget if
available, otherwise the official python.org per-user installer) and
puts it on a standard **approval card** showing the exact commands —
nothing runs until you approve it. If Windows shows a UAC/admin
prompt during the install, that click is yours; the card says so up
front. After installing, **Re-check** confirms the version the app
can see. (One-click install is Windows-only in this version.)

## 17. ✉️ Ask Muse — asking for features from inside the app

You don't have to open the Muse chat to ask for something. The
**✉️ Ask Muse** panel (left column) takes the request right here:
you type it, the app sends it to Muse, Muse does the work, and
the result comes back — as an app update, an answer, or a note about
where the result lives.

### 16a. One-time setup: the GitHub token

Sending rides on the private GitHub repo, so the app needs a token
that can write to exactly that repo and nothing else. You create it
once, on the GitHub website:

1. Go to **github.com** and sign in.
2. Click your **profile picture** (top right) → **Settings**.
3. In the left column, scroll to the bottom: **Developer settings**.
4. **Personal access tokens** → **Fine-grained tokens** →
   **Generate new token**.
5. Give it a name (e.g. `Muse Bridge — Ask Muse`) and an expiration
   you are comfortable with.
6. **Repository access** → **Only select repositories** → select
   **mikebestoption-Muse-Bridge** (just that one).
7. **Permissions** → **Repository permissions** → **Contents** →
   **Read and write**. (Leave everything else alone.)
8. **Generate token**, then copy it — GitHub shows it once.
9. Back in Muse Bridge: **⚙ Settings → GitHub token (for Ask
   Muse)** → paste → **Save**.

The token is stored encrypted on this PC, exactly like your Meta API
key — never logged, never shown again, and the app uses it for
nothing except the `requests/` folder of that one repo. Do the same
on your other PC with its own token if you want to send from there
too (tokens are per-PC; requests and statuses sync through the repo
either way).

### 16b. Send a request

1. Open **✉️ Ask Muse**.
2. Pick the kind: **App feature** (a change to Muse Bridge),
   **New skill**, **Task for Muse** (work that isn't an app
   change), or **Question**.
3. Type it in plain words — *"hey, I want you to do such and such"*
   is exactly the right register. The first line becomes the
   request's title, so make it a good summary.
4. Click **✉️ Send to Muse**.

The request lands in the repo as `requests/REQ-<date>-<time>-<title>.md`
— your words verbatim, with a small header (when, from which PC,
which app version, which type).

### 16c. Watch it move

Every request shows a status chip:

- **Sent to Muse** — filed in the repo, not yet picked up.
- **Seen by Muse** — Muse's side has it and has logged it.
- **Muse is building it** — work is actively in progress.
- **Shipped in vX.Y.Z** — done, and live in that release. Your app
  will offer the update itself (Settings → Updates, or on its next
  launch) — the loop closes on its own.
- **Answered** — for questions (and tasks that don't change the
  app). The card shows the answer, or where it was answered
  ("answered in your Muse chat").

Click **↻ Refresh statuses** (or just reopen the panel) to pull the
latest states. Requests sent from your other PC show up here too.
If GitHub is unreachable, the panel shows the **last check** and says
so — it never pretends the list is empty or broken.

### 16d. No token yet? Drafts, honestly

If you haven't saved a GitHub token, **Send** does **not** pretend:
the request is saved as a **draft on this PC** with the note *"Add
your GitHub token in Settings to send this to Muse"*, plus a
**Copy request text** button so you can paste it anywhere yourself.
Once the token is saved, the draft's **✉️ Send now** button files it
for real. If a send fails mid-flight (connection drops), the request
stays as a **Send failed — retry** draft; retrying first checks
whether the file already landed, so you never file a duplicate.

The full contract between the app and Muse's side — file formats,
status vocabulary, who writes what — lives in
`docs/REQUESTS-PROTOCOL.md` in the repo.

## 18. Where everything lives — the Bridge folder and logs

By default the Bridge folder is in your **Documents**:

```
Documents\MuseBridge\
  Inbox\        ← files FROM ChatGPT/Dot go here (click in the app to import)
  Outbox\       ← packets FOR ChatGPT / Muse land here
  NightRuns\    ← night-log.md and morning-summary files
  test-log.md   ← every Dot verdict ever logged
```

1. Click **Open Bridge folder** (left column) to jump straight there.
2. To move the Bridge folder somewhere else: **⚙ Settings → Change…**
   next to the Bridge folder path, pick the new home, **Save**.

Your chat history, settings, terminals and queues live in the app's own
data folder on your PC (Windows keeps it under your user AppData). Your
API key lives there too — encrypted by Windows, as Section 4 explains.
So does the Vault file (`vault.json`) — a single blob encrypted with
your master password, as Section 12 explains. It is never uploaded
anywhere and never included in the code repo.
So do your **Loops** (`loops.json`), your **SOPs** (`sops.json`), and
any staged video files (`video-temp\`) — all local, all yours.
So is `requests-local.json` — your Ask Muse drafts and the cached
status list (the sent requests themselves live in the private repo's
`requests\` folder, Section 16).
Nothing in this app is uploaded anywhere except your chat messages going
to Meta when you are in live mode.

## 19. Troubleshooting

**"It says Mock mode / my answers start with [Mock mode…]"**
You have not added an API key yet, or it was removed. **⚙ Settings** →
paste the key from dev.meta.ai → **Save**. The banner turns green.

**"I pasted a key but it still isn't live"**
Check for extra spaces at the start/end of the paste, and that you clicked
**Save**. If Meta rejects the key, chat answers will show Meta's error
message — get a fresh key at dev.meta.ai and paste the new one in
(replacing the old one), then **Save**.

**"Import from clipboard says the clipboard is empty"**
Copy the text again in ChatGPT (select it, **Ctrl+C**) and click the
button right after — copying anything else in between replaces it.

**"The copy/paste step focused the wrong window"**
The automatic clipboard steps find windows by their **title**. Make sure
the ChatGPT window is open and its title actually contains "ChatGPT",
close extra windows with similar titles, then re-approve the step. Or use
the manual **⬇ Import from clipboard** / **⬆ Copy for ChatGPT** buttons —
they always work.

**"A task card is showing a command I don't understand"**
Click **Deny**. Always. Then ask in chat: "explain that step in plain
words first." A step you don't understand is a step that doesn't run.

**"Transcription says it is not ready / a setup check has a ✗"**
Open **📸 Lessons & SOPs → 🎙 Transcripts**. The **Transcription
setup** box names the problem in plain words — usually the speech
model has not been downloaded yet (**⬇ Download** on the model row),
or the engine files need their **🔧 Repair** button. Transcription
never needs Python or any other program installed; if it still fails
after the Fix, open the check's **details** and send that text to
Muse.

**"My transcript says PARTIAL / a meeting did not fully transcribe"**
Nothing was lost quietly: the header names the exact missing ranges.
On the transcript's card in the **🎙 Transcripts** library, click
**↻ Retry missing parts** — only the gaps re-run. For long meetings,
also make sure the **Meeting quality** model is downloaded and
selected (Section 16) — it drops far fewer words than Fast.

**"Creating a file failed: 'EPERM: operation not permitted, mkdir C:\Users\<you>'"**
That was a v0.3.0 bug — Spark guessed your Windows profile path, and the
app then tripped over the profile folder itself while creating the file.
**Fixed in v0.3.1:** update to `MuseBridge-0.3.1-setup.exe` (install it
over the top — your key and Vault carry over), then ask for the same file
again. The approval card now shows your **real** Desktop path from
Windows (even if your Desktop is redirected to OneDrive), and approving
it creates the file.

**"Settings is cut off — I can't scroll it and can't reach Save"**
That was a v0.3.1-and-earlier bug on smaller screens (or with Windows
display scaling turned up): the Settings window was taller than the
screen, clipped at the top and bottom, with no scrollbar, so the fields
and the Save button at the bottom were unreachable. **Fixed in v0.3.2:**
update to `MuseBridge-0.3.2-setup.exe` (install over the top — your key
and Vault carry over). Settings — and the Vault, Terminals, Night Queue
and Audits panels too — now scroll in the middle, with the title and the
Save/Approve/Close buttons always visible. *Interim workaround on an
older build:* with Settings open, press **Ctrl+−** (Ctrl and the minus
key) a few times to zoom the app out until Save appears, then **Ctrl+0**
to reset the zoom afterwards.

**"Will it take over my browser while I'm working on it?"**
No — that's exactly what the v0.3 hands guard prevents. Steps that type
(paste to ChatGPT, fill a login, fill a 2FA code) first check that you've
been hands-off. On an approval card you'll see a short countdown —
**"Will type in 3… 2… 1…"** — and if you start typing yourself, the
countdown starts over. The Deny button becomes **Stop** during the
countdown; click it and nothing is typed. In the Night Queue, a typing
step waits until you've been idle for **⚙ Settings → Hands idle
threshold** seconds (default 30), and parks instead of typing if you're
still busy after **⚙ Settings → Hands max wait** minutes (default 30).
Chatting, reading files and everything else that doesn't type never
waits at all.

**"What happens if someone else uses the PC, or I lock the screen?"**
Locking the screen (or switching to another Windows user, like Kelly's
account, with **Switch user** — not Sign out) keeps the app running in
the background: chat/file jobs in the Night Queue keep going. Typing
steps can't see a screen to type into, so they park as **WAITING_ON_USER**
with the reason **"session"** — shown in full as *"session locked or
switched away"*. Nothing is marked failed and nothing is typed blind.
When you're back, re-run the parked jobs. One warning: if the other
person **signs your account out** instead of switching, the app closes
like any program and everything stops until you log in and reopen it.

**"A fill says Vault locked"**
Unlock the vault in the **🔐 Vault panel** with your master password,
then approve the step again. If fills keep hitting a locked vault at
night, lengthen **⚙ Settings → Vault auto-lock** — but remember a longer
window is a wider window; keep it as short as your queue allows.

**"I forgot my master password"**
There is no recovery — by design, nobody can open that vault, including
you. Delete the app's `vault.json` file (in the app's data folder) to
start a fresh vault, and re-add your entries. Your chats, settings and
Bridge files are untouched.

**"The fill typed into the wrong window / nothing happened"**
Fills find windows by **title**. Set the entry's **Target window title**
to distinctive text from that window's title bar/tab, make sure only one
window matches, click into the username field first, and keep other
windows with similar titles closed. A few hardened apps (some banking
apps) block typed-in keystrokes from software entirely — those logins
stay manual.

**"The 2FA code was rejected"**
Codes live for 30 seconds — if the app typed right at the changeover,
just run **Fill 2FA code** again. If it keeps failing, the secret key
saved on the entry may not match the site: redo the site's 2FA setup
(Section 12b, step 2) and update the entry. Also check your PC clock is
set automatically — TOTP codes depend on accurate time.

**"A Night Queue job says STOPPED"**
That is the safety system working: the job tried to go outside what you
approved. Read its note in the Night panel and in **night-log.md**. If
you want the extra work done, add it as a new job and approve the queue
again.

**"A terminal is stuck on AWAITING"**
It is holding a shell job for your approval. Open **🖥 Terminals**, find
the session, read the exact command on its card, then **Approve & run**
or **Skip**.

**"The app won't open / Windows blocked it"**
Unsigned version: on the blue screen click **More info** →
**Run anyway**. If it still won't open, use the zip version (Section 1,
Option C).

**"I want to start completely over"**
**+ New chat** clears the conversation. To remove the key, use
**⚙ Settings → Remove key**. Your Bridge folder files (packets, logs,
summaries) stay on disk until you delete them yourself in File Explorer.

**"I dropped a file and the app said it can't be read"**
Only png/jpeg/webp images and plain-text documents can be attached
(Section 13a). Executables, zip files, and other image formats are
refused — by design, with the file named in the status line so you
know exactly which one. Convert or screenshot the content instead:
a screenshot of a document page attaches as an image just fine.

**"My document attached but Spark only saw part of it"**
Text documents are included up to **100 KB per file**. A bigger file
is cut at 100 KB, and the block in your message says so — split the
file, or attach just the part you want Spark to read.

---

*Muse Bridge v0.3 — the "never fight the user" release (on top of v0.2's
Vault). Live Muse Spark chat, the approval gate, terminals, the Night
Queue, vault encryption, TOTP codes (RFC test vectors), the guarantee
that passwords/codes never appear in cards, history, packets or logs,
and the v0.3 hands guards (idle + locked/switched-session detection,
unit-tested with simulated probes) were verified on the build machine
(headless tests + mock mode); the Windows SendKeys typing — logins,
codes, and the copy/paste steps — the Windows guard probes on a real
session (including switching to a second user account), and the portable
.exe get their first live run on your PC.*

**"Generate SOP is greyed out on my Vimeo link"**
The link alone gives the app the video's title and thumbnail — not the
recording. Add one of these, then the button enables: the **video file
itself** (drop it in, or pick it with 🎬), a **Vimeo access token**
(⚙ Settings — then re-add the link so captions + the file are
fetched), or a **transcript file** (📝 Add transcript file on the
card). The app will not fake an SOP from a thumbnail.

**"My SOP says 'from video frames only (no narration transcript)'"**
That recording had no captions the app could read and no transcript
file was added, so the SOP was written from the sampled frames alone.
For a fuller SOP, add the transcript (📝 button on the card — .txt,
.md, or .vtt) or save a Vimeo token in Settings so captions are
fetched automatically, then click **✨ Regenerate SOP**.

**"A loop run stopped at a step and is asking me to Skip or Stop"**
That's the approval system working: the step was denied or failed, so
the run halted instead of guessing. Read the step's output in the
checklist — **Skip this step & continue** keeps the step's
denied/failed mark and moves on; **Stop the run** ends it there.
Nothing after a denied step ran without you seeing it.

**"My loop's Night Queue job parked as 'waiting on you'"**
The loop reached a **Manual step** (or a fill against a locked vault,
or a typing step while the screen was locked) — something only you can
do. Do that step yourself in the morning, then run the loop from the
🔁 Loops panel to finish it interactively.

**"My Ask Muse request sits at 'Sent to Muse' and never moves"**
Statuses move when Muse's side picks the request up — the watcher
polls the repo regularly and the nightly 2:30 AM summary sweeps it
too. If it has been a full day, check that the request really sent
(a **Draft** or **Send failed** chip means it never left this PC —
save the GitHub token in ⚙ Settings, then use the request's
**✉️ Send now** / **↻ Retry send** button), and that the token
hasn't expired on GitHub (fine-grained tokens show their expiration
under github.com → Settings → Developer settings; generate a fresh
one and paste it over the old if it lapsed).

**"Ask Muse says it's offline / showing the last check"**
The panel could not reach GitHub at the last refresh — your requests
are safe (they're either already in the repo or saved as drafts here).
Check the PC's connection, then **↻ Refresh statuses**.
