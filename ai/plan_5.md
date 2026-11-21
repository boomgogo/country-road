# plan_5 — solid trees, moving clouds, a version, and places

Answers `ai/prompt_5.md`.  Two issues and two features.  Both issues have
a cause I can point to in the code, and neither is a trade-off anybody
chose:

* **Issue 1 (trees)** is a bookkeeping bug in `Physics.syncTrees`.  It
  explains "one in a hundred" almost exactly.
* **Issue 2 (clouds)** is the drawn cloud layer (`CloudGeo`, the default
  since `?clouds=geo`).  It pins its clouds to a grid fixed in world space
  and only re-decides them every 240 m.  It is not a rendering saving.
  The fix costs nothing per frame.
* **Feature 1 (version)** is small.
* **Feature 2 (places)** is most of the iteration.

Order of work: **version → trees → clouds → places.**  Places go last
because they reuse the fixed collider pattern from the tree fix, and
because their night lighting has to be judged against a sky that moves
properly.

---

# Issue 1 — why most trees have no collider

## 1. The cause

`src/car/physics.js`, `syncTrees`:

```js
for (const [k, list] of scatter.trunks) {
  if (this.trees.has(k) || !list.length) continue;      // done once, for ever
  ...
  for (const t of list) {
    if (Math.hypot(t.x - x, t.z - z) > this.treeRadius) continue;   // only the ones in range *now*
    cols.push(...);
  }
  if (cols.length) this.trees.set(k, cols);             // marks the whole chunk done
}
```

A scatter chunk is 128 m square.  On the first frame that **any** of its
trunks comes within 95 m of the car, colliders are made for the trunks
within 95 m at that moment, which is usually one to three at the chunk's
near edge.  Then the chunk is marked done, and `this.trees.has(k)` skips
it for as long as it exists.  Every trunk that came into range later never
gets a collider.  In a chunk of about 60 to 100 trunks, that is about one
in fifty to one in a hundred.

The one exception is the chunks around the car at spawn.  Even there,
only the trunks within 95 m of the spawn point get colliders.

There are two smaller faults on top of that:

