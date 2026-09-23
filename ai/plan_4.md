# plan_4 — a two-day drive, and what it shows

Answers `ai/prompt_4.md`.  Five items, and they depend on each other
more than the numbering suggests:

* **1 (the autoplayer) and 2 (the film)** are one piece of tooling.  The
  film is the autoplayer with a camera on it.
* **The film is also the best test this project has had.**  48 minutes
  of continuous drive covers two full days and nights, about 48 hourly
  weather draws, and about 58 km of road.  That is further and longer
  than any probe has driven without a teleport.  Anything item 4 asks
  about that is not specific to one device should show up in it.  It
  does **not** cover the seasons: a season is 3 game-days, so the whole
  film is spring.
* **3 (make it more fun)** is written *after* the drive, from what the
  drive showed, and not before.
* **4 (bugs)** has three reports, and each has a cause I can name from
  the code.  Each still gets a probe first, because `next_3.md` ends on
  a probe that disagrees with itself.
* **5 (fork-me link)** is independent and small.

Order of work: **5 → 4a (blur) → 4b/4c (void, cracks) → 1 → 2 → 3**.
The bugs go before the film because a film of a known crack has to be
rendered again once the crack is fixed.  The autoplayer's first short runs
are the soak test the bug fixes need anyway.

---

# Item 5 — "fork me on GitHub"

The load screen and the pause menu are the **same element**
(`index.html` `#load`, and `Loader.pause()` takes `gone` off it again).
So one link covers both screens.

* Put an `<a class="fork" href="https://github.com/boomgogo/country-road"
  target="_blank" rel="noopener">` inside `#load`, as static markup.  It
  goes in the markup and not in JavaScript for the reason
  `loader.js`'s header gives: nothing in JS runs until the physics wasm
  has arrived, and the link should be there from the first paint.
* Use a corner ribbon or a small corner tag in the overlay's existing
  type (11px, wide letter-spacing, white at about 0.6 opacity).  No
  image and no third-party ribbon PNG.  It costs zero bytes of load time
  against the spec's 2–3 s.
* **The trap:** the overlay starts the drive on *any* click or key.  The
  link's `click`, `pointerdown` and `touchstart` must `stopPropagation()`
  (or the loader must ignore events whose target is inside `.fork`).
  Otherwise clicking the link opens GitHub *and* starts the drive behind
  it.  Check the same thing for keyboard focus: Enter on a focused link
  must not also count as the "any key".
* Hide it under `.clean` / `?rec`, so the film has no ribbon.
* Placement on a phone: top-right collides with the touch strip (`AUTO`,
  `CAM`, `☰`), but that strip is hidden while the overlay is up.
  Confirm that in a 390×844 emulation, and move the link to bottom-centre
  on a coarse pointer if they overlap.

Acceptance: the link is visible on the cold load screen and after `Esc`.
It opens the repo in a new tab and does not start or resume the drive.
It is absent from `?rec` frames.  The first-load time does not change.

---

# Item 4 — performance and bugs

## 4a. Blurry on a phone and on a Surface Go

**The likely cause is not the render scale.  It is where the picture
ends up.**  `Pipeline.setSize` calls `renderer.setPixelRatio(1)` and
`renderer.setSize(w, h, false)` with CSS pixels.  So the **canvas's own
drawing buffer is at CSS resolution on every device**, and the browser
upscales it to the panel:

| device | DPR | panel | canvas buffer today | scene RT (tier start → governor floor) |
|---|---|---|---|---|
| Surface Go (UHD 615, `medium`) | 1.5 | 1800×1200 | 1200×800 | 1.0× → 0.6× of CSS = **0.67 → 0.4 of panel** |
| typical phone (`low`) | 2.5–3 | ~1080×2400 | ~400×870 | 1.25× → 0.6× of CSS = **0.45 → 0.2 of panel** |
| HD 630 desktop, DPR 1 | 1 | 1920×1080 | 1920×1080 | fine; this is where every probe ran |

Every probe so far ran on the last row, which is why nothing saw this.
Four things make it worse, and they stack:

1. the browser's upscale of the canvas (bilinear, soft);
2. FXAA on top of an already-upscaled image;
3. the ink.  It is computed from the scene-resolution depth, so at 0.4
   of the panel a "two texel" line is five panel pixels of grey smear.
   A cel picture reads as sharp or blurry almost entirely by its lines;
