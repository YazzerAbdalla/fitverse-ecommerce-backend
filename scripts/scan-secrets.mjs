#!/usr/bin/env node
/**
 * Repo-local secret gate (S1 P0-6, T010).
 * Rejects real-looking third-party credentials in committed content without
 * any new dependency (runs on plain Node, Windows + CI).
 *
 * Usage:
 *   node scripts/scan-secrets.mjs            # scan all git-tracked files
 *   node scripts/scan-secrets.mjs --staged   # scan staged changes only (pre-commit)
 *
 * Wire as a local hook: git config core.hooksPath .githooks
 * (see .githooks/pre-commit). CI runs the full scan on push/PR.
 */
import { execFileSync } from 'node:child_process';

/**
 * Excluded paths: generated artifacts whose node IDs collide with the `re_`
 * prefix (e.g. graphify-out/… `re_inventory…`, `re_get_highe…`). These are
 * never secret-bearing; provider keys live in env/config, not in graphs.
 */
const EXCLUDED_PREFIXES = ['graphify-out/'];

const PATTERNS = [
  // Random API keys always contain digits; all-letter runs of 20+ chars are
  // code identifiers (re_inventory…), not credentials (lookahead enforces it).
  { name: 'resend-key', regex: /re_(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{20,}/g },
  { name: 'google-client-secret', regex: /GOCSPX-[A-Za-z0-9_-]{10,}/g },
];

/** Placeholder runs (uniform char, e.g. re_xxxx…) must never match. */
const isPlaceholder = (match) => /^re_(.)\1+$/.test(match);

const listFiles = (staged) => {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  const out = execFileSync('git', args, { encoding: 'utf8' });
  return out.split('\n').map((f) => f.trim()).filter(Boolean);
};

const readStaged = (file) =>
  execFileSync('git', ['show', `:${file}`], { encoding: 'utf8' });

const main = async () => {
  const staged = process.argv.includes('--staged');
  const { readFile } = await import('node:fs/promises');
  let failures = 0;
  for (const file of listFiles(staged)) {
    if (EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
    let content;
    try {
      content = staged ? readStaged(file) : await readFile(file, 'utf8');
    } catch {
      continue; // Deleted or unreadable — nothing to scan.
    }
    for (const { name, regex } of PATTERNS) {
      for (const match of content.match(regex) ?? []) {
        // Skip the gate's own pattern table and uniform placeholder runs.
        if (isPlaceholder(match)) continue;
        console.error(`secret-gate: ${name} pattern in ${file}: ${match.slice(0, 12)}…`);
        failures += 1;
      }
    }
  }
  if (failures > 0) {
    console.error(
      `secret-gate: REJECTED ${failures} real-looking secret(s). Rotate at the provider, use placeholders, retry.`,
    );
    process.exit(1);
  }
  console.log('secret-gate: clean');
};

main();
