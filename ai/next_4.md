# next_4 — what landed for `prompt_4.md`, and what it left

Implements `ai/plan_4.md`.  All five items are in.  The three bugs were
each reproduced by a probe before anything was changed, and each probe
now passes where HEAD fails.  The film is on DRIVE2 and the suggestions
are in `ai/suggest_4.md`.

**Landed**

| file | what |
|---|---|
| `index.html`, `src/core/loader.js` | §5: "fork me on github", on the load screen and the pause menu, which are one element |
| `src/core/post.js` | §4a: the canvas at device pixels; an up pass that draws the ink sharp at that resolution |
| `src/core/quality.js`, `src/main.js` | §4a: governor floors and targets per tier |
| `src/world/terrain.js` | §4b: `heightAt` takes the base and leaves its road query for the mesher |
| `src/world/chunks.js` | §4b: a build 3.5x cheaper, a queue by class re-keyed every frame, coarse-first, the chunk under the car guaranteed, seams mended in place; §4c: skirts |
| `src/car/physics.js` | §4b: colliders follow a chunk's revision, not only its identity |
| `src/main.js` | the ground watch and its net; `?debug=1`; `stats`; bare `?auto` meant *manual* and now means full |
| `tools/play/` | item 1 `autoplay.mjs`; item 2 `film.mjs`, `check-mp4.mjs`, `sheet.py`; shared `lib.mjs` |
| `perf-bench/` | `dpr.mjs`, `void.mjs`, `seam.mjs`, `far.mjs`, new; `cdp.mjs` takes a port and a profile |
| `package.json` | `mp4-muxer`, dev only — the film's MP4 writer, since the machine has no ffmpeg |
| `README.md` | `?debug`, `?auto`, the tools |

---

# Item 5 — the link

Static markup inside `#load`, so it paints with the first paint and costs
no request.  The overlay starts the drive on any press or key, so
`Loader._onGo` now ignores events whose target is inside the link — the
same guard the two choice buttons already had, and for the same reason.
Top right on a mouse, bottom centre on a finger.  `?rec` removes the
whole overlay, so the film has no link in it.

---

# 4a — blurry on a phone and a Surface Go

## 1. The cause was where the picture ended up, not how big it was drawn

`Pipeline.setSize` set a pixel ratio of 1 and sized the canvas to the
window, so the finished frame was CSS-sized on every device and the
compositor stretched it to the panel.  `perf-bench/dpr.mjs` takes the
compositor's screenshot at device pixels, and on HEAD:

| device | canvas | scene | scene / panel, tier start → governor floor |
|---|---|---|---|
| Surface Go (1200×800 @1.5, `medium`) | 1200×800 | 1200×800 → 720×480 | 0.67 → **0.40** |
| phone (393×851 @2.75, `low`) | 393×851 | 491×1063 → 235×510 | 0.45 → **0.22** |

Every earlier probe ran at DPR 1, where canvas and panel are the same,
and so none of them could see it.

## 2. What changed

* **The canvas is the panel's size** (`outFor`: the DPR, to 2, to the
  same 4.2 Mpx budget as the scene, never below 1).  On a DPR-1 desktop
  nothing changes.
* **A scene smaller than the canvas goes through a new up pass** instead
  of FXAA and the compositor.  The look pass writes linear colour plus
  the ink's strength in alpha; the up pass rebuilds both at device
  pixels.  The colour is bilinear pulled toward nearest (`uCrisp`).  The
  ink is *redrawn*: a cubic B-spline of the strength field, and a
  smoothstep one device pixel wide across its half-height contour,
  divided by the local peak so faint lines stay faint.  Bilinear came
  first and was visibly wrong at the Surface's floor: the contour of a
  bilinear staircase is a staircase.
* **The governor gives up less, and later**: `medium` floor 0.6 → 0.75,
  target 48 → 40 fps; `low` floor 0.6 → 0.8, target 48 → 36 fps.  This is
  a judgement.  Nothing here has run on either GPU.

