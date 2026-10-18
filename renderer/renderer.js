'use strict';

/* Muse Bridge — renderer.
 * Talks to the main process only through window.desktop (preload).
 * It can PROPOSE task steps (from assistant replies) but can never run one
 * itself: execution happens in main, only after an Approve click here —
 * or, in Night Queue mode, only for jobs approved by name in the queue. */

const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  status: document.getElementById('status-line'),
  modeBanner: document.getElementById('mode-banner'),
  bridgePath: document.getElementById('bridge-path'),
  settingsBridgePath: document.getElementById('settings-bridge-path'),
  inboxList: document.getElementById('inbox-list'),
  modal: document.getElementById('settings-modal'),
  apiKey: document.getElementById('api-key'),
  keyNote: document.getElementById('key-note'),
  model: document.getElementById('model'),
  dotModal: document.getElementById('dot-modal'),
  dotWhat: document.getElementById('dot-what'),
  terminalsPanel: document.getElementById('terminals-panel'),
  terminalsList: document.getElementById('terminals-list'),
  nightPanel: document.getElementById('night-panel'),
  nightJobs: document.getElementById('night-jobs'),
  nightStatus: document.getElementById('night-status'),
  nightSummary: document.getElementById('night-summary'),
  nightBadge: document.getElementById('night-badge'),
  vaultPanel: document.getElementById('vault-panel'),
  vaultBody: document.getElementById('vault-body'),
  vaultBadge: document.getElementById('vault-badge')
};

let messages = []; // [{ role: 'user'|'assistant', content: string }]
let settings = null;
let sending = false;
let lastDotWhat = '';

// ---------- hands guard status ----------
// Typing ("hands") steps are guarded in main: before typing, main may wait
// (you're using the PC / interactive countdown) and reports progress per
// execution id. Whoever started the execution registers a handler here.
const HANDS_TYPES = ['paste_to_app', 'copy_from_app', 'fill_login', 'fill_totp'];
const handsStatusHandlers = new Map();
if (window.desktop.onHandsStatus) {
  window.desktop.onHandsStatus((payload) => {
    const handler = handsStatusHandlers.get(payload.execId);
    if (handler) handler(payload);
  });
}

// ---------- small helpers ----------

function setStatus(text) {
  els.status.textContent = text || '';
}

// Renders text with **bold** support, using DOM nodes only (no innerHTML).
function renderRich(container, text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      container.appendChild(strong);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  }
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function persist() {
  try { await window.desktop.saveHistory(messages); } catch (_) { /* non-fatal */ }
}

function conversationMarkdown() {
  return messages.map((m) => `### ${m.role === 'user' ? 'Michael' : 'Muse Spark'}\n\n${m.content}`).join('\n\n');
}

// ---------- message rendering ----------

function addMessageToDom(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (role !== 'system') {
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? 'You' : 'Muse Spark';
    wrap.appendChild(who);
  }
  const body = document.createElement('div');
  body.className = 'body';
  renderRich(body, content);
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

async function addSystemMessage(content) {
  messages.push({ role: 'assistant', content });
  addMessageToDom('system', content);
  await persist();
}

function showWelcomeIfEmpty() {
  if (messages.length) return;
  const div = document.createElement('div');
  div.className = 'welcome';
  const h = document.createElement('h1');
  h.textContent = 'Chat with Muse Spark. Get things done on this PC.';
  div.appendChild(h);
  const p = document.createElement('div');
  p.textContent =
    'Ask a question, ask me to do something on your desktop (I will always show you the exact step and wait for your approval), ' +
    'or import a ChatGPT result — clipboard or Bridge Inbox — and I will review it.';
  div.appendChild(p);
  els.messages.appendChild(div);
}

function renderAll() {
  els.messages.innerHTML = '';
  showWelcomeIfEmpty();
  for (const m of messages) addMessageToDom(m.role, m.content);
}

// ---------- actions (approval gate) ----------

function parseActions(text) {
  const match = String(text).match(/```actions\s*([\s\S]*?)```/);
  if (!match) return { text, actions: [] };
  let actions = [];
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed)) actions = parsed;
  } catch (_) { return { text, actions: [] }; }
  return { text: text.replace(match[0], '').trim(), actions };
}

function describeForCard(action) {
  const label = action.label || action.type;
  // Vault fills: the card shows label + username + target window, and states
  // plainly that the secret itself is never shown — because it is never here.
  if (action.type === 'fill_login' || action.type === 'fill_totp') {
    const entry = (vaultState.entries || []).find(
      (e) => e.label.toLowerCase() === String(action.entryLabel || '').toLowerCase()
    );
    const lines = [
      `Vault entry: ${action.entryLabel}`,
      `Username: ${entry ? entry.username : '(from the vault entry)'}`,
      `Target window: ${action.targetWindowTitle || (entry && entry.targetTitle) || '(the entry\'s saved window)'}`,
      action.type === 'fill_login'
        ? 'Password: •••••••• — typed by the app straight from the vault. It is never displayed, logged, or sent to the model.'
        : 'Authenticator code: •••••• — generated by the app at run time from the vault. It is never displayed here or logged.'
    ];
    return { label, detail: lines.join('\n') };
  }
  if (action.type === 'wait_for_user') {
    return { label, detail: `This step needs you in person: ${action.reason || 'user action needed'}` };
  }
  const detail = { ...action };
  delete detail.label;
  return { label, detail: JSON.stringify(detail, null, 2) };
}

function addTaskCard(action) {
  const card = document.createElement('div');
  card.className = 'task-card';
  const { label, detail } = describeForCard(action);

  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = `⚠ Approval needed — ${label}`;
  card.appendChild(title);

  const pre = document.createElement('div');
  pre.className = 'task-detail';
  pre.textContent = detail;
  card.appendChild(pre);

  const row = document.createElement('div');
  row.className = 'row';
  const approve = document.createElement('button');
  approve.className = 'approve';
  approve.textContent = 'Approve & run';
  const deny = document.createElement('button');
  deny.className = 'deny';
  deny.textContent = 'Deny';
  row.appendChild(approve);
  row.appendChild(deny);
  card.appendChild(row);

  const result = document.createElement('div');
  result.className = 'task-result';
  card.appendChild(result);

  // Card lifecycle: 'pending' → 'running' → 'done'. For HANDS steps the
  // Deny button stays alive during the run as a Stop button: it cancels the
  // guard's countdown/wait in main, and nothing gets typed.
  let cardState = 'pending';
  let currentExecId = null;
  const isHands = HANDS_TYPES.includes(action.type);

  approve.addEventListener('click', async () => {
    if (cardState !== 'pending') return;
    cardState = 'running';
    approve.disabled = true;
    currentExecId = newId();
    if (isHands) {
      deny.textContent = 'Stop';
      result.textContent = 'Getting ready to type…';
      handsStatusHandlers.set(currentExecId, (status) => {
        if (cardState !== 'running') return;
        if (status.kind === 'countdown') {
          result.textContent = `✋ Will type in ${status.remainingSec}… hands off the mouse and keyboard — or click Stop to cancel. (If you type, the countdown starts over.)`;
        }
      });
    } else {
      deny.disabled = true;
      result.textContent = 'Running…';
    }
    try {
      const res = await window.desktop.executeTask(action, { mode: 'interactive', execId: currentExecId });
      cardState = 'done';
      card.classList.add('done');
      deny.disabled = true;
      result.textContent = res.cancelled
        ? `✋ ${res.output}`
        : res.ok ? `✓ Done. ${res.output}` : `✗ Failed. ${res.output}`;
      messages.push({
        role: 'assistant',
        content: `[Task result] ${res.summary}: ${res.ok ? 'OK' : res.cancelled ? 'CANCELLED' : 'FAILED'} — ${res.output}`
      });
      await persist();
    } catch (err) {
      cardState = 'done';
      result.textContent = `✗ Error: ${err.message}`;
    } finally {
      if (currentExecId) handsStatusHandlers.delete(currentExecId);
    }
    scrollToBottom();
  });

  deny.addEventListener('click', async () => {
    if (cardState === 'running') {
      // Stop during a hands countdown/wait: cancel in main. The execution
      // promise resolves as cancelled and the approve handler finishes the
      // card — nothing is typed.
      deny.disabled = true;
      result.textContent = 'Stopping…';
      try { await window.desktop.cancelTask(currentExecId); } catch (_) { /* non-fatal */ }
      return;
    }
    if (cardState !== 'pending') return;
    cardState = 'done';
    approve.disabled = true;
    deny.disabled = true;
    card.classList.add('done');
    result.textContent = 'Denied — nothing was run.';
    messages.push({ role: 'assistant', content: `[Task denied by user] ${label} — nothing was run.` });
    await persist();
    scrollToBottom();
  });

  els.messages.appendChild(card);
  scrollToBottom();
}

// ---------- chat ----------

// Teach mode: at most one pending screenshot attachment for the next
// message. { dataUrl, name } — the data URL lives only in this session's
// memory and in a lesson IF the user explicitly saves it as one; chat
// history stays text-only.
let pendingAttachment = null;

function showAttachmentChip() {
  const chip = document.getElementById('attachment-chip');
  if (!chip) return;
  if (!pendingAttachment) {
    chip.classList.add('hidden');
    return;
  }
  document.getElementById('attachment-thumb').src = pendingAttachment.dataUrl;
  document.getElementById('attachment-name').textContent = pendingAttachment.name || 'screenshot';
  chip.classList.remove('hidden');
}

function setPendingAttachment(attachment) {
  pendingAttachment = attachment;
  showAttachmentChip();
}

