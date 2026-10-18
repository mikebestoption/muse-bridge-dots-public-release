'use strict';

// Loops — pure core (Muse Bridge v0.4.0).
//
// A Loop is a named, reusable workflow: an ordered list of steps built
// one by one in the app (n8n-style), documented in plain English, and
// run step by step. This module is the shared, environment-agnostic
// core: it runs in the browser renderer (classic script, exposed as
// window.MuseLoopsCore) AND under bare node (module.exports) for the
// store, the runner, and the unit tests. It never touches the DOM, the
// filesystem, or the network.
//
// Step types — each maps onto machinery that already exists:
//   prompt      — send a text prompt to Muse Spark; the reply becomes
//                 the step output. {{prev}} in the text is replaced
//                 with the previous step's output.
//   task        — ONE desktop action from the existing action protocol
//                 (open_url, open_app, list_folder, create_file,
//                 append_to_file, run_command). Executed ONLY through
//                 the existing approval path — a Loop never bypasses it.
//   fill        — a vault fill_login / fill_totp by entry LABEL, via the
//                 existing guarded fill actions. Labels only, ever.
//   instruction — text shown to the user; the run waits for their
//                 "Done ✓" tap (manual steps from SOPs land here).
//   note        — documentation only; never executes.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MuseLoopsCore = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  const STEP_TYPES = ['prompt', 'task', 'fill', 'instruction', 'note'];

  const STEP_TYPE_LABELS = {
    prompt: 'Ask Muse Spark',
    task: 'Desktop task',
    fill: 'Vault fill',
    instruction: 'Manual step',
    note: 'Note'
  };

  // The desktop actions a Loop task step may wrap — the file/URL/command
  // subset of the task engine's protocol. Hands actions are NOT here:
  // vault fills are their own step type, and copy/paste stay chat-only.
  const TASK_ACTION_TYPES = [
    'open_url', 'open_app', 'list_folder', 'create_file', 'append_to_file', 'run_command'
  ];

  const FILL_KINDS = ['fill_login', 'fill_totp'];

  let stepSeq = 0;
  function newStepId() {
    stepSeq += 1;
    return `step-${Date.now().toString(36)}-${stepSeq}-${Math.floor(Math.random() * 1e6)}`;
  }

  function emptyStep(type) {
    switch (type) {
      case 'prompt': return { id: newStepId(), type, text: '' };
      case 'task': return { id: newStepId(), type, action: { type: 'open_url', url: '' } };
      case 'fill': return { id: newStepId(), type, fillKind: 'fill_login', entryLabel: '', targetWindowTitle: '' };
      case 'instruction': return { id: newStepId(), type, text: '' };
      case 'note': return { id: newStepId(), type, text: '' };
      default: return null;
    }
  }

  function cleanString(v) {
    return typeof v === 'string' ? v : '';
  }

  // Validate + normalize one raw step. Throws Error with a human reason.
  function normalizeStep(raw, index) {
    const where = `Step ${index + 1}`;
    if (!raw || typeof raw !== 'object') throw new Error(`${where}: not a step object.`);
    if (!STEP_TYPES.includes(raw.type)) throw new Error(`${where}: unknown step type "${raw.type}".`);
    const id = typeof raw.id === 'string' && raw.id ? raw.id : newStepId();
    if (raw.type === 'prompt' || raw.type === 'instruction' || raw.type === 'note') {
      return { id, type: raw.type, text: cleanString(raw.text) };
    }
    if (raw.type === 'fill') {
      const fillKind = FILL_KINDS.includes(raw.fillKind) ? raw.fillKind : 'fill_login';
      const entryLabel = cleanString(raw.entryLabel).trim();
      if (!entryLabel) throw new Error(`${where}: a vault fill step needs the vault entry label.`);
      const step = { id, type: 'fill', fillKind, entryLabel };
      const title = cleanString(raw.targetWindowTitle).trim();
      if (title) step.targetWindowTitle = title;
      return step;
    }
    // task
    const action = raw.action;
    if (!action || typeof action !== 'object' || !TASK_ACTION_TYPES.includes(action.type)) {
      throw new Error(`${where}: a task step needs one of these actions: ${TASK_ACTION_TYPES.join(', ')}.`);
    }
    const clean = { type: action.type };
    for (const key of ['url', 'name', 'path', 'content', 'command', 'cwd']) {
      if (typeof action[key] === 'string') clean[key] = action[key];
    }
    if (typeof action.label === 'string' && action.label) clean.label = action.label;
    const step = { id, type: 'task', action: clean };
    if (raw.needsReview) step.needsReview = true;
    return step;
  }

  // Validate + normalize loop data (create/update payloads). Throws on
  // anything unusable; returns { name, description, steps }.
  function validateLoopData(data) {
    if (!data || typeof data !== 'object') throw new Error('A loop needs a name and steps.');
    const name = cleanString(data.name).trim();
    if (!name) throw new Error('A loop needs a name.');
    const rawSteps = Array.isArray(data.steps) ? data.steps : [];
    const steps = rawSteps.map((s, i) => normalizeStep(s, i));
    return {
      name,
      description: cleanString(data.description),
      steps
    };
  }

  // The executable action a step maps to (task + fill steps only).
  // Fill actions carry the entry LABEL only — secrets are fetched by
  // the main process from the vault at execution moment, as always.
  function stepToAction(step, loopName) {
    if (!step) return null;
    const prefix = loopName ? `Loop "${loopName}": ` : 'Loop step: ';
    if (step.type === 'task') {
      const action = { ...step.action };
      if (!action.label) action.label = `${prefix}${describeTaskAction(action)}`;
      return action;
    }
    if (step.type === 'fill') {
      const action = { type: step.fillKind, entryLabel: step.entryLabel };
      if (step.targetWindowTitle) action.targetWindowTitle = step.targetWindowTitle;
      action.label = `${prefix}${step.fillKind === 'fill_login' ? 'Fill login' : 'Fill authenticator code'} for ${step.entryLabel}`;
      return action;
    }
    return null;
  }

  // Plain-English one-liners for the six task action types. Mirrors the
  // task engine's describeAction wording for these types; fill steps
  // describe by label + window only (never a secret — there is none here).
  function describeTaskAction(action) {
    if (!action) return '(empty task)';
    switch (action.type) {
      case 'open_url': return `Open URL: ${action.url || ''}`;
      case 'open_app': return `Open app: ${action.path || action.name || ''}`;
      case 'list_folder': return `List folder: ${action.path || ''}`;
      case 'create_file': return `Create file: ${action.path || ''}`;
      case 'append_to_file': return `Append to file: ${action.path || ''}`;
      case 'run_command': return `Run command${action.cwd ? ` in ${action.cwd}` : ''}: ${action.command || ''}`;
      default: return String(action.type || 'task');
    }
  }

  function describeStep(step) {
    if (!step) return '(empty step)';
    switch (step.type) {
      case 'prompt': return `Ask Muse Spark: "${step.text || ''}"`;
      case 'task': return describeTaskAction(step.action);
      case 'fill':
        return `${step.fillKind === 'fill_login' ? 'Fill login' : 'Fill authenticator code'} for vault entry "${step.entryLabel}"` +
          (step.targetWindowTitle ? ` in window "${step.targetWindowTitle}"` : '') +
          ' (from the vault — the secret is never shown)';
      case 'instruction': return `You do this by hand: ${step.text || ''}`;
      case 'note': return `Note: ${step.text || ''}`;
      default: return String(step.type);
    }
  }

  // {{prev}} substitution for prompt steps: the previous step's output.
  function applyPrev(text, prevOutput) {
    const prev = prevOutput == null ? '' : String(prevOutput);
    return String(text || '').replace(/\{\{\s*prev\s*\}\}/g, prev);
  }

  function moveStep(steps, fromIndex, toIndex) {
    const list = Array.isArray(steps) ? steps.slice() : [];
    if (fromIndex < 0 || fromIndex >= list.length) return list;
    const target = Math.max(0, Math.min(list.length - 1, toIndex));
    const [item] = list.splice(fromIndex, 1);
    list.splice(target, 0, item);
    return list;
  }

  function slugify(name) {
    const slug = String(name || 'loop')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return slug || 'loop';
  }

  // The readable documentation view of a loop — the same text the
  // "Export .md" button writes to the Bridge Outbox. Documentation is
  // a first-class part of a loop, not an afterthought.
  function loopToMarkdown(loop) {
    const lines = [
      `# Loop: ${loop.name || 'Untitled loop'}`,
      '',
      loop.description ? loop.description : '(no description)',
      '',
      `Steps: ${loop.steps ? loop.steps.length : 0} · Updated: ${loop.updatedAt || loop.createdAt || ''}`,
      '',
      '## Steps',
      ''
    ];
    (loop.steps || []).forEach((step, i) => {
      lines.push(`${i + 1}. **${STEP_TYPE_LABELS[step.type] || step.type}** — ${describeStep(step)}`);
      if (step.type === 'task' && step.action && typeof step.action.content === 'string' && step.action.content) {
        lines.push(`   Content: ${step.action.content.length > 200 ? `${step.action.content.slice(0, 200)}…` : step.action.content}`);
      }
      if (step.needsReview) {
        lines.push('   ⚠ Auto-converted from an SOP — review this step before running the loop.');
      }
    });
    lines.push('');
    lines.push('Runs step by step in Muse Bridge. Desktop-task and vault-fill steps always go through the standard approval cards (or the one Night Queue approval when the loop runs as a queue job) — a loop never bypasses approvals.');
    return lines.join('\n');
  }

  return {
    STEP_TYPES,
    STEP_TYPE_LABELS,
    TASK_ACTION_TYPES,
    FILL_KINDS,
    newStepId,
    emptyStep,
    normalizeStep,
    validateLoopData,
    stepToAction,
    describeTaskAction,
    describeStep,
    applyPrev,
    moveStep,
    slugify,
    loopToMarkdown
  };
});