* **The collider is a third of the drawn trunk's width.**  `r: S.trunk *
  1.35` is in the tree's *unit* geometry, but the instance is scaled by
  `h * S.w` across.  The drawn broadleaf trunk is about 0.32 m in radius
  at its base, and its collider is 0.10 m.  So a glancing hit goes
  visibly through the bark.
* **No rebuild check.**  A scatter chunk rebuilt under the same key (the
  places work below will rebuild them) keeps its old colliders.  Terrain
  already handles this with `have.chunk === c && have.rev === c.rev`, and
  trees need the same test.

What stays as it is, by design: **scrub has no collider** (42 % of plants,
"a bush should brush past"), and neither has any canopy.  If you count the
low bushes as trees, part of "one in a hundred" is this.  See *Decisions*
at the end.

## 2. Measure first

`perf-bench/trees.mjs`, using `?rec` and the stepped clock:

* **Coverage.**  Every 2 s of autodrive, count the non-scrub trunks within
  80 m and how many of them have a collider.  The check is a `castRay`
  across each trunk at half its height, filtered to the trees' colliders.
  HEAD should come out at a few percent.
* **Impact.**  Teleport the car to 25 m from 20 seeded trunks on flat
  ground, facing each one, and drive straight at it at full throttle.
  Pass means the car stops within 1 m of the drawn bark.  HEAD should miss
  most of them.

## 3. Fix

* **Track per chunk, decide by the chunk's box distance.**  A chunk gets
  colliders for *all* its trunks when its box (`boxDist`, as terrain uses)
  comes within `treeRadius`.  It drops them past `treeRadius * 1.25`.
  That is about 9 chunks and at most about 600 static cylinders, which
  Rapier's broadphase barely notices.  Per-trunk add and drop would be
  more exact, but it does more work every frame and buys nothing at 95 m.
* **Store the list's identity** with the colliders, and rebuild when
  `scatter.trunks.get(k) !== have.list`.
* **Size from the instance.**  `Scatter._build` records `r` from the
  instance's own x/z scale: `S.trunk * h * S.w * jitter`, times about 1.1
  so the bark never shows through.  The height is unchanged.

Acceptance: `trees.mjs` gives 100 % coverage within 80 m, 20 of 20 impacts
stop at the bark, and scrub still passes through.  The physics step time
at 4× CPU throttle stays within noise of HEAD (`stats.stepMs`).

---

# Issue 2 — the clouds stand still and then jump

## 4. The cause, and the answer to "is this to save rendering?"

**No.**  The GPU draws the whole cloud instance set every frame either
way.  What is being saved is a **CPU scan**, and the way the scan was
skipped is what freezes the sky.

`src/world/cloudgeo.js`, `_place`:

* Each cloud sits at `(ix + jitter) * cell`, a grid fixed in **world**
  space.  Whether a cell holds a cloud is decided by sampling the field,
  and the field *does* drift: `rawAt` adds `ofs`, which is 9 m/s × clock
  time.  So the wind moves the field under the clouds, but never moves the
  clouds themselves.
* The set is rebuilt only when the eye has moved 240 m, the drift has
  moved 240 m, or the coverage cut has changed by 0.004.  Parked, that is
  every **27 s**.  At cruise it is about every **12 s**.  During a weather
  blend it is every few frames.
* Between rebuilds every cloud is frozen.  At a rebuild, every cell whose
  field value crossed the cut pops in or out, and every surviving cloud
  changes size, because `rad` depends on `v - cut` and `v` has moved under
  it.  That is "stationary for a while, then jumps to the next state".

There is a second symptom of the same cause: **the ground shadows do
move**.  They come from the field on the GPU, continuously.  So a cloud
and its own shadow drift apart by up to 240 m and then snap back
together.

The scan is about 1 800 cells × 3 CPU texture taps, plus a sort and up to
2 500 lobe matrices.  That is too much to do every frame on a phone, so
keeping a threshold is right.  The fault is that a rebuild *changes*
clouds that should not change.

The march (`?clouds=march`) samples the field per pixel, so it drifts
smoothly already and is not touched here.

## 5. Measure first

`perf-bench/cloudmove.mjs`, `?rec`, a parked car, `?weather=partly`, at
noon:

* Grab the upper half of the frame every 0.5 s for 90 s, and take the
  mean absolute difference between consecutive grabs.  HEAD should show
  flat zeros with a spike about every 27 s.  The fix should show a steady,
  small, nonzero line with no spikes.
* **Cloud against shadow.**  For each drawn cloud centre, `rawAt` at its
  current world position must stay above the cut over time.  On HEAD it
  drifts off and snaps back.
* Time `_place` at 1× and 4× throttle, so the cost is known before
  anything moves it.

## 6. Fix

1. **Put the grid in the field's frame.**  Cell centres are
   `(ix + jitter) * cell` in *field* coordinates, and a cloud's world
   position is that minus `ofs`.  The field is a rigid translation (both
   scales in `rawAt` take the same `ofs`), so a cloud's field value is
   then constant for as long as it exists.  It cannot pop because of the
   drift.
2. **Move the mesh every frame.**  `mesh.position = -(ofs - ofsAtBuild)`
   on x and z.  That is one matrix per frame.  Clouds move at the wind
   speed, exactly with their shadows.
3. **Rebuild on eye movement in the field frame** (`eye + ofs`), keeping
   the 240 m threshold.  A rebuild now reproduces every surviving cloud
   exactly.  Only three things still change at a rebuild:
   * cells crossing the outer range at 17 km, which are already haze;
   * cells crossing a ring boundary at 5 or 10 km, where the cell size
     changes;
   * the coverage cut, during a weather change.
4. **Grow and dissolve rather than pop**, for what still changes.  Each
   cloud gets a key of `(ring, ix, iz)` and an instanced `aGrow`
   attribute holding its birth or death time.  `LOBE_VERT` scales the
   lobes about the cluster centre from 0 to 1 over about 8 s of real time,
   which looks like a cumulus forming.  A removed cloud stays in the
   buffer and shrinks out.  15 % of the slots are reserved for clouds that
   are fading.  The ring boundaries get ±300 m of hysteresis, so a cell on
   a boundary does not flicker between rings.
5. **Weather changes now read as weather.**  A falling cut adds clouds
   that grow in, and a rising one dissolves them, over seconds instead of
   a single frame.
6. **Jumps of the clock are not fades.**  A rest (`Z`) or a scrub
   (`[` `]`) moves `ofs` by kilometres.  If `ofs` moves more than 1 km in
   one frame, the layer rebuilds without fading.
7. **Only if `_place` costs more than about 2 ms at 4× throttle:**
   spread the rebuild over three frames, one ring per frame.

Acceptance: `cloudmove.mjs` shows no spikes, and cloud and shadow agree at
every sample.  `cover.mjs` still lands on the march's sky fraction
(`partly` about 0.34, `cloudy` about 0.48).  A 10-minute `autoplay.mjs`
run passes.  A rest and a scrub end on a correct sky with no smear.

---

# Feature 1 — the version, in an unused corner

## 7. What and where

**The string.**  `v.` followed by the first 4 hex characters of the
commit being built, for example `v.b3b6`.  `vite.config.js` works it out
once, at config time:

1. `process.env.WORKERS_CI_COMMIT_SHA`, if Cloudflare's git-connected
   builds are ever used;
2. otherwise `git rev-parse HEAD`;
3. otherwise `dev`.

It reaches the page two ways:

* **Static markup.**  A small `transformIndexHtml` plugin replaces
  `%COMMIT%` in `index.html`.  The label paints with the first paint,
  needs no JS, and adds nothing to the load time, for the same reason the
  fork link is markup.
* **`define: { __COMMIT__ }`** for JS: the first line of `?debug=1`,
  `__game.version`, and one `console.info` at boot, so a bug report can
  name the build.

`npm run deploy` already builds first, so the deployed page carries the
commit it was built from.  `index.html` is unhashed and Workers static
assets revalidate it by default, so a new deploy shows its new version.

**The corner is top-left**, because it is the only corner free on both
devices and on both screens:

| corner | desktop, driving | desktop, load/pause | touch, driving | touch, load/pause |
|---|---|---|---|---|
| top-left | free | free | free | free |
| top-right | free | fork link | AUTO / CAM / ☰ | free |
| bottom-left | distance | free | thumb pad | free |
| bottom-right | speed | free | pedals | free |

`<p class="ver">` sits outside both `#load` and `.hud`, so one element
covers the load screen, the pause menu and the drive.  Its position is
`top: calc(6px + env(safe-area-inset-top))` and
`left: calc(8px + env(safe-area-inset-left))`.  The type is the HUD's:
monospace, 9–10 px, wide letter-spacing, white at about 0.35 opacity.  It
has `pointer-events: none` and a z-index above the load overlay.  It sits
above the top stack, which starts at 20 px on desktop and 48 px on touch,
so they do not overlap.