// Read an image File/Blob into a validated pending attachment.
function readImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type || '')) {
    setStatus('That file is not a png, jpeg, or webp image — screenshots must be one of those.');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    setStatus('That image is over ~8 MB — take a smaller screenshot and try again.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    setPendingAttachment({ dataUrl: String(reader.result), name: file.name || 'pasted screenshot' });
    setStatus('Screenshot attached — it will be sent with your next message.');
  };
  reader.onerror = () => setStatus('Could not read that image file.');
  reader.readAsDataURL(file);
}

// "Save as lesson" inline form under a screenshot exchange. The image is
// stored locally in userData only when Save is clicked.
function addLessonSaveForm(wrap, attachment) {
  const box = document.createElement('div');
  box.className = 'lesson-save';
  const openBtn = document.createElement('button');
  openBtn.className = 'mini-btn large';
  openBtn.textContent = '📸 Save as lesson';
  box.appendChild(openBtn);
  openBtn.addEventListener('click', () => {
    openBtn.remove();
    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'Lesson name — e.g. Elevate login screen';
    name.className = 'lesson-field';
    const note = document.createElement('textarea');
    note.rows = 2;
    note.placeholder = 'Your words: what this shot shows, what to click, what to do';
    note.className = 'lesson-field';
    const mapping = document.createElement('input');
    mapping.type = 'text';
    mapping.placeholder = 'Proposed action mapping (optional) — e.g. open Elevate, fills go in this window';
    mapping.className = 'lesson-field';
    const save = document.createElement('button');
    save.className = 'mini-btn large';
    save.textContent = 'Save lesson on this PC';
    save.addEventListener('click', async () => {
      if (!name.value.trim()) {
        setStatus('Give the lesson a name first.');
        name.focus();
        return;
      }
      const res = await window.desktop.lessonsAdd({
        name: name.value.trim(),
        note: note.value,
        actionMapping: mapping.value,
        imageDataUrl: attachment.dataUrl
      });
      if (res && res.ok) {
        box.textContent = `📸 Lesson saved: ${res.lesson.name} (stored only on this PC)`;
        setStatus('Lesson saved — its notes will ride along as context in later chats.');
      } else {
        setStatus(`Could not save the lesson: ${res && res.error ? res.error : 'unknown error'}`);
      }
    });
    box.append(name, note, mapping, save);
  });
  wrap.appendChild(box);
}

async function sendUserText(text) {
  let trimmed = (text || '').trim();
  const attachment = pendingAttachment;
  if (!trimmed && attachment) trimmed = 'What do you see in this screenshot?';
  if (!trimmed || sending) return;
  sending = true;
  els.send.disabled = true;
  if (attachment) setPendingAttachment(null);

  // History stays text-only: the stored user message notes the screenshot
  // but never carries image bytes. The image itself is sent only on the
  // live API call below (and kept in this session for Save-as-lesson).
  const storedContent = attachment ? `${trimmed}\n\n[📸 screenshot attached: ${attachment.name || 'screenshot'}]` : trimmed;
  messages.push({ role: 'user', content: storedContent });
  const userWrap = addMessageToDom('user', storedContent);
  if (attachment) {
    const img = document.createElement('img');
    img.className = 'msg-shot';
    img.alt = 'Screenshot sent with this message';
    img.src = attachment.dataUrl;
    userWrap.appendChild(img);
  }
  await persist();
  setStatus('Muse Spark is thinking…');

  try {
    const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
    if (attachment) {
      // Attach the image to the last user message for this call only.
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (apiMessages[i].role === 'user') {
          apiMessages[i] = { ...apiMessages[i], imageDataUrl: attachment.dataUrl };
          break;
        }
      }
    }
    // Teach context: saved lesson notes ride along (text only, most
    // recent lessons), the same pattern as the vault planning context.
    // NOT saved to history.
    try {
      const lessonContext = await window.desktop.lessonsContext();
      if (lessonContext) {
        apiMessages.unshift({
          role: 'user',
          content: `[Teach lessons — reference context, not from Michael's current message]\n${lessonContext}`
        });
      }
    } catch (_) { /* lessons unavailable — chat still works */ }
    // Planning context: the model may reference vault entries BY LABEL in
    // fill_login / fill_totp proposals. Labels + usernames only — secrets
    // are unreachable from here by design. This note is NOT saved to history.
    try {
      const planning = await window.desktop.vaultListForPlanning();
      if (planning && planning.length) {
        apiMessages.unshift({
          role: 'user',
          content:
            '[Planning context — not from Michael] The vault on this PC has these entries ' +
            '(label / username): ' + planning.map((p) => `${p.label} / ${p.username}`).join('; ') +
            '. To use one, propose a fill_login or fill_totp action with entryLabel set to the label. ' +
            'You do not know and must never ask for, guess, or repeat any password or code.'
        });
      }
    } catch (_) { /* vault unavailable — chat still works */ }
    const res = await window.desktop.sendChat(apiMessages);
    const { text: cleanText, actions } = parseActions(res.reply || '');
    messages.push({ role: 'assistant', content: cleanText });
    addMessageToDom('assistant', cleanText);
    await persist();
    if (attachment) addLessonSaveForm(userWrap, attachment);
    for (const action of actions) {
      // Resolve paths in main against the real OS folders first, so the
      // approval card shows the exact path that will run — the model may
      // have guessed a profile path that isn't this machine's.
      let cardAction = action;
      try { cardAction = await window.desktop.resolveTask(action); } catch (_) { /* keep raw */ }
      addTaskCard(cardAction);
    }
    setStatus(res.mode === 'mock' ? 'Mock mode — add your API key in Settings for live Muse Spark.' : '');
  } catch (err) {
    addMessageToDom('system', `Something went wrong: ${err.message}`);
    setStatus('');
  } finally {
    sending = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

// One bare chat call (used by terminals + night queue). Returns parsed reply.
async function bareChat(prompt) {
  const res = await window.desktop.sendChat([{ role: 'user', content: prompt }]);
  return { ...parseActions(res.reply || ''), mode: res.mode };
}

// ---------- Bridge: inbox / import ----------

async function refreshInbox() {
  els.inboxList.innerHTML = '';
  try {
    const files = await window.desktop.listInbox();
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'inbox-empty';
      empty.textContent = 'Inbox is empty.';
      els.inboxList.appendChild(empty);
      return;
    }
    for (const f of files) {
      const item = document.createElement('div');
      item.className = 'inbox-item';
      const name = document.createElement('div');
      name.textContent = `📄 ${f.name}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${Math.max(1, Math.round(f.size / 1024))} KB · ${new Date(f.modified).toLocaleString()}`;
      item.appendChild(name);
      item.appendChild(meta);
      item.title = 'Import into chat';
      item.addEventListener('click', () => importInboxFile(f.name));
      els.inboxList.appendChild(item);
    }
  } catch (err) {
    const empty = document.createElement('div');
    empty.className = 'inbox-empty';
    empty.textContent = `Could not read Inbox: ${err.message}`;
    els.inboxList.appendChild(empty);
  }
}

async function importInboxFile(name) {
  try {
    const file = await window.desktop.importInboxFile(name);
    showImportCard(file.content, `Bridge Inbox file "${file.name}"`);
  } catch (err) {
    addMessageToDom('system', `Import failed: ${err.message}`);
  }
}

// An imported ChatGPT text lands here first: review it, log it as a Dot test
// result, or both. Nothing is sent anywhere until Michael picks.
function showImportCard(rawText, sourceLabel) {
  const text = rawText.length > 20000 ? rawText.slice(0, 20000) + '\n…[truncated]' : rawText;
  const card = document.createElement('div');
  card.className = 'task-card done';

  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = `📥 Imported from ${sourceLabel} (${text.length} characters)`;
  card.appendChild(title);

  const pre = document.createElement('div');
  pre.className = 'task-detail';
  pre.textContent = text.slice(0, 600) + (text.length > 600 ? '\n…' : '');
  card.appendChild(pre);

  const row = document.createElement('div');
  row.className = 'row';
  const reviewBtn = document.createElement('button');
  reviewBtn.textContent = 'Review with Muse Spark';
  const logBtn = document.createElement('button');
  logBtn.textContent = 'Log as Dot test result';
  row.appendChild(reviewBtn);
  row.appendChild(logBtn);
  card.appendChild(row);

  reviewBtn.addEventListener('click', () => {
    sendUserText(`[ChatGPT result for review — from ${sourceLabel}]\n\n${text}\n\nPlease review this ChatGPT result: what is correct, what is wrong, and what is unverified?`);
  });
  logBtn.addEventListener('click', async () => {
    logBtn.disabled = true;
    reviewBtn.disabled = true;
    await logDotResult({ what: lastDotWhat || 'Imported Dot result', source: sourceLabel, raw: text });
  });

  els.messages.appendChild(card);
  scrollToBottom();
}

async function exportPacket(target) {
  if (!messages.length) {
    setStatus('Nothing to package yet — have a chat first.');
    return;
  }
  try {
    const res = await window.desktop.exportPacket(target, messages);
    await addSystemMessage(`📦 Packet saved to Bridge Outbox: ${res.filename}\n${res.path}`);
  } catch (err) {
    setStatus(`Package failed: ${err.message}`);
  }
}

// ---------- UI clipboard bridge ----------

async function importFromClipboard() {
  try {
    const text = await window.desktop.readClipboard();
    if (!text || !text.trim()) {
      setStatus('Clipboard is empty (or holds no text). Copy something in ChatGPT first.');
      return;
    }
    showImportCard(text, 'clipboard');
  } catch (err) {
    setStatus(`Clipboard read failed: ${err.message}`);
  }
}

