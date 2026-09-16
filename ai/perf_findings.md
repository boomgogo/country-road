# Performance on integrated graphics: findings so far (2026-09-15)

Task: improve frame rate on old laptops with no dedicated GPU.
Status: session 1 (below) was committed as `d50d06c`. **Session 2 (2026-09-16/17) found the root
cause and fixed it; see "Session 2" at the end.** Its "Next steps" replace the ones in session 1.

## Test machine

- i7-7700HQ, Intel HD 630 (KBL GT2), 14 GB, 1920x1080. It also has a GTX 1050, but
  `prime-select` is `on-demand`, so Chrome runs on the Intel GPU.
- Chrome 153 in headless mode (`--headless=new --enable-gpu --use-angle=gl`).
  It reports `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL ES 3.2)`,
  so headless runs on the real iGPU. Viewport is 1920x993, dpr 1.
- Dev server: `npx vite --port 5178`.
- Test URL: `/?auto=full&fresh&seed=country&sound=0&t=10:00`

## Measurement harness (`ai/perf-bench/`)

Copied from the session scratchpad. Run with `HEADLESS=1 node <script>`.

- `cdp.mjs`: launches Chrome with remote debugging (port 9333) and exposes `evaluate()`.
- `nat.mjs` / `nat2.mjs`: **real rAF fps**. This is the only fully trustworthy number.
  - `VARIANTS=a+b,c` applies in-page toggles defined in `nat.mjs`.
  - `nat2.mjs` takes query-string variants instead.
- `bench2.mjs`: per-pass cost, synced with `readPixels` around each pass.
  - The syncs **inflate** the absolute numbers. Use it for relative comparisons only.
- `bench3.mjs`: scene-pass cost per object group (hides each group in turn).
- `bench5.mjs` / `bench6.mjs`: ground shader variants and anisotropy sweep. They patch
  `onBeforeCompile` in the page.
- `bench7.mjs`: chunk count and triangles per LOD step, and scene cost with each step hidden.
- `prof.mjs`: CDP CPU profile of `step()` with drawing disabled.
- `gpu.mjs`: EXT_disjoint_timer_query attempt. **It returns ~0 on ANGLE/Mesa, so it is useless here.**

Gotchas:
- `pkill -f chrome-prof` also matches the shell running it. Kill by PID instead.
- Creating a new three.js material from another module instance breaks the renderer.

## Baseline (before any change)

- **7.5–7.7 fps** (p50 frame 133 ms).
- The scene render target was 2849x1473 = 4.2 M px. `Pipeline` uses 1.5x at dpr 1, then
  clamps to the 4.2 M pixel budget, which gives 1.42x.
- Cloud march target 1425x737. Cloud history 2849x1473, half-float.
- 338 draw calls, 2.01 M triangles.
- The canvas was created with `antialias: true`, although only the FXAA quad draws to it.

Synced breakdown (ms, inflated):

| | 2849x1473 | 1920x993 |
|---|---|---|
| scene (without shadow) | 94 | 77 |
| clouds | 31 | 22 |
| shadow | 14 | 18 |
| ink | 6.5 | 5 |
| grade | 6 | 5 |
| fxaa | 9 | 9 |
| CPU remainder | ~19 | ~14 |

### The scene pass is fill-rate bound, and it is the ground

- Ground chunks cost **102 of 115 ms** of the scene pass. Every other object is under 5 ms.
- The same pass at 1/10 resolution costs 15 ms against 113 ms at full size.

Ground shader variants at 2849x1473 (ms):

| variant | ms |
|---|---|
| base | 113.8 |
| single-sample `detile` | 78.9 |
| no cloud shadow | 109.8 |
| whole `FRAG_BODY` replaced by a constant | 26.4 |
| no shadow receive | 105.4 |
| PCF instead of PCFSoft | 112.7 |
| basic shadow map | 104 |

- **Anisotropy is the big one.** `main.js` called `setAnisotropy(getMaxAnisotropy())`,
  which is 16x on 8 ground textures (512² ×6, fade 256², road 1024²).
  The shader takes about 15 texture taps per pixel: `detile` takes 2 taps × 6 materials,
  plus 3 fade taps and the road.

