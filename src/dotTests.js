'use strict';

// Dot Test Runner — Michael's Oct 14, 2026 QA loop, as an app feature:
//   Muse produces work -> Dot (ChatGPT) audits it -> verdicts come back ->
//   verdicts are logged here and Muse fixes what is real.
// Packets are written to the Bridge Outbox (durable) and can also be copied
// to the clipboard for pasting into the ChatGPT window (fast path).

const fs = require('fs');
const path = require('path');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function buildTestPacket({ what, context }) {
  return [
    '# Test this — packet for Dot (ChatGPT)',
    '',
    `## What to test\n${what || '(not specified)'}`,
    '',
    '## Where',
    '- The material under "Material to test" below, and any files it names.',
    '',
    '## Expected result',
    'A point-by-point verdict list. Reply using EXACTLY one line per check, in this format:',
    '`CLAIM: <what you checked> | RESULT: PASS / FAIL / UNVERIFIED | EVIDENCE: <what you saw>`',
    'Then a short summary paragraph.',
    '',
    '## Material to test',
    '',
    context || '(no material attached)'
  ].join('\n');
}

async function writeTestPacket(bridgePath, packetText) {
  const outbox = path.join(bridgePath, 'Outbox');
  await fs.promises.mkdir(outbox, { recursive: true });
  const filename = `dot-test-packet-${stamp()}.md`;
  const full = path.join(outbox, filename);
  await fs.promises.writeFile(full, packetText, 'utf8');
  return { filename, path: full };
}

// Parse Dot's reply into verdicts. Primary format is the CLAIM/RESULT/EVIDENCE
// line above; fallback: any line containing PASS / FAIL / UNVERIFIED becomes a
// verdict, and if nothing parses, the whole reply is one UNVERIFIED verdict.
function parseVerdicts(text) {
  const verdicts = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[-*\s]+/, '').trim();
    const m = line.match(/CLAIM:\s*(.+?)\s*\|\s*RESULT:\s*(PASS|FAIL|UNVERIFIED)\s*\|\s*EVIDENCE:\s*(.*)$/i);
    if (m) {
      verdicts.push({ claim: m[1].trim(), result: m[2].toUpperCase(), evidence: m[3].trim() });
      continue;
    }
    const loose = line.match(/\b(PASS|FAIL|UNVERIFIED)\b/i);
    if (loose && line.length > 8 && !/^CLAIM:/i.test(line)) {
      verdicts.push({ claim: line.slice(0, 200), result: loose[1].toUpperCase(), evidence: '' });
    }
  }
  if (!verdicts.length) {
    verdicts.push({
      claim: 'Dot reply did not use the verdict format — full reply logged for manual review',
      result: 'UNVERIFIED',
      evidence: String(text || '').slice(0, 300)
    });
  }
  return verdicts;
}

async function appendTestLog(bridgePath, { what, source, verdicts, raw }) {
  const logFile = path.join(bridgePath, 'test-log.md');
  await fs.promises.mkdir(bridgePath, { recursive: true });
  const block = [
    '',
    `## ${new Date().toISOString()} — ${what || 'Dot test'}`,
    `Source: ${source || 'unknown'}`,
    '',
    ...verdicts.map((v) => `- **${v.result}** — ${v.claim}${v.evidence ? ` — Evidence: ${v.evidence}` : ''}`),
    '',
    '<details><summary>Raw Dot reply</summary>',
    '',
    '```',
    String(raw || '').slice(0, 8000),
    '```',
    '</details>',
    ''
  ].join('\n');
  await fs.promises.appendFile(logFile, block, 'utf8');
  return logFile;
}

// Clearly-labeled fake Dot result for mock mode / offline end-to-end demo.
function simulateDotResult(what) {
  const topic = what || 'the submitted work';
  return [
    '[SIMULATED Dot result — mock mode. No real ChatGPT run happened.]',
    '',
    `CLAIM: ${topic} — main claim is stated clearly | RESULT: PASS | EVIDENCE: Simulated check of the packet structure`,
    `CLAIM: ${topic} — numbers and dates are backed by named sources | RESULT: UNVERIFIED | EVIDENCE: Simulation cannot open sources; a live Dot run is needed`,
    `CLAIM: ${topic} — no missing steps in the described flow | RESULT: PASS | EVIDENCE: Simulated read-through of the packet`,
    '',
    'Simulated summary: the packet format works end to end. Run it for real by copying the packet into ChatGPT and importing the reply.'
  ].join('\n');
}

module.exports = { buildTestPacket, writeTestPacket, parseVerdicts, appendTestLog, simulateDotResult };
