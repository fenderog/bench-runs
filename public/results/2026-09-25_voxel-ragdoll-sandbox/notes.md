# Capture and grading notes

## Task and prompt

- **Benchmark instruction:** `in this folder create a godot project with a voxel character walking around
  avoiding obstacles. Add ragdoll wherever you can to make it a fun experience. Make the whole experience
  inspired by this gif: http://www.zombox.net/stuff/zombox_cap_134.gif`
- The prompt arrived as the opening message of a pi session, which also carried the
  `fe-capture-benchmark-run` skill invocation and the system prompt. `prompt.md` preserves that
  **whole** first message byte for byte; the graded instruction is the sentence quoted above. The
  skill text is harness-injected context, not part of the benchmark's task definition.
- So this is **not** a prompt-only single-turn evaluation: the model was also acting as operator for
  part of the run (choosing the export preset, debugging the web build, and finally publishing this
  archive). That work is in the transcript and is not hidden from it.

## Coverage boundary

Pi appends every turn to one continuously growing session file. `media/raw/` is a **byte-for-byte
snapshot** of `2026-09-26T02-48-58-089Z_01a0db9d-a9e8-71e3-889b-39ecb88e6ac0.jsonl` taken at
**398 lines / 11,926,042 bytes**, SHA-256
`f46da183ad60d5c38da06b1f3b6fb5b2f3513f8ebcaf69f62c0b797b92e586b2`.

It is a **prefix**, not the final session file — the session continues afterwards with the
scaffolding, staging and this publish step, which are operator actions rather than task work. The
byte length and hash above are the ones the capture recorded under `run.start.source`; an exact line
count is deliberately *not* restated as a claim about the live file, because that file is still
growing while this note is written. The canonical transcript was not edited after capture.

## Model and reasoning

- **Model:** `stealth/space-bunny-alpha` via `openrouter`, reasoning level `high`
  (`thinking_level_change` record).
- The session header records one model switch, from `muse-spark-1.3-contributor` (meta) to
  `stealth/space-bunny-alpha` at `2026-09-26T02:49:05Z`. It happens **before** the first assistant
  message of this task, so it does not affect the result; the transcript retains it as a raw record.
- **Reasoning visibility:** all 116 thinking blocks are disclosed as plain text. None were encrypted
  by the provider. No reasoning text was reconstructed or paraphrased.

## What was built

A Godot 4.7 project in `/Volumes/M2SSD/tries/2026-09-25-voxel-spacebunny`, **2,263 lines of GDScript
across 15 files, with no imported assets of any kind** — every mesh is generated in code at load
time, which is why the exported game data is only 71 KB.

- **The yard** (`world.gd`): a 19.2 x 19.2 m walled enclosure generated from value noise at three
  scales — a big blotch picks the biome, a middle octave breaks up its edge, a hash sprinkles grit.
  102 obstacles: 26 crates, 18 stumps, 16 barrels, 8 pillars, 34 loose blocks, plus 10 meat pickups.
- **The blockhead** (`voxel_rig.gd`): **11 voxel parts** — head, torso, pelvis, pack, two arms, two
  legs, two feet, and a cleaver — on pivot nodes posed in code. The walk is procedural: leg swing,
  counter-swinging arms, torso bob and lean, and a slow breath when idle.
- **The ragdoll**: any part can become its own `RigidBody3D`, wired back together with **9
  `ConeTwistJoint3D`s** (spine, neck, pack, two shoulders, two hips, two ankles). The cleaver is
  deliberately *not* jointed — it is held by collision exceptions, so it leaves the hand on every
  flop. Getting up is not a teleport: each part is blended in world space from where it actually
  came to rest back to the walk pose over 0.5 s.
- **Everything else is loose too**: barrels roll and punt the player, crates shatter into eight rigid
  blocks above 4 m/s, and loose blocks are kicked by the player's feet.

## Verification performed

- `godot --headless --quit-after` — 0 errors, 0 warnings.
- `godot --path . -- --autotest=<dir>` drives a scripted run through trip, dive, recovery, barrel
  punt, crate shatter, pickup, death and respawn, screenshotting each step into `media/`. Final run:
  **0 errors, 0 warnings**; `flops 0->1` on the wall trip (`cause=trip`, vigor 100→80.6),
  `flops 1->2` on the dive, `flops 2->3` on the barrel punt (`cause=knock`), `ragdoll=true parts=11`,
  recovery back to `NORMAL`, eat `42->64`, death and respawn at `(0, 0, 4)` with vigor 100.
- **Web build**: exported, served over `http.server`, loaded in headless Chrome 154.0.8037.58 over the
  DevTools protocol. Boots as `Godot Engine v4.7.2.stable`, `OpenGL ES 3.0 (WebGL 2.0)`,
  `Emscripten 4.0.20, single-threaded`; canvas 1280x633; **0 JS exceptions, 0 console errors**.
