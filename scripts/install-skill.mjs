#!/usr/bin/env node
/**
 * Copy the bundled skill into the pi agent skills directory so it is available
 * from any project:  npm run skill:install
 *
 * The repo copy is the source of truth; this just publishes it locally.
 * Override the destination with PI_AGENT_DIR=/path/to/agent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'skills', 'fe-capture-benchmark-run');
const AGENT_DIR = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const DEST = path.join(AGENT_DIR, 'skills', 'fe-capture-benchmark-run');

if (!fs.existsSync(path.join(SOURCE, 'SKILL.md'))) {
  console.error(`✗ ${SOURCE}/SKILL.md is missing`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(SOURCE, DEST, { recursive: true });

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    entry.isDirectory() ? walk(full) : files.push(path.relative(DEST, full));
  }
};
walk(DEST);

console.log(`✓ installed fe-capture-benchmark-run → ${DEST.replace(os.homedir(), '~')}`);
for (const file of files.sort()) console.log(`    ${file}`);
console.log('\n  Use it with /skill:fe-capture-benchmark-run, or just ask to capture a run.');
console.log('  Re-run this after editing skills/fe-capture-benchmark-run/ in the repo.');