async function copyForChatGPT() {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) {
    setStatus('Nothing to copy yet — no Muse Spark answer in this chat.');
    return;
  }
  const brief = [
    '# Verify this — from Muse Bridge',
    '',
    'You are the second engine (Dot / ChatGPT). Audit the result below.',
    'Reply with one line per check: CLAIM: <check> | RESULT: PASS / FAIL / UNVERIFIED | EVIDENCE: <what you saw>',
    '',
    '## Result to check',
    '',
    last.content
  ].join('\n');
  await window.desktop.writeClipboard(brief);
  setStatus('Copied to clipboard — paste it into your ChatGPT window.');
}

// ---------- Dot test runner ----------

async function logDotResult({ what, source, raw }) {
  try {
    const { verdicts, logFile } = await window.desktop.logDotResult({ what, source, raw });
    const lines = verdicts.map((v) => `- ${v.result} — ${v.claim}${v.evidence ? ` — Evidence: ${v.evidence}` : ''}`);
    let attachNote = '';
    // Audit signal: an imported verdict flips the oldest SENT audit item.
    const sentItem = audits.find((a) => a.status === 'sent');
    if (sentItem) {
      sentItem.status = 'verdict-back';
      sentItem.verdicts = verdicts;
      sentItem.verdictSource = source;
      await persistAudits();
      renderAudits();
      attachNote = `\n🔍 Audit status: "${sentItem.title}" flipped to VERDICT BACK and the verdict was attached to the original item.`;
    }
    await addSystemMessage(
      `🧪 Dot test verdicts for "${what}" (source: ${source}) — logged to ${logFile}:\n${lines.join('\n')}${attachNote}`
    );
    return verdicts;
  } catch (err) {
    addMessageToDom('system', `Could not log Dot result: ${err.message}`);
    return [];
  }
}

async function buildDotPacket() {
  const what = els.dotWhat.value.trim();
  if (!what) {
    setStatus('Describe what Dot should test first.');
    return null;
  }
  lastDotWhat = what;
  return window.desktop.buildDotPacket({ what, context: conversationMarkdown() || '(empty conversation)' });
}

// ---------- Terminals / sessions ----------

let sessions = [];
const sessionRuntime = {}; // id -> { paused, stopped, approvalResolve }

