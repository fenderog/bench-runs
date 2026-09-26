#!/usr/bin/env node
/**
 * Capture one run from any harness into a bench-runs result folder.
 *
 *   node capture-run.mjs --from <raw session log> [--format auto|pi|claude-code|codex|openai|anthropic|generic] \
 *     --title "…" [--model …] [--harness …] [--reasoning-mode …] [--benchmark …] \
 *     [--tags a,b] [--date YYYY-MM-DD] [--summary "…"] \
 *     [--metrics metrics.json] [--media extra.json] [--notes-file notes.md] \
 *     [--repo /path/to/bench-runs] [--id folder-name] [--no-raw] [--force] [--dry-run]
 *
 * Writes: run.json, transcript.jsonl (canonical), transcript.md, prompt.md,
 * media/raw/<original log>. Nothing is invented: unknown fields stay unknown.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapt } from './adapters.mjs';
import { renderTranscript, describeReasoning, reasoningCounts } from './transcript-to-md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── args ─────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) flags[key] = true;
  else { flags[key] = next; i++; }
}
const flag = (name, fallback = null) => (flags[name] === undefined || flags[name] === true ? fallback : flags[name]);

if (!flag('from') && !positional.length) {
  console.error(`Capture a harness run as a bench-runs result.

  --from <file|->        raw session/API log (use - for stdin)          [required]
  --format <name>        auto | pi | claude-code | codex | openai | anthropic | generic
  --title "…"            run title                                       [required]
  --model <id>           model identifier, e.g. openai/gpt-5
  --harness <name ver>   harness name and version, e.g. "pi 0.4.2"
  --reasoning-mode "…"   free text, e.g. "extended thinking, effort=high"
  --benchmark <name>     benchmark the run belongs to
  --tags a,b             comma separated tags
  --date YYYY-MM-DD      defaults to the run's own timestamp
  --summary "…"          two sentences for the card
  --metrics <file.json>  graded metrics (merged over the derived counters)
  --media <file.json>    extra media entries to append
  --notes-file <file>    prose for notes.md
  --repo <dir>           bench-runs checkout (auto-detected otherwise)
  --id <folder>          result folder name (default <date>_<slug>)
  --no-raw               do not copy the source log into media/raw/
  --force                overwrite an existing result folder
  --dry-run              show what would be written

  Environment: BENCH_REPO=/path/to/bench-runs`);
  process.exit(1);
}

const START = Date.now();

/* ── locate the repo ──────────────────────────────────────────────────────── */

function looksLikeRepo(dir) {
  return fs.existsSync(path.join(dir, 'public', 'results')) &&
    fs.existsSync(path.join(dir, 'scripts', 'build-manifest.mjs'));
}

