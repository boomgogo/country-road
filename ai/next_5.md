# next_5 — what landed for `prompt_5.md`, and what it left

Implements `ai/plan_5.md`.  All four items are in.  Both issues were
measured on HEAD by a new probe before anything was changed, and both
probes now pass where HEAD fails.  Nothing is committed.

**Landed**

| file | what |
|---|---|
| `vite.config.js`, `index.html`, `src/core/hud.js`, `src/main.js` | §7 the version: `v.` + four hex digits of the commit, top left, static markup |
| `src/car/physics.js`, `src/world/scatter.js` | §3 tree colliders per chunk, by box distance and list identity, at the drawn radius; `syncPlaces` |
| `src/world/cloudgeo.js`, `src/world/cloudfield.js` | §6 the cloud grid in the field's frame, the mesh following the drift, grow and dissolve, a scan spread over frames |
| `src/world/placeplan.js` (new) | §9 the schedule, the names, the signs' towns, "near *town*" — on the first load, about 3 kB |
| `src/world/places.js` (new) | §9–13 siting, streaming, building, the sign atlas, windows, glows, lamps |
| `src/world/placekit.js` (new) | §10 fifteen archetypes, procedural, vertex-coloured |
| `src/world/lamps.js` (new) | §13 the lamp pools as a material patch; on the first load, about 2 kB |
| `src/world/groundmat.js`, `src/road/furniture.js` | patched with the lamps |
| `src/core/quality.js` | `lamps` per tier: 8, 8, 4 |
| `perf-bench/trees.mjs`, `cloudmove.mjs`, `places.mjs` (new) | §2, §5, §14 |
| `perf-bench/cdp.mjs`, `tools/play/lib.mjs` | `CDP_PORT`, so a soak and a probe can run at once |
| `README.md` | the version, places, `?places=off`, the probes |

---

# Issue 1 — the trees

The cause was the one `plan_5.md` §1 named: `syncTrees` made colliders
for the trunks in range on the first frame *any* trunk of a chunk was,
then marked the whole chunk done.

`perf-bench/trees.mjs`, `?seed=country`, stepped:

| | HEAD | now |
|---|---|---|
| trunks within 80 m with a collider | **126 of 1508 (8.4 %)**, worst sample 1 of 57 | **2397 of 2397 (100 %)** |
| drives at a trunk from 25 m that stop at the bark | 2 of 8 (the six others drove through) | **20 of 20** |
| bumper-to-axis at the stop | — | 0.02 – 0.40 m, about the trunk's own radius |
| physics per frame at 4× CPU, 1280×720 | — | 1.18 – 1.24 ms with 393 trunk colliders, against 1.08 – 1.21 with none |

So "one in a hundred" was about one in twelve on this seed, the rest of
it being scrub, which still has no collider by design.  The collider is
now the drawn trunk's base radius plus 5 %; it was the unit geometry's
0.10 m against a drawn 0.2 – 0.45 m.

The probe skips a drive when the slope steers the car wide of the trunk,
and says so; one of 21 was.

# Issue 2 — the clouds

**The answer to the question in the prompt: it was not a rendering
saving.**  The lobes were drawn every frame either way.  What was saved
was a CPU scan, and skipping it froze the sky between rebuilds.

`perf-bench/cloudmove.mjs` reads the cumulus layer's own render target
(the frame itself hides it: the cirrus is drawn per pixel from the field
and moves every frame whatever the cumulus does).  Parked, `partly`,
noon, 60 s:

| | HEAD | now |
|---|---|---|
| change between grabs 0.5 s apart, median | 0.012 — standing still | 0.22 — drifting |
| grabs with nothing moving | 37 of 114 | 0 of 114 |
| jumps | **8.6 and 10.3** at 22.5 s and 50.5 s | none; max 0.54 |
| field under the lobes, drift since written | 0.0145 — clouds walk off their shadows | **0.0000** |

What changed (§6): the grid is in the field's frame, so a cloud's field
value never changes and the drift cannot pop it; the mesh moves by the
drift every frame, so clouds and shadows move together; what a rescan
still changes (the range edge, ring boundaries, the budget, the cut in a
weather change) grows in or shrinks out over 8 s; jumps of the clock or
the car (rest, scrub, teleport) rebuild at once with no fades.

Two things beyond the plan:

* **The deck follows the eye's height continuously.**  It is set as a
  height *above the camera*, and was moved in a step at each rebuild too —
  50 m at once on a climb.
