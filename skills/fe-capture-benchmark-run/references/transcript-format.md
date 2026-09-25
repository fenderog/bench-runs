# Canonical transcript format — `bench-run/1`

`transcript.jsonl`: one JSON object per line, UTF-8, `\n`-terminated, no BOM, no
pretty-printing. Written once and never edited. Anything that does not fit the
schema goes in a `raw` field rather than being dropped.

## Common fields

Every event:

| Field | Type | Notes |
|---|---|---|
| `seq` | int | Monotonic from 0, no gaps, no reordering. The tie-breaker for everything. |
| `type` | string | One of the event types below. |
| `t` | string \| null | ISO-8601 UTC timestamp from the harness, or `null` if it has none. Never a guess. |
| `raw` | object \| null | The original unmapped record, attached when the adapter could not represent part of it. |

`seq` is the source of truth for ordering. Timestamps are often seconds-resolution,
equal across concurrent tool calls, or local-time; never sort by `t`.

## Events

### `run.start` — first line, exactly one

```json
{"seq":0,"type":"run.start","t":"2026-06-21T10:12:00.000Z","schema":"bench-run/1",
 "prompt_id":"01a0da1c-5258-7444-bf13-95108a8317b3",
 "harness":{"name":"pi","version":"0.4.2","invocation":"pi -p …","originator":"cli"},
 "model":{"id":"anthropic/claude-sonnet-4.5","provider":"openrouter"},
 "reasoning":{"mode":"high","effort":"high","budget_tokens":8000,
              "visible":true,"encrypted":false},
 "params":{"temperature":0,"top_p":1,"max_tokens":1024,"seed":7},
 "tools":["bash","read","edit","grep"],
 "cwd":"/Users/me/proj",
 "source":{"path":"~/.pi/agent/sessions/…jsonl","sha256":"…","bytes":123456,"format":"pi"}}
```

`reasoning.visible` and `reasoning.encrypted` are the two most misreported fields
in benchmark write-ups. Set `visible: false` when the harness ran reasoning but
did not disclose it to the transcript; set `encrypted: true` when ciphertext is
present. Both may be true at once.

### `system.message` — zero or more

```json
{"seq":1,"type":"system.message","t":null,"text":"You are …","applies_to_run":true}
```

Usually huge and usually identical across runs. Keep it if it is available:
a system prompt determines the result as much as the model does. Set
`applies_to_run: false` for harness boilerplate that is not part of the task
(e.g. a UI caveat injected by the tool).

### `user.message` — the task prompt

```json
{"seq":2,"type":"user.message","t":"2026-06-21T10:12:03.412Z","text":"Solve …",
 "original_prompt":true}
```

Exactly one event carries `original_prompt: true`: the task as the benchmark
defines it. Later human turns are ordinary `user.message` events without the
flag. For a synthetic prompt, add `"synthetic": true` and explain the construction
in `notes.md`.

### `assistant.thinking` — one per reasoning block

```json
{"seq":3,"type":"assistant.thinking","t":"2026-06-21T10:12:05.900Z",
 "text":"I should check …","encrypted":false,"signature":null,"tokens":412}
```

Never merge consecutive thinking blocks. When the harness returns an empty
`thinking` string with a non-empty `signature` (pi, Claude Code) or an
`encrypted_content` blob (Codex), emit the event with
`"text":"", "encrypted":true, "signature":"<the blob>"`. Do not paraphrase, and
do not delete the block.

### `assistant.message`

```json
{"seq":4,"type":"assistant.message","t":"2026-06-21T10:12:06.500Z","text":"The answer is 42.",
 "model":"anthropic/claude-sonnet-4.5","usage":{"input_tokens":812,"output_tokens":96},
 "stop_reason":"end_turn"}
```

Also use this for visible text emitted alongside tool calls. Content that is
neither text, thinking nor a tool call (images, audio, citations) goes in `raw`
with a short `summary` of what it was.

### `tool.call` / `tool.result`

```json
{"seq":5,"type":"tool.call","t":"2026-06-21T10:12:07.000Z","call_id":"call_01a0…",
 "name":"bash","input":{"command":"ls -la"},"input_text":"ls -la"}
{"seq":6,"type":"tool.result","t":"2026-06-21T10:12:07.400Z","call_id":"call_01a0…",
 "status":"ok","output":"total 0\n…","truncated":false,"original_bytes":812}
```

- `call_id` must match between call and result. If the harness supplies none,
  synthesise a stable id (`t7`) and note it in `run.start.source.note`.
- `status`: `ok` | `error` | `timeout` | `denied` | `unknown`.
- `input_text` is a flattened single-line form for grepping; `input` holds the
  structured arguments. Keep both when the harness has both.
- For very large outputs (long command output, big file reads) prefer
  `truncated: true` + `original_bytes` + `output` cut at a documented limit, and
  keep the original in `media/raw/`. Silent truncation is a correctness bug.

### `note` — operator annotations

```json
{"seq":7,"type":"note","t":"2026-06-21T10:20:00.000Z","kind":"intervention",
 "text":"Run cancelled at step 34; agent was looping on the same test."}
```

`kind`: `intervention` | `caveat` | `redaction` | `context`. Notes are how you
record what the transcript cannot show. They are additions, never corrections —
do not rewrite history with them.

### `run.end` — last line, exactly one

```json
{"seq":8,"type":"run.end","t":"2026-06-21T10:24:11.000Z","status":"complete",
 "output":"…final answer as returned…","stop_reason":"end_turn",
 "usage":{"input_tokens":14821,"output_tokens":2013,
          "reasoning_tokens":1420,"cache_read_input_tokens":12000},
 "duration_ms":761000,
 "counts":{"turns":12,"assistant_messages":11,"thinking_blocks":9,
           "tool_calls":14,"tool_errors":2}}
```

Also valid as the last line when things went wrong:

```json
{"seq":8,"type":"run.error","t":"…","status":"failed","error":{"message":"context length exceeded","kind":"context_limit"},
 "output":"partial text emitted before failure"}
```

`status`: `complete` | `partial` | `failed` | `aborted` | `running`. `run.end`
mirrors `run.json.status`, and `output` must be the raw final text — the thing
being graded — not a description of it.

## Coverage rules

1. Events appear in the order the harness produced them. Batched parallel tool
   calls keep call/result pairings by `call_id`, not by adjacency.
2. A field you do not have is absent or `null`. Never `0`, never `"unknown"`,
   never `""` as a stand-in.
3. Counts in `run.end.counts` are derived by counting events. If they disagree
   with the harness's own numbers, the event counts win and the discrepancy goes
   in a `note`.
4. Adapters must be total: every input record either maps to an event or is
   attached as `raw`. Narrate unmapped record types in `run.start.source.unmapped`
   (e.g. `{"event_msg":6,"turn_context":1}`) so nothing disappears quietly.
