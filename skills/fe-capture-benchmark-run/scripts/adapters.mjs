/**
 * Adapters: raw harness logs → canonical bench-run/1 events.
 *
 * Every adapter is total: each input record either becomes an event or is counted
 * in `unmapped`. Nothing is silently dropped, nothing is invented.
 *
 * Verified against real session files for: pi, Claude Code, Codex CLI/Desktop,
 * OpenAI Chat Completions + Responses (incl. streaming), Anthropic Messages.
 */

/* ── shared helpers ───────────────────────────────────────────────────────── */

/** Timestamps arrive as ISO strings, unix seconds, or milliseconds. */
export function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const ms = value > 1e11 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Flatten any harness content representation into plain text. */
export function textOf(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block === null || typeof block !== 'object') return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.thinking === 'string') return block.thinking;
      if (typeof block.content === 'string') return block.content;
      if (Array.isArray(block.content)) return textOf(block.content);
      if (typeof block.summary === 'string') return block.summary;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** `arguments` is a JSON string in most tool-call formats. */
function parseArgs(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

/** One-line flattened form of a tool input, for grep. */
function flattenInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return String(input);
  const keys = ['command', 'cmd', 'path', 'file_path', 'query', 'pattern', 'url', 'prompt'];
  for (const key of keys) {
    if (typeof input[key] === 'string') return input[key];
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

class Events {
  constructor(harness) {
    this.harness = harness;
    this.list = [];
    this.unmapped = {};
    this.first = null;
    this.last = null;
  }

  push(type, t, fields = {}) {
    const at = iso(t);
    if (at) {
      if (!this.first) this.first = at;
      this.last = at;
    }
    this.list.push({ type, t: at, ...fields });
    return this.list[this.list.length - 1];
  }

  skip(type) {
    const key = String(type ?? 'unknown');
    this.unmapped[key] = (this.unmapped[key] ?? 0) + 1;
  }

  lastAssistantMessage() {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].type === 'assistant.message' && this.list[i].text) return this.list[i];
    }
    return null;
  }

  usageTotals() {
    const totals = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_input_tokens: 0 };
    for (const event of this.list) {
      if (!event.usage) continue;
      for (const key of Object.keys(totals)) totals[key] += Number(event.usage[key]) || 0;
    }
    return totals;
  }
}

/** A tool result arriving before its call (or without one) still needs a call_id. */
function pairId(events, callId, fallbackName) {
  if (callId) return callId;
  const synthetic = `unpaired-${events.list.filter((e) => e.type === 'tool.result').length + 1}`;
  return fallbackName ? `${synthetic}:${fallbackName}` : synthetic;
}

/* ── pi ───────────────────────────────────────────────────────────────────── */