## 3. What it measures, and what it does not

The canvas now equals the panel on both emulated devices, and on the
desktop it is unchanged.  In the crops from `dpr.mjs` the new frame is
plainly sharper at the tier's own starting scale on both devices.  At
the old floors (0.4 and 0.22 of the panel) the ink is sharp but a
shallow ridge line jogs in visible steps; the higher floors are what
keep a device out of that range.

`ink.mjs` passes all five cases.  Its scores rose (medium 0.022 → 0.030,
high 0.003 → 0.012, low 0.006 → 0.022), and this was chased down rather
than waved through.  It is not the skirts (identical with them off), and
it is not the up pass's crisp weights (identical with `uCrisp` at 0).
It is the device-pixel canvas: the probe's cases run at DPR 1.5, and a
frame no longer downsampled by the compositor has more fine detail in
it.  The saved frames show no bars.

**Not verified: a real phone and a real Surface Go.**  `?debug=1` is the
way to check.  It shows the density, the canvas and scene sizes, the
route, the fps and the governor's level.  A screenshot of it from each
device is the acceptance test `plan_4.md` set, and it has not happened.

---

# 4b — the car falls into the void

## 4. Reproduced

`perf-bench/void.mjs` drives the real frame loop with the CPU
throttled, and counts frames with no chunk under the car, a stale
collider, or the car more than 2 m below `heightAt`.  HEAD at 4×,
roughly a Pentium 4415Y: the field drained from 427 chunks to 62 in two
minutes and the car fell through twice in three.  At 6×, six falls in
five minutes.

The chunk builder was the whole story, in two parts:

* **A 1 m chunk cost 470 ms of main thread at 6×** (76 ms at 1×), and
  62 % of that was `curvatureAt`: five calls into the noise per vertex,
  at points that are mostly other vertices of the same grid.
* **The queue ran on stale keys.**  A missing chunk kept the distance it
  had when it was requested, 2 km out at the front of the field, and
  every rebuild of an *existing* chunk sorted ahead of it on a negative
  key.  On a slow CPU the ground under the car was always behind
  something cosmetic.

## 5. The fix

* **A cheaper build.**  The landform is sampled once on a grid with a
  margin, and the curvature is read off it: exact at 1 m, ±6 m scaled
  by (5/6)² at 2 m.  `heightAt` takes that base and leaves its road
  query for the mesher, which had been making it a second time.  1 m
  chunk: 470 → 135 ms at 6×, 76 → 25 ms at 1×.
* **Three classes, re-keyed every frame** from where the car is:
  missing, fix (+150 m), save (last).
* **Coarse-first**: a missing chunk within 420 m is built at 4 m and
  refined through `_relod` like any other.
* **A 12 ms budget** while a chunk within 260 m is missing.
* **The chunk under the car is built on the spot** if it is ever not
  live (`_ensureUnder`), and a car 2 m under the ground for 0.4 s is put
  back on the road.
* **Seams are mended in place.**  After the above, 142 of 220 rebuilds
  a minute were a fine chunk rebuilt from nothing because its
  *neighbour* changed resolution.  `_restitch` redoes the four edge
  rows instead, at about 0.7 ms.  Colliders now follow `rev`.

## 6. What it measures

`void.mjs`, three minutes each.  These five ran before §7 found that an
emulated device persists in the shared Chrome profile, so they are **all
at the phone's 393×851 @2.75**, the last thing `dpr.mjs` had set.  Both
sides of each comparison are at the same size, so the comparisons stand,
and the size is the one the report was about:

| | HEAD 4× | new 4× | new 6× (5 min) | HEAD 1× | new 1× |
|---|---|---|---|---|---|
| live chunks at the end | 62–425, draining | ~422 | ~420 | ~421 | ~423 |
| frames over no ground | 860 | **0** | **0** | 0 | 0 |
| falls | 2 | **0** | **0** | 0 | 0 |
| fps | 49 (a gutted world) | 42 | 27 | 60 | 60 |