function newId() {
  return `s-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function persistSessions() {
  try {
    await window.desktop.storeSave('sessions', sessions.map((s) => ({ ...s, log: s.log.slice(-300) })));
  } catch (_) { /* non-fatal */ }
}

function sessionLog(session, line) {
  session.log.push(line);
  renderTerminals();
}

async function runSession(session) {
  const rt = (sessionRuntime[session.id] = sessionRuntime[session.id] || { paused: false, stopped: false });
  if (session.status === 'running') return;
  rt.stopped = false;
  rt.paused = false;
  session.status = 'running';
  sessionLog(session, '▶ Session started.');

  while (!rt.stopped) {
    if (rt.paused) {
      session.status = 'paused';
      renderTerminals();
      await new Promise((r) => setTimeout(r, 400));
      if (!rt.stopped) session.status = 'running';
      continue;
    }
    const job = session.queue.find((j) => j.status === 'pending');
    if (!job) break;
    job.status = 'running';
    sessionLog(session, `\n> [${job.kind}] ${job.text}`);

    if (job.kind === 'chat') {
      try {
        const { text, actions } = await bareChat(`[Terminal session "${session.name}" — role: ${session.engine}] ${job.text}`);
        sessionLog(session, text.slice(0, 3000));
        if (actions.length) {
          sessionLog(session, '⚠ The assistant proposed desktop steps. Terminals never run proposed steps — use the main chat approval cards for those.');
        }
        job.status = 'done';
      } catch (err) {
        sessionLog(session, `✗ Chat job failed: ${err.message}`);
        job.status = 'failed';
      }
      renderTerminals();
    } else {
      // Shell job: inline approval inside this session's own panel.
      session.status = 'awaiting';
      renderTerminals();
      const approved = await new Promise((resolve) => { rt.approvalResolve = resolve; });
      if (approved) {
        try {
          const res = await window.desktop.executeTask({
            type: 'run_command',
            command: job.text,
            cwd: session.folder || undefined,
            label: `Terminal "${session.name}": ${job.text}`
          });
          sessionLog(session, res.ok ? `✓ ${res.output}` : `✗ ${res.output}`);
          job.status = res.ok ? 'done' : 'failed';
        } catch (err) {
          sessionLog(session, `✗ ${err.message}`);
          job.status = 'failed';
        }
      } else {
        sessionLog(session, 'Skipped — not approved.');
        job.status = 'skipped';
      }
      session.status = rt.stopped ? 'stopped' : 'running';
      renderTerminals();
    }
    await persistSessions();
  }

  session.status = rt.stopped ? 'stopped' : 'idle';
  sessionLog(session, rt.stopped ? '■ Session stopped.' : '✓ Queue finished.');
  await persistSessions();
}

function resolveSessionApproval(session, value) {
  const rt = sessionRuntime[session.id];
  if (rt && rt.approvalResolve) {
    const resolve = rt.approvalResolve;
    rt.approvalResolve = null;
    resolve(value);
  }
}

function renderTerminals() {
  els.terminalsList.innerHTML = '';
  for (const session of sessions) {
    const card = document.createElement('div');
    card.className = 'terminal-card';

    const head = document.createElement('div');
    head.className = 'terminal-head';

    const nameInput = document.createElement('input');
    nameInput.value = session.name;
    nameInput.title = 'Session name';
    nameInput.addEventListener('change', () => { session.name = nameInput.value; persistSessions(); renderTerminals(); });

    const engineInput = document.createElement('input');
    engineInput.value = session.engine;
    engineInput.title = 'Engine / role label';
    engineInput.addEventListener('change', () => { session.engine = engineInput.value; persistSessions(); });

    const folderInput = document.createElement('input');
    folderInput.value = session.folder || '';
    folderInput.placeholder = 'Working folder';
    folderInput.title = 'Working folder for shell jobs';
    folderInput.addEventListener('change', () => { session.folder = folderInput.value; persistSessions(); });

    const status = document.createElement('span');
    status.className = `tstatus ${session.status}`;
    status.textContent = session.status.toUpperCase();

    head.appendChild(nameInput);
    head.appendChild(engineInput);
    head.appendChild(folderInput);
    head.appendChild(status);
    card.appendChild(head);

    const controls = document.createElement('div');
    controls.className = 'row';
    const startBtn = document.createElement('button');
    startBtn.className = 'mini-btn large';
    startBtn.textContent = '▶ Start';
    startBtn.addEventListener('click', () => runSession(session));
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'mini-btn large';
    pauseBtn.textContent = '⏸ Pause';
    pauseBtn.addEventListener('click', () => {
      const rt = (sessionRuntime[session.id] = sessionRuntime[session.id] || {});
      rt.paused = !rt.paused;
      sessionLog(session, rt.paused ? '⏸ Paused.' : '▶ Resumed.');
    });
    const stopBtn = document.createElement('button');
    stopBtn.className = 'mini-btn large';
    stopBtn.textContent = '■ Stop';
    stopBtn.addEventListener('click', () => {
      const rt = (sessionRuntime[session.id] = sessionRuntime[session.id] || {});
      rt.stopped = true;
      resolveSessionApproval(session, false);
      renderTerminals();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn large';
    delBtn.textContent = 'Delete session';
    delBtn.addEventListener('click', async () => {
      sessions = sessions.filter((s) => s.id !== session.id);
      await persistSessions();
      renderTerminals();
    });
    const flagBtn = document.createElement('button');
    flagBtn.className = 'mini-btn large';
    flagBtn.textContent = '🚩 Flag output for Dot audit';
    flagBtn.addEventListener('click', () => {
      flagForAudit({
        title: `Terminal "${session.name}" output`,
        kind: 'terminal',
        content: session.log.slice(-40).join('\n') || '(empty log)'
      });
    });
    controls.appendChild(startBtn);
    controls.appendChild(pauseBtn);
    controls.appendChild(stopBtn);
    controls.appendChild(flagBtn);
    controls.appendChild(delBtn);
    card.appendChild(controls);

    const log = document.createElement('div');
    log.className = 'terminal-log';
    log.textContent = session.log.join('\n');
    card.appendChild(log);
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });

    // Pending shell job awaiting approval in this panel
    const awaitingJob = session.queue.find((j) => j.status === 'running');
    if (session.status === 'awaiting' && awaitingJob) {
      const pending = document.createElement('div');
      pending.className = 'pending-job';
      const txt = document.createElement('div');
      txt.appendChild(document.createTextNode('Approval needed — run this exact command in '));
      const code = document.createElement('code');
      code.textContent = session.folder || '(home folder)';
      txt.appendChild(code);
      pending.appendChild(txt);
      const cmd = document.createElement('div');
      const cmdCode = document.createElement('code');
      cmdCode.textContent = awaitingJob.text;
      cmd.appendChild(cmdCode);
      pending.appendChild(cmd);
      const row = document.createElement('div');
      row.className = 'row';
      const okBtn = document.createElement('button');
      okBtn.className = 'approve mini-btn large';
      okBtn.textContent = 'Approve & run';
      okBtn.addEventListener('click', () => resolveSessionApproval(session, true));
      const skipBtn = document.createElement('button');
      skipBtn.className = 'mini-btn large';
      skipBtn.textContent = 'Skip';
      skipBtn.addEventListener('click', () => resolveSessionApproval(session, false));
      row.appendChild(okBtn);
      row.appendChild(skipBtn);
      pending.appendChild(row);
      card.appendChild(pending);
    }

    const queued = session.queue.filter((j) => j.status === 'pending' || j.status === 'running');
    if (queued.length) {
      const q = document.createElement('div');
      q.className = 'side-note';
      q.textContent = 'Queue: ' + queued.map((j) => `[${j.kind}] ${j.text}`).join('  ·  ');
      card.appendChild(q);
    }

    const addRow = document.createElement('div');
    addRow.className = 'terminal-add';
    const kindSel = document.createElement('select');
    for (const [v, label] of [['chat', 'Chat job'], ['shell', 'Shell job']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = label;
      kindSel.appendChild(opt);
    }
    const jobInput = document.createElement('input');
    jobInput.className = 'job-text';
    jobInput.placeholder = 'Job text — for shell jobs, the exact command';
    const addBtn = document.createElement('button');
    addBtn.className = 'mini-btn large';
    addBtn.textContent = 'Add job';
    addBtn.addEventListener('click', async () => {
      const text = jobInput.value.trim();
      if (!text) return;
      session.queue.push({ id: newId(), kind: kindSel.value, text, status: 'pending' });
      jobInput.value = '';
      await persistSessions();
      renderTerminals();
    });
    addRow.appendChild(kindSel);
    addRow.appendChild(jobInput);
    addRow.appendChild(addBtn);
    card.appendChild(addRow);

    els.terminalsList.appendChild(card);
  }
  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'inbox-empty';
    empty.textContent = 'No sessions yet. Create one — e.g. "Builder — Spark", "Tester — Dot", "Researcher".';
    els.terminalsList.appendChild(empty);
  }
}

// ---------- Night Queue ----------

let nightJobs = [];
let nightRunning = false;
let nightStopRequested = false;
let nightCurrentExecId = null; // execId of the in-flight queue step, if any

async function persistNight() {
  try { await window.desktop.storeSave('nightQueue', nightJobs); } catch (_) { /* non-fatal */ }
}

function renderNight() {
  els.nightJobs.innerHTML = '';
  nightJobs.forEach((job, idx) => {
    const li = document.createElement('li');
    const type = document.createElement('span');
    type.className = 'jtype';
    type.textContent = job.type;
    li.appendChild(type);
    li.appendChild(document.createTextNode(` ${job.text}${job.folder ? `  (in ${job.folder})` : ''}`));
    const st = document.createElement('span');
    st.className = `jstatus ${job.status}`;
    st.textContent = (job.status || 'pending').toUpperCase();
    li.appendChild(st);
    if (job.status === 'waiting_on_user' && (job.parkReason || job.note)) {
      const note = document.createElement('span');
      note.className = 'jnote';
      note.textContent = `⏸ Waiting on you: ${job.parkReason || job.note}`;
      li.appendChild(note);
    } else if (job.note) {
      const note = document.createElement('span');
      note.className = 'jnote';
      note.textContent = job.note;
      li.appendChild(note);
    }
    if (!nightRunning && job.status === 'pending') {
      const toggleWrap = document.createElement('label');
      toggleWrap.className = 'night-audit-toggle';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = Boolean(job.needsAudit);
      toggle.addEventListener('change', async () => {
        job.needsAudit = toggle.checked;
        await persistNight();
      });
      toggleWrap.appendChild(toggle);
      toggleWrap.appendChild(document.createTextNode(' Needs Dot audit'));
      li.appendChild(toggleWrap);
      const remove = document.createElement('button');
      remove.className = 'mini-btn';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        nightJobs.splice(idx, 1);
        await persistNight();
        renderNight();
      });
      li.appendChild(remove);
    }
    els.nightJobs.appendChild(li);
  });
  document.getElementById('night-approve').disabled = nightRunning || !nightJobs.some((j) => j.status === 'pending');
  document.getElementById('night-stop').disabled = !nightRunning;
  els.nightBadge.textContent = nightRunning ? 'RUNNING' : 'OFF';
  els.nightBadge.className = nightRunning ? 'badge on' : 'badge';
}

async function nightLogLine(text) {
  try { await window.desktop.nightLog(`[${new Date().toISOString()}] ${text}`); } catch (_) { /* non-fatal */ }
}

async function runNightQueue() {
  if (nightRunning) return;
  const pending = nightJobs.filter((j) => j.status === 'pending');
  if (!pending.length) return;
  nightRunning = true;
  nightStopRequested = false;
  els.nightStatus.textContent = 'Running the approved queue…';
  await nightLogLine(`QUEUE APPROVED by user — ${pending.length} job(s): ${pending.map((j) => `[${j.type}] ${j.text}`).join(' | ')}`);
  renderNight();

  // Park a job: it needs the human (security key touch, phone prompt,
  // locked vault…). Parking is NOT a halt — the rest of the queue keeps
  // going, and the morning summary lists parked jobs with their reason.
  async function parkJob(job, reason) {
    job.status = 'waiting_on_user';
    job.parkReason = reason;
    job.note = reason;
    await nightLogLine(`PARKED (waiting on you) [${job.type}] ${job.text} — Reason: ${reason}`);
  }

  let halted = false;
  for (const job of nightJobs) {
    if (job.status !== 'pending') continue;
    if (nightStopRequested) {
      await nightLogLine('Queue stopped by user before this job.');
      break;
    }
    job.status = 'running';
    job.note = '';
    renderNight();
    await nightLogLine(`START [${job.type}] ${job.text}`);

    try {
      if (job.type === 'wait_for_user') {
        // Pre-declared human step (hardware key, phone prompt…). Park it
        // and CONTINUE with the remaining jobs.
        await parkJob(job, job.text);
      } else if (job.type === 'fill_login' || job.type === 'fill_totp') {
        // Pre-approved by name in this queue: the job text IS the vault
        // entry label the user approved. Secrets never appear here — main
        // fetches them from the vault and the result speaks in labels only.
        // Hands guard runs in main in queue mode: while Michael is using
        // the PC the step waits (logged once here); a locked/switched
        // session parks it immediately.
        const execId = newId();
        let waitLogged = false;
        handsStatusHandlers.set(execId, async (status) => {
          if (status.kind !== 'user-active') return;
          els.nightStatus.textContent = "⏸ Waiting — you're using the PC (hands step paused)";
          if (!waitLogged) {
            waitLogged = true;
            await nightLogLine(`⏸ Waiting — you're using the PC [${job.type}] ${job.text}`);
          }
        });
        let res;
        nightCurrentExecId = execId;
        try {
          res = await window.desktop.executeTask({
            type: job.type,
            entryLabel: job.text,
            targetWindowTitle: job.folder || undefined,
            label: `Night Queue: ${job.type === 'fill_login' ? 'Login' : 'Authenticator code'} for ${job.text}`
          }, { mode: 'queue', execId });
        } finally {
          nightCurrentExecId = null;
          handsStatusHandlers.delete(execId);
        }
        if (res.cancelled) {
          job.status = 'stopped';
          job.note = 'Stopped by you during the hands wait — nothing was typed.';
          await nightLogLine(`STOPPED (cancelled during hands wait) [${job.type}] ${job.text}`);
        } else if (res.waitForUser) {
          const reason = res.parkReason === 'session'
            ? 'session locked or switched away'
            : res.parkReason === 'user-active'
              ? 'user active on the PC'
              : res.output;
          await parkJob(job, reason);
        } else {
          job.status = res.ok ? 'done' : 'failed';
          job.note = res.output.slice(0, 220);
          await nightLogLine(`${res.ok ? 'DONE' : 'FAILED'} [${job.type}] ${res.output}`);
        }
      } else if (job.type === 'chat') {
        const { text, actions } = await bareChat(job.text);
        const waitAction = actions.find((a) => a.type === 'wait_for_user');
        if (waitAction) {
          // The step needs the human in person. Park THIS job, keep going.
          await parkJob(job, waitAction.reason || 'User action needed (security key / phone prompt)');
        } else if (actions.length) {
          // Out-of-scope: the assistant tried to go beyond the approved job.
          job.status = 'stopped';
          job.note = 'Assistant proposed desktop steps that were NOT in the approved queue. Queue halted for your review — nothing extra was run.';
          halted = true;
          await nightLogLine(`STOPPED (out-of-scope proposal, not executed): ${job.text} — reply was: ${text.slice(0, 400)}`);
        } else {
          job.status = 'done';
          job.note = text.slice(0, 220);
          await nightLogLine(`DONE [chat] ${job.text} — ${text.slice(0, 400)}`);
        }
      } else if (job.type === 'shell') {
        // The job text IS the approved step, exactly as the user read it.
        const res = await window.desktop.executeTask({
          type: 'run_command',
          command: job.text,
          cwd: job.folder || undefined,
          label: `Night Queue: ${job.text}`
        });
        job.status = res.ok ? 'done' : 'failed';
        job.note = res.output.slice(0, 220);
        await nightLogLine(`${res.ok ? 'DONE' : 'FAILED'} [shell] ${job.text} — ${res.output.slice(0, 400)}`);
      } else if (job.type === 'dot-test') {
        const built = await window.desktop.buildDotPacket({
          what: job.text,
          context: conversationMarkdown() || '(no chat material — test the job text itself)'
        });
        if (settings && !settings.hasKey) {
          const raw = await window.desktop.simulateDot(job.text);
          const { verdicts } = await window.desktop.logDotResult({ what: job.text, source: 'Night Queue (simulated, mock mode)', raw });
          job.status = 'done';
          job.note = `Packet exported (${built.filename}); SIMULATED Dot verdicts logged: ${verdicts.map((v) => v.result).join(', ')}.`;
          await nightLogLine(`DONE [dot-test, simulated] ${job.text} — packet ${built.filename}`);
        } else {
          job.status = 'done';
          job.note = `Test packet exported to Outbox (${built.filename}) — awaiting a real Dot run; there is no automatic ChatGPT channel.`;
          await nightLogLine(`DONE [dot-test, packet exported] ${job.text} — ${built.filename}`);
        }
      }
    } catch (err) {
      job.status = 'failed';
      job.note = err.message;
      await nightLogLine(`FAILED [${job.type}] ${job.text} — ${err.message}`);
    }

    // Audit signal: a flagged job enters Dot's audit queue when it finishes.
    if (job.needsAudit && !job.auditFlagged && ['done', 'stopped', 'failed'].includes(job.status)) {
      job.auditFlagged = true;
      await flagForAudit({
        title: `Night job (${job.status}): ${job.text}`,
        kind: 'night-job',
        content: `Job: [${job.type}] ${job.text}\nStatus: ${job.status}\nResult/note: ${job.note || ''}`
      });
      await nightLogLine(`AUDIT FLAGGED for Dot: [${job.type}] ${job.text}`);
    }

    await persistNight();
    renderNight();
    if (halted) break;
  }

  nightRunning = false;
  const summary = await window.desktop.nightSummary(nightJobs);
  const parkedCount = summary.counts.waiting_on_user || 0;
  const parkedList = nightJobs
    .filter((j) => j.status === 'waiting_on_user')
    .map((j) => `[${j.type}] ${j.text} — ${j.parkReason || j.note || 'user action needed'}`);
  els.nightSummary.textContent =
    `Morning summary saved: ${summary.path}\nDone ${summary.counts.done} · Stopped ${summary.counts.stopped} · Failed ${summary.counts.failed} · Waiting on you ${parkedCount} · Not run ${summary.counts.pending}` +
    (parkedCount ? `\n⏸ Parked — waiting on you:\n${parkedList.map((p) => `  - ${p}`).join('\n')}` : '') +
    (halted ? '\n⚠ The queue HALTED: a job tried to go outside its approved steps. Review before re-approving.' : '');
  els.nightStatus.textContent = halted ? 'Halted — review the stopped job.' : 'Queue finished.';
  await nightLogLine(`RUN ENDED — done ${summary.counts.done}, stopped ${summary.counts.stopped}, failed ${summary.counts.failed}, waiting on user ${parkedCount}, not run ${summary.counts.pending}. Summary: ${summary.path}`);
  await addSystemMessage(`🌙 Night Queue run finished. ${els.nightSummary.textContent}`);
  renderNight();
}