* Hidden under `body.clean` (`?rec`, so not in films) and by `H`.  `H`
  currently hides only `hud.el`, so it also sets a body class.
* `?debug=1` draws over top-left.  The label hides there, and the version
  moves into the overlay's first line.

Acceptance: a production build shows `v.xxxx` matching
`git rev-parse --short=4 HEAD` on the load screen, the pause menu and
while driving, at 1920×1080 and in the 393×851 phone emulation.  It
overlaps nothing, it is absent from `?rec` frames, and the first-load
time does not change.

---

# Feature 2 — places (`suggest_4.md` §1)

## 8. What goes in

From the suggestion, in the order they get built:

* **Towns**, every 15–25 km of road.  The first is about 4 km from the
  start, so a new drive reaches one in its first four minutes.  Each has
  10–16 houses, a pub with an upstairs veranda, a servo (fuel canopy,
  bowsers and a shop), a hall or a small timber church, street lights on
  the main street, and a war memorial at the middle.
* **Landmarks**, every 2–4 km between towns: a farmhouse with a
  windbreak, a woolshed, a pair of silos, a windmill and tank, and a
  lookout.  None within 1.5 km of a town.
* **Signposts**: town entry and exit signs, a "60" at each end of town,
  and green distance signs.  The sign after each town gives the next two
  towns; there is one more every 5 km or so, and one 1–2 km before a
  town.  For example "Wattle Creek 12 / Stony Flat 31".  A HUD toast on
  entering a town, and "near Wattle Creek" in the load screen's `continue`
  line.
