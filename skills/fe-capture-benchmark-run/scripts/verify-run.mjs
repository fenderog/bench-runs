#!/usr/bin/env node
/**
 * Verify a captured run is complete, self-consistent and safe to publish.
 *
 *   node verify-run.mjs public/results/<run-id> [--strict] [--allow-secrets] [--allow-home-paths]
 *
 * Errors exit 1. Warnings exit 0 unless --strict.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const strict = args.includes('--strict');
const allowSecrets = args.includes('--allow-secrets');
const allowHomePaths = args.includes('--allow-home-paths');

if (!dir) {
  console.error('Usage: node verify-run.mjs public/results/<run-id> [--strict] [--allow-secrets]');
  process.exit(1);
}
if (!fs.existsSync(dir)) {
  console.error(`✗ ${dir} does not exist`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const notes = [];
const error = (message) => errors.push(message);
const warn = (message) => warnings.push(message);
const info = (message) => notes.push(message);

const read = (file) => fs.readFileSync(path.join(dir, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(dir, file));

const KNOWN_TYPES = new Set([
  'run.start', 'run.end', 'run.error', 'system.message', 'user.message',
  'assistant.thinking', 'assistant.message', 'tool.call', 'tool.result', 'note',
]);

/* ── run.json ─────────────────────────────────────────────────────────────── */

let run = null;
if (!exists('run.json')) {
  error('run.json is missing');
} else {
  try {
    run = JSON.parse(read('run.json'));
  } catch (err) {
    error(`run.json is not valid JSON: ${err.message}`);
  }
}

if (run) {
  if (!run.title) error('run.json has no "title"');
  if (!run.date) error('run.json has no "date"');
  else if (Number.isNaN(Date.parse(run.date))) error(`run.json date "${run.date}" is not parseable`);
  if (!run.summary) warn('run.json has no "summary" — the card will show only the title');
  if (!run.model) warn('run.json has no "model" — the run cannot be compared to anything');
  if (!run.benchmark) warn('run.json has no "benchmark"');

  const metrics = run.metrics ?? {};
  const graded = Object.keys(metrics).filter((k) => !/^(turns|reasoning_blocks|tool_calls|tool_errors|tokens_total|duration)$/.test(k));
  if (!graded.length) warn('no graded metric yet — "metrics" only holds derived counters (add e.g. {"accuracy":{"value":0.842,"unit":"%"}})');
  for (const [key, value] of Object.entries(metrics)) {
    const numeric = typeof value === 'number' || typeof value?.value === 'number';
    if (!numeric) warn(`metric "${key}" has no numeric value and will render as text`);
  }

  const environment = run.environment ?? {};
  for (const key of ['harness', 'model', 'reasoning_mode']) {
    if (!environment[key]) warn(`environment.${key} is not recorded — a run is not reproducible without it`);
  }

  for (const [index, item] of (run.media ?? []).entries()) {
    if (!item?.src) continue;
    if (/^(https?:)?\/\//i.test(item.src) || item.src.startsWith('data:')) continue;
    const target = decodeURIComponent(item.src);
    if (!fs.existsSync(path.join(dir, target))) error(`media[${index}] (${item.type}) points at a missing file: ${item.src}`);
  }
}

/* ── transcript.jsonl ─────────────────────────────────────────────────────── */

let events = [];
if (!exists('transcript.jsonl')) {
  error('transcript.jsonl is missing — the canonical record is the point of the capture');
} else {
  const raw = read('transcript.jsonl');
  if (raw.charCodeAt(0) === 0xfeff) error('transcript.jsonl starts with a BOM');
  raw.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push({ ...JSON.parse(line), _line: index + 1 });
    } catch (err) {
      error(`transcript.jsonl line ${index + 1} is not valid JSON: ${err.message}`);
    }
  });
}