* **The rebuild was the expensive part, not the scan.**  Composing ~2 900
  lobe matrices was 3.4 ms of the 3.7.  Each cluster's lobes are now kept
  in a frame that only moves every 30 km of drift, so a rescan copies
  them.  A rescan is now 0.1 – 0.2 ms per frame for six frames (320
  cells each), then 0.5 ms to commit.  A full rebuild — only on a jump —
  is 2.5 ms, 12.9 at 4× throttle.

`cover.mjs`, geo layer, HEAD → now: `country` 0.124 → 0.147, 0.340 →
0.329, 0.485 → 0.510 (few clouds, partly, cloudy); seed 7 0.209 → 0.168,
0.412 → 0.416, 0.508 → 0.530.  Both directions, summing to 2.078 against
2.100: the lattice moved, so the sample of sky in one frame is different,
and the fraction has not.

# Feature 1 — the version

`v.b3b6` today, top left, 9 px at 0.35 opacity.  Checked on the load
screen and while driving at 1280×720 and in the 393×851 phone emulation:
it overlaps nothing, it is gone under `?rec`, `H` and `?debug=1` (whose
first line now carries it), and `__game.version` and one `console.info`
say it too.  `npm run build` writes it into `dist/index.html`; a dirty
tree prints a warning and still says HEAD's hash, as decided in the plan.

# Feature 2 — places