- **Embedded on the bench site, not just standalone**: with the run page served from this repo, the
  detail view for `2026-09-25_voxel-ragdoll-sandbox` was opened, `.playable-launch` clicked, and the
  game probed from inside the iframe. It mounts same-origin under the site's own sandbox
  (`allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms allow-modals
  allow-downloads allow-orientation-lock`), canvas **1049x589** matching the iframe box exactly, and
  the same three boot lines with no errors. The `allow-same-origin` token is what makes the relative
  `index.pck` / `index.wasm` fetches legal, so this was worth checking rather than assuming.
- **Input verified in the browser**: a synthetic `Space` keydown dispatched over CDP produced a live
  dive — the DIVE banner appeared, `FLOPS 0->1`, `DIVES 0->1`, vigor `100->96`, camera tracking the
  ragdoll. The tool that does this is kept at `tools/web-check.mjs` in the project.

## The one real rendering bug, and what it cost

The first web export rendered **almost black**. It was not the web export: the same scene under
Forward+ was correct and under Compatibility was crushed, which was proved by rendering the identical
frame under both renderers and sampling the same pixels.

The cause was the `srgb_to_linear()` conversion applied to the palette in `VoxelMesh.from_sparse()`.
It is correct under Forward+ and near-fatal under Compatibility, where the shadowed key light stops
contributing and only the unshadowed fill light survives. Authoring the palette in sRGB and passing
it through untouched is correct in both. Along the way the following were each ruled out **by
screenshot, not by argument**: SSAO, glow, colour adjustment, MSAA, the soft-shadow filter, shadow
bias, normal bias, cascade mode (`ORTHOGONAL` / 2 / 4 splits), shadow max distance, light angle,
self-shadowing by the ground and the skirt, a second directional light, and the camera. A minimal
repro project was built to localise it to the project rather than the engine.

Two consequences of that investigation are permanent and worth stating:

- **The project is pinned to the Compatibility renderer.** Web only ships OpenGL ES 3.0 and the
  exporter refuses to build a Forward+ project for it, and there is no per-preset override — so the
  desktop build runs on Compatibility too. SSAO is therefore a no-op here and is left enabled only so
  the setting returns if the project ever moves back to Forward+.
- **`vram_texture_compression/for_mobile=true` makes the web exporter reject the preset** with a bare
  `Cannot export project with preset "Web" due to configuration errors:` and an empty error string —
  no indication of which option is wrong. Both VRAM compression options are off, which is correct
  anyway: this project imports no textures at all.

## Interventions and caveats

- **Four `ask_user_question` rounds.** One was **rejected by the tool** (`questions.2.options: must
  not have more than 4 items` — a tags question with eight options) and had to be split; that failed
  call is in the transcript. The rest set control scheme (player-only), ragdoll scope (full body
  everywhere), art direction (faithful Zombox), world size (single walled yard), run name, artifact
  size, and tags. The model did not choose these silently.
- **The Zombox reference gif was fetched and decompiled, not guessed at**: 450 frames, a 12-frame
  contact sheet plus twelve full-resolution frames, inspected to fix the framing, the character's
  tan palette, and the HUD layout (bread counter, three inventory slots). The gif and the extracted
  frames were deleted from the project afterwards.
- **Prior art was consulted, not copied.** `~/dev/zombox-ragdoll` and `~/dev/voxel-ramble` (both
  earlier attempts of mine) were read for the jointed-ragdoll and voxel-mesher patterns. This run
  rebuilt the yard, the character rig, the prop set and the whole palette; the harness-recipes
  approach in the skill was also reused for the run folder layout.
- The run therefore includes real tool failures (five `tool_errors`, the ask_user_question rejection
  among them). That is left in place: a run whose tools failed is a more useful record than a tidied
  one.
- **`verify-run.mjs` reports 2 tool calls with no matching result.** That is not a defect in the
  capture: the log was snapshotted mid-turn, and the last two `tool.call` records in
  `media/raw/` are the environment-gathering commands whose results had not yet been written when
  the snapshot was taken. The transcript ends on `run.end` with those two calls outstanding.
- **Not covered:** no audio. The export ships Godot's two audio worklets because the template always
  does, but the project plays no sound and defines no `AudioStream`. Frame rate was not measured
  anywhere — headless SwiftShader is not representative, so no FPS number is claimed.
- **The 38 MB in the repo is 99% engine.** The game is 71 KB of `.pck`; `index.wasm` is 39.5 MB. It
  was committed deliberately so the run page is actually playable, which is a real cost to anyone
  cloning the repository.

## Privacy

Before publication the raw log and transcript were checked for API keys, authorisation headers and
private-key blocks; `verify-run.mjs` reports no credential leak. They are not free of paths,
though: the prompt, raw log and transcript contain absolute paths from file operations
(`/Volumes/M2SSD/tries/…`, `/Users/fender/…`), and `verify-run.mjs` warns about them on 11
`transcript.jsonl` lines, 23 `transcript.md` lines, 2 `prompt.md` lines, 2 `system-prompt.md` lines
and this file. **The repository is public**, so these are being published, not merely held on a
private machine. They are retained deliberately: the account name is already public, the machine
name is already inferable from it, and redacting paths out of the canonical log would break the one
thing this format exists for — checking the transcript against what actually happened on the
machine. If that trade is wrong for this repo, the fix is to redact at capture time and record the
redaction here, not to quietly edit the transcript afterwards.
