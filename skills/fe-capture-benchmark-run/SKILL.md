---
name: fe-capture-benchmark-run
description: Capture a complete, auditable record of an LLM or agent run from any harness (pi, Claude Code, Codex, OpenAI/Anthropic SDKs, LangGraph, or a custom eval script) into a publishable bench-runs result. Preserves the original prompt verbatim, every thinking/reasoning block, all tool calls and results, and the final output, alongside model, harness, and reasoning-mode metadata. Use when asked to log, capture, archive, transcribe, or publish a run, or to turn a session or API trace into a benchmark result.
license: MIT
compatibility: Node 18+. Writes into a bench-runs repo (the one containing public/results/ and scripts/build-manifest.mjs). No network access needed.
metadata:
  version: 1.2.0
  format: bench-run/1
---

# Capture a benchmark run from any harness

Turn one agent/LLM run into a result that a stranger can audit six months from now:
what was asked, what the model thought, what it did, what came out, and on what
stack. The artefact is a folder in a bench-runs repo:

```
public/results/<run-id>/
├── run.json          ← what the website renders
├── transcript.jsonl  ← canonical, machine-readable, lossless timeline
├── transcript.md     ← human-readable rendering (prompt + reasoning + tools + output)
├── prompt.md         ← the original task prompt, verbatim and alone
├── notes.md          ← optional prose: method, caveats
└── media/
    ├── raw/          ← the untouched source session/API log
    └── …             ← screenshots, video, .wasm playables, extra logs
```

The point is **evidence, not summary**. Anyone must be able to verify the claim
"model X with reasoning mode Y scored Z" from the artefacts you ship.

## Non-negotiables

1. **Verbatim or not at all.** Copy prompt, reasoning, tool I/O and output
   character-for-character. Never paraphrase, tidy, translate, re-wrap, or
   "summarise for brevity". If you must shorten, truncate explicitly with
   `truncated: true` and record `original_bytes`, and keep the full version in
   `media/raw/`.
2. **Never invent.** No reconstructed reasoning, no guessed token counts, no
   plausible-looking latency. Omit an unknown field; do not fill it in.
