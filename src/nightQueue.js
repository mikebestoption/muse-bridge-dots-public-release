'use strict';

// Night Queue reporting helpers.
// The model (Michael's standing approval discipline):
// - Default OFF. Nothing here runs anything by itself.
// - The user assembles a named list of jobs, reads the FULL list, and taps
//   one explicit "Approve this queue" — that approval covers exactly those
//   jobs, exactly as written, in that order. Nothing else.
// - If a job's assistant reply proposes steps outside the approved job text,
//   that job is STOPPED and the queue HALTS for the user. No self-expansion.

const fs = require('fs');
const path = require('path');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function appendNightLog(bridgePath, line) {
  const dir = path.join(bridgePath, 'NightRuns');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'night-log.md');
  await fs.promises.appendFile(file, `${line}\n`, 'utf8');
  return file;
}

async function writeNightSummary(bridgePath, jobs) {
  const dir = path.join(bridgePath, 'NightRuns');
  await fs.promises.mkdir(dir, { recursive: true });
  const filename = `morning-summary-${stamp()}.md`;
  const counts = { done: 0, stopped: 0, failed: 0, pending: 0, waiting_on_user: 0 };
  for (const j of jobs) {
    if (j.status === 'done') counts.done += 1;
    else if (j.status === 'stopped') counts.stopped += 1;
    else if (j.status === 'failed') counts.failed += 1;
    else if (j.status === 'waiting_on_user') counts.waiting_on_user += 1;
    else counts.pending += 1;
  }
  const parked = jobs.filter((j) => j.status === 'waiting_on_user');
  const body = [
    `# Morning summary — Night Queue run ${new Date().toISOString()}`,
    '',
    `Done: ${counts.done} · Stopped: ${counts.stopped} · Failed: ${counts.failed} · Waiting on you: ${counts.waiting_on_user} · Not run: ${counts.pending}`,
    '',
    ...jobs.map((j, i) => `${i + 1}. **[${(j.status || 'pending').toUpperCase()}] ${j.type}** — ${j.text}${j.note ? `\n   Note: ${j.note}` : ''}`),
    '',
    ...(parked.length
      ? [
          '## ⏸ Parked — waiting on you',
          '',
          'These jobs need something only you can do (a hardware security key',
          'touch, a phone prompt, unlocking the vault…). The queue kept going',
          'with the other jobs. Finish the step, then re-run the parked job.',
          '',
          ...parked.map((j) => `- **[${j.type}]** ${j.text} — Reason: ${j.parkReason || j.note || 'user action needed'}`),
          ''
        ]
      : []),
    'Full detail is in night-log.md in this folder. Stopped jobs stopped because',
    'they tried to go outside the approved queue — review and re-approve if wanted.'
  ].join('\n');
  const full = path.join(dir, filename);
  await fs.promises.writeFile(full, body, 'utf8');
  return { filename, path: full, counts };
}

module.exports = { appendNightLog, writeNightSummary };
