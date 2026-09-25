# Notes — hello world html capture (mid-run)

## Method
- Source session: `~/.pi/agent/sessions/--Volumes-M2SSD-dev--/2026-09-25T22-03-49-961Z_01a0da98-9d46-74bd-b8a5-43614f90b080.jsonl`
- Adapter: `pi` (`capture-run.mjs --format pi`). Verbatim prompt, reasoning blocks
  (including encrypted ones), tool calls/results preserved character-for-character.
- The task artefact (`hello-world.html`, single file saying "Hello world") was
  written with the `write` tool during this same session; the `tool.call write`
  is present in `transcript.jsonl`.
- A copy of the artefact is stored at `media/hello-world.html` for rendering.

## Caveats (read before grading)
- **Captured mid-run**: status is honestly `running`. One tool call has no
  matching result yet (the capture command itself), and there is no final
  assistant message in this snapshot. Re-capture after the session ends for a
  `complete` record; do not edit this transcript — annotate here instead.
- **Reasoning mostly encrypted**: 10/13 thinking blocks are empty prose with
  provider ciphertext (`encrypted: true`); 3 blocks disclosed. Ciphertext is
  preserved in `media/raw/`. `reasoning.visible` is partial, not full.
- **Home paths**: transcript and prompt contain absolute paths such as
  `/Users/fender/...` (skill location, session slug). Fine for a private repo;
  redact before public publishing.
- **Decoding params** (temperature/top_p/seed) are not reported by the harness
  and are omitted, not defaulted.