* **Lights at night** for all of it (§13).

Out of this iteration: the one-lane bridge, because the tracer avoids
water rather than crossing it (`trace.js:527`) and a bridge is tracer
work.  Also out: the memorial *at a crossroads*, since there are no
crossroads; it goes at the middle of the town instead.

## 9. Where things go: by arc length, on laid road only

**A schedule that is a pure function of the seed.**  `places.js` derives,
per line (`mid` forward, `back` backward), a list of
`{ s, kind, side, seed }`.  The gaps between entries are seeded, so place
*k* is at a fixed `s_k`, whether or not the road has been traced there
yet.  A town's name comes from the same seed.

* **Signs can therefore be put up before the town exists.**  A sign at
  `s` says `round((s_town - s) / 1000)`, and it is exact by construction:
  the town is *defined* to be centred on `s_town`.  Its lots spread over
  `s_town ± 400 m`, or ± 800 m if too few lots pass the site test.  The
  entry sign goes 150 m before the first lot that was built.
* **Nothing needs saving.**  Places come out of (seed, line, s), and the
  road is already deterministic per seed.

**Built only on road that will stay.**  The tracer can delete and
re-trace nodes ahead (`Midline` reverts, `lowWater`).  So a place is
built only once its road is traced, inside a streaming window of
`s - 400` to `s + 1600`.  It is wider ahead than the furniture's `+620`,
because a town should be visible across a valley.  The main loop already
takes `road.takeDirtyBoxes()` and `road.takeLaidBoxes()` once a frame for
the chunks.  The same boxes go to `places.invalidate()` in the same loop,
because `take*` consumes them.  Any place under a dirty box is dropped and
re-sited.

**The site test**, per building footprint:

* all four corners ≥ 9 m from the carriageway edge (`road.nearest`), and
  ≥ 22 m from the *other* part of the road, wherever it loops back near;
* every corner above `WATER_LEVEL + 1.5`;
* corner heights within 2.5 m of each other for a house, 1.5 m for a
  shed, 0.8 m for a silo;
* not over another place.

A lot that fails is left empty: a town on a hillside is a smaller town.

**No terrain edits.**  `heightAt` is load-bearing and was just made 3.5×
cheaper, and pads would put a new term in it.  Buildings stand on what the
land gives them instead:

* a house sits on **stumps**, the Queenslander answer to a slope, and the
  right look for the east coast;
* a shed or woolshed sits on a concrete plinth that runs 0.5 m below the
  lowest corner;
* silos and tanks get a ring footing.

Floor level is the highest corner plus 0.3 m.  The chunks' skirts
(`next_4.md` §8) already show that below-ground geometry is safe with the
ink.

**Trees out of the yard.**  `Scatter._build` rejects any point inside a
place's clearing (`places.blocked(x, z)`, a grid lookup).  Places resolve
before scatter reaches them, because the place window runs 1.6 km ahead
and scatter 340 m.  When a place is built or dropped, the scatter chunks
it overlaps are rebuilt anyway; the tree fix's list-identity check is what
lets the colliders follow them.  The farmhouse's windbreak and a couple of
yard trees use the scatter's own geometry and materials, so they turn with
the seasons for free.

## 10. What they are made of

**One procedural kit, no assets.**  `src/world/placekit.js` builds each
archetype once, at load, as merged low-poly geometry with vertex colours:

| archetype | parts | about |
|---|---|---|
| house ×3 variants | weatherboard box, gable or hip roof, veranda and posts, stumps, steps, water tank | 250 tris |
| farmhouse | house + wider veranda + shed | 400 |
| pub | two storeys, upstairs veranda, parapet sign | 450 |
| servo | canopy on 4 posts, 2 bowsers, shop box, price sign | 300 |
| hall / church | gable box, porch / belfry | 200 |
| woolshed | long box, skillion roof, yards (rail boxes) | 350 |
| silos | 2 × cylinder + cone, conveyor | 300 |
| windmill + tank | lattice of thin boxes, blade disc (turns), tank | 350 |
| lookout | gravel pad, rail, bench, sign | 120 |
| memorial | plinth + obelisk | 60 |
| street light, signs | pole + head; post + panel | 20–40 |