Scene pass by anisotropy level (ms):

| resolution | aniso 16 | 8 | 4 | 2 | 1 | 1 + single detile |
|---|---|---|---|---|---|---|
| 2849x1473 | 112.7 | 97.2 | 73.8 | 54.7 | 43.2 | 38.4 |
| 1920x993 | 71 | 61.1 | 46.3 | 34 | 29.5 | 26.4 |

### Terrain LOD

- LOD is chosen by distance from the *road*, so road chunks stayed at 1 m spacing for
  the whole traced road.
- Before the change, per step (chunks / thousands of triangles):
  1 m: 63 / 2064K · 2 m: 51 / 418K · 4 m: 98 / 201K · 8 m: 99 / 51K · 16 m: 116 / 15K.
- Hiding the 1 m chunks (aniso 1, 1920x993): scene pass 42.4 → 15.2 ms. Part of that is
  simply that the near ground fills most of the screen.

### Other costs

- **Shadow map** cost is mostly geometry, not map size. Synced: 3072² = 17.6 ms,
  2048² = 15.2 ms, 1024² = 13.8 ms. Ground chunks with step ≤ 2 cast, at 33K triangles
  per 1 m chunk.
- **Clouds** (synced, at scene scale 1):

  | cloud march scale | history scale | ms |
  |---|---|---|
  | 0.5 | 1 | 22.5 |
  | 0.33 | 1 | 20 |
  | 0.25 | 0.5 | 13.5 |

  The full-resolution resolve (9-tap clip box) is a real part of the cost.
- **CPU**: `step()` without drawing takes 4.8 ms.
  - 40.7% is `ChunkField._roadDist`. `_relod` → `_neighbourStep` → `_lodFor` runs 5 ring
    searches per non-live neighbour cell, every frame.
  - 34% is terrain noise in chunk builds, which already has a frame budget.
  - The frame is GPU-bound; CPU is secondary.

### Real fps with in-page toggles, before code changes (1920x993)

| settings | fps |
|---|---|
| as shipped | 7.7 |
| scene scale 1, aniso 2 | 19.9 |
| + clouds 0.25, history 0.5 | 22.5 |
| + shadow 2048, updated every 2nd frame | 24.4 |
| + ink and FXAA off | 26.4 |
| scale 1, aniso 2, no clouds, shadow frozen, no post | 33.9 |

Even with everything off it only reaches 34 fps, so a large fixed cost remains somewhere.

## Code changes made (uncommitted)

1. **`src/core/quality.js` (new).**
   - Three tiers:
     - `high`: the existing picture. Scale 1.75, aniso 16, shadow 3072, clouds 0.5 with full history.
     - `medium`: integrated GPUs. Scale 1, may range 0.6–1.5, aniso 4, shadow 2048,
       clouds 0.3, history 0.5.
     - `low`: coarse pointer or software renderer. Scale 1.25, aniso 2, shadow 1536,
       clouds 0.3, history 0.5.
   - `pickTier` checks, in order: `?quality=`, then `?rec` (always high), then coarse
     pointer, then a GPU-name regex from `WEBGL_debug_renderer_info`.
   - `ResolutionGovernor`: dynamic render scale driven by the median frame time.
     - Steps down when slower than 48 fps; steps up after 6 s held above 56 fps.
     - Skips levels that `pipeline.scaleFor` says draw identically.
     - Reverts and sets a floor if a step down gained less than 8%.
     - If a step up drops straight back, that scale becomes the ceiling for 60 s.
     - `?dynres=0` disables it.