**What a drive now has**: a sign at the start ("Ferny Gap 4 / Curlew
Point 24" on `country`), a farmhouse at 1.5 km, the first town at about
4 km, a landmark every 2 – 4 km and a town every 15 – 25 km, both ways
along the road.  A toast on entering a town; "near Ferny Gap" or "8 km
from Ferny Gap" on the continue button and the pause menu.

`perf-bench/places.mjs`, the first 6 towns and 20 landmarks of `country`
and of `7`:

* **46 of 52 sited, 0 failing** — clearance from every road, standing
  on the ground within what the footing allows, no trunk in a yard, a
  collider in every building.  Towns came out at 14 – 20 buildings each.
  Of `country`'s six, four have all of memorial, pub, servo and hall or
  church; Curlew Point lost its hall and Currawong Ridge its pub and its
  hall to the slope of the ground, after nine nudges along the street,
  both sides and three setbacks each.
* **6 refused by their ground** — two lookouts, a farmhouse and three
  sets of silos, all on slopes past what a plinth or a ring footing can
  take.  They are left empty, which is the plan's rule: a town on a
  hillside is a smaller town, and a farm on one is no farm.
* **Signs exact**: 0 of 30 off by more than half a kilometre, on both
  seeds — by construction, and now by measurement.
* Contact sheets at `capture/places/day.png` and `night.png`.  **They are
  for you to judge**; I think the towns read as towns and the night is the
  best thing in this iteration.

**Cost**, `places.mjs MODE=cost`, real frames, 4× CPU, the car driving
through the first town:

| | town vs places off | town vs open road |
|---|---|---|
| 1280×720 `medium`, 11:00 | −4.0 % | −2.7 % |
| 1280×720 `medium`, 22:00 | +5.7 % | +1.8 % |
| phone 393×851 `low`, 11:00 | −14.7 % | −8.8 % |
| phone `low`, 22:00 | −0.5 % | −0.5 % |

The plan's bar (within 10 % of the open road, 15 % at night) is met
everywhere.  The phone's −14.7 % against places off is **noise, mostly**
— the same build gave −11.5 % and +1.7 % in other runs, because the chunk
builder alone takes 6.7 ms of a 25 ms frame at 4× and swings with how
much ground is queued.  Timed per system instead, on the phone at 4×:
places' script is 0.13 ms a frame and the render 0.64 ms more, about 3 %.
The probe now reports the mean as well as the median.

Changed on the way, against the plan:

* **Merged, not instanced.**  §10 said an instanced mesh per archetype.
  A town is 18 buildings of 8 kinds, so that was 8 draw calls of two or
  three instances, twice with the shadows — +31 calls in town.  Each
  place is now one mesh of buildings with each building's colours baked
  in, one of windows, one of footings and posts: +16.
* **Siting is spread over frames**, 1.5 ms each: a town is 1 – 16 ms of
  height samples here, several times that on a phone.
* **Road boxes do not drop a place outright.**  The road's growing tip is
  in a box every frame; a place in one is asked whether its own road is
  still where it was and its footprints still clear every road, and kept
  if so.  A lot that was refused is asked again only when road is taken
  *away* near it: new road can only add to what it must keep clear of.
* **Clearing a yard keeps the wood.**  A tree skipped for a yard takes
  the five random draws it would have taken, so the other trees in its
  chunk stay where they were.
* **The pub's and the servo's signs are lit at night**, from within; road
  signs flare in the headlights as planned.
* **The post chain was checked by eye, not by the numeric probe** §13
  described.  The scene target is half float, the windows at 2.2 come
  through warm and bright in every night still, and nothing in `post.js`
  needed to change.

The first load: 1349 kB gzipped against 1344 on HEAD (+0.4 %).  Vite now
splits three.js into a shared chunk — it is called `lamps-*.js`, after
one of its modules, which is only a name — and `places-*.js`, 17.6 kB
gzipped, is fetched when the boot starts and waited on by nothing.  That
is a change from §10, which said after the first frame: beside a car of
megabytes it lands long before the click either way, and a drive resumed
in the middle of a town no longer watches the town arrive.

**Soak**: `autoplay.mjs --minutes 40` on `country`, stepped, against a
production build served by `vite preview` (a first run on the dev server
was cut off at game-minute 23 when an edit to `main.js` hot-reloaded its
page; the build is the final code less two small changes made while it
ran, the pause menu's arc position and the 60 sign's size): **44 km over 40 game-hours, every action ok, no
failures**, no frame over a missing chunk or a stale collider and no fall.
Geometries held at 550 – 630 throughout (means 553 and 582 for the two
halves), scene objects at about 550, textures at 22 — one more than HEAD's
21, which is the sign atlas.  The JS heap read 115 MB on average in the
first half, 130 in the second and 151 at the last sample; it is sampled
without a forced GC and swings by 30 MB between neighbouring minutes, so
that is not a leak and not proof of none.  A longer run with
`--js-flags=--expose-gc` and a collection before each sample would settle
it.

---

# Found on the way, not fixed

* **The headlights still recompile every material at dusk.**  `lights.js`
  says the lamps exist from boot so the light count never changes — and
  then sets `light.visible = level > 0.01`, and three leaves invisible
  lights out of the count.  In the soak the program count went from 34 to
  53 at 19:06, the first dusk.  The programs are cached after that, so it
  is once a session, but it is the stall the comment says it prevents.
  The fix is one line (always visible, intensity 0) and costs two spot
  lights' worth of lighting maths by day; worth measuring on the Surface
  Go before choosing.
* **There is no guardrail on the backward line.**  `main.js` calls
  `furniture.update(Math.max(0, s - 200), s + 620)`, which for a negative
  `s` is an empty range — so driving the other way from the start there
  are no rails and nothing to stop the car leaving the road.  Older than
  this iteration.
* **The pause menu's save writes a stale position when driving by hand.**
  `openMenu` saves `s: auto.s`, and `Autodrive.sync` only runs while the
  autopilot is holding something — so a player who drove manually, pressed
  `Esc` and closed the tab resumes where the autopilot last was, or at the
  start.  The throttled save in `tick` uses the right `s`; the forced one
  does not.  "Near *town*" in that menu now reads the car's own arc
  position (`roadS`) for exactly this reason; the save itself I left alone,
  since it predates this iteration — it is the same one-word change.
* **Towns ahead of the traced road have no horizon glow yet.**  A glow is
  put up when a town is sited, and siting needs road; the road is traced
  2.4 km or so ahead, so a town's glow appears about when its lights do.
  Behind the car they glow out to 8 km as planned.

# Next, in the order I would do them

1. **The pause save** above — `roadS` for `auto.s`, one word.
2. **The headlight recompile** above — a measured one-liner.
3. **Rails on the backward line** — `furniture.update` by direction, the
   way `main.js` already extends the road.
4. **Bridges and crossroads** (`suggest_4.md` §1, held back in the plan):
   a one-lane bridge where the tracer meets a creek, and a side road into
   each town, so the memorial can stand at a crossroads.
5. **A bluer night** (`suggest_4.md` §3).  With lights in the world the
   rest of the night can come up a little; the stills show how dark the
   land between towns still is.
6. **Something to collect** (`suggest_4.md` §2): the photo mode `P` is
   still bound to nothing, and each town's sign is now a postcard.
7. Real devices for `next_4.md`'s §4a, still open, and now with towns —
   a phone at night in a town is the case `MODE=cost` can only emulate.