**Drawn the way everything else is.**  The materials come from `cel()`
with `vertexColors`, the season patch (snow on roofs, wet in rain) and
`patchClouds`, so cloud shadows cross a town as they cross a hill.  The
ink pass outlines buildings with no extra work, since it reads depth.
`castShadow` is on.

**Instanced per archetype**, so a town is about 10–14 draw calls plus
lights and signs.  An instance colour gives each building its own roof
(Colorbond red, green, grey, blue).  A per-vertex roof mask applies that
colour to the roof only, so the walls stay weatherboard.

**Colliders.**  `physics.syncPlaces`: a cuboid per building, a cylinder
per silo and tank, and thin boxes for the posts of signs and street
lights.  Made per *place* when its box comes within 190 m, not once per
chunk.  That is the lesson of §1.

**Loaded after the first frame.**  `places.js` and `placekit.js` come in
through a dynamic `import()` once the drive is running, because the first
place is kilometres away.  Initial load is unchanged, and the spec's
2–3 s is untouched.  `?places=off` turns all of it off, for A/B frame
times.

## 11. Names

Towns are named from the seed, as compounds of plain English country
words:

* first words: Wattle, Stony, Cedar, Ironbark, Grey Gum, Possum, Kelpie,
  Red Hill, Bellbird, Black Swamp, and about 40 more;
* second words: Creek, Flat, Gully, Springs, Crossing, Downs, Vale,
  Ridge, Plains, Bend, Hill, and about 10 more.

That gives about 800 names with no repeat inside a drive.  Some will
match real places, which is fine for words like these.  It deliberately
does **not** generate pseudo-Aboriginal words from syllables.  Made-up
words in that style can land on real words or names with meanings, and
that is not something to do by accident.

## 12. Signs

* **Text** goes into one canvas atlas: a white label on Australian sign
  green, entry signs in their own style, and the 60 in a red ring.  The
  canvas is drawn once per town name as it resolves and uploaded as one
  `CanvasTexture`.  Each sign instance reads its UV rectangle from an
  instanced attribute.
* **At night** a sign is lit by the headlight SpotLights like everything
  else.  A retroreflective boost on the panel (an emissive term from the
  angle between the headlight and the panel, the same uniforms as the
  lamps) makes it flare in the beam the way a real sign does.

## 13. Night: the lights have to show

This is the part the prompt calls out.  It has four layers, all with a
**fixed count from boot**.  `lights.js` explains why: three.js
recompiles every material when the light count changes, so nothing here
is a new `THREE.Light`.

1. **Windows.**  Inset quads on every building, in their own instanced
   mesh with an unlit material.  By day they are dark glass tinted by the
   sky.  At night each window is warm yellow (`#ffcf7a`, at an HDR level
   to be set against the grade), switched by a per-window hash against the
   clock:
   * windows come on between dusk and an hour after it, so a town lights
     up gradually;
   * most go off between 22:00 and 01:00;
   * a porch light per house and the pub sign stay on all night.

   Lights are seasonal for free, because dusk is `clock.night`, the same
   scalar the headlights use.  Windows take only half the fog, so a
   farmhouse window still reads 1.5 km away across a valley, which is the
   picture `suggest_4.md` §3 asked for.
2. **Glows.**  One instanced mesh of additive, camera-facing quads, one
   per light source (window group, porch, street light, servo canopy).
   They are depth-tested with no depth write, so the ink never sees them.
   Each has a minimum size on screen, so a distant light is a point and
   not nothing.  This is what makes a town visible at night from a ridge.
3. **Light on the ground.**  A material patch, `patchLamps`, in the same
   pattern as `patchClouds`, on the terrain, road, building and furniture
   materials.  It is a fixed array of the **8 nearest active lamps** (4 on
   `low`), written once a frame, and adds a pool of light quantised into
   the cel bands.  Street lights then light the road you drive through
   town on, and a porch light lights its yard.  The cost is 8 distance
   tests per fragment, and it is zero by day, because the count is 0 and
   the loop exits.  The tiers carry the count.