2. **`src/world/chunks.js`.**
   - `FAR_LOD` tables per tier cap the finest spacing by distance from the car. The cap
     never goes coarser than 4 m, so the 8.6 m carriageway keeps at least 2 vertices across it.
     - high: 1 m within 420 m, 2 m within 820 m, else 4 m.
     - medium: 1 m within 200 m, 2 m within 460 m, else 4 m.
     - low: 1 m within 150 m, 2 m within 340 m, else 4 m.
   - The cap is applied in `_lodFor`, and in `_relod` for both `want` and `relax`
     (the 0.8 hang-back).
   - Road distances for non-live neighbour cells are cached in `_roadDistCache`.
     - `_build`'s neighbour steps go through the same cache, so they agree with `_neighbourStep`.
     - The cache is cleared when the rolling scan wraps, and in `invalidate()` and `reset()`.
3. **`src/core/post.js`.**
   - New `Pipeline.scaleFor(w, h, limit)`; `setSize` uses it.
   - The pixel-budget clamp now allows scales below 1 when `limit < 1`.
4. **`src/world/clouds.js`.** New `history` option: the cloud history's size as a
   fraction of the render target.
5. **`src/main.js`.**
   - The renderer is created before choosing the tier. `antialias` is now `!CEL`.
   - Tier values feed anisotropy (min of tier and GPU max), shadow map size,
     `ChunkField` `farLod`, cloud scale and history, and the pipeline's `maxScale`.
   - The governor is created after `resize()`, and `frame()` calls `governor.frame(rawDt)`.
   - `__game.quality` (tier, reason, GPU) and `__game.governor` are exposed.
   - The console logs `[quality] <tier> - <reason> (<gpu>)`.

Results after the changes (`dynres=0`):

- **medium: 20.7 fps**, render target 1920x993.
  - 1 m chunks: 12 (393K triangles). Visible triangles 2011K → 664K.
  - Scene pass at aniso 1: 42.4 → 24.2 ms.
- **high: 8.1 fps** (was 7.7).
- **Open puzzle:** the LOD cap cut the scene pass a lot, but real fps barely moved
  (19.9 → 20.7 at equal scale, and aniso 4 against 2). Something else caps the frame.
  - Synced medium breakdown: scene 39.6, shadow 15.6, clouds 15.1, ink 5.1, grade 5.3,
    fxaa 7.6, CPU remainder 13.7.
  - Headless may quantise frame times to 16.7 ms steps, since p50/p95 land exactly on
    50 and 66.7 ms. Confirm in headed Chrome.

## Not yet verified

- The governor has never been observed running (every run above used `dynres=0`).
- No visual check yet of:
  - LOD refinement popping as chunks go 4 m → 2 m → 1 m.
  - Half-resolution cloud history.
  - Scale below 1.
  - The high tier looking unchanged.
- No check of rebuild churn or build-queue behaviour while driving with the cap.
- No production build (`npm run build`) tested, and no phone tested.

## Next steps

1. **Find the remaining fixed cost with a real-fps A/B sweep on medium.** This was about to
   run when stopped. Add these toggles to `nat.mjs`:
   - `noClouds`, `shOff`, `noPost`, `aniso1`
   - scale 0.75 and 0.6 (set `pipeline.maxScale`, then dispatch `resize`)
   - `noGround`: hide chunk meshes after every `chunks.update`
   - `hideAll`: hide all non-light scene children and stub `clouds.render`
   - `noRender`: stub `pipeline.render` and `clouds.render`, which measures CPU and compositor only

   Then run with `QS="&dynres=0"`.
2. Depending on the result, candidates:
   - Merge ink and grade into one full-screen pass. It is visually identical and saves a
     pass and a render target. Note that `enabled.grade` is not checked in `render()` today.
   - On medium: single-sample `detile`, or fewer ground taps.
   - Fewer shadow casters on medium (step 1 only, or a smaller cascade than ±200 m),
     since shadow cost is geometry.
   - Throttled shadow updates. Risk: the car's shadow lags at speed.
   - On medium: cheaper cloud march (`MAX_ITER` 72, `LIGHT_STEPS` 5, `MS_OCTAVES` 6).
   - Sky dome and cloud composite draw full-screen before the terrain. Check the overdraw.
3. Verify the governor converges and doesn't oscillate. Test headed Chrome with real vsync.
4. Take visual captures of medium against high, and the high tier before and after.
5. Write `ai/plan_N.md` and `ai/next_N.md` per `CLAUDE.md` once the work settles.


