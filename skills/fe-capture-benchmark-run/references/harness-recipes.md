# Harness recipes

Where each harness keeps its log, what the records look like, and how they map to
`bench-run/1` (see `transcript-format.md`). Shapes below were verified against
real session files, not documentation.

## Sniff the format

```bash
# what am I looking at?
f=$HOME/.pi/agent/sessions/--Users-me-proj--/2026-06-21T10-12-00Z_abc.jsonl
python3 -c "import json,sys,collections; print(collections.Counter(json.loads(l).get('type') for l in open(sys.argv[1]) if l.strip()))" "$f"
head -c 400 "$f"
```

| Fingerprint in the first lines | Adapter |
|---|---|
| `{"type":"session","version":3,…}` then `model_change` / `message` | `pi` |
| `{"type":"user","message":{…}}` with `parentUuid`, `promptId`, `isSidechain` | `claude-code` |
| `{"type":"session_meta","payload":{…}}` + `response_item` / `event_msg` | `codex` |
| `choices[0].message` or `output[0].type == "reasoning"` | `openai` |
| `content[0].type == "thinking"` with `signature`, top-level `stop_reason` | `anthropic` |
| anything else with `role`/`content` per line | `generic` |

---

## pi

**Where** `~/.pi/agent/sessions/<cwd-slug>/<ISO-timestamp>_<uuid>.jsonl`
The slug is the working directory with `/` replaced by `-`
(`/Users/me/proj` → `--Users-me-proj--`). `pi --continue` appends to the same file.

**Records**

```jsonc
{"type":"session","version":3,"id":"01a0da1c-…","timestamp":"…","cwd":"/Users/me/proj"}
{"type":"model_change","provider":"anthropic","modelId":"claude-sonnet-4.5"}
{"type":"thinking_level_change","thinkingLevel":"high"}
{"type":"message","message":{"role":"…","content":[…],"timestamp":1790365787523,…}}
```

`message.content` blocks: `{type:"text",text}`, `{type:"thinking",thinking,thinkingSignature}`,
`{type:"toolCall",id,name,arguments}`.
`role` is one of `system` (carries a `sections` object with `preamble`/`tools`),
`user`, `assistant`, `toolResult`
(`{toolCallId,toolName,content:[{type:"text",text}],isError}`).
Assistant messages carry `api`, `provider`, `model`, `usage`, `stopReason`,
`responseId`.

**Mapping**

| pi | canonical |
|---|---|
| `session` | `run.start.prompt_id` (its `id`), `run.start.cwd` |
| `model_change` | `run.start.model.{provider,id}` |
| `thinking_level_change` | `run.start.reasoning.mode` / `.effort` |
| `message` / `role:system` | `system.message` (join `sections`) |
| `message` / `role:user` (first) | `user.message` with `original_prompt: true` |
| `message` / `role:assistant` + `text` | `assistant.message` |
| `message` / `role:assistant` + `thinking` | `assistant.thinking` |
| `message` / `role:assistant` + `toolCall` | `tool.call` |
| `message` / `role:toolResult` | `tool.result` (`isError` → `status: "error"`) |

**Gotchas**

- `timestamp` is **milliseconds**; other fields are ISO strings.
- Thinking is frequently `{"thinking":"","thinkingSignature":"[{\"type\":\"reasoning.encrypted\",…}]"}` —
  empty prose, real ciphertext. Emit the event with `encrypted: true`.
- One assistant message may interleave `thinking`, `text` and several `toolCall`
  blocks. Emit them in block order, incrementing `seq`.
- Reasoning levels are also reported in `/model` output; trust the
  `thinking_level_change` record.

---

## Claude Code