4. the governor.  Its target is 48 fps with a median test, and a phone
   that is thermally or vsync-capped at 30–40 likely sits on
   `minScale` = 0.6 the whole drive.

**Measure first** (half a day):

* `?debug=1` overlay: DPR, CSS size, canvas buffer size, scene RT size,
  governor level and history, median fps, tier and why.  It is cheap,
  it ships, and the user can open it on the actual phone and the actual
  Surface Go and send a screenshot.  That is the only real-device data
  this plan can get.
* A CDP emulation run: `Emulation.setDeviceMetricsOverride` with
  deviceScaleFactor 1.5 at 1200×800 and 2.75 at 393×851, plus
  `Emulation.setCPUThrottlingRate` 4.  Log the governor's trajectory
  over two minutes of autodrive.  The HD 630 plays the part of a
  weak GPU well enough to show whether the governor bottoms out.

**Fix, in order of confidence:**

1. **Size the output to device pixels, and keep the scene's size as its
   own question.**  The canvas buffer should be `css × min(DPR, 2)`
   (capped by a pixel budget for 4K).  The final pass (look + FXAA, or
   look alone) renders into it and upsamples the scene RT in the shader,
   not in the compositor.  The governor keeps moving the *scene*.  The
   output buffer does not move.  On its own this does not add detail,
   but it takes away one of the two resamples. The HUD, touch controls
   and text are DOM, so they are already sharp.
2. **Draw the ink at output resolution.**  Move the depth second
   difference into the final pass.  Sample depth NEAREST at scene
   texels (the texel-rounding rule in `post.js` still applies, and
   `ink.mjs` must still pass all five of its cases), but produce the
   line mask per *output* pixel with a threshold that is sharp in
   output pixels.  The lines then have crisp edges at any scene scale.
   This is the one change most likely to make a phone read as sharp.
3. **Contrast-adaptive sharpening when the scene is upscaled**
   (a CAS-style 5-tap in the final pass, strength ∝ output/scene
   ratio, off at ratio ≤ 1).  About one pass of 5 taps at output
   resolution.  Measure its cost on the emulated phone before keeping
   it.
4. **FXAA off when the scene is supersampled** (ratio ≥ 1.4), because
   it only softens there.
5. **Re-tune the governor for weak devices:**
   * target the display's *achievable* rate rather than 48 fps flat.
     When the median sits at a clean 30 (33.3 ms ± 1) and a step down
     bought nothing, that is a cap, not the GPU, and the existing
     "bought nothing" rule should be extended to treat it that way;
   * raise `low.minScale` from 0.6 toward 0.75 *of CSS*, if the
     emulated phone holds 30 there.  A soft picture at 50 fps is better
     than a sharp one at 20, but 0.6 on a DPR-3 phone is 0.2 of the
     panel, and at that point the picture has stopped being a picture.

**What "fixed" means:** the phone and the Surface Go screenshots, from
the `?debug=1` build, look sharp to the user.  I cannot sign this one
off myself.  On the emulations: the canvas buffer equals device pixels,
the median frame time does not get worse by more than 10 %, and
`ink.mjs` still passes.

## 4b. The terrain fails to generate and the car falls into the void

Both devices named have a slow CPU (the Surface Go is a Pentium 4415Y).
That points at the chunk builder, which is main-thread and runs on a
fixed **4 ms per frame** (`ChunkField.budgetMs`).  Three things in
`chunks.js` and `main.js` can put the car over ground that does not
exist yet:

1. **Priority inversion in the queue.**  The queue sorts on `d`, and
   `invalidate()` pushes at `d = -2` and `_relod()` pushes urgent
   rebuilds at `d = -1`.  A *new* chunk is pushed at its distance, which
   is ≥ 0.  So a road backtrack (up to 2.7 km of invalidation) or a
   burst of neighbour-restitches **goes ahead of the missing chunk the
   car is about to drive onto**.  On a fast CPU the backlog clears in a
   few frames.  On a 4415Y it can last longer than the car takes to
   cross 128 m, which is 6 s at `CRUISE`.  A rebuild of a chunk that
   *exists* is cosmetic; a chunk that does not exist is a hole.  The
   ordering has them the wrong way round.