function findRepo(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!looksLikeRepo(resolved)) {
      throw new Error(`${resolved} is not a bench-runs checkout (needs public/results/ and scripts/build-manifest.mjs)`);
    }
    return resolved;
  }
  if (process.env.BENCH_REPO) return findRepo(process.env.BENCH_REPO);
  let dir = process.cwd();
  for (;;) {
    if (looksLikeRepo(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not find a bench-runs checkout — pass --repo or set BENCH_REPO');
}

/* ── read + adapt the source ──────────────────────────────────────────────── */

const source = flag('from') ?? positional[0];
const isStdin = source === '-';
const text = isStdin ? fs.readFileSync(0, 'utf8') : fs.readFileSync(source, 'utf8');
const sourcePath = isStdin ? '<stdin>' : path.resolve(source);
const sourceName = isStdin ? 'session.jsonl' : path.basename(sourcePath);
const sourceHash = createHash('sha256').update(text).digest('hex');

const adapted = adapt(text, { format: flag('format', 'auto'), sourcePath });
const { meta, unmapped, counts, finalOutput } = adapted;
if (!counts.user_messages) {
  console.error('✗ no user.message event found — the original prompt would be missing. Refusing to write a run without it.');
  console.error(`  format detected as "${adapted.format}"; check the log or pass --format.`);
  process.exit(1);
}

/* ── canonicalise: run.start, body, run.end ───────────────────────────────── */

const CAPS = { tool_result: 100_000, system_message: 50_000 };
const truncations = [];
const body = adapted.events.map((event) => {
  const limit = event.type === 'tool.result' ? CAPS.tool_result
    : event.type === 'system.message' ? CAPS.system_message : null;
  const field = event.type === 'tool.result' ? 'output' : 'text';
  const value = event[field];
  if (limit && typeof value === 'string' && value.length > limit) {
    truncations.push(`${event.type} ${event.call_id ?? ''}`.trim());
    return { ...event, [field]: value.slice(0, limit), truncated: true, original_bytes: Buffer.byteLength(value) };
  }
  return event;
});

const duration = adapted.firstTimestamp && adapted.lastTimestamp
  ? Date.parse(adapted.lastTimestamp) - Date.parse(adapted.firstTimestamp)
  : null;

const reasoningStats = reasoningCounts(body);

const usage = body.reduce((totals, event) => {
  if (!event.usage) return totals;
  for (const [key, value] of Object.entries(event.usage)) {
    if (typeof value === 'number') totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}, {});
if (!Object.keys(usage).length) delete usage.input_tokens;

const status = flag('status', finalOutput ? 'complete' : 'partial');
const startEvent = {
  seq: 0,
  type: 'run.start',
  t: adapted.firstTimestamp,
  schema: 'bench-run/1',
  prompt_id: meta.promptId ?? null,
  harness: meta.harness ?? { name: adapted.format },
  model: meta.model ?? {},
  reasoning: meta.reasoning ?? { mode: null, visible: null, encrypted: false },
  params: meta.params ?? {},
  tools: meta.tools?.length ? meta.tools : null,
  cwd: meta.cwd ?? null,
  source: {
    path: isStdin ? '<stdin>' : sourcePath.replace(process.env.HOME ?? '', '~'),
    sha256: sourceHash,
    bytes: Buffer.byteLength(text),
    format: adapted.format,
    adapter: `fe-capture-benchmark-run@1.0.0`,
    note: meta.sourceNote ?? null,
    unmapped: Object.keys(unmapped).length ? unmapped : null,
  },
};

const endEvent = {
  seq: 0,
  type: finalOutput || status === 'complete' ? 'run.end' : 'run.error',
  t: adapted.lastTimestamp,
  status,
  output: finalOutput,
  stop_reason: [...body].reverse().find((e) => e.stop_reason)?.stop_reason ?? null,
  usage: Object.keys(usage).length ? usage : null,
  duration_ms: duration,
  counts: { ...counts, turns: counts.assistant_messages },
};

const events = [startEvent, ...body, endEvent].map((event, index) => ({ ...event, seq: index }));
const lastEvent = events[events.length - 1];
if (!lastEvent.output && status === 'complete') lastEvent.type = 'run.error';
if (!lastEvent.output && !lastEvent.error) {
  lastEvent.error = { message: 'no final assistant output was found in the source log', kind: 'no_output' };
}

/* ── derive run.json ──────────────────────────────────────────────────────── */

const slugify = (value) => String(value).toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run';

const title = flag('title') ?? meta.promptId ?? sourceName;
const dateSource = flag('date') ?? adapted.firstTimestamp ?? new Date().toISOString();
const date = /^\d{4}-\d{2}-\d{2}$/.test(dateSource) ? `${dateSource}T00:00:00Z` : new Date(dateSource).toISOString();
const folder = flag('id') ?? `${date.slice(0, 10)}_${slugify(title)}`;
const repo = findRepo(flag('repo'));
const dir = path.join(repo, 'public', 'results', folder);

if (fs.existsSync(dir) && !flags.force && !flags['dry-run']) {
  console.error(`✗ ${path.relative(repo, dir)} already exists — pass --force to overwrite or --id to rename.`);
  process.exit(1);
}

const readJsonArg = (name, fallback) => {
  const file = flag(name);
  if (!file) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✗ --${name} ${file}: ${err.message}`);
    process.exit(1);
  }
};

const derivedMetrics = {
  turns: { value: counts.turns ?? counts.assistant_messages, hint: 'assistant messages' },
  reasoning_blocks: counts.thinking_blocks
    ? { value: counts.thinking_blocks, hint: counts.encrypted_thinking_blocks ? `${counts.encrypted_thinking_blocks} encrypted by the provider` : 'captured verbatim' }
    : undefined,
  tool_calls: counts.tool_calls ? { value: counts.tool_calls } : undefined,
  tool_errors: counts.tool_errors ? { value: counts.tool_errors, hint: 'failed tool calls' } : undefined,
  tokens_total: usage.input_tokens || usage.output_tokens
    ? { value: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0), hint: 'summed from per-message usage' }
    : undefined,
  duration: duration ? { value: Math.round(duration / 100) / 10, unit: 's' } : undefined,
};
const gradedMetrics = readJsonArg('metrics', {});
const metrics = { ...prune(derivedMetrics), ...gradedMetrics };

const harnessLabel = [flag('harness') ?? [meta.harness?.name, meta.harness?.version].filter(Boolean).join(' ')].filter(Boolean).join(' ').trim();
const reasoning = meta.reasoning ?? {};
const reasoningLabel = flag('reasoning-mode') ?? describeReasoning(reasoning, reasoningStats).split(' · ')
  .filter((part) => !/block\(s\)|captured verbatim|not disclosed by harness/.test(part))
  .join(', ');

const rawCopyName = `raw/${sourceName}`;

const environment = prune({
  harness: harnessLabel || null,
  harness_originator: meta.harness?.originator ?? null,
  model: flag('model') ?? meta.model?.id ?? null,
  model_provider: meta.model?.provider ?? null,
  reasoning_mode: reasoningLabel || 'not reported by harness',
  reasoning_visible: reasoningStats.total === 0 ? (reasoning.visible === false ? 'no reasoning was run, or the harness withheld it' : 'no reasoning blocks in the log')
    : reasoningStats.encrypted > 0
      ? `partial — ${reasoningStats.disclosed}/${reasoningStats.total} block(s) disclosed, ${reasoningStats.encrypted} encrypted by the provider`
      : `yes, all ${reasoningStats.total} block(s) captured verbatim`,
  reasoning_encrypted: reasoningStats.encrypted ? `yes, ciphertext preserved in media/${rawCopyName}` : null,
  decoding: meta.params && Object.keys(meta.params).length
    ? Object.entries(meta.params).map(([k, v]) => `${k}=${v}`).join(', ') : null,
  tools: meta.tools?.length ? meta.tools.join(', ') : null,
  working_directory: meta.cwd ?? null,
  transcript_format: adapted.format,
  source_log: sourceName,
  permission_mode: meta.permissionMode ?? null,
});

const media = [
  { type: 'markdown', src: 'prompt.md', caption: 'Original prompt (verbatim)' },
  ...(body.some((e) => e.type === 'system.message')
    ? [{ type: 'markdown', src: 'system-prompt.md', caption: 'System prompt' }] : []),
  { type: 'markdown', src: 'transcript.md', lazy: true, caption: `Full transcript — prompt, ${counts.thinking_blocks} reasoning block(s), ${counts.tool_calls} tool call(s) and the final output` },
  { type: 'file', src: 'transcript.jsonl', label: 'transcript.jsonl (canonical, machine readable)' },
  ...(flags['no-raw'] ? [] : [{ type: 'file', src: `media/${rawCopyName}`, label: `Original ${adapted.format} session log (untouched)`, download: true }]),
  ...(readJsonArg('media', []) ?? []),
];

const notesFile = flag('notes-file');
let notes = notesFile ? fs.readFileSync(notesFile, 'utf8') : '';
const noteParts = [];
if (truncations.length) {
  noteParts.push(`Large outputs were truncated in \`transcript.jsonl\` (${truncations.length} event(s)); the complete original log is preserved in \`media/${rawCopyName}\`.`);
}
if (unmapped && Object.keys(unmapped).length) {
  noteParts.push(`Harness records not mapped to transcript events: ${Object.entries(unmapped).map(([k, v]) => `\`${k}\`×${v}`).join(', ')}.`);
}
if (noteParts.length) notes = `${notes.trim()}\n\n${noteParts.join('\n\n')}`.trim();

const run = prune({
  id: folder,
  title,
  model: flag('model') ?? meta.model?.id ?? '',
  benchmark: flag('benchmark', '') || '',
  date,
  tags: flag('tags') ? String(flag('tags')).split(',').map((t) => t.trim()).filter(Boolean) : [],
  summary: flag('summary', '') || '',
  metrics,
  environment,
  links: [],
  media,
  notes,
});

/* ── write ────────────────────────────────────────────────────────────────── */

const promptEvent = body.find((e) => e.type === 'user.message' && e.original_prompt);
const systemEvents = body.filter((e) => e.type === 'system.message');

if (flags['dry-run']) {
  console.log(`▸ would write ${path.relative(repo, dir)}/`);
  for (const file of ['run.json', 'transcript.jsonl', 'transcript.md', 'prompt.md', ...(systemEvents.length ? ['system-prompt.md'] : []), `media/${rawCopyName}`]) {
    console.log(`   ${file}`);
  }
  console.log(`\n  format    ${adapted.format} (auto-detected)`);
  console.log(`  events    ${events.length}`);
  console.log(`  counters  ${JSON.stringify({ ...counts, turns: counts.assistant_messages })}`);
  console.log(`  unmapped  ${JSON.stringify(unmapped)}`);
  console.log(`  reasoning ${reasoningLabel || 'not reported'} (visible: ${reasoning.visible}) `);
  console.log(`  warnings  ${truncations.length} truncation(s)`);
  process.exit(0);
}

await fsp.mkdir(path.join(dir, 'media', 'raw'), { recursive: true });
await fsp.writeFile(path.join(dir, 'transcript.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
await fsp.writeFile(path.join(dir, 'prompt.md'), `${promptEvent?.text ?? ''}\n`, 'utf8');
if (systemEvents.length) {
  await fsp.writeFile(path.join(dir, 'system-prompt.md'), `${systemEvents.map((e) => e.text).join('\n\n---\n\n')}\n`, 'utf8');
}
if (!flags['no-raw']) await fsp.writeFile(path.join(dir, 'media', rawCopyName), text, 'utf8');
await fsp.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
await fsp.writeFile(path.join(dir, 'transcript.md'), `${renderTranscript(events, { title, run }).trimEnd()}\n`, 'utf8');

if (flags['rebuild-manifest']) {
  const { spawnSync } = await import('node:child_process');
  spawnSync(process.execPath, [path.join(repo, 'scripts', 'build-manifest.mjs')], { cwd: repo, stdio: 'inherit' });
}

/* ── report ───────────────────────────────────────────────────────────────── */

const rel = path.relative(process.cwd(), dir) || '.';
const warn = (text) => console.log(`  ⚠ ${text}`);
console.log(`✓ captured ${folder}`);
console.log(`  format      ${adapted.format}`);
console.log(`  events      ${events.length} (${counts.user_messages} user, ${counts.assistant_messages} assistant, ${counts.thinking_blocks} reasoning, ${counts.tool_calls} tool calls)`);
console.log(`  reasoning   ${reasoningLabel || 'not reported'} — ${reasoningStats.total ? `${reasoningStats.disclosed}/${reasoningStats.total} block(s) disclosed${reasoningStats.encrypted ? `, ${reasoningStats.encrypted} encrypted` : ''}` : 'no blocks in the log'}`);
if (duration) console.log(`  duration    ${(duration / 1000).toFixed(1)}s`);
console.log(`  written     ${rel}/run.json, transcript.jsonl, transcript.md, prompt.md`);
if (reasoningStats.total === 0 && reasoning.visible !== false) warn('no reasoning blocks in this log — if reasoning was enabled, record {"reasoning":{"visible":false}} in run.start');
if (reasoningStats.encrypted && reasoningStats.disclosed === 0) warn('all reasoning was withheld as ciphertext — the run records that honestly; do not paraphrase reasoning from elsewhere');
if (!finalOutput) warn('no final assistant output found; check the log tail');
if (truncations.length) warn(`${truncations.length} oversized output(s) truncated in transcript.jsonl (originals in media/${rawCopyName})`);
if (Object.keys(unmapped).length) warn(`unmapped harness records: ${JSON.stringify(unmapped)}`);
if (!Object.keys(gradedMetrics).length) warn('metrics are derived counters only — add the graded result with --metrics, e.g. {"accuracy":{"value":0.842,"unit":"%"}}');
if (!run.summary) warn('summary is empty — a run without a summary is unreadable six months from now');
if (truncations.length || Object.keys(unmapped).length) console.log(`  note        caveats were written into run.json notes`);

console.log(`\nNext:
  1. edit ${rel}/run.json — summary, graded metrics, environment, charts
  2. node ${path.join(path.relative(process.cwd(), HERE), 'verify-run.mjs')} ${rel}
  3. cd ${path.relative(process.cwd(), repo) || '.'} && npm run manifest && npm run dev
  4. git add -A && git commit -m "results: ${slugify(title)}" && git push`);

function prune(object) {
  if (Array.isArray(object)) return object;
  if (object === null || typeof object !== 'object') return object;
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = prune(value);
      if (!Object.keys(nested).length) continue;
      out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}