---

# Session 2: root cause and fixes (2026-09-16/17)

## Root cause

**The ground shader sampled every texture for every pixel, including layers whose weight was 0.**
`groundmat.js` read all six surface textures, twice each for the detile, plus 3 fade taps and
the road. That is 15 anisotropic taps per ground fragment. It then blended most of them away at
a weight of exactly 0: rock, sand, heather and gravel under an open field, and all of the grass
under the tarmac. On an HD 630, texture taps are the expensive thing. One anisotropic tap
across the visible ground costs about 1.5 ms at 1080p.

This also answers session 1's "open puzzle". The remaining fixed cost was not headless vsync
quantisation. Measured with vsync off (`--disable-gpu-vsync --disable-frame-rate-limit`,
average fps over 10–12 s), hiding only the ground chunks took medium from 22.8 to 80 fps.
Clouds, post and shadows were each worth 1–5 ms.

## Method notes

- **Use uncapped throughput for A/B** (`tog.mjs`, `CHROME_ARGS="--disable-gpu-vsync
  --disable-frame-rate-limit"`). The fps is averaged over a time window, and the difference
  between runs is about ±1 fps.
- **readPixels-synced per-pass timings are badly inflated.** A synced frame took 95 ms against
  a real 33 ms. The sync itself costs about 1.2 ms idle, and the rest is lost pipelining. Use
  them only to rank passes within one run.