2. **A fixed budget on a slow CPU is a fixed fraction of a much slower
   machine.**  A 1 m chunk is 129² height evaluations with a road query
   each.  If one of those takes 60–100 ms of main thread on a 4415Y, a
   4 ms slice builds one chunk every 15–25 frames.
3. **No safety net for this case.**  `troubleFor` only counts
   upside-down and under-water.  A car falling through a missing
   collider is neither, so it falls until something else happens.

**Measure first:**

* Counters that can be logged in `?debug=1` and read by a probe: frames
  where the car's own chunk (and the chunk 60 m ahead) is not live, or
  live without a collider; queue length by class; ms per chunk build
  by step.
* `perf-bench/void.mjs`: autodrive for ten minutes at
  `setCPUThrottlingRate` 4 and 6, with `?quality=low`.  It counts
  those frames and any fall of the car below `terrain.heightAt − 2 m`.
  It should reproduce the fault before anything is changed.  If it does
  not, the fault is something else and this section is wrong.  In that
  case the next suspect is the unexplained "ground within 100 m does
  not draw" state that `ChunkField.reset()` works around after a
  teleport.  `recover()` (`T`, and the automatic one) teleports and
  does **not** reset.  The probe should call `recover()` a few times to
  test it.

**Fix:**

1. **Three priority classes, not a signed distance.**  (a) *Missing*
   chunks within the physics radius or on the path ahead, nearest
   first.  (b) Correctness rebuilds (invalidated road, finer LOD needed
   near the car, restitch).  (c) Everything else, by distance.  An
   in-flight build of class (c) is abandoned (it is a generator, so
   this is dropping it and re-queuing) when a class (a) request
   arrives.
2. **Coarse first for anything missing.**  A missing chunk is built at
   4 m first, which costs 1/16 of a 1 m build, then refined through the
   existing relod path.  The collider rule (`syncTerrain` swaps on
   identity) already handles the refinement.  Driving over 4 m ground
   for a second is better than falling through none.
3. **An adaptive budget.**  4 ms normally.  Up to about 12 ms while any
   class-(a) chunk is outstanding.  A dropped frame is better than a
   fall.
4. **A net.**  If the car is over a chunk with no collider, or is more
   than 3 m below `terrain.heightAt` (analytic, needs no chunk), freeze
   its vertical motion or `recover()`.  The analytic height is the same
   function the chunks are built from, so it is always available.
5. **Only if (1)–(3) are not enough on the throttled probe:** move height
   generation into a Worker.  The terrain is a pure function of the
   seed, and the road can be posted as nodes.  This is the structural
   fix, but it is days rather than hours, and it only goes ahead if
   `void.mjs` still fails without it.

Acceptance: `void.mjs` at 6× throttle, ten minutes → zero frames with
the car over a missing collider and zero falls.  At 1× there is no
change in frame time.

## 4c. The ground cracks open and the background shows

"It did not affect driving" means the colliders are whole and only the
mesh is open.  There are two plausible causes:

1. **The restitch window.**  Chunk A was stitched to neighbour B at
   B's old step.  When B is rebuilt finer, A's edge is still snapped to
   B's *old* coarse line until A is rebuilt too.  `_relod` flags it as
   urgent, but it is still at least one build later, and on a slow CPU
   many.  Until then there is a sliver of sky along the seam.  It
   appears as the car approaches (refinement), which fits "from time to
   time".
2. **Water and ground**, or road and ground, at a chunk edge.  This is
   less likely, but the probe below will tell.

**Measure:** rebuild the seam probe `next_3.md` §13 item 6 still owes.
Set the clear colour to magenta and hide the sky dome and the clouds.
Autodrive for ten minutes at 1× and at 4× throttle.  Count magenta
pixels below the horizon line per frame, and dump the first few frames
that have any, with the chunk grid overlaid.

**Fix: skirts.**  Each chunk gets a strip along its four edges that
drops a few metres (proportional to its step: 1 m chunk → 2 m skirt,
4 m → 8 m) with the edge normals copied, so it shades as ground.  It
covers every crack class at once, whatever the cause, including ones
nobody has found yet.  It costs about 4 × 129 × 2 extra vertices on a
1 m chunk, under 2 %.  The collider does not get one.  Stitching stays,
because the skirt hides a crack but does not prevent the seam that the
ink would draw along it.

