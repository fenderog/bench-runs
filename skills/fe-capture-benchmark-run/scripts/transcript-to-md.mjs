#!/usr/bin/env node
/**
 * Render a canonical transcript.jsonl as readable markdown.
 *
 *   node transcript-to-md.mjs <transcript.jsonl> [--out transcript.md] [--title "…"]
 *
 * Reasoning, prompts, tool inputs and tool outputs all go inside fenced blocks so
 * whitespace and formatting survive exactly as generated — markdown reflow would
 * quietly rewrite the evidence.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Pick a fence longer than any backtick run inside the content. */
export function fence(text, lang = '') {
  const body = String(text ?? '');
  const runs = body.match(/`{3,}/g) ?? [];
  const ticks = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${ticks}${lang}\n${body.replace(/\s+$/, '')}\n${ticks}`;
}

const esc = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const secs = (ms) => (ms === null || ms === undefined ? null : `${(ms / 1000).toFixed(1)}s`);
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : null);

export function readTranscript(file) {
  const events = [];
  const bad = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      bad.push(`line ${index + 1}: ${err.message}`);
    }
  });
  return { events, bad };
}

export function renderTranscript(events, { title, run = null } = {}) {
  const start = events.find((e) => e.type === 'run.start') ?? {};
  const end = [...events].reverse().find((e) => e.type === 'run.end' || e.type === 'run.error') ?? {};
  const timeline = events.filter((e) => !['run.start', 'run.end', 'run.error'].includes(e.type));
  const thinking = events.filter((e) => e.type === 'assistant.thinking');
  const toolCalls = events.filter((e) => e.type === 'tool.call');
  const toolResults = events.filter((e) => e.type === 'tool.result');
  const resultsByCall = new Map(toolResults.map((e) => [e.call_id, e]));
  const duration = start.t && end.t ? Date.parse(end.t) - Date.parse(start.t) : null;
  const usage = end.usage ?? {};

  const out = [];
  out.push(`# ${title ?? run?.title ?? start.prompt_id ?? 'Run transcript'}`);
  out.push('');

  const facts = [
    ['harness', [start.harness?.name, start.harness?.version, start.harness?.originator].filter(Boolean).join(' · ')],
    ['model', [start.model?.provider, start.model?.id].filter(Boolean).join('/')],
    ['reasoning', describeReasoning(start.reasoning, reasoningCounts(events))],
    ['decoding', start.params && Object.keys(start.params).length ? Object.entries(start.params).map(([k, v]) => `${k}=${v}`).join(', ') : ''],
    ['tools', Array.isArray(start.tools) && start.tools.length ? start.tools.join(', ') : ''],
    ['started', start.t ?? ''],
    ['duration', duration !== null ? secs(duration) : ''],
    ['prompt id', start.prompt_id ?? ''],
    ['cwd', start.cwd ?? ''],
  ].filter(([, value]) => value);

  if (facts.length) {
    out.push('| Field | Value |', '|---|---|');
    for (const [key, value] of facts) out.push(`| ${key} | ${esc(value)} |`);
    out.push('');
  }

  const counts = [
    `${events.filter((e) => e.type === 'user.message').length} user message(s)`,
    `${events.filter((e) => e.type === 'assistant.message').length} assistant message(s)`,
    `${thinking.length} reasoning block(s)${thinking.some((e) => e.encrypted) ? ` (${thinking.filter((e) => e.encrypted).length} encrypted)` : ''}`,
    `${toolCalls.length} tool call(s)`,
    toolResults.filter((e) => e.status === 'error').length ? `${toolResults.filter((e) => e.status === 'error').length} tool error(s)` : null,
    usage.output_tokens ? `${num((usage.input_tokens ?? 0) + usage.output_tokens)} tokens` : null,
    usage.reasoning_tokens ? `${num(usage.reasoning_tokens)} reasoning tokens` : null,
    `status: ${end.status ?? 'unknown'}`,
  ].filter(Boolean);
  out.push(`**${counts.join(' · ')}**`);
  out.push('');

  const promptEvent = events.find((e) => e.type === 'user.message' && e.original_prompt);
  if (promptEvent) {
    out.push('## Original prompt', '', fence(promptEvent.text, 'text'), '');
  }

  const systemEvents = events.filter((e) => e.type === 'system.message');
  if (systemEvents.length) {
    out.push('## System prompt', '');
    for (const event of systemEvents) {
      out.push(fence(event.text, 'text'), '');
    }
  }

  out.push('## Timeline', '');
  if (!timeline.length) out.push('_No conversation events were captured._', '');

  for (const event of timeline) {
    const label = `seq ${event.seq}`;
    switch (event.type) {
      case 'system.message':
        out.push(`### ${label} · system${event.applies_to_run === false ? ' (not part of the task)' : ''}`, '', fence(event.text, 'text'), '');
        break;
      case 'user.message':
        out.push(`### ${label} · user${event.original_prompt ? ' (task prompt)' : ''}`, '', fence(event.text, 'text'), '');
        break;
      case 'assistant.thinking': {
        const note = event.encrypted ? ' — **encrypted by the provider; prose not disclosed**' : '';
        out.push(`### ${label} · reasoning${note}`, '');
        if (event.text) out.push(fence(event.text, 'text'), '');
        if (event.encrypted && event.signature) {
          out.push('_Reasoning ciphertext omitted here — it is preserved in `transcript.jsonl` and `media/raw/`._', '');
        }
        if (!event.text && !event.encrypted) out.push('_Empty reasoning block._', '');
        break;
      }
      case 'assistant.message':
        out.push(`### ${label} · assistant${event.model ? ` (${event.model})` : ''}`, '', fence(event.text, 'text'), '');
        break;
      case 'tool.call': {
        out.push(`### ${label} · tool call \`${event.name}\``, '');
        if (event.input_text && Object.keys(event.input ?? {}).length <= 1) {
          out.push(fence(event.input_text, 'text'), '');
        } else {
          out.push(fence(JSON.stringify(event.input ?? {}, null, 2), 'json'), '');
        }
        const result = event.call_id ? resultsByCall.get(event.call_id) : null;
        if (result) {
          out.push(`**Result**${result.status !== 'ok' ? ` — status: ${result.status}` : ''}${result.truncated ? ' (truncated; full output in media/raw)' : ''}`, '');
          out.push(fence(result.output, 'text'), '');
        }
        break;
      }
      case 'tool.result': {
        const hasCall = event.call_id && toolCalls.some((c) => c.call_id === event.call_id);
        if (hasCall) break; // already rendered under its call
        out.push(`### ${label} · tool result${event.call_id ? ` \`${event.call_id}\`` : ''}${event.status !== 'ok' ? ` — ${event.status}` : ''}`, '', fence(event.output, 'text'), '');
        break;
      }
      case 'note':
        out.push(`### ${label} · note (${event.kind ?? 'context'})`, '', fence(event.text, 'text'), '');
        break;
      default:
        out.push(`### ${label} · ${event.type}`, '', fence(JSON.stringify(event, null, 2), 'json'), '');
    }
  }

  out.push('## Final output', '');
  out.push(end.output ? fence(end.output, 'text') : '_No final output was recorded._', '');

  if (end.error) {
    out.push('## Error', '', fence(JSON.stringify(end.error, null, 2), 'json'), '');
  }

  if (Object.keys(usage).length) {
    out.push('## Usage', '', '| Metric | Value |', '|---|---|');
    for (const [key, value] of Object.entries(usage)) out.push(`| ${key.replace(/_/g, ' ')} | ${num(value) ?? value} |`);
    out.push('');
  }

  return out.join('\n');
}

export function describeReasoning(reasoning, counts = null) {
  if (!reasoning) return '';
  const mode = reasoning.mode ?? (reasoning.effort ? 'enabled' : null);
  const parts = [mode && String(mode)];
  if (reasoning.effort && reasoning.effort !== mode) parts.push(`effort=${reasoning.effort}`);
  if (reasoning.budget_tokens) parts.push(`budget=${reasoning.budget_tokens}`);
  const total = counts?.total ?? null;
  const disclosed = counts?.disclosed ?? null;
  const encrypted = counts?.encrypted ?? null;
  if (total !== null && disclosed !== null) {
    if (!total) parts.push('no reasoning blocks in the log');
    else if (counts.encrypted) parts.push(`${disclosed}/${total} block(s) disclosed, ${encrypted} encrypted by the provider`);
    else parts.push(`${total} block(s) captured verbatim`);
  } else if (reasoning.visible === false) parts.push('not disclosed by harness');
  else if (reasoning.visible === true) parts.push('captured');
  if (reasoning.encrypted && !encrypted) parts.push('encrypted at rest');
  return parts.filter(Boolean).join(' · ');
}

/** Counts for the reasoning label, computed from the events themselves. */
export function reasoningCounts(events) {
  const thinking = events.filter((e) => e.type === 'assistant.thinking');
  return {
    total: thinking.length,
    disclosed: thinking.filter((e) => !e.encrypted && String(e.text ?? '').trim()).length,
    encrypted: thinking.filter((e) => e.encrypted).length,
  };
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const input = positional[0];
  if (!input) {
    console.error('Usage: node transcript-to-md.mjs <transcript.jsonl> [--out transcript.md] [--title "…"]');
    process.exit(1);
  }
  const { events, bad } = readTranscript(input);
  if (bad.length) {
    console.error(`✗ ${bad.length} unparseable line(s) in ${input}`);
    bad.slice(0, 5).forEach((b) => console.error(`  ${b}`));
    process.exit(1);
  }
  const runPath = path.join(path.dirname(input), 'run.json');
  const run = fs.existsSync(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : null;
  const markdown = renderTranscript(events, { title: flag('title') ?? run?.title, run });
  const out = flag('out') ?? path.join(path.dirname(input), 'transcript.md');
  fs.writeFileSync(out, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  console.log(`✓ ${events.length} events → ${out} (${(markdown.length / 1024).toFixed(1)} KB)`);
}