4. **A town's glow on the horizon.**  One large, faint, additive sprite
   over each resolved town out to 8 km, hazed by distance.  It costs
   nothing.  Towns behind the car (on the `back` line, already resolved)
   glow in the mirror too.

**The first thing to check is whether the post chain keeps them.**  The
look pass and `setNight` darken the whole frame.  Before the lights are
tuned, a probe frame at 22:00 measures what a window at level 1.0, 2.0
and 4.0 comes out as on screen.  If the scene target clamps at 1.0, the
grade has to leave emissive alone, and that is a `post.js` change.

## 14. How it is checked

* **`perf-bench/places.mjs`.**  For the first 6 towns and 20 landmarks of
  two seeds, it teleports to each and checks four things:
  * no footprint is within the clearance of either road line;
  * no building floats more than 0.6 m or is buried by more than its
    plinth;
  * no tree trunk stands inside a clearing;
  * every building within 190 m has a collider.

  It grabs one still at 11:00 and one at 22:00 at each, and puts them on
  contact sheets with `tools/play/sheet.py`.  **The sheets are for you
  to look at**, because whether a town reads as a town is not a number.
* **Signs are consistent.**  Along 60 km of road, each sign's number is
  within 0.5 km of the arc distance to that town's centre, and the names
  on consecutive signs follow the schedule.
* **Cost.**  `autoplay.mjs --realtime --throttle 4 --quality low`, in the
  phone emulation and at 1280×720 `medium`.  Median fps inside a town must
  be within 10 % of the open road, and within 15 % at night with all
  lights on.  Draw calls (`renderer.info`) are logged in town and out.
* **Soak.**  A 40-minute `autoplay.mjs` run with places on: no new
  failures, and heap and geometry counts flat.  Places stream in and out,
  so a leak would show here first.
* **First load.**  The same measurement as earlier plans, before and
  after.  Places are behind a dynamic import, so it should not move.

---

# Decisions I made — say if you want them the other way

| | default in this plan | the alternative |
|---|---|---|
| bushes (scrub) | stay soft, no collider | solid, about 1.7× the colliders |
| version on a build with uncommitted changes | `v.xxxx` of HEAD, exactly as the template says, and the build prints a warning | add a mark, such as `v.xxxx+` |
| town spacing | 15–25 km (`suggest_4.md`), the first at about 4 km | closer, such as 8–15 km; it is one constant |
| autopilot through town | unchanged | slow to the posted 60 (out of scope here; it changes `autoplay.mjs`'s watch too) |

# Deliberately not in this plan

* Bridges, crossroads, side roads.  Tracer work, and the next thing that
  would make places better.
* Traffic, animals, reflector posts, a bluer night (`suggest_4.md`
  §3 and §5).  Night lighting here is only the places' own.
* The open items from `next_4.md`: the real-device screenshots for §4a,
  and the car's shading 60 km and more from the origin.  The places
  probe will visit sites 20–60 km out, though, and any shading fault on
  buildings out there goes into `next_5.md`.

# Files expected to change

| file | why |
|---|---|
| `vite.config.js`, `index.html`, `src/core/hud.js`, `src/main.js` | §7 version: the define, the HTML plugin, the label, `H`, debug line |
| `src/car/physics.js`, `src/world/scatter.js` | §3 tree colliders: per chunk by box distance, list identity, real radius; and `syncPlaces` |
| `src/world/cloudgeo.js` | §6 the field-frame grid, the per-frame offset, grow and dissolve, hysteresis |
| `src/world/places.js` (new) | §9 schedule, names, siting, streaming, invalidation, `blocked()` |
| `src/world/placekit.js` (new) | §10 archetype geometry, materials, windows, signs atlas |
| `src/world/lamps.js` (new) | §13 `patchLamps`, the nearest-8 lamp set, glows, horizon glow |
| `src/core/quality.js` | lamp count per tier |
| `src/core/post.js` | only if §13's probe finds the grade crushing emissive |
| `src/core/loader.js` | "near *town*" on the continue button |
| `perf-bench/trees.mjs`, `cloudmove.mjs`, `places.mjs` (new) | §2, §5, §14 |
| `README.md` | the version label, `?places=off`, the new probes |
| `ai/next_5.md` | the write-up |