Acceptance: zero magenta pixels in the seam probe at 1× and 4×, and
`streak.mjs` / `verge.mjs` unchanged.

## 4d. What the film itself will be watched for

The film is also a probe.  Two risks follow from the length of the
drive:

* **Float precision.**  Rapier is f32, and so are the instanced
  matrices, the road and furniture vertices, and every shader that reads
  a world position (ground texture coordinates, noise).  At the film's
  ~58 km of arc the car is at most 2^16 m from the origin, where a
  float32 step is under 1 cm.  That is probably fine, and it is no
  longer a blocker for the film.  It is still worth one cheap check,
  because a player's resumed drive can go much further than the film:
  `perf-bench/far.mjs` jumps to s = 60, 150 and 300 km and looks for
  suspension jitter (variance of `car.wheelY` on straight road),
  shimmer in the ground texture, and jitter in the trees.  If it finds
  any, a floating origin goes into `next_4.md` as its own item.  It does
  not go into this plan.
* **Leaks.**  The film logs JS heap size, `renderer.info` (geometries,
  textures, programs) and the live and pooled chunk counts every
  game-hour.  Anything that is still growing at the end of day two is a
  bug.

---

# Item 1 — the autoplayer

Autodrive already steers and holds speed (`car/autodrive.js`, `F`), and
`?rec` already hands the frame loop to a script (`__game.step(dt)`,
`grab()`).  The autoplayer adds the parts a *player* does that
autodrive does not:

`tools/play/autoplay.mjs` (a new `tools/` directory, because this is not
a benchmark):

* It launches Chrome through the existing `cdp.mjs`, runs `?rec=1` on a
  fixed seed, and sets autodrive `full` through `__game.auto`.
* A **scenario script**, so a run exercises what a player would touch,
  on a schedule: cycle the camera (chase / far / bonnet) now and then,
  take the controls for a stretch and give them back (this exercises
  the per-channel override), and occasionally leave the road to test
  `recover()`.  Seeded, so a run can be repeated exactly.
* **Assertions on every step**, not only at the end.  The run fails with
  the step number and a grabbed frame if the car is off the road for
  more than N s under full autodrive, if it falls (§4b), if it is stuck
  (speed < 1 m/s for 10 s), if it recovers more than K times an hour,
  or if an exception is thrown.
* `--headless`, `--throttle N` and `--quality` flags, so the same
  script is the soak test for §4b and §4c on a slow CPU.
* A JSON log per game-minute: position, speed, weather, season, fps,
  chunk and queue counters, heap.  Item 3 reads this log.

No rest (`Z`) and no clock winding (`[` `]`) in the film run.  The prompt
says one continuous drive, and a rest is a cut in everything but name.

---

# Item 2 — the film

**Length.**  A game-day is `DAY` = 1 440 s, and the clock runs at one
game second per real second.  So two game-days without a cut is
2 880 s: **48 minutes of film**, 86 400 frames at 30 fps.

**How it is made.**  Frames are stepped, not screen-recorded:
`step(1/30)` then a frame readback.  So the film is the same film
every time, and it does not depend on the machine keeping up.

* **Readback:** `grab()` gives a PNG data URL, and 86 400 PNG encodes
  plus base64 over CDP is too slow.  Add a `grabRaw()` that
  `readPixels` into a reused buffer (keeping `grab()`'s cleared-buffer
  check and `finish()`), then either:
  * send the raw RGBA frames to the recorder over a local binary
    WebSocket, or
  * the WebCodecs `VideoEncoder` in the page (H.264), where only
    encoded chunks cross to Node.

  Which of the two depends on a 2-minute benchmark of each.  The target
  is at least 15 frames/s of wall clock, which makes the film about
  **1.6 hours to render**.
* **Encode:** Node pipes into `ffmpeg` (NVENC on the GTX 1050 in this
  machine if the in-page route loses; `libx264 -crf 18` otherwise).
  1920×1080, 30 fps, `high` tier (which `?rec` already forces).