**Where** `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
Slug is the cwd with `/` → `-`, without the surrounding dashes pi uses
(`/Users/me/proj` → `-Users-me-proj`).

**Records** — `user`, `assistant`, `system`, plus high-volume bookkeeping:
`attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`,
`file-history-snapshot`, `file-history-delta`, `cost-state`, `atis-latch`.
All of the latter belong in `raw` or are dropped count-wise into
`run.start.source.unmapped`.

```jsonc
{"parentUuid":"…","isSidechain":false,"message":{"role":"assistant",
  "model":"claude-opus-5-5","id":"msg_…","content":[…],"usage":{…},"stop_reason":"…"}}
```

Content blocks: `{type:"text",text}`, `{type:"thinking",thinking,signature}`,
`{type:"tool_use",id,name,input}`, `{type:"tool_result",tool_use_id,content,is_error}`.

**Mapping**

| Claude Code | canonical |
|---|---|
| first `user` with a string `content` | `user.message` + `original_prompt: true` |
| `user` whose `content` blocks are `tool_result` | `tool.result` (skip `isMeta: true` UI caveats, or `system.message` with `applies_to_run: false`) |
| `assistant` + `thinking` | `assistant.thinking` |
| `assistant` + `text` | `assistant.message` (`model` from `message.model`) |
| `assistant` + `tool_use` | `tool.call` (`input` is already structured) |
| `attachment`, `file-history-*` | not a transcript event — count as unmapped |

**Gotchas**

- Tool results arrive as *user* messages. Do not attribute them to the human, and
  do not let them become `user.message` events.
- `isSidechain: true` records are sub-agent conversations. Keep them (with
  `raw.isSidechain`), but the main chain is what the benchmark grades.
- `<local-command-caveat>` / `isMeta: true` records are harness noise.
- Thinking again often has an empty `thinking` with a long base64 `signature`.
- `cost-state` / `last-prompt` records can repeat hundreds of times; exclude them
  from `raw` dumps to keep `transcript.jsonl` usable, and say so in a `note`.

---

## Codex CLI / Desktop

**Where** `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`

**Records**

```jsonc
{"timestamp":"…","ordinal":0,"type":"session_meta","payload":{
  "session_id":"…","cwd":"/Users/me/proj","originator":"Codex Desktop",
  "cli_version":"0.126.0-alpha.8","model_provider":"openai","base_instructions":{"text":"…"}}}
{"timestamp":"…","ordinal":8,"type":"response_item","payload":{
  "type":"reasoning","summary":[],"content":null,"encrypted_content":"gAAAAAB…"}}