if (events.length) {
  events.forEach((event, index) => {
    if (event.seq !== index) error(`event at line ${event._line} has seq ${event.seq}, expected ${index} — order must be explicit and gapless`);
    if (!KNOWN_TYPES.has(event.type)) error(`unknown event type "${event.type}" at line ${event._line}`);
    if (event.t && Number.isNaN(Date.parse(event.t))) warn(`event ${event.seq} has an unparseable timestamp "${event.t}"`);
  });

  const [first, last] = [events[0], events[events.length - 1]];
  if (first.type !== 'run.start') error(`the first event is "${first.type}", expected run.start`);
  if (!['run.end', 'run.error'].includes(last.type)) error(`the last event is "${last.type}", expected run.end or run.error`);
  if (events.filter((e) => e.type === 'run.start').length > 1) error('more than one run.start event');

  const start = first.type === 'run.start' ? first : {};
  const prompts = events.filter((e) => e.type === 'user.message' && e.original_prompt);
  if (!prompts.length) error('no user.message has original_prompt: true — the original prompt was not captured');
  if (prompts.length > 1) error(`${prompts.length} events claim original_prompt: true; exactly one must`);
  if (prompts.length === 1 && prompts[0] !== events.find((e) => e.type === 'user.message')) {
    warn('original_prompt is not the first user.message — follow-ups before it will be misread as the task');
  }

  if (prompts.length === 1 && exists('prompt.md')) {
    const promptFile = read('prompt.md').replace(/\n+$/, '');
    if (promptFile !== String(prompts[0].text ?? '').replace(/\n+$/, '')) {
      error('prompt.md differs from the original_prompt event — the two must agree byte for byte');
    }
  } else if (prompts.length === 1 && !exists('prompt.md')) {
    warn('prompt.md is missing (run `node transcript-to-md.mjs transcript.jsonl` or rewrite it from the event)');
  }

  const thinking = events.filter((e) => e.type === 'assistant.thinking');
  const disclosed = thinking.filter((e) => !e.encrypted && String(e.text ?? '').trim());
  const visible = start.reasoning?.visible;
  if (visible === true && !disclosed.length) {
    error('run.start says reasoning.visible: true but no reasoning text was captured');
  }
  if (thinking.length && !disclosed.length && visible !== false) {
    warn(`no reasoning prose was captured — set run.start.reasoning.visible to false so the result states the harness withheld it (currently ${JSON.stringify(visible)})`);
  }
  if (!thinking.length && visible !== false) {
    warn('no reasoning blocks at all: if the harness ran with reasoning on, record {"reasoning":{"visible":false}} in run.start');
  }
  const blank = thinking.filter((e) => !String(e.text ?? '').trim() && !e.encrypted);
  if (blank.length) warn(`${blank.length} reasoning block(s) are empty and not marked encrypted`);

  const calls = events.filter((e) => e.type === 'tool.call');
  const results = events.filter((e) => e.type === 'tool.result');
  const resultIds = new Set(results.map((e) => e.call_id));
  const unpaired = calls.filter((e) => !resultIds.has(e.call_id));
  if (unpaired.length) warn(`${unpaired.length} tool call(s) have no matching result (interrupted run?)`);
  if (calls.some((e) => !e.call_id)) error('a tool.call has no call_id — results cannot be paired');
  const unnamed = calls.filter((e) => !e.name || e.name === 'unknown');
  if (unnamed.length) warn(`${unnamed.length} tool call(s) have no tool name`);

  if (!last.output && last.status === 'complete') error('run.end reports status complete but has no output');
  // A missing run.json.status is tolerated (the site treats it as complete and the
  // schema no longer tracks it); only a *contradictory* status is an error.
  if (run?.status && last.status && run.status !== last.status) {
    error(`run.json.status ("${run.status}") disagrees with the transcript's last event ("${last.status}")`);
  }

  const counts = {
    user_messages: events.filter((e) => e.type === 'user.message').length,
    assistant_messages: events.filter((e) => e.type === 'assistant.message').length,
    reasoning_blocks: thinking.length,
    tool_calls: calls.length,
    tool_errors: results.filter((e) => e.status === 'error').length,
    notes: events.filter((e) => e.type === 'note').length,
  };
  for (const [key, value] of Object.entries(counts)) {
    if (last.counts?.[key] !== undefined && last.counts[key] !== value) {
      warn(`run.end.counts.${key} = ${last.counts[key]} but ${value} event(s) are present`);
    }
  }
  info(`${counts.user_messages} user · ${counts.assistant_messages} assistant · ${counts.reasoning_blocks} reasoning · ${counts.tool_calls} tool calls (${counts.tool_errors} errors) · ${counts.notes} notes`);
  info(`reasoning: mode=${start.reasoning?.mode ?? 'n/a'} visible=${start.reasoning?.visible} encrypted=${Boolean(start.reasoning?.encrypted)}`);
  info(`harness: ${[start.harness?.name, start.harness?.version].filter(Boolean).join(' ') || 'not recorded'} · model: ${start.model?.id ?? 'not recorded'}`);
  if (start.source?.unmapped) info(`unmapped source records: ${JSON.stringify(start.source.unmapped)}`);
}

/* ── secret scan ──────────────────────────────────────────────────────────── */

const SECRET_PATTERNS = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API key'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'OpenAI-style API key'],
  [/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{16,}/g, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained PAT'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'Hugging Face token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/g, 'JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key'],
  [/(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{16,}["']/gi, 'credential assignment'],
];

const HOME_RE = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\//g;

if (!allowSecrets || !allowHomePaths) {
  const files = ['run.json', 'transcript.jsonl', 'prompt.md', 'notes.md', 'system-prompt.md', 'transcript.md']
    .filter((file) => fs.existsSync(path.join(dir, file)));
  const homeHits = new Map(); // file → {count, first}
  for (const file of files) {
    const lines = read(file).split('\n');
    for (const [index, line] of lines.entries()) {
      if (!allowSecrets) {
        for (const [pattern, label] of SECRET_PATTERNS) {
          pattern.lastIndex = 0;
          const match = pattern.exec(line);
          if (match) {
            const seen = match[0];
            error(`${file}:${index + 1} looks like a ${label}: ${seen.slice(0, 6)}…${seen.slice(-4)} — replace it with {{REDACTED}} and add {"type":"note","kind":"redaction"} recording the redaction`);
          }
        }
      }
      if (!allowHomePaths) {
        HOME_RE.lastIndex = 0;
        const match = HOME_RE.exec(line);
        if (match) {
          const entry = homeHits.get(file) ?? { count: 0, first: index + 1, sample: match[0] };
          entry.count++;
          homeHits.set(file, entry);
        }
      }
    }
  }
  for (const [file, hit] of homeHits) {
    warn(`${file}: ${hit.count} line(s) contain an absolute home path (first at line ${hit.first}, e.g. ${hit.sample}) — fine for a private repo, worth redacting before publishing; pass --allow-home-paths to silence`);
  }
}

/* ── report ───────────────────────────────────────────────────────────────── */

for (const message of notes) console.log(`  · ${message}`);
for (const message of warnings) console.log(`  ⚠ ${message}`);
for (const message of errors) console.log(`  ✗ ${message}`);

const verdict = errors.length ? 'fail' : warnings.length ? (strict ? 'fail (strict)' : 'pass with warnings') : 'pass';
console.log(`\n${errors.length ? '✗' : '✓'} ${path.basename(path.resolve(dir))}: ${verdict} — ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length || (strict && warnings.length) ? 1 : 0);