3. **Reasoning that the harness will not disclose is still data.** Many stacks
   return encrypted or redacted reasoning (e.g. an empty `thinking` string next
   to a `signature`, or Codex's `encrypted_content`). Emit an
   `assistant.thinking` event with `encrypted: true`, keep the ciphertext in
   `media/raw/`, and set `reasoning.visible: false` in `run.start`. Silently
   omitting the block would misrepresent the run as having no reasoning.
4. **One run, one folder, one immutable record.** Never edit a captured
   transcript after the fact. Corrections go in `notes.md` as an annotation.
5. **Redact secrets before publishing.** Scan for keys/tokens; a transcript
   contains every command the agent ran and every file it read.

## Step 1 — locate the repo

Find the bench-runs checkout (the directory containing both `public/results/`
and `scripts/build-manifest.mjs`). If the current directory is inside one, use it;
otherwise ask. Everything below is relative to that root.

## Step 2 — find the source session

Session logs are written by the harness, usually under the user's home directory.
See `references/harness-recipes.md` for exact paths and formats, plus the
detection commands, for: **pi**, **Claude Code**, **Codex CLI/Desktop**,
**OpenAI Chat Completions / Responses**, **Anthropic Messages**, and generic
JSONL. If the harness is unknown, ask for the log or the API request/response pair
and use the `generic` adapter.

Capture facts about the *environment* while you still have them — harness version,
reasoning level, sampling parameters, sandbox, GPU. Some of this is only in the
session header or the CLI flags, not in the messages.

## Step 3 — make the run directory first, then capture into it

Every new run gets its own directory before anything else. **Ask first, scaffold
second**: before creating anything, ask the user for the run name and tags with
the interactive question tool (`ask_user_question`) — never invent them.
Ask both in one go:

- **Run name** — the human title for the card and folder slug. Propose your
  best suggestion as the recommended option (e.g. `"<model> — <task>"`);
  the user can also just type their own.
- **Tags** — multi-select from your suggestions (task type, benchmark, topic);
  the user can add their own. Do not ask for the model — it is appended to the
  tags automatically (see below).

Then scaffold it with the repo helper (the capture tool targets the same folder
with `--id`):

```bash
cd /path/to/bench-runs
npm run new -- "Muse Spark — hello-world html" \
  --model muse-spark-1.3-contributor \
  --tags html,hello-world,muse-spark-1.3-contributor
# → public/results/2026-09-25_muse-spark-hello-world-html/
```

Do the work with that folder as home: task artefacts (`.html`, images, video,
`.wasm`, logs) go straight into `<folder>/media/`. `.html` files render on the
site as embedded playables; everything visual stays visible while prompts,
transcripts and raw logs collapse into the audit trail automatically.

Always include the model id in `--tags` — the site's tag chips are how runs get
filtered by model.

Then normalise the source log into the same folder with the bundled capture
tool. `--id` reuses the scaffolded directory and `--force` lets the capture
refresh its own files; hand-placed files under `media/` are left alone. Note
the capture **rewrites `run.json`**, so artefacts only survive via `--media`,
and the graded outcome via `--metrics` — pass them every time:

```bash
node <skill-dir>/scripts/capture-run.mjs \
  --repo /path/to/bench-runs \
  --id 2026-09-25_muse-spark-hello-world-html \
  --force \
  --from ~/.pi/agent/sessions/--Users-me-proj--/2026-06-21T10-12-00Z_abc.jsonl \
  --format pi \
  --title "Muse Spark — hello-world html" \
  --model muse-spark-1.3-contributor \
  --harness "pi 0.87.1" \
  --benchmark hello-world \
  --tags html,hello-world,muse-spark-1.3-contributor \
  --media /tmp/hello-world-media.json \
  --metrics /tmp/hello-world-metrics.json \
  --summary "Two sentences: what ran, what happened, headline number."
```

`--media` is a JSON array of the artefact entries staged in `media/`, e.g.
`[{"type":"playable","src":"media/hello-world.html","caption":"Generated site"}]`.
`--metrics` is the graded outcome, e.g. `{"success":{"value":1,"unit":"%"}}`.

`--format auto` (the default) sniffs the log. If the harness is unsupported,
write the canonical JSONL yourself — the schema is small and specified in
`references/transcript-format.md`.

Then verify before going further:

```bash
node <skill-dir>/scripts/verify-run.mjs public/results/<run-id>
```

It fails on unparseable transcripts, non-monotonic `seq`, missing originals,
missing files, and leaked credentials. Fix what it reports; re-run until clean.

## Step 4 — complete `run.json`

`capture-run.mjs` writes a working skeleton. You must then edit it to add what a
machine cannot know:

- **`summary`** — two sentences: what was run, what happened, what the headline
  number is. This is the only prose most people will read.
- **`metrics`** — the graded outcome. `{ "value": …, "unit": "%", "hint": "…" }`.
  Values ≤ 1 with `"unit": "%"` render as percentages.
- **`environment`** — the reproducibility block. Always include `harness`,
  `harness_version`, `model`, `reasoning_mode`, `decoding`, `tools`, `max_steps`,
  `sandbox`, `hardware`. These are the fields that make a run comparable.
- **`charts`** — only if you have real series data (score per category, latency
  vs. length). Never draw a chart from invented numbers.
- **`media`** — screenshots of the UI, a screen recording, a `.wasm` playable of
  the artefact, external logs. `capture-run.mjs` already wires up `prompt.md`,
  `transcript.md` and `transcript.jsonl`.
- **`notes.md`** — method, extraction rules, known caveats, everything the run
  *cannot* show.

Keep `status` honest: `running` and `partial` exist so a preliminary number is
never mistaken for a final one.

## Step 5 — publish (one command: verify → manifest → push)

```bash
cd /path/to/bench-runs
npm run publish -- <run-id>   # verify-run + manifest + git commit + git push
npm run dev                   # optional: eyeball it at http://127.0.0.1:4173
```

`--no-push` commits without pushing; `--dry-run` prints the steps without
running them; `--message "…"` overrides the default `results: <run-id>` commit
message. The command fails fast — a red verify or manifest build stops before
anything is committed. CI redeploys afterwards; open tabs pick the run up
automatically.

## What "captured everything" means

Before you call a run done, all of these must be answerable from the folder alone:

- [ ] The exact task prompt, byte-identical, in `prompt.md` and in the first
      `user.message` event with `original_prompt: true`
- [ ] Every thinking/reasoning block, in order, with empty/encrypted ones marked
      as such rather than dropped — and `reasoning.visible` telling the truth
- [ ] Every assistant message that produced user-visible output
- [ ] Every tool call with its full input, and every result (errors included) —
      a run whose tools failed is a more interesting record, not a worse one
- [ ] The final output as its own field (`run.end.output`), not inferred
- [ ] Model id, harness + version, reasoning mode/effort/budget, decoding params
- [ ] Usage, duration, step/turn counts, stop reason where the harness reports them
- [ ] The untouched original log in `media/raw/`
- [ ] Zero credentials, zero absolute home paths you are not happy to publish
- [ ] `verify-run.mjs` exits 0

## Reference

- `references/transcript-format.md` — canonical event schema, field by field
- `references/harness-recipes.md` — per-harness paths, shapes, sniffing, gotchas
- `scripts/capture-run.mjs` — adapt + capture into the run folder + write `run.json`
- `scripts/publish-run.mjs` — verify + manifest + commit + push in one step
- `scripts/verify-run.mjs` — validation and secret scanning
- `scripts/transcript-to-md.mjs` — re-render `transcript.md` after edits