```

`response_item.payload.type` is `message`, `reasoning`, `function_call`, or
`function_call_output`. Other top-level types: `turn_context`, `event_msg`.

**Mapping**

| Codex | canonical |
|---|---|
| `session_meta` | `run.start` (`prompt_id` ← `session_id`, `cwd`, `harness.version` ← `cli_version`, `harness.originator`) |
| `base_instructions.text` | `system.message` |
| `response_item` + `message` role user | `user.message` (first → `original_prompt: true`) |
| `response_item` + `message` role assistant | `assistant.message` |
| `response_item` + `reasoning` | `assistant.thinking` — `summary[].text` if present, else `""` with `encrypted_content` in `signature` and `encrypted: true` |
| `response_item` + `function_call` | `tool.call` (`arguments` is a JSON *string* — parse it, keep the original in `raw`) |
| `response_item` + `function_call_output` | `tool.result` |
| `event_msg`, `turn_context` | unmapped (token counters/UI events) — count them |

**Gotchas**

- `ordinal` gives a reliable order when timestamps are equal.
- Reasoning is encrypted at rest: `content: null`, `summary: []` in older
  versions. `reasoning.visible: false` will be the honest value far more often
  than not.
- Model name is often absent from the rollout — take it from `turn_context` or the
  CLI's `/model` setting, and record where you got it in `run.start.source.note`.

---

## OpenAI API (Chat Completions and Responses)

**Chat Completions** — request + response pair:

```jsonc
// response
{"model":"gpt-5","choices":[{"message":{"role":"assistant","content":"…",
  "reasoning_content":"…","tool_calls":[{"id":"call_1","type":"function",
  "function":{"name":"bash","arguments":"{\"cmd\":\"ls\"}"}}]},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":812,"completion_tokens":96,
          "completion_tokens_details":{"reasoning_tokens":64}}}
```

Reasoning appears as `message.reasoning_content`, `message.reasoning`, or
`choices[].delta.reasoning_content` while streaming. Summon it into
`assistant.thinking` **before** the message on the same `seq` order as the API
emitted it; note in `run.start.source.note` which field name this provider used.

**Responses API** — `output[]` is an ordered array:

| `output[].type` | canonical |
|---|---|
| `reasoning` | `assistant.thinking` — `summary[].text`; `encrypted_content` if the summary is empty |
| `message` → `content[].output_text` | `assistant.message` |
| `function_call` | `tool.call` (`call_id`, `arguments` as a JSON string) |
| `function_call_output` (next request) | `tool.result` |

Include the request's `instructions` as `system.message`, `temperature`/`top_p`
as `run.start.params`, and `reasoning: {effort: "high"}` as
`run.start.reasoning.effort`. `usage.output_tokens_details.reasoning_tokens`
feeds `run.end.usage.reasoning_tokens`.

**Streaming**: accumulate deltas by `choices[0].index` / `output_index` and
reassemble before adapting. Keep the raw SSE chunk log in `media/raw/` — it is the
only evidence of the true interleaving of reasoning and tool calls.

---

## Anthropic API (Messages)

```jsonc
// response
{"id":"msg_01…","model":"claude-sonnet-4-5","role":"assistant",
 "content":[{"type":"thinking","thinking":"…","signature":"EqQBCgIY…"},
            {"type":"text","text":"…"},
            {"type":"tool_use","id":"toolu_01…","name":"bash","input":{"cmd":"ls"}}],
 "stop_reason":"tool_use",
 "usage":{"input_tokens":812,"output_tokens":96}}
```

Tool results come back in the **next request** as user messages containing
`{type:"tool_result",tool_use_id,content,is_error}` — pair them by `tool_use_id`.

Extended thinking settings live on the *request*:
`"thinking":{"type":"enabled","budget_tokens":8000}` →
`run.start.reasoning = {mode:"extended", budget_tokens:8000, effort:null}`.
`"type":"disabled"` → `mode:"off"`. Preserve the `signature` on thinking blocks:
it is the only proof of what was actually generated. Redacted thinking arrives as
`{"type":"redacted_thinking","data":"…"}` → `encrypted: true`.

---

## Generic / custom harness

Aim for the smallest thing that satisfies `bench-run/1`:

```jsonl
{"seq":0,"type":"run.start","model":{"id":"my-finetune-v3"},"harness":{"name":"evalkit","version":"1.2"},"reasoning":{"mode":"none","visible":true}}
{"seq":1,"type":"user.message","text":"…","original_prompt":true}
{"seq":2,"type":"assistant.message","text":"…"}
{"seq":3,"type":"run.end","status":"complete","output":"…"}
```

If your harness logs something richer, add the fields you have and push the rest
into `raw`. The `generic` adapter also accepts:

- `{"messages":[{"role":"user","content":"…"},…]}` (one JSON object or JSONL)
- `{"request":{…},"response":{…}}`
- `{"input":"…","output":"…"}`
- CSV/pasted prose — **not** auto-adaptable; transcribe it by hand and mark the
  run `note kind: context` explaining the manual step.

**If the harness has no accessible log** (closed UI, no export), say so plainly:
reconstruct nothing. Capture what you *do* have (prompt, final answer,
screenshots, model name from the UI) and add
`{"type":"note","kind":"caveat","text":"Reasoning not exposed by this harness; transcript rebuilt from the prompt, final answer and screenshots."}`
An honestly-labelled partial record beats a fabricated complete one.