// ---------- Settings ----------

function applySettings(s) {
  settings = s;
  els.model.value = s.model;
  const autolockEl = document.getElementById('vault-autolock');
  if (autolockEl) autolockEl.value = Number.isFinite(s.vaultAutoLockMinutes) ? s.vaultAutoLockMinutes : 10;
  const handsIdleEl = document.getElementById('hands-idle-threshold');
  if (handsIdleEl) handsIdleEl.value = Number.isFinite(s.handsIdleThresholdSeconds) ? s.handsIdleThresholdSeconds : 30;
  const handsWaitEl = document.getElementById('hands-max-wait');
  if (handsWaitEl) handsWaitEl.value = Number.isFinite(s.handsMaxWaitMinutes) ? s.handsMaxWaitMinutes : 30;
  const auditDefaultEl = document.getElementById('audit-night-default');
  if (auditDefaultEl) auditDefaultEl.checked = Boolean(s.auditNightDefault);
  els.bridgePath.textContent = s.bridgePath;
  els.settingsBridgePath.textContent = s.bridgePath;
  if (s.hasKey) {
    els.modeBanner.className = 'mode-banner live';
    els.modeBanner.textContent = `● Live — Muse Spark (${s.model})`;
    els.keyNote.textContent = s.keyPersisted
      ? 'A key is saved on this PC (encrypted by your operating system). Paste a new key to replace it.'
      : 'A key is set for this session only (OS encryption unavailable, so it is not saved to disk). Paste a new key to replace it.';
  } else {
    els.modeBanner.className = 'mode-banner mock';
    els.modeBanner.textContent = 'Mock mode — add your Meta Model API key in Settings';
    els.keyNote.textContent = 'Get a key at dev.meta.ai, then paste it here. It is stored only on this PC, encrypted by your operating system, and sent only to api.meta.ai.';
  }
}

function openSettings() {
  els.apiKey.value = '';
  els.modal.classList.remove('hidden');
}
function closeSettings() {
  els.modal.classList.add('hidden');
}

async function saveSettings() {
  const payload = {
    model: els.model.value,
    auditNightDefault: Boolean(document.getElementById('audit-night-default') && document.getElementById('audit-night-default').checked),
    vaultAutoLockMinutes: (() => {
      const el = document.getElementById('vault-autolock');
      const v = el ? parseInt(el.value, 10) : NaN;
      return Number.isFinite(v) && v >= 0 ? v : 10;
    })(),
    handsIdleThresholdSeconds: (() => {
      const el = document.getElementById('hands-idle-threshold');
      const v = el ? parseInt(el.value, 10) : NaN;
      return Number.isFinite(v) && v > 0 ? v : 30;
    })(),
    handsMaxWaitMinutes: (() => {
      const el = document.getElementById('hands-max-wait');
      const v = el ? parseInt(el.value, 10) : NaN;
      return Number.isFinite(v) && v > 0 ? v : 30;
    })()
  };
  const key = els.apiKey.value.trim();
  if (key) payload.apiKey = key;
  const updated = await window.desktop.saveSettings(payload);
  applySettings(updated);
  closeSettings();
  setStatus(updated.hasKey ? 'Settings saved — live Muse Spark is on.' : 'Settings saved.');
}

// ---------- Teach lessons panel ----------

async function renderLessons() {
  const list = document.getElementById('lessons-list');
  if (!list) return;
  list.innerHTML = '';
  let lessons = [];
  try {
    lessons = await window.desktop.lessonsList();
  } catch (_) { /* panel still renders its empty state */ }
  if (!lessons.length) {
    const empty = document.createElement('div');
    empty.className = 'side-note';
    empty.textContent = 'No lessons yet. Send a chat message with a screenshot attached, then use "📸 Save as lesson" under your message.';
    list.appendChild(empty);
    return;
  }
  for (const lesson of lessons) {
    const card = document.createElement('div');
    card.className = 'lesson-card';
    const img = document.createElement('img');
    img.className = 'lesson-thumb';
    img.alt = `Lesson screenshot: ${lesson.name}`;
    window.desktop.lessonsImage(lesson.id).then((url) => { if (url) img.src = url; }).catch(() => {});
    card.appendChild(img);
    const body = document.createElement('div');
    body.className = 'lesson-body';
    const title = document.createElement('strong');
    title.textContent = lesson.name;
    body.appendChild(title);
    if (lesson.note) {
      const note = document.createElement('div');
      note.textContent = lesson.note;
      body.appendChild(note);
    }
    if (lesson.actionMapping) {
      const mapping = document.createElement('div');
      mapping.className = 'side-note';
      mapping.textContent = `Action mapping: ${lesson.actionMapping}`;
      body.appendChild(mapping);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'mini-btn large';
    sendBtn.textContent = 'Attach screenshot to next message';
    sendBtn.addEventListener('click', async () => {
      const url = await window.desktop.lessonsImage(lesson.id);
      if (!url) {
        setStatus('That lesson’s screenshot file is missing on this PC.');
        return;
      }
      setPendingAttachment({ dataUrl: url, name: `lesson: ${lesson.name}` });
      document.getElementById('lessons-panel').classList.add('hidden');
      setStatus(`Lesson screenshot attached: ${lesson.name} — type your message and Send.`);
      els.input.focus();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn large';
    delBtn.textContent = 'Delete lesson';
    delBtn.addEventListener('click', async () => {
      await window.desktop.lessonsRemove(lesson.id);
      renderLessons();
      setStatus(`Lesson deleted: ${lesson.name}`);
    });
    row.append(sendBtn, delBtn);
    body.appendChild(row);
    card.appendChild(body);
    list.appendChild(card);
  }
}

// ---------- updater UI ----------

function setUpdateStatus(text) {
  const el = document.getElementById('update-status');
  if (el) el.textContent = text || '';
}

if (window.desktop.onUpdaterStatus) {
  window.desktop.onUpdaterStatus((payload) => {
    const info = (payload && payload.info) || {};
    switch (payload && payload.state) {
      case 'checking':
        setUpdateStatus('Checking for updates…');
        break;
      case 'available':
        setUpdateStatus(`Update available${info.version ? ` — v${info.version}` : ''}. Downloading in the background…`);
        break;
      case 'not-available':
        setUpdateStatus('You are on the latest version.');
        break;
      case 'downloading':
        setUpdateStatus(`Downloading update… ${Math.round(info.percent || 0)}%`);
        break;
      case 'downloaded':
        setUpdateStatus(`Update ready${info.version ? ` — v${info.version}` : ''}.`);
        document.getElementById('install-update').classList.remove('hidden');
        setStatus('A Muse Bridge update has downloaded — open Settings and click "Restart to update" when ready.');
        break;
      case 'error':
        setUpdateStatus(info.message || 'Update check failed.');
        break;
      default:
        break;
    }
  });
}

// ---------- wire up ----------

// Teach: attach via button / file picker, paste, and drag-drop.
document.getElementById('attach-image').addEventListener('click', () => {
  document.getElementById('attach-file').click();
});
document.getElementById('attach-file').addEventListener('change', (e) => {
  readImageFile(e.target.files && e.target.files[0]);
  e.target.value = '';
});
document.getElementById('attachment-remove').addEventListener('click', () => {
  setPendingAttachment(null);
  setStatus('Screenshot detached.');
});
els.input.addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      readImageFile(item.getAsFile());
      e.preventDefault();
      return;
    }
  }
});
for (const zone of [document.getElementById('composer-wrap'), els.messages]) {
  if (!zone) continue;
  zone.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) {
      e.preventDefault();
      readImageFile(file);
    }
  });
}
document.getElementById('toggle-lessons').addEventListener('click', () => {
  document.getElementById('lessons-panel').classList.toggle('hidden');
  renderLessons();
});
document.getElementById('close-lessons').addEventListener('click', () => {
  document.getElementById('lessons-panel').classList.add('hidden');
});

