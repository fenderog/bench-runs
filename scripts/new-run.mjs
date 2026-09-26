#!/usr/bin/env node
/**
 * Scaffold a new benchmark run: `npm run new -- "Llama 3.1 8B — GSM8K"`
 *
 * Options:
 *   --model "org/model"      --benchmark "GSM8K"
 *   --tags a,b,c             --status complete|running|failed
 *   --date 2026-06-21
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = path.join(ROOT, 'public', 'results');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(arg);
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const title = positional.join(' ').trim();

if (!title) {
  console.error('Usage: npm run new -- "Run title" [--model m] [--benchmark b] [--tags a,b]');
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 48) || 'run';

const date = typeof flags.date === 'string' ? flags.date : new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`✗ --date must be YYYY-MM-DD (got "${date}")`);
  process.exit(1);
}

let folder = `${date}_${slug}`;
let n = 2;
while (await exists(path.join(RESULTS_DIR, folder))) folder = `${date}_${slug}-${n++}`;

const dir = path.join(RESULTS_DIR, folder);
const tags = typeof flags.tags === 'string' ? flags.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

const run = {
  id: folder,
  title,
  model: typeof flags.model === 'string' ? flags.model : '',
  benchmark: typeof flags.benchmark === 'string' ? flags.benchmark : '',
  date: new Date(`${date}T${new Date().toISOString().slice(11, 19)}Z`).toISOString(),
  tags,
  summary: '',
  metrics: {
    accuracy: 0,
    avg_latency_ms: 0,
    tokens_per_sec: 0,
  },
  environment: {
    gpu: '',
    backend: '',
    quantization: '',
  },
  links: [],
  media: [],
  notes: '',
};

await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
await fsp.writeFile(
  path.join(dir, 'notes.md'),
  `# ${title}\n\nMethod, observations, caveats…\n`,
);

console.log(`✓ created public/results/${folder}/`);
console.log(`
Next:
  1. Drop artefacts into public/results/${folder}/media/
     (.html renders as an embedded playable, plus image / video / table / code)
  2. Capture the harness log into this same folder (rewrites run.json, so
     declare artefacts via --media and keep the model id in --tags):
       node skills/fe-capture-benchmark-run/scripts/capture-run.mjs \\
         --repo . --id ${folder} --force --from <session.jsonl> \\
         --media <media.json> --tags ${[...tags, '<model-id>'].filter(Boolean).join(',') || '<model-id>'}
  3. npm run publish -- ${folder}   # verify + manifest + commit + push
`);

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