HEAD's higher fps at 4× is the price of drawing a sixth of the world,
not a regression here.  At 1× the two drives are the same drive, metre
for metre, both at the display's 60.

Then, with the window set explicitly (`void.mjs` now does, `DEV=phone`
for the phone), at 4×: the phone at `low`, 38–42 fps; 1280×720 at
`medium` for the Surface Go, 32–34 fps.  Both had **0 frames over no
ground and 0 falls**.

---

# 4c — the ground cracks open

## 7. Reproduced, and what the cracks were

`perf-bench/seam.mjs` draws only the ground, over a magenta clear
colour with magenta fog, and counts magenta that has ground above it in
its screen column.  For a heightfield seen from above, that can only be
a hole.  `SELFTEST=1` hides a chunk to prove it can see one.  Getting the
probe honest took four corrections, each found by looking at the frames
it flagged:

* the game *copies* the sky into `scene.background` every tick;
* an emulated device persists in the shared Chrome profile;
* a pitched camera's columns are not vertical planes, so skip 8 px
  under the skyline;
* fogged ground reaches green 60–80, so magenta means green under 30.

On HEAD there are two kinds of crack.  **Single-pixel pinholes** along
seams, in nearly every other frame: two meshes sharing an edge do not
rasterize watertight.  And **whole chunks missing past a crest** at
middle distance, with the background showing under the far hills.

## 8. The fix, and what it measures

**Skirts.**  Every edge vertex gets a twin 1 + 1.5·step metres below it,
with the same normal and road attributes, indexed both ways round.  About
3 % more vertices on a 1 m chunk.  Colliders and water are untouched.
Together with the stitching semantics (`_stepOf`: a live neighbour's
*actual* step, not the step it wants), and §4b keeping the field whole:

| 150 s of game, 750 frames | HEAD | new |
|---|---|---|
| 1× | 151–200 frames with holes, worst 0.5 Mpx | **0** |
| 4× | 433 frames, worst 0.6 Mpx | **0** |

---

# 4d — a long way from the origin

`perf-bench/far.mjs` traces the road out, jumps there, drives ten
seconds:

| arc km | from origin | float32 step | wheel jitter | pitch jitter |
|---|---|---|---|---|
| 2 | 1.9 km | 0.12 mm | 0.45 mm | 0.30 mrad |
| 60 | 45 km | 3.9 mm | 0.62 mm | 0.22 mrad |
| 150 | 112 km | 7.8 mm | 0.84 mm | 0.15 mrad |
| 300 | 218 km | 15.6 mm | 0.84 mm | 0.24 mrad |

The physics is fine to 300 km.  **The car's shading may not be.**  From
60 km on, the stills show blotchy grey patches and dotted ink on the
body that the 2 km car does not have.  The likely cause is the shadow
lookup, which transforms a float32 world position.  But each distance
faces a different heading under the sun, so it is not proven.  The ground
and the trees look fine at all four distances.

---

# Item 1 — the autoplayer