function adaptPi(records) {
  const e = new Events('pi');
  const meta = { model: {}, harness: { name: 'pi' }, reasoning: { mode: null, effort: null, visible: null, encrypted: false }, params: {}, tools: [] };
  let assistantIndex = 0;

  for (const record of records) {
    switch (record.type) {
      case 'session':
        meta.promptId = record.id ?? null;
        meta.cwd = record.cwd ?? null;
        // `version` is the *session file format* version, not the harness version.
        meta.sourceNote = `pi session format v${record.version}`;
        break;

      case 'model_change':
        meta.model = { id: record.modelId ?? null, provider: record.provider ?? null };
        break;

      case 'thinking_level_change':
        meta.reasoning.mode = record.thinkingLevel ?? null;
        meta.reasoning.effort = record.thinkingLevel ?? null;
        break;

      case 'message': {
        const m = record.message ?? {};
        const at = m.timestamp ?? record.timestamp;
        const blocks = Array.isArray(m.content) ? m.content : [];

        if (m.role === 'system') {
          const sections = m.sections && typeof m.sections === 'object' ? m.sections : null;
          const text = sections
            ? Object.entries(sections).map(([k, v]) => `## ${k}\n${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n\n')
            : textOf(m.content);
          if (text) e.push('system.message', at, { text, applies_to_run: true, ...(sections ? { raw: { sections } } : {}) });
          for (const tool of Array.isArray(m.toolsAdded) ? m.toolsAdded : []) {
            const name = typeof tool === 'string' ? tool : tool?.name ?? tool?.id ?? tool?.tool?.name;
            if (name && !meta.tools.includes(name)) meta.tools.push(name);
          }
          break;
        }

        if (m.role === 'user') {
          const text = textOf(m.content);
          if (!text) { e.skip('message:user:empty'); break; }
          e.push('user.message', at, { text, ...(e.list.some((x) => x.type === 'user.message') ? {} : { original_prompt: true }) });
          break;
        }

        if (m.role === 'assistant') {
          assistantIndex++;
          const usage = m.usage ? normalizeUsage(m.usage) : null;
          let emitted = 0;
          for (const block of blocks) {
            if (block?.type === 'thinking') {
              const signature = block.thinkingSignature ?? null;
              const text = block.thinking ?? '';
              e.push('assistant.thinking', at, {
                text,
                encrypted: text.trim() === '' && Boolean(signature),
                signature,
                tokens: null,
              });
              emitted++;
            } else if (block?.type === 'text') {
              e.push('assistant.message', at, {
                text: block.text ?? '',
                model: m.model ?? null,
                usage: emitted === 0 ? usage : null,
                stop_reason: m.stopReason ?? null,
              });
              emitted++;
            } else if (block?.type === 'toolCall') {
              e.push('tool.call', at, {
                call_id: block.id ?? null,
                name: block.name ?? 'unknown',
                input: parseArgs(block.arguments),
                input_text: flattenInput(parseArgs(block.arguments)),
              });
              emitted++;
            } else if (block) {
              e.skip(`pi:assistant-block:${block.type ?? 'unknown'}`);
            }
          }
          if (!emitted) e.skip('pi:assistant:empty');
          if (blocks.some((b) => b?.type === 'thinking')) meta.reasoning.visible = true;
          break;
        }

        if (m.role === 'toolResult') {
          e.push('tool.result', at, {
            call_id: pairId(e, m.toolCallId ?? null, m.toolName),
            name: m.toolName ?? null,
            status: m.isError ? 'error' : 'ok',
            output: textOf(m.content),
          });
          break;
        }

        e.skip(`pi:role:${m.role ?? 'unknown'}`);
        break;
      }

      default:
        e.skip(`pi:${record.type ?? 'unknown'}`);
    }
  }

  return finish(e, meta);
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' ? v : undefined);
  const out = {
    input_tokens: num(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    output_tokens: num(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
    reasoning_tokens: num(usage.reasoning_tokens ?? usage.reasoningTokens ?? usage.reasoning?.tokens),
    cache_read_input_tokens: num(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cached_input_tokens),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return Object.keys(out).length ? out : null;
}

/* ── Claude Code ──────────────────────────────────────────────────────────── */

function adaptClaudeCode(records) {
  const e = new Events('claude-code');
  const meta = {
    harness: { name: 'claude-code' },
    model: {}, reasoning: { mode: null, effort: null, visible: null, encrypted: false }, params: {},
  };

  for (const record of records) {
    const message = record.message;

    if (record.type === 'mode' || record.type === 'permission-mode') {
      if (!meta.permissionMode) meta.permissionMode = record.mode ?? record.permissionMode ?? null;
      e.skip(record.type);
      continue;
    }

    if (record.type !== 'user' && record.type !== 'assistant' && record.type !== 'system') {
      e.skip(record.type ?? 'unknown');
      continue;
    }

    if (record.swiftVersion) meta.harness.version = record.swiftVersion;
    const at = record.timestamp ?? message?.timestamp;
    const blocks = Array.isArray(message?.content) ? message.content : [];

    if (record.type === 'system') {
      const text = textOf(message?.content ?? record.content);
      if (text) e.push('system.message', at, { text, applies_to_run: false });
      else e.skip('system:empty');
      continue;
    }

    if (record.isMeta === true) {
      // Local-command caveats and other UI injections are not part of the task.
      e.skip('user:isMeta');
      continue;
    }

    if (record.type === 'user') {
      const toolResults = blocks.filter((b) => b?.type === 'tool_result');
      const prose = typeof message.content === 'string' ? message.content : textOf(blocks.filter((b) => b?.type === 'text'));
      if (prose.trim()) {
        e.push('user.message', at, {
          text: prose,
          ...(e.list.some((x) => x.type === 'user.message') ? {} : { original_prompt: true }),
        });
      }
      for (const block of toolResults) {
        e.push('tool.result', at, {
          call_id: block.tool_use_id ?? pairId(e, null, null),
          status: block.is_error ? 'error' : 'ok',
          output: textOf(block.content),
        });
      }
      if (!prose.trim() && !toolResults.length) e.skip('user:empty');
      continue;
    }

    // assistant
    if (message?.model) meta.model.id = message.model;
    if (message?.usage) {
      const usage = normalizeUsage(message.usage);
      if (usage) meta.usage = { ...(meta.usage ?? {}), ...usage };
    }
    const sidechain = record.isSidechain === true;

    for (const block of blocks) {
      const extra = sidechain ? { subagent: true } : {};
      if (block?.type === 'thinking') {
        const text = block.thinking ?? '';
        e.push('assistant.thinking', at, { text, encrypted: text.trim() === '' && Boolean(block.signature), signature: block.signature ?? null, ...extra });
        meta.reasoning.visible = true;
      } else if (block?.type === 'redacted_thinking') {
        e.push('assistant.thinking', at, { text: '', encrypted: true, signature: block.data ?? null, ...extra });
      } else if (block?.type === 'text') {
        e.push('assistant.message', at, { text: block.text ?? '', model: message?.model ?? null, usage: normalizeUsage(message?.usage), stop_reason: message?.stop_reason ?? null, ...extra });
      } else if (block?.type === 'tool_use') {
        e.push('tool.call', at, { call_id: block.id ?? null, name: block.name ?? 'unknown', input: parseArgs(block.input), input_text: flattenInput(parseArgs(block.input)), ...extra });
      } else if (block) {
        e.skip(`claude-code:assistant-block:${block.type ?? 'unknown'}`);
      }
    }
    if (!blocks.length) e.skip('claude-code:assistant:empty');
  }

  return finish(e, meta);
}

/* ── Codex ────────────────────────────────────────────────────────────────── */

function adaptCodex(records) {
  const e = new Events('codex');
  const meta = { harness: { name: 'codex' }, model: {}, reasoning: { mode: null, effort: null, visible: null, encrypted: false }, params: {} };

  for (const record of records) {
    const t = record.timestamp;
    if (record.type === 'session_meta') {
      const p = record.payload ?? {};
      meta.promptId = p.session_id ?? p.id ?? null;
      meta.cwd = p.cwd ?? null;
      meta.harness.version = p.cli_version ?? null;
      meta.harness.originator = p.originator ?? p.source ?? null;
      meta.model.provider = p.model_provider ?? null;
      if (p.base_instructions?.text) {
        e.push('system.message', t, { text: p.base_instructions.text, applies_to_run: true });
      }
      continue;
    }

    if (record.type === 'turn_context') {
      const p = record.payload ?? {};
      if (p.model) meta.model.id = p.model;
      if (p.effort || p.reasoning_effort) meta.reasoning.effort = p.effort ?? p.reasoning_effort;
      if (p.cwd && !meta.cwd) meta.cwd = p.cwd;
      e.skip('turn_context');
      continue;
    }

    if (record.type !== 'response_item') {
      e.skip(record.type ?? 'unknown');
      continue;
    }

    const p = record.payload ?? {};
    switch (p.type) {
      case 'message': {
        if (p.role === 'developer' || p.role === 'system') {
          const text = textOf(p.content);
          if (text) e.push('system.message', t, { text, applies_to_run: true });
          else e.skip('codex:message:empty');
          break;
        }
        const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : null;
        if (!role) { e.skip(`codex:message-role:${p.role ?? 'unknown'}`); break; }
        const text = textOf(p.content);
        if (!text) { e.skip('codex:message:empty'); break; }
        if (role === 'user') {
          e.push('user.message', t, { text, ...(e.list.some((x) => x.type === 'user.message') ? {} : { original_prompt: true }) });
        } else {
          e.push('assistant.message', t, { text, model: meta.model.id ?? null });
        }
        break;
      }

      case 'reasoning': {
        const summary = textOf(p.summary);
        const encrypted = Boolean(p.encrypted_content) && !summary.trim();
        e.push('assistant.thinking', t, {
          text: summary || textOf(p.content),
          encrypted,
          signature: p.encrypted_content ?? null,
        });
        if (!encrypted) meta.reasoning.visible = true;
        else if (meta.reasoning.visible === null) meta.reasoning.visible = false;
        break;
      }

      case 'function_call': {
        const input = parseArgs(p.arguments);
        e.push('tool.call', t, { call_id: p.call_id ?? p.id ?? null, name: p.name ?? 'unknown', input, input_text: flattenInput(input) });
        break;
      }

      case 'function_call_output':
        e.push('tool.result', t, {
          call_id: p.call_id ?? p.id ?? null,
          status: p.status === 'failed' ? 'error' : 'ok',
          output: textOf(p.output),
        });
        break;

      default:
        e.skip(`codex:response_item:${p.type ?? 'unknown'}`);
    }
  }

  return finish(e, meta);
}

/* ── OpenAI ───────────────────────────────────────────────────────────────── */

function adaptOpenai(input) {
  const e = new Events('openai');
  const meta = { harness: { name: 'openai' }, model: {}, reasoning: { mode: null, effort: null, visible: null, encrypted: false }, params: {} };
  const { request, responses } = splitRequestResponse(input);
  const chunks = responses.flatMap((r) => (r && typeof r === 'object' && Array.isArray(r._stream) ? r._stream : [r]));

  if (request) {
    meta.model.id = request.model ?? null;
    if (request.instructions) e.push('system.message', null, { text: request.instructions, applies_to_run: true });
    if (request.reasoning?.effort) meta.reasoning = { ...meta.reasoning, mode: 'enabled', effort: request.reasoning.effort, visible: false };
    if (request.reasoning?.summary) meta.reasoning.mode = `enabled (summary=${request.reasoning.summary})`;
    for (const key of ['temperature', 'top_p', 'max_tokens', 'max_output_tokens', 'seed', 'stop']) {
      if (request[key] !== undefined) meta.params[key] = request[key];
    }
    if (Array.isArray(request.tools) && request.tools.length) meta.tools = request.tools.map((t) => t?.function?.name ?? t?.name ?? 'tool').filter(Boolean);
    for (const message of Array.isArray(request.input) ? request.input : Array.isArray(request.messages) ? request.messages : []) {
      if (message?.role === 'user') {
        e.push('user.message', null, { text: textOf(message.content), ...(e.list.some((x) => x.type === 'user.message') ? {} : { original_prompt: true }) });
      } else if (message?.type === 'function_call_output') {
        e.push('tool.result', null, { call_id: message.call_id ?? null, status: 'ok', output: textOf(message.output) });
      } else if (message?.type === 'function_call') {
        e.push('tool.call', null, { call_id: message.call_id ?? null, name: message.name ?? 'unknown', input: parseArgs(message.arguments), input_text: flattenInput(parseArgs(message.arguments)) });
      } else if (message?.role === 'assistant' && typeof message.content === 'string') {
        e.push('assistant.message', null, { text: message.content, model: request.model ?? null });
      }
    }
  }

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.model) meta.model.id = chunk.model;

    // Responses API
    if (Array.isArray(chunk.output)) {
      if (chunk.usage) {
        const usage = normalizeUsage(chunk.usage);
        if (usage) meta.usage = usage;
      }
      for (const item of chunk.output) {
        if (item.type === 'reasoning') {
          const summary = textOf(item.summary);
          const encrypted = !summary.trim() && Boolean(item.encrypted_content);
          e.push('assistant.thinking', null, { text: summary, encrypted, signature: item.encrypted_content ?? null });
          if (!encrypted) meta.reasoning.visible = true;
        } else if (item.type === 'message') {
          e.push('assistant.message', null, { text: textOf(item.content), model: chunk.model ?? null });
        } else if (item.type === 'function_call') {
          const input = parseArgs(item.arguments);
          e.push('tool.call', null, { call_id: item.call_id ?? item.id ?? null, name: item.name ?? 'unknown', input, input_text: flattenInput(input) });
        } else {
          e.skip(`openai:output:${item.type ?? 'unknown'}`);
        }
      }
      continue;
    }

    // Chat Completions (full or streamed delta)
    const choice = chunk.choices?.[0];
    if (!choice) { e.skip('openai:chunk:no-choices'); continue; }
    const part = choice.message ?? choice.delta ?? {};
    if (chunk.usage) {
      const usage = normalizeUsage(chunk.usage);
      if (usage) meta.usage = usage;
    }
    const reasoningText = part.reasoning_content ?? part.reasoning ?? '';
    if (reasoningText) {
      if (reasoningText.trim()) {
        const previous = e.list[e.list.length - 1];
        if (chunk._delta && previous?.type === 'assistant.thinking') previous.text += reasoningText;
        else e.push('assistant.thinking', null, { text: reasoningText, encrypted: false, signature: null });
        meta.reasoning.visible = true;
      }
      meta.reasoning.mode ??= 'enabled';
    }
    const content = typeof part.content === 'string' ? part.content : textOf(part.content);
    if (content) {
      const previous = e.list[e.list.length - 1];
      if (chunk._delta && previous?.type === 'assistant.message') previous.text += content;
      else e.push('assistant.message', null, { text: content, model: chunk.model ?? null, stop_reason: choice.finish_reason ?? null });
    }
    for (const call of part.tool_calls ?? []) {
      const fn = call.function ?? {};
      if (chunk._delta && call.index !== undefined) {
        const existing = e.list.find((x) => x.type === 'tool.call' && x.call_id === call.id);
        if (existing && !call.id) { existing.input_text += fn.arguments ?? ''; break; }
      }
      const input = parseArgs(fn.arguments);
      e.push('tool.call', null, { call_id: call.id ?? null, name: fn.name ?? 'unknown', input, input_text: flattenInput(input) });
    }
  }

  return finish(e, meta);
}

/* ── Anthropic Messages ───────────────────────────────────────────────────── */

function adaptAnthropic(input) {
  const e = new Events('anthropic');
  const meta = { harness: { name: 'anthropic-messages' }, model: {}, reasoning: { mode: null, effort: null, visible: null, encrypted: false }, params: {} };
  const { request, responses } = splitRequestResponse(input);

  if (request) {
    meta.model.id = request.model ?? null;
    const system = typeof request.system === 'string' ? request.system : textOf(request.system);
    if (system) e.push('system.message', null, { text: system, applies_to_run: true });
    const thinking = request.thinking ?? request.reasoning;
    if (thinking?.type === 'enabled') meta.reasoning = { ...meta.reasoning, mode: 'extended', budget_tokens: thinking.budget_tokens ?? null, effort: thinking.effort ?? null };
    else if (thinking?.type === 'disabled') meta.reasoning = { ...meta.reasoning, mode: 'off' };
    for (const key of ['temperature', 'top_p', 'top_k', 'max_tokens', 'stop_sequences']) {
      if (request[key] !== undefined) meta.params[key] = request[key];
    }
    if (Array.isArray(request.tools)) meta.tools = request.tools.map((t) => t?.name ?? 'tool').filter(Boolean);
    for (const message of request.messages ?? []) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      if (message.role === 'user') {
        const prose = typeof message.content === 'string' ? message.content : textOf(blocks.filter((b) => b?.type === 'text'));
        if (prose.trim()) {
          e.push('user.message', null, { text: prose, ...(e.list.some((x) => x.type === 'user.message') ? {} : { original_prompt: true }) });
        }
        for (const block of blocks) {
          if (block?.type === 'tool_result') {
            e.push('tool.result', null, { call_id: block.tool_use_id ?? null, status: block.is_error ? 'error' : 'ok', output: textOf(block.content) });
          }
        }
      } else if (message.role === 'assistant') {
        for (const block of blocks) emitAnthropicBlock(e, block, null, meta, message.model ?? request.model ?? null);
      }
    }
  }

  for (const response of responses) {
    if (!response || typeof response !== 'object') continue;
    const model = response.model ?? meta.model.id ?? null;
    if (response.model) meta.model.id = response.model;
    if (response.usage) {
      const usage = normalizeUsage(response.usage);
      if (usage) meta.usage = usage;
    }
    for (const block of Array.isArray(response.content) ? response.content : []) {
      emitAnthropicBlock(e, block, response.stop_reason ?? null, meta, model);
    }
  }

  return finish(e, meta);
}

function emitAnthropicBlock(e, block, stopReason, meta, model) {
  if (!block || typeof block !== 'object') return;
  switch (block.type) {
    case 'thinking': {
      const text = block.thinking ?? '';
      const encrypted = text.trim() === '' && Boolean(block.signature);
      e.push('assistant.thinking', null, { text, encrypted, signature: block.signature ?? null });
      meta.reasoning.visible = !encrypted;
      break;
    }
    case 'redacted_thinking':
      e.push('assistant.thinking', null, { text: '', encrypted: true, signature: block.data ?? null });
      meta.reasoning.visible = false;
      break;
    case 'text':
      e.push('assistant.message', null, { text: block.text ?? '', model, stop_reason: stopReason });
      break;
    case 'tool_use':
      e.push('tool.call', null, { call_id: block.id ?? null, name: block.name ?? 'unknown', input: parseArgs(block.input), input_text: flattenInput(parseArgs(block.input)) });
      break;
    default:
      e.skip(`anthropic:block:${block.type ?? 'unknown'}`);
  }
}

/** Input may be a bare response, an array of responses, or `{request, response}`. */
function splitRequestResponse(input) {
  if (Array.isArray(input)) {
    // `{request, response}` pairs, or just responses
    const responses = [];
    let request = null;
    for (const item of input) {
      if (item && typeof item === 'object' && (item.request || item.response)) {
        request ??= item.request ?? null;
        if (item.response) responses.push(item.response);
      } else {
        responses.push(item);
      }
    }
    return { request, responses: normalizeToArray(responses) };
  }
  if (input && typeof input === 'object') {
    if (input.request || input.response) {
      return { request: input.request ?? null, responses: normalizeToArray(input.response ?? input.responses) };
    }
    return { request: null, responses: [input] };
  }
  return { request: null, responses: [] };
}

const normalizeToArray = (value) => (Array.isArray(value) ? value.flatMap(normalizeToArray) : value ? [value] : []);

/* ── generic ──────────────────────────────────────────────────────────────── */

function adaptGeneric(input) {
  const e = new Events('generic');
  const meta = { harness: { name: 'generic' }, model: {}, reasoning: { mode: null, effort: null, visible: null, encrypted: false }, params: {} };

  const messages = Array.isArray(input) ? input
    : Array.isArray(input?.messages) ? input.messages
      : Array.isArray(input?.input) ? input.input
        : input?.input && input?.output ? [{ role: 'user', content: input.input }, { role: 'assistant', content: input.output }]
          : input?.output ? [{ role: 'assistant', content: input.output }]
            : null;

  if (!messages) {
    throw new Error('generic adapter needs an array of messages, {messages:[…]}, {request,response}, or {input,output}');
  }

  if (input && !Array.isArray(input)) {
    meta.model.id = input.model ?? input.model_id ?? null;
    if (input.harness) meta.harness = typeof input.harness === 'string' ? { name: input.harness } : input.harness;
    if (input.reasoning_mode ?? input.reasoningMode) meta.reasoning.mode = input.reasoning_mode ?? input.reasoningMode;
    for (const key of ['temperature', 'top_p', 'max_tokens', 'seed']) {
      if (input[key] !== undefined) meta.params[key] = input[key];
    }
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') { e.skip('generic:non-object'); continue; }
    const at = message.timestamp ?? message.t ?? null;
    const role = message.role ?? message.type;
    const blocks = Array.isArray(message.content) ? message.content : [];

    if (role === 'system') {
      const text = textOf(message.content);
      if (text) e.push('system.message', at, { text, applies_to_run: true });
      else e.skip('generic:system:empty');
      continue;
    }

    if (role === 'user') {
      const prose = typeof message.content === 'string' ? message.content : textOf(blocks.filter((b) => b?.type === 'text' || typeof b === 'string'));
      if (prose.trim()) {
        e.push('user.message', at, { text: prose, ...(e.list.some((x) => x.type === 'user.message') ? {} : { original_prompt: true }) });
      }
      for (const block of blocks) {
        if (block?.type === 'tool_result') {
          e.push('tool.result', at, { call_id: block.tool_use_id ?? block.id ?? null, status: block.is_error ? 'error' : 'ok', output: textOf(block.content ?? block.output) });
        }
      }
      continue;
    }

    if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
      e.push('tool.result', at, {
        call_id: message.tool_call_id ?? message.toolCallId ?? message.tool_use_id ?? null,
        name: message.name ?? message.toolName ?? null,
        status: message.is_error || message.error ? 'error' : 'ok',
        output: textOf(message.content ?? message.output),
      });
      continue;
    }

    if (role !== 'assistant') { e.skip(`generic:role:${role ?? 'unknown'}`); continue; }

    if (typeof message.content === 'string' && message.content.trim()) {
      e.push('assistant.message', at, { text: message.content, model: message.model ?? null });
    }
    for (const block of blocks) {
      if (block?.type === 'thinking' || block?.type === 'reasoning') {
        const text = block.thinking ?? block.reasoning ?? block.text ?? '';
        e.push('assistant.thinking', at, { text, encrypted: text.trim() === '' && Boolean(block.signature ?? block.encrypted_content), signature: block.signature ?? block.encrypted_content ?? null });
        if (text.trim()) meta.reasoning.visible = true;
      } else if (block?.type === 'redacted_thinking') {
        e.push('assistant.thinking', at, { text: '', encrypted: true, signature: block.data ?? null });
      } else if (block?.type === 'text') {
        e.push('assistant.message', at, { text: block.text ?? '', model: message.model ?? null });
      } else if (block?.type === 'tool_use' || block?.type === 'toolCall') {
        const input = parseArgs(block.input ?? block.arguments);
        e.push('tool.call', at, { call_id: block.id ?? null, name: block.name ?? 'unknown', input, input_text: flattenInput(input) });
      } else if (typeof block === 'string') {
        if (block.trim()) e.push('assistant.message', at, { text: block, model: message.model ?? null });
      } else if (block) {
        e.skip(`generic:assistant-block:${block.type ?? 'unknown'}`);
      }
    }
    for (const call of message.tool_calls ?? []) {
      const fn = call.function ?? {};
      const input = parseArgs(fn.arguments ?? call.arguments);
      e.push('tool.call', at, { call_id: call.id ?? null, name: fn.name ?? call.name ?? 'unknown', input, input_text: flattenInput(input) });
    }
    if (message.reasoning_content ?? message.reasoning) {
      const text = message.reasoning_content ?? message.reasoning;
      e.push('assistant.thinking', at, { text: String(text), encrypted: false, signature: null });
      meta.reasoning.visible = true;
    }
  }

  return finish(e, meta);
}

/* ── finish + dispatch ────────────────────────────────────────────────────── */

function finish(events, meta) {
  const thinking = events.list.filter((x) => x.type === 'assistant.thinking');
  if (meta.reasoning.visible === null) {
    meta.reasoning.visible = thinking.some((x) => !x.encrypted && x.text?.trim());
  }
  meta.reasoning.encrypted = thinking.some((x) => x.encrypted);
  const blank = thinking.filter((x) => !x.text?.trim());
  if (blank.length && !meta.reasoning.encrypted) meta.reasoning.note = `${blank.length} empty reasoning block(s)`;

  const final = events.lastAssistantMessage();
  return {
    meta,
    events: events.list,
    unmapped: events.unmapped,
    finalOutput: final?.text ?? null,
    firstTimestamp: events.first,
    lastTimestamp: events.last,
    counts: {
      thinking_blocks: thinking.length,
      encrypted_thinking_blocks: thinking.filter((x) => x.encrypted).length,
      assistant_messages: events.list.filter((x) => x.type === 'assistant.message').length,
      tool_calls: events.list.filter((x) => x.type === 'tool.call').length,
      tool_errors: events.list.filter((x) => x.type === 'tool.result' && x.status === 'error').length,
      user_messages: events.list.filter((x) => x.type === 'user.message').length,
    },
  };
}

export function detectFormat(text, hint = 'auto') {
  if (hint && hint !== 'auto') return hint;
  const lines = text.split('\n').filter((l) => l.trim()).slice(0, 40);
  const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const types = new Set(records.map((r) => r.type).filter(Boolean));

  if (types.has('session_meta') || records.some((r) => r?.payload?.encrypted_content !== undefined || r?.payload?.type === 'response_item')) return 'codex';
  if (types.has('session') && (types.has('message') || types.has('model_change') || types.has('thinking_level_change'))) return 'pi';
  if (records.some((r) => r?.parentUuid !== undefined || r?.promptId !== undefined || r?.isSidechain !== undefined)) return 'claude-code';

  const parsed = records.length > 1 ? records : (() => { try { return [JSON.parse(text)]; } catch { return []; } })();
  const one = parsed.find((r) => r && typeof r === 'object');
  if (one) {
    if (Array.isArray(one.output) && one.output.some((o) => o?.type === 'reasoning' || o?.type === 'message')) return 'openai';
    if (Array.isArray(one.choices)) return 'openai';
    if (one.request || one.response) {
      const inner = one.response ?? one.request;
      if (Array.isArray(inner?.content)) return 'anthropic';
      if (Array.isArray(inner?.output) || Array.isArray(inner?.choices)) return 'openai';
    }
    if (Array.isArray(one.content) && (one.stop_reason !== undefined || one.type === 'message')) return 'anthropic';
    if (Array.isArray(one.messages) || Array.isArray(one.input)) {
      const nested = one.messages?.[0] ?? one.input?.[0];
      if (nested?.type === 'function_call_output') return 'openai';
      if (Array.isArray(nested?.content) && nested.content.some((b) => b?.type === 'thinking')) return 'anthropic';
      return 'generic';
    }
  }
  if (types.has('message') || types.size) return 'generic';
  throw new Error('could not determine the transcript format — pass --format');
}

/** OpenAI streaming logs are `data: {…}` event streams. */
export function parseSse(text) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join('');
    if (payload === '[DONE]') break;
    try {
      const chunk = JSON.parse(payload);
      chunk._delta = true;
      out.push(chunk);
    } catch { /* ignore keepalives */ }
  }
  return out;
}

/** Parse the raw log into records, tolerating JSONL, a single JSON doc, or SSE. */
export function parseRecords(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/^data:\s*\{/.test(trimmed) || trimmed.includes('\ndata: {')) {
    return parseSse(trimmed).map((chunk) => {
      const { _delta, ...rest } = chunk;
      return { ...rest, _stream: [chunk] };
    });
  }
  const lines = trimmed.split('\n').filter((l) => l.trim());
  const records = [];
  let parsedAsJsonl = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
      parsedAsJsonl++;
    } catch {
      records.length = 0;
      break;
    }
  }
  if (parsedAsJsonl === lines.length && records.length) return records;
  return [JSON.parse(trimmed)];
}

export function adapt(text, { format = 'auto', sourcePath = null } = {}) {
  const resolved = detectFormat(text, format);
  const records = parseRecords(text);
  const result = { format: resolved, sourcePath };
  switch (resolved) {
    case 'pi': Object.assign(result, adaptPi(records)); break;
    case 'claude-code': Object.assign(result, adaptClaudeCode(records)); break;
    case 'codex': Object.assign(result, adaptCodex(records)); break;
    case 'openai': Object.assign(result, adaptOpenai(records.length > 1 && !records[0]?._stream ? records : records[0])); break;
    case 'anthropic': Object.assign(result, adaptAnthropic(records.length > 1 && !records[0]?.request ? records : records[0])); break;
    case 'generic': Object.assign(result, adaptGeneric(records.length === 1 ? records[0] : records)); break;
    default: throw new Error(`unknown format "${resolved}"`);
  }
  return result;
}