// Updater: Settings buttons.
document.getElementById('check-updates').addEventListener('click', async () => {
  setUpdateStatus('Checking for updates…');
  try {
    const res = await window.desktop.checkForUpdates();
    if (res && !res.checked && res.reason === 'not-packaged') {
      setUpdateStatus('Update checks run in the installed app — this is a development/unpackaged run.');
    } else if (res && !res.checked) {
      setUpdateStatus('Update check is unavailable in this build.');
    }
  } catch (err) {
    setUpdateStatus(`Update check failed: ${err.message}`);
  }
});
document.getElementById('install-update').addEventListener('click', async () => {
  const ok = await window.desktop.installUpdate();
  if (!ok) setUpdateStatus('No downloaded update is ready to install yet.');
});

document.getElementById('send').addEventListener('click', () => {
  const text = els.input.value;
  els.input.value = '';
  sendUserText(text);
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = els.input.value;
    els.input.value = '';
    sendUserText(text);
  }
});

document.getElementById('new-chat').addEventListener('click', async () => {
  messages = [];
  await window.desktop.clearHistory();
  renderAll();
  setStatus('');
});
document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('close-settings').addEventListener('click', closeSettings);
document.getElementById('save-settings').addEventListener('click', saveSettings);
document.getElementById('clear-key').addEventListener('click', async () => {
  const updated = await window.desktop.clearKey();
  applySettings(updated);
  setStatus('API key removed. Back to mock mode.');
});
document.getElementById('choose-bridge').addEventListener('click', async () => {
  const updated = await window.desktop.chooseBridgeFolder();
  applySettings(updated);
  await refreshInbox();
});

document.getElementById('refresh-inbox').addEventListener('click', refreshInbox);
document.getElementById('open-bridge-folder').addEventListener('click', () => window.desktop.openBridgeFolder());
document.getElementById('package-chatgpt').addEventListener('click', () => exportPacket('chatgpt'));
document.getElementById('package-Muse').addEventListener('click', () => exportPacket('claude-code'));

document.getElementById('import-clipboard').addEventListener('click', importFromClipboard);
document.getElementById('copy-for-chatgpt').addEventListener('click', copyForChatGPT);

// Dot test modal
document.getElementById('open-dot-test').addEventListener('click', () => els.dotModal.classList.remove('hidden'));
document.getElementById('dot-close').addEventListener('click', () => els.dotModal.classList.add('hidden'));
document.getElementById('dot-export').addEventListener('click', async () => {
  const built = await buildDotPacket();
  if (!built) return;
  els.dotModal.classList.add('hidden');
  await addSystemMessage(`🧪 Dot test packet exported to Outbox: ${built.filename}\n${built.path}\nGive it to Dot (open the file, or use "Copy packet for Dot"), then import Dot's reply here.`);
});
document.getElementById('dot-copy').addEventListener('click', async () => {
  const built = await buildDotPacket();
  if (!built) return;
  await window.desktop.writeClipboard(built.packet);
  els.dotModal.classList.add('hidden');
  setStatus('Test packet copied — paste it into your ChatGPT window.');
});
document.getElementById('dot-simulate').addEventListener('click', async () => {
  const what = els.dotWhat.value.trim() || 'Simulated test';
  lastDotWhat = what;
  const raw = await window.desktop.simulateDot(what);
  els.dotModal.classList.add('hidden');
  await logDotResult({ what, source: 'SIMULATED Dot (mock mode)', raw });
});

// Terminals panel
document.getElementById('toggle-terminals').addEventListener('click', () => {
  els.terminalsPanel.classList.toggle('hidden');
  renderTerminals();
});
document.getElementById('close-terminals').addEventListener('click', () => els.terminalsPanel.classList.add('hidden'));
document.getElementById('add-terminal').addEventListener('click', async () => {
  const presets = [
    { name: 'Builder', engine: 'Spark' },
    { name: 'Tester', engine: 'Dot' },
    { name: 'Researcher', engine: 'Spark' }
  ];
  const preset = presets[sessions.length % presets.length];
  sessions.push({
    id: newId(),
    name: `${preset.name} — ${preset.engine}`,
    engine: preset.engine,
    folder: '',
    status: 'idle',
    queue: [],
    log: [`Session created. Engine/role: ${preset.engine}.`]
  });
  await persistSessions();
  renderTerminals();
});

// Night panel
document.getElementById('toggle-night').addEventListener('click', () => {
  els.nightPanel.classList.toggle('hidden');
  renderNight();
});
document.getElementById('close-night').addEventListener('click', () => els.nightPanel.classList.add('hidden'));
document.getElementById('night-add-job').addEventListener('click', async () => {
  const text = document.getElementById('night-job-text').value.trim();
  if (!text) return;
  nightJobs.push({
    id: newId(),
    type: document.getElementById('night-job-type').value,
    text,
    folder: document.getElementById('night-job-folder').value.trim(),
    status: 'pending',
    note: '',
    needsAudit: Boolean(settings && settings.auditNightDefault)
  });
  document.getElementById('night-job-text').value = '';
  await persistNight();
  renderNight();
});
document.getElementById('night-approve').addEventListener('click', runNightQueue);
document.getElementById('night-stop').addEventListener('click', async () => {
  nightStopRequested = true;
  // If a hands step is currently waiting out the guard, cancel it too —
  // Stop should not have to wait for the hands max wait to expire.
  if (nightCurrentExecId) {
    try { await window.desktop.cancelTask(nightCurrentExecId); } catch (_) { /* non-fatal */ }
  }
});
document.getElementById('night-clear').addEventListener('click', async () => {
  nightJobs = nightJobs.filter((j) => j.status === 'pending' || j.status === 'running' || j.status === 'waiting_on_user');
  await persistNight();
  renderNight();
});

// ---------- Vault ----------
// The panel talks to main through window.desktop vault IPCs. Everything it
// renders is labels/usernames/flags. A revealed secret appears only inside
// this panel's own reveal line, on an explicit click, and is never pushed
// into chat messages, history, packets, or logs.

let vaultState = { exists: false, unlocked: false, entries: [] };
let vaultEditingId = null;

async function refreshVault() {
  try {
    vaultState = await window.desktop.vaultStatus();
  } catch (_) {
    vaultState = { exists: false, unlocked: false, entries: [] };
  }
  els.vaultBadge.textContent = !vaultState.exists ? 'NOT SET UP' : vaultState.unlocked ? 'UNLOCKED' : 'LOCKED';
  els.vaultBadge.className = vaultState.unlocked ? 'badge on' : 'badge';
  renderVault();
}

function vaultField(labelText, input) {
  const wrap = document.createElement('label');
  wrap.className = 'vault-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  wrap.appendChild(span);
  wrap.appendChild(input);
  return wrap;
}

function vaultTextInput(placeholder, value, type) {
  const input = document.createElement('input');
  input.type = type || 'text';
  input.placeholder = placeholder;
  input.value = value || '';
  input.autocomplete = 'off';
  return input;
}

function renderVault() {
  const body = els.vaultBody;
  body.innerHTML = '';

  if (!vaultState.exists) {
    const box = document.createElement('div');
    box.className = 'vault-box';
    const p = document.createElement('div');
    p.className = 'side-note';
    p.textContent = 'No vault yet. Choose a master password — at least 8 characters, something you will not forget. There is NO reset and NO recovery: if you forget it, the vault contents are lost forever. That is what makes it safe.';
    const pw = vaultTextInput('Master password', '', 'password');
    const pw2 = vaultTextInput('Master password, again', '', 'password');
    const btn = document.createElement('button');
    btn.className = 'mini-btn large';
    btn.textContent = 'Create vault';
    btn.addEventListener('click', async () => {
      if (pw.value !== pw2.value) { setStatus('Master passwords do not match.'); return; }
      const res = await window.desktop.vaultCreate(pw.value);
      if (!res.ok) { setStatus(`Vault: ${res.error}`); return; }
      vaultState = res;
      els.vaultBadge.textContent = 'UNLOCKED';
      els.vaultBadge.className = 'badge on';
      renderVault();
      setStatus('Vault created and unlocked. Add your first entry below.');
    });
    box.appendChild(p);
    box.appendChild(vaultField('Master password', pw));
    box.appendChild(vaultField('Repeat it', pw2));
    box.appendChild(btn);
    body.appendChild(box);
    return;
  }

  if (!vaultState.unlocked) {
    const box = document.createElement('div');
    box.className = 'vault-box';
    const p = document.createElement('div');
    p.className = 'side-note';
    p.textContent = 'Vault is locked. While it is locked, nothing can be filled — login and code steps will say "Vault locked" and Night Queue fill jobs will park as waiting on you.';
    const pw = vaultTextInput('Master password', '', 'password');
    const btn = document.createElement('button');
    btn.className = 'mini-btn large';
    btn.textContent = 'Unlock vault';
    btn.addEventListener('click', async () => {
      const res = await window.desktop.vaultUnlock(pw.value);
      if (!res.ok) { setStatus(`Vault: ${res.error}`); return; }
      vaultState = res;
      els.vaultBadge.textContent = 'UNLOCKED';
      els.vaultBadge.className = 'badge on';
      renderVault();
      setStatus('Vault unlocked.');
    });
    box.appendChild(p);
    box.appendChild(vaultField('Master password', pw));
    box.appendChild(btn);
    body.appendChild(box);
    return;
  }

  // Unlocked: lock button + entries + add/edit form.
  const topRow = document.createElement('div');
  topRow.className = 'row';
  const lockBtn = document.createElement('button');
  lockBtn.className = 'mini-btn large';
  lockBtn.textContent = '🔒 Lock now';
  lockBtn.addEventListener('click', async () => {
    vaultState = await window.desktop.vaultLock();
    els.vaultBadge.textContent = 'LOCKED';
    els.vaultBadge.className = 'badge';
    renderVault();
    setStatus('Vault locked.');
  });
  const autoNote = document.createElement('span');
  autoNote.className = 'side-note';
  autoNote.textContent = `Auto-locks after ${settings ? settings.vaultAutoLockMinutes : 10} min idle (Settings). ${vaultState.entries.length} entr${vaultState.entries.length === 1 ? 'y' : 'ies'}.`;
  topRow.appendChild(lockBtn);
  topRow.appendChild(autoNote);
  body.appendChild(topRow);

  for (const entry of vaultState.entries) {
    body.appendChild(renderVaultEntry(entry));
  }

  body.appendChild(renderVaultForm(vaultEditingId
    ? vaultState.entries.find((e) => e.id === vaultEditingId)
    : null));
}

