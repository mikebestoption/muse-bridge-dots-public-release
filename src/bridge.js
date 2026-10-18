'use strict';

// Bridge folder: the file-based bridge between ChatGPT (Dot) and Muse.
//   <Bridge>/Inbox/   — ChatGPT results land here (exports, saved replies, briefs)
//   <Bridge>/Outbox/  — handoff packets this app packages for ChatGPT / Muse
// There is NO automatic ChatGPT account sync; files are the channel, by design
// (matches Michael's existing shared-file two-engine workflow).

const fs = require('fs');
const path = require('path');

const IMPORTABLE_EXTS = ['.md', '.txt', '.json'];

function ensureBridge(bridgePath) {
  const inbox = path.join(bridgePath, 'Inbox');
  const outbox = path.join(bridgePath, 'Outbox');
  const nightRuns = path.join(bridgePath, 'NightRuns');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(outbox, { recursive: true });
  fs.mkdirSync(nightRuns, { recursive: true });
  return { bridgePath, inbox, outbox, nightRuns };
}

async function listInbox(bridgePath) {
  const { inbox } = ensureBridge(bridgePath);
  const entries = await fs.promises.readdir(inbox, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!IMPORTABLE_EXTS.includes(path.extname(e.name).toLowerCase())) continue;
    const stat = await fs.promises.stat(path.join(inbox, e.name));
    files.push({ name: e.name, size: stat.size, modified: stat.mtime.toISOString() });
  }
  files.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return files;
}

async function readInboxFile(bridgePath, name) {
  const { inbox } = ensureBridge(bridgePath);
  // Prevent path traversal: only a bare filename inside Inbox is allowed.
  const safeName = path.basename(String(name || ''));
  if (!IMPORTABLE_EXTS.includes(path.extname(safeName).toLowerCase())) {
    throw new Error('Only .md, .txt and .json files can be imported.');
  }
  const full = path.join(inbox, safeName);
  const content = await fs.promises.readFile(full, 'utf8');
  return { name: safeName, content };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function conversationToMarkdown(messages) {
  return messages
    .map((m) => `### ${m.role === 'user' ? 'Michael' : 'Muse Spark'}\n\n${m.content}`)
    .join('\n\n');
}

// target: 'chatgpt' | 'claude-code' (Muse here = the Muse in Michael's Muse app)
async function writePacket(bridgePath, target, messages) {
  const { outbox } = ensureBridge(bridgePath);
  const convo = conversationToMarkdown(messages || []);
  let filename;
  let body;
  if (target === 'chatgpt') {
    filename = `for-chatgpt-verify-${stamp()}.md`;
    body = [
      '# Verify this — handoff from Muse Bridge',
      '',
      'You are the second engine (Dot / ChatGPT). Muse produced the result below.',
      'Audit it and report back: what is correct, what is wrong, what is unverified.',
      'Drop your reply as a .md file into the Bridge Inbox so it can be imported back.',
      '',
      '## What to check',
      '- Every factual claim, number, date and name in the result below',
      '- Logic gaps, missing steps, and anything stated without a source',
      '',
      '## Where',
      '- The conversation / result reproduced below',
      '- Any source files named inside it',
      '',
      '## Expected result',
      '- A point-by-point audit: CONFIRMED / WRONG / UNVERIFIED per claim, with reasons',
      '',
      '## Source conversation',
      '',
      convo || '(empty conversation)'
    ].join('\n');
  } else {
    filename = `for-claude-review-${stamp()}.md`;
    body = [
      '# For Muse — review packet from Muse Bridge',
      '',
      '## Contents',
      convo || '(empty conversation)',
      '',
      '## Ask',
      'Review the above, fix what is real, and answer wrong claims with receipts.'
    ].join('\n');
  }
  const full = path.join(outbox, filename);
  await fs.promises.writeFile(full, body, 'utf8');
  return { filename, path: full };
}

// Generic Outbox writer (loop documentation, SOP exports). The name
// is reduced to a bare filename inside Outbox — no traversal, ever.
async function writeOutboxFile(bridgePath, filename, content) {
  const { outbox } = ensureBridge(bridgePath);
  const safeName = path.basename(String(filename || 'export.md'));
  const full = path.join(outbox, safeName);
  await fs.promises.writeFile(full, String(content || ''), 'utf8');
  return { filename: safeName, path: full };
}

module.exports = { ensureBridge, listInbox, readInboxFile, writePacket, writeOutboxFile };
