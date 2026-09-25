#!/usr/bin/env node
/**
 * Publish a captured run: verify → manifest → commit → push.
 *
 *   npm run publish -- <run-id> [--message "..."] [--no-push] [--dry-run]
 *
 * <run-id> is the folder name under public/results/. Fails fast: a red
 * verify-run or manifest build stops before anything is committed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith('--')) { positional.push(arg); continue; }
  const key = arg.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) flags[key] = true;
  else { flags[key] = next; i++; }
}

const runId = positional[0];
if (!runId || runId.includes('/') || runId === '.' || runId === '..') {
  console.error('Usage: npm run publish -- <run-id> [--message "..."] [--no-push] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'public', 'results', runId, 'run.json'))) {
  console.error(`✗ public/results/${runId}/run.json not found — scaffold with \`npm run new\` or capture first.`);
  process.exit(1);
}

const dry = Boolean(flags['dry-run']);
const step = (cmd, args) => {
  console.log(`▸ ${cmd} ${args.join(' ')}`);
  if (dry) return;
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`✗ ${cmd} failed (exit ${result.status ?? '?'}) — nothing pushed.`);
    process.exit(result.status ?? 1);
  }
};

step(process.execPath, ['skills/fe-capture-benchmark-run/scripts/verify-run.mjs', `public/results/${runId}`]);
step(process.execPath, ['scripts/build-manifest.mjs']);
step('git', ['add', '-A']);
const message = typeof flags.message === 'string' && flags.message ? flags.message : `results: ${runId}`;
step('git', ['commit', '-m', message]);
if (!flags['no-push']) step('git', ['push']);

console.log(dry ? '(dry run — nothing executed)' : `✓ published ${runId}${flags['no-push'] ? ' (committed locally, not pushed)' : ''}`);