`tools/play/autoplay.mjs` plays with the keys a player has, through
`Input.dispatchKeyEvent` into the same listener a keyboard reaches.  It
uses autodrive, then on a seeded schedule: another camera, a tap of the
wheel, the handbrake, off into a field and `T`, the two part-auto modes,
`]`, and a rest through the night.  Every action checks its own outcome,
and `lib.mjs`'s `Watch` checks the drive every few seconds.  There are
two clocks: stepped (`?rec`, repeatable) and realtime (`?auto=full`, the
page's own loop, for throttled soak tests).

The first 40-minute run reported five failures, and triaging them was
worth more than the pass that followed:

| failure | verdict |
|---|---|
| `rest` ended at 04:31 | the test: first light in summer at −30° *is* 04:30 |
| `]` moved the clock 36 s | the test: `t` counts game-minutes, so that was 36 of them — correct |
| two `nudge`s, and "off the road 25 m for 10 s" | the test held the key 0.6–1.2 s.  A separate run of 16 such holds put the car 13–45 m into the field, four times past the road query's 46 m, and **the autopilot came back from all 16, in 5–12 s**.  Nudges are now 0.2–0.5 s taps with 15 s to return |
| (not reported) | a car beyond the road query reads `fromRoad: null`, and `null > 6` is false — the most lost car never counted as off the road.  Fixed |

After those fixes: 40 minutes of play on `drift`, 44 km, every action
type, **no failures**.  Realtime at 4× throttle, `low`: 6 minutes, no
failures.

---

# Item 2 — the film

`/media/DRIVE2/country-road/two-days/`, made by `tools/play/film.mjs`
from a frozen copy of the working tree, so that editing `src/` could not
reload it mid-take:

| | |
|---|---|
| drive | seed `country`, day 1 08:00 → day 3 08:00, 53.5 km, full autodrive, chase camera |
| master | 1920×1080 at 30 fps, 48.0 min, 86 400 frames, H.264 16 Mbit/s, 4.53 GB |
| time-lapse | every 8th frame of the same take, 6.0 min, 0.62 GB |
| render | 2.59 h on the HD 630, 9.3 frames/s; 0 cleared frames |
| watch | nothing: never more than 1.94 m from the midline, 0 falls, 0 frames without ground, 0 exceptions |
| memory | heap 135–183 MB throughout, geometries 545–649 with no trend, live chunks 411–426 |

`check-mp4.mjs` opened both files in Chrome's own `<video>`: durations
2 880 s and 360 s, and decoded frames at the start, middle and end.
Also on the drive: `log.jsonl`, 48 hourly stills with a contact sheet,
and `code-uncommitted.diff`, which with c6a34e3 is the exact code.

**How it is made.**  There is no ffmpeg on this machine.  Frames go from
the canvas into a `VideoFrame`, get encoded in the page by WebCodecs,
and cross to Node as encoded chunks.  `mp4-muxer` writes them straight
into the file.  The GTX 1050 was tried and headless Chrome cannot create
a WebGL context on NVIDIA's EGL, so the HD 630 drew it.  There is no
sound, because the engine is an AudioWorklet on the real-time clock.

The seed was picked by `film.mjs --survey`, off `weather.forecast`.  Of
ten seeds, `country` has heavy rain by day and by night, light rain,
cloud and a clear second night.  It is also the world every probe here
uses.

---

# Item 3 — `ai/suggest_4.md`

Written from the film, its log and the scripted play.  The short
version: it is beautiful and the same minute over and over, and there
is nothing to do.  Night is 42 % of the day, and 21 of the film's 48
hourly stills are headlights on black.  The weather is the best thing
in it, and the seasons are too slow to see in a sitting.  Places with
signposts is the one change to make first.  While checking a claim for
it: `P` is bound to a `photo` command that nothing handles.

---

# Next, in the order I would do them

1. **A screenshot of `?debug=1` from the real phone and the real Surface
   Go.**  §4a is measured in emulation only, and its acceptance was
   always the device.  It also shows whether the new governor targets
   are right.
2. **The car's shading far from the origin (§4d).**  Settle whether it is
   precision: the same car, same heading, same sun, at 2 km and at
   150 km.  If it is, rebase the world's origin every few km.  A long
   resumed drive gets there.
3. **Night** (`suggest_4.md` §3).  It is cheap and it is 42 % of the
   game.
4. **Places and signposts** (`suggest_4.md` §1).
5. `next_3.md`'s own list is still open: the far bucket in `streak.mjs`,
   `nearest` on the inside of a tight bend, frame time on a GPU whose
   timer queries work, and `clouds.js` behind a dynamic import.
