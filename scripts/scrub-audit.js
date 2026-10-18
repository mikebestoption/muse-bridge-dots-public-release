'use strict';

// Pre-publish scrub audit for the public Muse Bridge tree (v0.3.3 spec A).
// Scans every publishable file for secrets, personal paths/data, and
// private-repo references. Exit code 1 if any BLOCKER finding exists.
//
// Publishable = the whole tree EXCEPT: .git, node_modules, dist, out.
// Files that legitimately discuss a pattern in the abstract (this script,
// tests that assert the absence of secrets) are scanned too — the report
// classifies findings so a human can waive WARNs explicitly, never silently.
//
// Usage: node scripts/scrub-audit.js [--json <reportPath>]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 'docs' holds internal build specs (incl. unbuilt future-version specs
// with private planning references) — it is NOT part of the public source
// drop, so it is out of audit scope, like build output.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'MuseBridge', 'docs']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXT = new Set(['.js', '.json', '.md', '.html', '.css', '.nsi', '.txt', '.yml', '.yaml', '']);

const RULES = [
  {
    id: 'github-token',
    level: 'BLOCKER',
    re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
    why: 'GitHub token in tree'
  },
  {
    id: 'generic-secret-token',
    level: 'BLOCKER',
    re: /\b(sk-[A-Za-z0-9]{20,}|hsurr:[A-Za-z0-9+/=_-]{10,}|AKIA[0-9A-Z]{16})\b/,
    why: 'API key / surrogate token shape in tree'
  },
  {
    id: 'bearer-or-key-assignment',
    level: 'BLOCKER',
    re: /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{12,}['"]/i,
    why: 'Hard-coded credential assignment (value redacted in report)'
  },
  {
    id: 'windows-personal-path',
    level: 'BLOCKER',
    re: /[A-Za-z]:\\Users\\(?!<|Public|Default)[A-Za-z0-9._-]+/i,
    why: 'Real Windows user profile path — special folders must be OS-resolved'
  },
  {
    id: 'unix-home-path',
    level: 'BLOCKER',
    re: /\/(home|Users)\/[A-Za-z0-9._-]+\//,
    why: 'Real home-directory path'
  },
  {
    id: 'private-repo-reference',
    level: 'BLOCKER',
    // Built from fragments so this script does not match its own rule.
    re: new RegExp(['mikebestoption', 'Muse-Bridge'].join('-')),
    why: 'Private repository reference must not appear in the public tree'
  },
  {
    id: 'personal-email',
    level: 'WARN',
    re: /[A-Za-z0-9._%+-]+@(debtconquest\.com|bestoption\.co|mejoralivio\.com|liquidela\.com)/,
    why: 'Maintainer business email — confirm it is intentional public contact info'
  },
  {
    id: 'one-drive-name',
    level: 'WARN',
    re: /\bkreut\b/i,
    why: 'Laptop username fragment'
  }
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      if (!SKIP_FILES.has(entry.name) && TEXT_EXT.has(path.extname(entry.name))) out.push(full);
    }
  }
  return out;
}

// Explicit waivers: findings a human has reviewed and accepted for the
// public tree, with the reason on record. A waiver downgrades to WARN —
// it never deletes the finding from the report.
const WAIVERS = [
  {
    file: 'tests/smoke-main.js',
    rule: 'bearer-or-key-assignment',
    reason: 'JBSWY3DPEHPK3PXP is the canonical public TOTP test vector (base32 of "Hello!\\xde\\xad\\xbe\\xef"), a fixture, not a real credential.'
  },
  {
    file: 'scripts/scrub-audit.js',
    rule: 'windows-personal-path',
    reason: 'This script contains the detection pattern itself, not a real path.'
  }
];

function applyWaivers(findings) {
  return findings.map((f) => {
    const w = WAIVERS.find((x) => x.file === f.file && x.rule === f.rule);
    return w && f.level === 'BLOCKER' ? { ...f, level: 'WARN', waived: w.reason } : f;
  });
}

function auditFile(file) {
  const findings = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return findings;
  }
  if (text.includes('\0')) return findings; // binary, skip
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) {
        findings.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          rule: rule.id,
          level: rule.level,
          why: rule.why,
          // Redact: show only the matched shape's first 12 chars, never a value.
          sample: `${m[0].slice(0, 12)}…`
        });
      }
    }
  });
  return findings;
}

function main() {
  const files = walk(ROOT, []);
  const findings = applyWaivers(files.flatMap(auditFile));
  const blockers = findings.filter((f) => f.level === 'BLOCKER');
  const warns = findings.filter((f) => f.level === 'WARN');
  const report = {
    auditedAt: new Date().toISOString(),
    root: 'muse-spark-desktop',
    filesScanned: files.length,
    blockers: blockers.length,
    warnings: warns.length,
    findings
  };
  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
    fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(`Scrub audit: ${files.length} files scanned, ${blockers.length} BLOCKER(s), ${warns.length} WARN(s)`);
  for (const f of findings) {
    console.log(`  [${f.level}] ${f.file}:${f.line} ${f.rule} — ${f.why} (${f.sample})`);
  }
  if (blockers.length) {
    console.log('SCRUB AUDIT FAILED — resolve BLOCKERs before publishing.');
    process.exit(1);
  }
  console.log('SCRUB AUDIT PASSED (WARNs require explicit human waiver).');
}

if (require.main === module) main();

module.exports = { auditFile, applyWaivers, RULES, WAIVERS };