* **One uninterrupted run.**  At 1.6 hours, a crash means starting
  again, which is cheaper than building checkpoint and resume and then
  proving that a resumed segment is bit-identical to a straight one.
  The recorder still writes the ffmpeg output as it goes and keeps the
  log, so a failed run shows where and why it failed.  If the benchmark
  comes in far under 15 frames/s (a render over about 5 hours), then
  checkpointing comes back into scope.
* **Deliverables in `/media/DRIVE2/country-road/two-days/`:**
  * `two-days-1080p30.mp4`: 48 min, one take
  * `two-days-timelapse-8x.mp4`: made *from* the master with ffmpeg
    frame selection, 6 min, still continuous with no cuts, just faster
  * `log.jsonl` (the autoplayer's log for the whole drive),
    `contact-sheet.png` (one frame per game-hour, 48 tiles), and
    `README.md` (seed, commit, flags, render time, grab retries)
  * Nothing from this goes in the repo.  Only the scripts do.
* **Start:** day 1, spring, 08:00, which is where every drive starts.
  The film runs to day 3, 08:00: two sunrises, two sunsets, two nights.
* **Weather:** it is seeded, so pick the seed from a quick survey of
  several seeds' first 48 game-hours of weather (the draw is cheap and
  needs no rendering).  Choose one that includes rain and a clear
  night, so the film shows more than one sky.  Put the seed in the
  README.
* **No audio.**  The engine is an AudioWorklet driven by the real-time
  clock.  Under stepped frames it would need an offline render of the
  whole 48 minutes in step with the video, which is out of scope here.
  Say so in the README.

**Dry runs before the real one:** one game-hour (1 min of film), then
six game-hours (6 min), each watched at speed.  Then the film.

---

# Item 3 — how to make it more fun (`ai/suggest_4.md`)

This is written *after* watching the time-lapse, the dry runs, and at
least an hour of driving by hand.  It is not written from the code.
What to look for, so it is measured rather than asserted:

* **Variety per minute.**  From `log.jsonl`, how long the drive goes
  without something changing: bend, crest, weather, landmark, town,
  water.  Long flat stretches are the likely complaint.
* **What a player can *do*.**  Right now it is steer, speed, camera,
  time.  Candidates to weigh, each with a rough cost: photo mode (the
  toon picture is the game's strength), places to stop and look,
  destinations or waypoints, roadside events (animals, traffic, a
  hitch-hiker, a fuel stop), a radio, collectables tied to seasons,
  challenge routes on a shared seed, and a "postcard" share from the
  pause screen.
* **What the drive itself sells.**  The day and night cycle and the
  weather are what two days show.  The seasons are not in the film (it
  is all spring), so before writing about them, drive a few minutes of
  each with `?season=`.  Also consider whether 3 game-days (72 minutes)
  per season is too long for a typical sitting to see even one change.
  That is a question for the user to decide, not for this plan.
* Each suggestion gets a cost against the spec, both the 2–3 s first
  load and entry-level phones.

Ranked, with the top three argued in more detail.

---

# What this plan does not do

* It does not re-derive the far-bucket question from `next_3.md` §11.
  The seam probe in §4c uses the same kind of in-world band, so the
  mask dump that item asked for can be done there cheaply if it comes
  up.
* It does not claim any real-device result.  §4a's acceptance has to be
  the user's screenshot from the actual phone and the actual Surface Go.

# Files expected to change

| file | why |
|---|---|
| `index.html`, `src/core/loader.js` | §5 link, and its event guard |
| `src/core/post.js`, `src/core/quality.js`, `src/main.js` | §4a output resolution, output-res ink, sharpen, governor |
| `src/world/chunks.js`, `src/main.js`, `src/car/physics.js` | §4b priorities, coarse-first, adaptive budget, net; §4c skirts |
| `src/main.js` | `?debug=1`, `grabRaw()` |
| `tools/play/autoplay.mjs`, `tools/play/film.mjs` | items 1 and 2 |
| `perf-bench/void.mjs`, `seam.mjs`, `far.mjs` | §4b, §4c, §4d |
| `README.md` | `?debug`, the link, the tools |
| `ai/suggest_4.md`, `ai/next_4.md` | item 3, and the write-up |
