'use strict';

// Audit Signal system — how this app LETS MUSE KNOW that Dot needs to audit
// something (Michael, Oct 17, 2026).
//
// Every result, job and terminal output carries an audit status:
//   not-requested  — default; nobody asked Dot to look at it
//   needs-audit    — flagged: waiting for Dot, listed in the Audits panel,
//                    counted in the Muse-side badges
//   sent           — audit packet packaged and sent to Dot (clipboard/Outbox)
//   verdict-back   — Dot's verdict imported and attached to the original item
//   fixes-queued   — failed verdict items turned into a fix job (one click)
//
// This module is the pure logic; the renderer owns the list, main owns the
// packet file write (via writeAuditPacket) and verdict parsing (dotTests).

const fs = require('fs');
const path = require('path');

const AUDIT_STATUSES = ['not-requested', 'needs-audit', 'sent', 'verdict-back', 'fixes-queued'];

const STATUS_LABELS = {
  'not-requested': 'Not requested',
  'needs-audit': 'NEEDS DOT AUDIT',
  sent: 'Audit sent to Dot',
  'verdict-back': 'Verdict back',
  'fixes-queued': 'Fixes queued'
};

function newAuditItem({ title, kind, content }) {
  return {
    id: `a-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    title: title || 'Untitled result',
    kind: kind || 'chat', // chat | night-job | terminal | manual
    content: content || '',
    status: 'needs-audit',
    created: new Date().toISOString(),
    packetPath: null,
    verdicts: [],
    verdictSource: null,
    fixJobId: null
  };
}

function waitingCount(items) {
  return (items || []).filter((i) => i.status === 'needs-audit').length;
}

function buildAuditPacket(item) {
  return [
    `# AUDIT REQUEST — for Dot (ChatGPT), from Muse Bridge`,
    '',
    `Item: ${item.title}`,
    `Kind: ${item.kind} · Flagged: ${item.created}`,
    '',
    '## What to check',
    '- Every factual claim, number, date and name in the result below',
    '- Logic gaps, missing steps, anything stated without a source',
    '',
    '## Where',
    '- The result reproduced below, and any files it names',
    '',
    '## Expected result',
    'One line per check, exactly in this format:',
    '`CLAIM: <what you checked> | RESULT: PASS / FAIL / UNVERIFIED | EVIDENCE: <what you saw>`',
    'Then a short summary. Return it via the Bridge (Inbox file) or clipboard',
    'so it can be attached to this item in Muse Bridge.',
    '',
    '## Result to audit',
    '',
    item.content || '(no content captured)'
  ].join('\n');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function writeAuditPacket(bridgePath, item) {
  const outbox = path.join(bridgePath, 'Outbox');
  await fs.promises.mkdir(outbox, { recursive: true });
  const filename = `audit-packet-${stamp()}.md`;
  const full = path.join(outbox, filename);
  await fs.promises.writeFile(full, buildAuditPacket(item), 'utf8');
  return { filename, path: full, packet: buildAuditPacket(item) };
}

// Failed verdict lines -> the text of a fix job.
function failedFixText(item) {
  const failed = (item.verdicts || []).filter((v) => v.result === 'FAIL');
  if (!failed.length) return null;
  return [
    `Fix the failed Dot-audit items for "${item.title}":`,
    ...failed.map((v) => `- ${v.claim}${v.evidence ? ` (Dot's evidence: ${v.evidence})` : ''}`),
    '',
    'Original result:',
    String(item.content || '').slice(0, 2000)
  ].join('\n');
}

module.exports = { AUDIT_STATUSES, STATUS_LABELS, newAuditItem, waitingCount, buildAuditPacket, writeAuditPacket, failedFixText };