- `readRenderTargetPixels` on a 1×1 target does **not** sync on Mesa/iris. It returns ~0 ms.
- **Headed Chrome hangs on this machine** (Wayland, alongside the user's Chrome) and never
  produces frames. Stay headless.
- **Pixel A/B:** `ab.mjs` serves a `git archive HEAD` copy on port 5180 next to the working
  tree on 5178. It renders the same `?rec` frame on both and diffs the 8-bit grade output.
  Same port against itself gives 0 differing channels.
  - The **first run after editing source** differs by ~820K channels. That is the GLB car
    losing its 2.5 s race to the built-in coupe on a cold Vite transform. Run it again.
- `?quality=` wins over `?rec`, so `ab.mjs` can compare any tier.
- `ab.mjs` takes `T=21:30` for the time. Appending `&t=` to `QS` does nothing, because the
  first `t` in the URL wins.

## Changes

1. **`src/world/groundmat.js`: weights first, then only the textures that show.**
   - Every layer weight is the same expression as before, in the same order.
   - A layer is sampled only if its weight > 0 and no layer mixed over it has a weight ≥ 1.
     `mix(x, y, 1.0)` is `y`, so the output does not change.
   - Samples use `textureGrad` with gradients taken once, outside the branches. The break
     sample's gradients are `BREAK_RATIO` = 0.0461 / 0.125 times the near ones.
   - Measured: `textureGrad` costs the same as implicit `texture`.
   - **Pixel diff against HEAD: max 1/255**, checked at 900 m / 10:00, 4200 m / winter 15:00,
     2500 m / rain, and at night.
   - Ground only, high tier, 2849×1473: 94 → 38 ms synced.
2. **`src/core/post.js`: ink and grade merged into one pass (`look`), and `rtA` removed.**
   - `INK` and `GRADE` are defines. `enabled.ink` and `enabled.grade` recompile on toggle,
     which also makes the `G` key work; it did nothing before.
   - About 1 ms at 1080p. Pixel diff max 1.
   - `ai/perf-bench/bench2.mjs` and `gpu.mjs` still reference `P.ink` and `P.grade` and are
     now stale.
3. **`src/world/chunks.js`: ground meshes get `renderOrder = 1`.**
   - Opaque objects sort by material id before depth, and the ground material is created
     first, so the ground was drawn first and then painted over by trees, rails and the car.
   - Drawn last, it is rejected by the depth test behind them. About 2 ms.
   - 68 of 12.6M channels differ, at exact depth ties. Nothing is visible in the diff.
   - The only opaque object without depth write is the sky dome, at -1000.
   - Moving the dome after the world with z = w was also tried. It gained nothing, so it was
     not kept.
4. **`src/main.js`: the key light is switched off by `shadow.intensity = 0` and
   `shadow.autoUpdate = false`, not by `castShadow = false`.**
   - Toggling `castShadow` changes the light configuration, and every lit material then
     recompiles.
   - That was a 375 ms freeze at the first dusk of each session (`dusk.mjs`). It is gone.
   - The night picture diff is max 5 on a handful of pixels, and the map is still not drawn
     at night.

## Results (HD 630, headless, 1920×993 viewport)

| | before (HEAD `d50d06c`) | after |
|---|---|---|
| medium, vsync, dynres off | 21.7 fps | 33.4 fps |
| medium, uncapped | 22.5 | 39.7 |
| high, uncapped (2849×1473) | 6.9 | 14.9 |
| low, uncapped (2400×1241) | 23.0 | 34.3 |
| medium with governor, settles at | scale 0.64, 33–44 fps | scale 0.71, 45–49 fps |
| dusk recompile freezes | 316 ms (lamps) + 375 ms (shadow) | 484 ms (lamps) only |

## Where medium's ~25 ms at scale 1 still goes (uncapped toggles)

| item | ms |
|---|---|
| ground: texture blend (grass is 2–4 taps, fade 3, road 1) | ~9 |
| ground: lighting and PCFSoft shadow receive (16 RGBA-unpack taps) | ~3–4 |
| ground: geometry and vertex work | ~3 |
| shadow pass | ~3.5 |
| cloud march and resolve | ~3.3 |
| FXAA | ~1.8 |
| look (ink and grade) | ~1 |
| everything else in the scene | ~3 |

- **The empty shadow pass costs almost the full amount.** With no casters it still costs
  ~3.5 ms, while removing trees, car or ground as casters saves only 0.2–0.8 ms each. A 1024
  map saves ~0.7 ms. So it is not geometry, and probably a per-pass overhead (clearing 2048²
  colour and depth, or a Mesa resolve). This is unexplained.
- **CPU** `tick` is ~4.5 ms: noise in chunk builds (budget 4 ms) and road queries. With
  drawing enabled, the CPU profile is dominated by GL calls blocking on GPU backpressure.

## Tried and dropped

- **Sky dome drawn after the world at the far plane:** no measurable gain.
- **Background `compileAsync` warm-up of the night light configurations 1.5 s after start:**
  it did remove the dusk hitch (490 → 73 ms). But on ANGLE-GL/Mesa, "parallel" compile still
  blocks the GPU process, so it put a **1.1 s stall at 3.7 s into the drive** instead.
  - It must compile into `pipeline.rtScene`, not the canvas, or it builds the wrong
    (sRGB-output) programs.
- **Headlights always in the light list (intensity 0):** removes the lamp hitch but costs
  ~1 ms every frame. Not done.

## Next steps

1. **Dusk headlight hitch (~0.5 s, once per session).**
   - Options: compile behind the load screen (costs load time; spec 2–3 s); keep the lamps
     always in the list (1 ms per frame); or give them a 0 → 1 fade from a distance-gated
     uniform so the light count never changes.
2. **Grass taps.** `tGrass` and `tGrassDry` could be one RGBA data texture holding
   (t_grass, speck_grass, t_dry, speck_dry), with the palettes in the shader.
   - That halves the green layer's taps, about 3 ms.
   - The picture changes slightly: the filter would run over the parameters rather than the
     sRGB colours. It needs a visual check.
3. **Shadows.**
   - Explain the ~3.5 ms fixed cost of an empty shadow pass.
   - On medium, a 4-tap bilinear PCF instead of three's 16-tap PCFSoft on RGBA-packed depth.
     That changes the penumbra.
4. **Cloud march** (~3.3 ms at 0.3 scale): it marches sky pixels that terrain will cover.
   Last frame's depth could mask it.
5. **Not tested:** real phones (the `low` tier), Windows/ANGLE-D3D, and headed Chrome with a
   real display vsync.