function renderVaultEntry(entry) {
  const card = document.createElement('div');
  card.className = 'vault-entry';

  const head = document.createElement('div');
  head.className = 'v-head';
  const title = document.createElement('span');
  title.className = 'v-title';
  title.textContent = entry.label;
  const user = document.createElement('span');
  user.className = 'v-user';
  user.textContent = entry.username;
  head.appendChild(title);
  head.appendChild(user);
  if (entry.hasPassword) head.appendChild(vaultChip('🔑 password'));
  if (entry.hasTotp) head.appendChild(vaultChip('⏱ 2FA'));
  if (entry.targetTitle) head.appendChild(vaultChip(`🪟 ${entry.targetTitle}`));
  card.appendChild(head);

  const revealLine = document.createElement('div');
  revealLine.className = 'v-reveal hidden-line';
  card.appendChild(revealLine);

  const row = document.createElement('div');
  row.className = 'row';
  const fillBtn = document.createElement('button');
  fillBtn.className = 'mini-btn large';
  fillBtn.textContent = 'Fill login';
  fillBtn.disabled = !entry.hasPassword;
  fillBtn.addEventListener('click', () => {
    els.vaultPanel.classList.add('hidden');
    addTaskCard({
      type: 'fill_login',
      entryLabel: entry.label,
      targetWindowTitle: entry.targetTitle || undefined,
      label: `Fill login for ${entry.label}`
    });
  });
  row.appendChild(fillBtn);

  const codeBtn = document.createElement('button');
  codeBtn.className = 'mini-btn large';
  codeBtn.textContent = 'Fill 2FA code';
  codeBtn.disabled = !entry.hasTotp;
  codeBtn.addEventListener('click', () => {
    els.vaultPanel.classList.add('hidden');
    addTaskCard({
      type: 'fill_totp',
      entryLabel: entry.label,
      targetWindowTitle: entry.targetTitle || undefined,
      label: `Fill authenticator code for ${entry.label}`
    });
  });
  row.appendChild(codeBtn);

  const showPwBtn = document.createElement('button');
  showPwBtn.className = 'mini-btn large';
  showPwBtn.textContent = 'Show password';
  showPwBtn.disabled = !entry.hasPassword;
  showPwBtn.addEventListener('click', async () => {
    const res = await window.desktop.vaultReveal(entry.id, 'password');
    if (!res.ok) { setStatus(`Vault: ${res.error}`); return; }
    showReveal(revealLine, `Password for ${entry.label}: ${res.value}`);
  });
  row.appendChild(showPwBtn);

  const showCodeBtn = document.createElement('button');
  showCodeBtn.className = 'mini-btn large';
  showCodeBtn.textContent = 'Show current code';
  showCodeBtn.disabled = !entry.hasTotp;
  showCodeBtn.addEventListener('click', async () => {
    const res = await window.desktop.vaultCurrentCode(entry.label);
    if (!res.ok) { setStatus(`Vault: ${res.error}`); return; }
    showReveal(revealLine, `Current code for ${entry.label}: ${res.code} (changes every 30 seconds)`);
  });
  row.appendChild(showCodeBtn);

  const editBtn = document.createElement('button');
  editBtn.className = 'mini-btn large';
  editBtn.textContent = vaultEditingId === entry.id ? 'Editing…' : 'Edit';
  editBtn.addEventListener('click', () => {
    vaultEditingId = vaultEditingId === entry.id ? null : entry.id;
    renderVault();
  });
  row.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'mini-btn large danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    const res = await window.desktop.vaultDeleteEntry(entry.id);
    if (!res.ok) { setStatus(`Vault: ${res.error}`); return; }
    vaultState.entries = res.entries;
    if (vaultEditingId === entry.id) vaultEditingId = null;
    renderVault();
    setStatus(`Vault entry "${entry.label}" deleted.`);
  });
  row.appendChild(delBtn);

  card.appendChild(row);
  return card;
}

function vaultChip(text) {
  const chip = document.createElement('span');
  chip.className = 'v-chip';
  chip.textContent = text;
  return chip;
}

function showReveal(line, text) {
  line.textContent = text;
  line.classList.remove('hidden-line');
  setTimeout(() => { line.textContent = ''; line.classList.add('hidden-line'); }, 15000);
}

function renderVaultForm(editing) {
  const form = document.createElement('div');
  form.className = 'vault-box';
  const h = document.createElement('div');
  h.className = 'v-form-title';
  h.textContent = editing ? `Edit entry — ${editing.label}` : 'Add an entry';
  form.appendChild(h);

  const label = vaultTextInput('e.g. GitHub, Twilio, ChatGPT', editing ? editing.label : '');
  const username = vaultTextInput('Username / email', editing ? editing.username : '');
  const password = vaultTextInput(editing ? 'Password (leave blank to keep the saved one)' : 'Password', '', 'password');
  const totp = vaultTextInput(editing ? 'Authenticator secret key (leave blank to keep)' : 'Authenticator secret key (optional, base32 from the 2FA setup screen)', '', 'password');
  const url = vaultTextInput('Website (optional)', editing ? editing.url : '');
  const target = vaultTextInput('Window title for filling (optional, e.g. the browser tab title)', editing ? editing.targetTitle : '');
  const notes = vaultTextInput('Notes (optional)', editing ? editing.notes : '');

  form.appendChild(vaultField('Label — site or app name', label));
  form.appendChild(vaultField('Username', username));
  form.appendChild(vaultField('Password', password));
  form.appendChild(vaultField('Authenticator (TOTP) secret', totp));
  form.appendChild(vaultField('URL', url));
  form.appendChild(vaultField('Target window title', target));
  form.appendChild(vaultField('Notes', notes));

  const hint = document.createElement('div');
  hint.className = 'side-note';
  hint.textContent = 'Tip: when a site offers "set up an authenticator app", choose "enter a setup key" (or scan the QR with any authenticator app first) and paste that secret key here — the app can then type your 6-digit codes for you.';
  form.appendChild(hint);

  const row = document.createElement('div');
  row.className = 'row';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'mini-btn large';
  saveBtn.textContent = editing ? 'Save changes' : 'Add entry';
  saveBtn.addEventListener('click', async () => {
    const payload = {
      label: label.value.trim(),
      username: username.value,
      url: url.value,
      targetTitle: target.value,
      notes: notes.value
    };
    // Blank on edit = keep the saved secret; on add, use what was typed.
    if (password.value || !editing) payload.password = password.value;
    if (totp.value || !editing) payload.totpSecret = totp.value;
    const res = editing
      ? await window.desktop.vaultUpdateEntry(editing.id, payload)
      : await window.desktop.vaultAddEntry(payload);
    if (!res.ok) { setStatus(`Vault: ${res.error}`); return; }
    vaultState.entries = res.entries;
    vaultEditingId = null;
    renderVault();
    setStatus(editing ? 'Entry updated.' : `Entry "${payload.label}" added to the vault.`);
  });
  row.appendChild(saveBtn);
  if (editing) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'mini-btn large';
    cancelBtn.textContent = 'Cancel edit';
    cancelBtn.addEventListener('click', () => { vaultEditingId = null; renderVault(); });
    row.appendChild(cancelBtn);
  }
  form.appendChild(row);
  return form;
}

// Vault wiring
document.getElementById('toggle-vault').addEventListener('click', async () => {
  els.vaultPanel.classList.toggle('hidden');
  if (!els.vaultPanel.classList.contains('hidden')) await refreshVault();
});
document.getElementById('close-vault').addEventListener('click', () => els.vaultPanel.classList.add('hidden'));
if (window.desktop.onVaultAutoLocked) {
  window.desktop.onVaultAutoLocked(async () => {
    await refreshVault();
    setStatus('Vault auto-locked (inactivity). Fills are paused until you unlock it.');
  });
}

// ---------- init ----------

