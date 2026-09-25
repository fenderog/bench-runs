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
  status: typeof flags.status === 'string' ? flags.status : 'complete',
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
  1. Drop assets into public/results/${folder}/media/
  2. Describe them in run.json -> "media": [
       { "type": "image",    "src": "media/accuracy.png", "caption": "Accuracy by category" },
       { "type": "video",    "src": "media/demo.mp4", "poster": "media/demo.jpg" },
       { "type": "playable", "kind": "iframe", "src": "media/playable/index.html", "caption": "WASM demo" },
       { "type": "playable", "kind": "wasm", "wasm": "media/mandel.wasm", "glue": "media/loader.js" },
       { "type": "table",    "src": "media/metrics.csv" }
     ]
  3. npm run dev      # preview locally
  4. git add -A && git commit -m "add run ${folder}" && git push
`);

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
