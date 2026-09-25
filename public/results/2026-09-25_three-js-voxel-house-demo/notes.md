# Capture and grading notes

## Task and prompt

- **Benchmark instruction:** `generate a voxel house in 3js`.
- The first user message actually sent to the model contains the full
  `fe-capture-benchmark-run` skill invocation followed by that instruction, because
  this run was asked to archive itself. `prompt.md` preserves the **whole** first
  message byte for byte; the graded instruction is its final line. The skill text is
  harness-injected context, not part of the benchmark's task definition.
- This is therefore **not** a prompt-only, single-turn evaluation: the model was also
  acting as the capture operator, and the transcript contains that work (locating the
  repo, inspecting the capture scripts, rendering checks).

## Coverage boundary

Pi appends every turn to one continuously growing session file. `media/raw/` is the
**first N original lines of `2026-09-25T23-01-24-051Z_01a0dacd-51d2-74c0-b788-3db806b3bef8.jsonl`,
copied byte-for-byte**, ending with the assistant message that completed the artefact
and produced this archive. It is an unmodified *prefix*, not the final session file —
the session continues afterwards with the publish step and the closing report, which
are operator actions rather than task work. The SHA-256 and byte length of the copied
prefix are recorded in `transcript.jsonl` under `run.start.source.sha256` / `.bytes`
(an exact line count is deliberately not printed here, because the live session file
keeps growing while this note is written). The canonical transcript was not edited
after capture.

## Model and reasoning

- **Model:** `deepseek/deepseek-v4.1-flash` via `openrouter`, reasoning level `high`
  (`thinking_level_change` record). All 43 assistant records in the log carry this
  model id.
- **Pre-prompt model switches:** the session header records four `model_change`
  events before the task prompt (`muse-spark-1.3-contributor` → `gpt-6-astra` →
  `gpt-6-sol` → `deepseek/deepseek-v4.1-flash`). No assistant message was produced
  under the earlier three, so they do not affect the result; the transcript retains
  them as raw records.
- **Reasoning visibility:** all thinking blocks are disclosed as plain text; none were
  encrypted by the provider. No reasoning text was reconstructed or paraphrased.

## What was built

- **Artefact:** `media/playable/index.html` (14,538 B), a standalone page that builds
  the house procedurally in three.js. SHA-256
  `d32053c66f3771bc155ff8ccdc915a0009950695dd35527f99c064432bdc9aa3`.
- **Dependency:** three.js **r128** UMD, vendored as `media/playable/three.min.js`
  (603,445 B, SHA-256 `9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2`),
  fetched once from cdnjs and served from the run folder. Nothing is loaded from the
  network when the playable is viewed, so the artefact stays auditable offline.
- **Scene:** a sparse voxel store (`Map` keyed by `x,y,z`, last write wins) emits
  **2,215** cubes into three `InstancedMesh` passes — opaque, translucent glass, and
  translucent smoke — with `instanceColor` per cube. Contents: 13-voxel-radius lawn,
  timber-framed house with hollow interior, five-course stepped gable roof, brick
  chimney with cap and drifting smoke, door with knob, six glazed windows, flagstone
  path, picket fence with gateway, four trees, flowers, and a small pond.
- **Interaction:** hand-rolled orbit controls (pointer drag, wheel zoom, clamped polar
  angle) written into the page rather than vendoring `OrbitControls.js`, keeping the
  artefact to two files. Day/night toggle (repaints sky, fog, sun, hemisphere light and
  lights a point lamp inside the front window), auto-spin, and reset-view buttons.
  A `?time=night` query parameter deep-links the night state.

## Verification performed

- `node --check` on the extracted inline scene script: passed.
- Headless Chrome (154.0.8037.58) load via the DevTools Protocol: **0 JS exceptions and
  0 console errors**, canvas present at 1400×880, `window.__voxelHouse.voxels === 2215`.
- `media/screenshot.png` (day) and `media/screenshot-night.png` (night) are unedited
  captures from that renderer; both were inspected visually.

## Interventions and caveats

- **One operator interruption.** After the first headless-Chrome screenshot attempts,
  the run stalled: this machine's Chrome does not exit under `--headless=new
  --screenshot` because GoogleUpdater/crashpad helper processes keep it alive, and the
  scene's perpetual `requestAnimationFrame` loop can prevent `--virtual-time-budget`
  from ever expiring. The operator interrupted the turn (`stopReason: aborted`) and
  asked why it kept stalling. The fix — driving Chrome over the DevTools Protocol and
  killing it after capture — was then written and used for both screenshots. This is
  recorded because it is visible in the transcript as a failed/aborted step, and the
  successful screenshots came from the second method, not the first.
- Two `ask_user_question` calls failed validation (an over-long question header, then
  an over-long option label) before a valid one was accepted; these are the three
  `tool.result` records with `isError` (the third being a command timeout).
- The run therefore includes real tool failures. That is left in place: a run whose
  tools failed is a more useful record than a tidied one.

## Usage caveat

The source pi log reports token usage on every assistant record using pi's own keys
(`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`). The
installed capture adapter does not normalise those key names, so `run.end.usage` is
null; the figures in `run.json.environment.usage_from_source` are the sums of those
original per-message fields, not estimates. Sampling/decoding parameters
(temperature, top_p, max_tokens), the step limit, and any seed were not reported by
the harness, so those environment fields are absent rather than guessed.

## Discrepancy: a pre-existing, unauditable run.json was superseded

- When this run's capture began, the folder already contained a `run.json` written by
  someone other than this capture: `status: complete`, tags
  `voxel, threejs, 3d, deepseek`, a summary, and a `metrics` **array** in the shape
  `build-manifest.mjs` emits. It is preserved byte-for-byte as
  `media/raw/superseded-run.json` (2,535 B, SHA-256
  `53d6d635ff3e8bf7ff8a62aa5a57cef17e83250f02b40013086fe99d1c622957`) so the
  discrepancy stays auditable; nothing here was deleted quietly.
- **It contained no audit trail at all** — no `transcript.jsonl`, no `prompt.md`, no
  `transcript.md`, no `media/raw/` source log. Every claim in it was therefore
  unverifiable from the folder alone, which is the one thing this capture format
  exists to prevent.
- **Two of its metrics are not supported by any evidence and were not carried
  forward:**
  - `fps: 60` with the hint "steady 60 FPS animation loop". The artefact contains no
    FPS counter or frame timing of any kind (`grep -ciE 'fps|performance.now|frameCount'`
    over `index.html` returns 0), and no measurement was taken in this session. The
    real render check ran under SwiftShader software rasterisation in headless Chrome,
    whose frame rate is not representative of the 60 Hz display loop anyway.
  - `duration: 142.4s` with the hint "generation and compilation time". No timer was
    ever started or stopped, and 142.4 s matches no span in the source log, whose
    first and last timestamps are used instead for the `duration` metric below.
  - Its `environment.model_provider: "deepseek"` is also wrong: the session log
    records the provider as `openrouter` (model `deepseek/deepseek-v4.1-flash`).
- The superseding record keeps the operator-chosen title, the verified
  metrics, the real provider, and the full transcript. Where it disagrees with the
  superseded file, the captured evidence wins and this note is the explanation.

## Privacy

Before publication the raw log and transcript were checked for API keys,
authorisation headers and private-key blocks; `verify-run.mjs` reports no credential
leak. The prompt, raw log and transcript necessarily contain absolute `/Users/fender/`
paths from file operations and the skill invocation. They are retained as provenance
rather than anonymised, because the capture is meant to be auditable against the
machine that produced it.