(async function init() {
  try {
    applySettings(await window.desktop.getSettings());
    try {
      const v = await window.desktop.getAppVersion();
      const vEl = document.getElementById('app-version');
      if (vEl && v) vEl.textContent = `v${v}`;
    } catch (_) { /* version label is cosmetic */ }
    messages = await window.desktop.getHistory();
    renderAll();
    await refreshInbox();
    sessions = (await window.desktop.storeGet('sessions')) || [];
    for (const s of sessions) if (s.status === 'running' || s.status === 'awaiting') s.status = 'stopped';
    renderTerminals();
    nightJobs = (await window.desktop.storeGet('nightQueue')) || [];
    for (const j of nightJobs) if (j.status === 'running') j.status = 'pending';
    renderNight();
    audits = (await window.desktop.storeGet('audits')) || [];
    renderAudits();
    await refreshVault();
  } catch (err) {
    addMessageToDom('system', `Startup problem: ${err.message}`);
  }
  els.input.focus();
})();

// ---------- Audit Signal system ----------
// Statuses: not-requested (default for everything) → needs-audit (flagged,
// listed here, counted in Muse's badges) → sent (packet with Dot) →
// verdict-back (Dot's verdict attached to the original item) → fixes-queued
// (failed items turned into a Night Queue fix job in one click).

const AUDIT_STATUS_LABELS = {
  'not-requested': 'Not requested',
  'needs-audit': 'NEEDS DOT AUDIT',
  sent: 'Audit sent to Dot',
  'verdict-back': 'Verdict back',
  'fixes-queued': 'Fixes queued'
};

let audits = [];

async function persistAudits() {
  try { await window.desktop.storeSave('audits', audits); } catch (_) { /* non-fatal */ }
}

function auditWaitingCount() {
  return audits.filter((a) => a.status === 'needs-audit').length;
}

function updateAuditBadges() {
  const n = auditWaitingCount();
  for (const id of ['audit-badge-chat', 'audit-badge-side', 'audit-badge-terminals']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle('hidden-badge', n === 0);
    el.textContent = id === 'audit-badge-chat' ? `🔍 ${n} NEED DOT AUDIT` : `${n} waiting`;
  }
}

// The one entry point: anything (chat answer, night job, terminal output)
// becomes a NEEDS DOT AUDIT item that Muse can see.
async function flagForAudit({ title, kind, content }) {
  const item = {
    id: newId(),
    title: title || 'Untitled result',
    kind: kind || 'chat',
    content: content || '',
    status: 'needs-audit',
    created: new Date().toISOString(),
    packetPath: null,
    verdicts: [],
    verdictSource: null,
    fixJobId: null
  };
  audits.unshift(item);
  await persistAudits();
  renderAudits();
  setStatus(`🚩 Flagged for Dot audit: "${item.title}" — see the Audits panel.`);
  return item;
}

function renderAudits() {
  updateAuditBadges();
  const list = document.getElementById('audits-list');
  if (!list) return;
  list.innerHTML = '';
  if (!audits.length) {
    const empty = document.createElement('div');
    empty.className = 'inbox-empty';
    empty.textContent = 'Nothing flagged. Results start as "Not requested" — flag one and it lands here for Dot, with a badge Muse can see.';
    list.appendChild(empty);
    return;
  }
  for (const item of audits) {
    const card = document.createElement('div');
    card.className = 'audit-item';

    const head = document.createElement('div');
    head.className = 'a-head';
    const title = document.createElement('span');
    title.className = 'a-title';
    title.textContent = item.title;
    const kind = document.createElement('span');
    kind.className = 'a-kind';
    kind.textContent = `${item.kind} · ${new Date(item.created).toLocaleString()}${item.verdictSource ? ` · verdict: ${item.verdictSource}` : ''}`;
    const chip = document.createElement('span');
    chip.className = `chip ${item.status}`;
    chip.textContent = AUDIT_STATUS_LABELS[item.status] || item.status;
    head.appendChild(title);
    head.appendChild(chip);
    head.appendChild(kind);
    card.appendChild(head);

    const content = document.createElement('div');
    content.className = 'a-content';
    content.textContent = item.content;
    card.appendChild(content);

    if (item.verdicts && item.verdicts.length) {
      const v = document.createElement('div');
      v.className = 'a-verdicts';
      v.textContent = 'Dot verdicts:\n' + item.verdicts.map((x) => `- ${x.result} — ${x.claim}${x.evidence ? ` — ${x.evidence}` : ''}`).join('\n');
      card.appendChild(v);
    }
    if (item.packetPath) {
      const p = document.createElement('div');
      p.className = 'a-kind';
      p.textContent = `Packet: ${item.packetPath}`;
      card.appendChild(p);
    }

    const row = document.createElement('div');
    row.className = 'row';

    if (item.status === 'needs-audit') {
      const sendBtn = document.createElement('button');
      sendBtn.className = 'mini-btn large';
      sendBtn.textContent = '📤 Package & copy for Dot';
      sendBtn.addEventListener('click', async () => {
        const built = await window.desktop.auditPackage(item);
        item.packetPath = built.path;
        await window.desktop.writeClipboard(built.packet);
        item.status = 'sent';
        await persistAudits();
        renderAudits();
        setStatus(`Audit packet copied for Dot and saved to Outbox: ${built.filename}`);
      });
      row.appendChild(sendBtn);
      const exportBtn = document.createElement('button');
      exportBtn.className = 'mini-btn large';
      exportBtn.textContent = 'Export packet only';
      exportBtn.addEventListener('click', async () => {
        const built = await window.desktop.auditPackage(item);
        item.packetPath = built.path;
        item.status = 'sent';
        await persistAudits();
        renderAudits();
        setStatus(`Audit packet saved to Outbox: ${built.filename}`);
      });
      row.appendChild(exportBtn);
    }

    if (item.status === 'needs-audit' || item.status === 'sent') {
      const clipBtn = document.createElement('button');
      clipBtn.className = 'mini-btn large';
      clipBtn.textContent = '⬇ Attach verdict from clipboard';
      clipBtn.addEventListener('click', async () => {
        const raw = await window.desktop.readClipboard();
        if (!raw || !raw.trim()) { setStatus('Clipboard is empty — copy Dot\'s reply first.'); return; }
        await attachVerdict(item, raw, 'clipboard import');
      });
      row.appendChild(clipBtn);
      const simBtn = document.createElement('button');
      simBtn.className = 'mini-btn large';
      simBtn.textContent = 'Simulate Dot verdict (mock)';
      simBtn.addEventListener('click', async () => {
        const raw = await window.desktop.simulateDot(item.title);
        await attachVerdict(item, raw, 'SIMULATED (mock)');
      });
      row.appendChild(simBtn);
    }

    if (item.status === 'verdict-back') {
      const failed = (item.verdicts || []).filter((v) => v.result === 'FAIL');
      if (failed.length) {
        const fixBtn = document.createElement('button');
        fixBtn.className = 'mini-btn large';
        fixBtn.textContent = `🔧 Queue fixes for ${failed.length} failed item(s)`;
        fixBtn.addEventListener('click', async () => {
          const fixText = [
            `Fix the failed Dot-audit items for "${item.title}":`,
            ...failed.map((v) => `- ${v.claim}${v.evidence ? ` (Dot's evidence: ${v.evidence})` : ''}`),
            '',
            'Original result:',
            String(item.content || '').slice(0, 2000)
          ].join('\n');
          const job = {
            id: newId(), type: 'chat', text: fixText, folder: '',
            status: 'pending', note: `Fix job from Dot audit of "${item.title}"`, needsAudit: false
          };
          nightJobs.push(job);
          item.status = 'fixes-queued';
          item.fixJobId = job.id;
          await persistNight();
          await persistAudits();
          renderNight();
          renderAudits();
          setStatus('Fix job added to the Night Queue list — it runs only when you approve the queue, like everything else.');
        });
        row.appendChild(fixBtn);
      } else {
        const ok = document.createElement('span');
        ok.className = 'a-kind';
        ok.textContent = 'No failed items — nothing to fix.';
        row.appendChild(ok);
      }
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'mini-btn large';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      audits = audits.filter((a) => a.id !== item.id);
      await persistAudits();
      renderAudits();
    });
    row.appendChild(removeBtn);

    card.appendChild(row);
    list.appendChild(card);
  }
}

// Shared by clipboard attach + mock simulation. Also writes the verdicts to
// test-log.md (same log the Dot test runner uses) and flips the status.
async function attachVerdict(item, raw, source) {
  const verdicts = await window.desktop.parseVerdicts(raw);
  item.verdicts = verdicts;
  item.verdictSource = source;
  item.status = 'verdict-back';
  await window.desktop.logDotResult({ what: `Audit: ${item.title}`, source, raw });
  await persistAudits();
  renderAudits();
  await addSystemMessage(
    `🔍 Audit verdict back for "${item.title}" (${source}): ${verdicts.map((v) => `${v.result} — ${v.claim}`).join(' · ')}` +
    (verdicts.some((v) => v.result === 'FAIL') ? '\nFailed items can be turned into a fix job from the Audits panel, one click.' : '')
  );
}

// Audit wiring
document.getElementById('toggle-audits').addEventListener('click', () => {
  document.getElementById('audits-panel').classList.toggle('hidden');
  renderAudits();
});
document.getElementById('close-audits').addEventListener('click', () => {
  document.getElementById('audits-panel').classList.add('hidden');
});
document.getElementById('flag-last-audit').addEventListener('click', () => {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) { setStatus('No Muse Spark answer to flag yet.'); return; }
  flagForAudit({
    title: `Chat result — ${last.content.slice(0, 60)}…`,
    kind: 'chat',
    content: last.content
  });
});
