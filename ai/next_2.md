# next_2 — what landed for `prompt_2.md`, and what it left

Implements `ai/plan_2.md`.  Both halves are in and measured; both left
something behind, and §4 and §7 are those.

**Landed**

| file | what |
|---|---|
| `src/world/terrain.js` | the three creases: the shoulder fall, the platform hinge, the crest rounding |
| `src/world/cloudgeo.js` | new — the drawn cloud layer |
| `src/main.js` | picks the layer; `?clouds=march` keeps the raymarch |
| `src/core/quality.js` | `cloudCount` and `cloudDetail` per tier |
| `ai/perf-bench/verge.mjs` | new — creases in the road corridor, a regression test |
| `ai/perf-bench/cover.mjs` | new — sky cover against `w.cloud`, both layers |
| `ai/perf-bench/gpu.mjs` | unstuck: it wrapped `P.ink`/`P.grade`, which became `P.look` |
| `ai/plan_2/verge.png`, `sky.png` | before and after, both halves |

---

# Part A — the road's ink edges

## 1. It was three creases, not one

`plan_2.md` found two and the third turned up while fixing them.  All three
are in the height function, all three run the whole length of the road, and
all three reach the screen the same way: the ink draws a second difference
of depth, the ground is a lattice, so a crease arrives as a slope break of
`curvature x vertex spacing` at one vertex row — 1 m in the corridor.

| crease | was | drew as |
|---|---|---|
| the shoulder fall in `crown` — 16 cm spent over the last 95 cm of tarmac | slope break 0.35 | a broken band of dashes hugging the white line |
| the platform → batter hinge | 0.50 fill, 0.67 cut | long diagonal strokes up the cutting, along the triangulation |
| `round()`'s `over` ramp | 0.25, twice | one break on top of the hinge, cancelling the fillet, and one six metres out in the grass |

The third is the one that makes the other two look easy.  `round` was
`0.5 * min(gap, 3 * min(1, over / 6))`, and it had two faults: it ramped on
`over`, which is a slope of a quarter switching on at the platform edge and
off six metres later; and `min(gap, 3) * 0.5` is nonzero for *every* gap,
so it lifted the whole cut face by up to a metre and a half instead of
easing its crest.  The batter was never the batter it said it was.

## 2. The fix

**The fall runs to the platform edge.**  `crown(d, w)` drops the same 16 cm
as a smoothstep from 0.78 of the carriageway out to `w`, which is 3.2 to
4.2 m of ground rather than 0.95 — a peak curvature of 0.08 per metre.
Ending it at `w` rather than at a constant keeps it in step with
`platform()`: the fall finishes exactly where the batter begins, both with
zero slope, so there is no second crease where they meet.  The tarmac is
flatter for it — 3 cm of drop at the white line rather than 16 — and the
drawn edge does not move, because the tarmac mask is keyed on distance.

**The hinge is filleted.**  `batter(over, ratio)` is a parabola for the
first `HINGE = 6` m and the straight batter after it: C1 at both ends,
constant curvature `1 / (HINGE * ratio)`, which is 0.11 in cutting and 0.08
in fill.  The crest and the toe move out by 3 m.

**The crest rounding is a function of `gap` alone**, a parabola that is
exactly zero once the face is `k` below natural ground and exactly `gap`
once it is `k` above.  `k` still has to grow from nothing at the platform
edge — a blend of scale `k` pulls the surface `k/4` off natural ground
wherever the two are merely *close*, downward in the cut branch and upward
in the fill branch, so at the platform edge, where which branch we are in
is a coin toss between `h` and `edge`, it is a step of `k/2` running the
length of the road.  That cost a detour: breaks of 0.8 at s = 2500, worse
than the crease it replaced.  `k` is ramped over twice the hinge, which
keeps it under the batter's own height everywhere and therefore keeps the
branch change inside the region where both branches return natural ground.

`FILL_ROUND` widens it at a toe, because `m` — how fast the two surfaces
are closing — is the fill slope *plus* the hillside's where in a cutting it
is the cut slope *minus* it, and the blend's curvature goes as `m^2`.

## 3. What it measures

`ai/perf-bench/verge.mjs`, 600 cross-sections over 12 km of
`?seed=country`, curvature per metre.  Deterministic — two runs agree to
every digit.

| | corridor mean | p99 | max | outer p99 | outer max |
|---|---|---|---|---|---|
| before | 1.336 | 2.03 | 2.31 | 1.19 | 2.16 |
| after | **0.244** | **0.89** | 1.85 | 1.33 | **8.46** |

On the embankment at s = 2500 — where the picture-based probe this one
replaced scored the fix as 20 % *worse*, which is why it was replaced; see
`verge.mjs`'s header — every cross-section's worst crease was at
±6.75–7.25 m,
the platform edge, 0.42 to 0.83, and is now 0.04 to 0.28, moved out to
8–24 m.

`ai/plan_2/verge.png` is the frame.  `ink.mjs` (plan_1's) still passes on
all five cases, and `npm run build` is clean.

## 4. What Part A did not fix

**The corridor is not under the knee.**  The ink starts drawing at about
0.2 per metre and the corridor's p99 is 0.89, so about one section in a
hundred still carries a crease the pass can find — the daylight line on
steep ground, where the two surfaces close fast and the blend's curvature
goes as `m^2 / 2k`.  Getting it under 0.2 at `m = 2` needs `k` near 11 m,
which rounds the crest off by nearly 3 m.  The way out is not a bigger `k`:
it is a blend whose width is fixed *in ground* rather than in height, which
needs the natural gradient in the outward direction — one extra `base()`
call and one `sampleAt` per corridor vertex.  That is affordable (most
vertices return before the road is ever queried) and it is the next thing
to try.

**The outer maximum went the wrong way**, 2.16 to 8.46, at one section in
six hundred: s = 10497, 24 m out.  8.46 per metre at a 0.5 m sample is a
*step*, not a crease — about a metre of it.  It is the same fault the
cross-section at s = 7060 shows directly: `nearest` jumps between two parts
of the midline (s = 7066 to s = 7073 across 0.25 m of ground), `q.y` moves
0.38 m with it, and the earthwork steps.  That is the medial axis on the
inside of a tight bend, it predates this work — the same section steps by
0.9 m before the fix — and the deeper batter makes it bigger.  It is a step
in the *physics collider* as well as in the picture, so it is worth its own
iteration; it cannot be fixed inside `heightAt` because the discontinuity
is in `nearest`'s answer, and the ground shader's `roadA` has the same
problem for the same reason.

**Widening `EARTH_FADE` buys nothing.**  12 to 16 m changed the probe by
not one digit in any column, so it is back at 12.  The taper is not where
these creases are.

---

# Part B — a sky that matches the drawing

## 5. What is there now

`src/world/cloudgeo.js`, the default; `?clouds=march` is the raymarch and
`?clouds=off` is the bare dome.  `?clouds=on|full|raw` still reach the
march, so nothing that used to work stopped.

A cloud is six lobes of one icosahedron on a flattened envelope, instanced
— the whole sky is one draw call, 1436 instances and 115 000 triangles at
`high`, 1176 and 23 000 at `low`.  They are placed by **the march's own
test on the march's own field**: `cloudShape(f) > uShapeCut`, one cell at a
time, with the base and the per-cloud thickness hung off the same two
channels `coverage()` uses.  `cloudfield.js` is untouched, so the cloud you
see is still the cloud whose shadow you drive through.

Lit by a three-band high-key ramp — `toon.js`'s 168/212/255, the ramp that
file keeps for pale masses — with the cool shift in the dark band that
`shadowTint` gives every other material, a darker underside, a silver
lining where the sun is behind, and the march's aerial perspective.

The ink is the world's own formula, a second difference of linearised
depth, run over the layer's own depth buffer in one pass.  It draws the
silhouette against the sky and the billow where two lobes meet.  The
world's post pass never sees the layer — `uFadeEnd` is 900 m and
`uSkyDepth` cuts at 1900 — so there are no double lines.

The rain shafts and the cirrus came across verbatim: both were single taps
in the march rather than part of it, and they sit in the same pass, behind
the cumulus, where they were.

## 6. What it measures

**Sky cover against `w.cloud`** (`ai/perf-bench/cover.mjs`), which is the
one invariant `cloudfield.js` is built around:

| weather | `w.cloud` | drawn | marched |
|---|---|---|---|
| fewClouds | 0.22 | 0.137 | 0.160 |
| partly | 0.52 | 0.367 | 0.330 |
| cloudy | 0.85 | 0.492 | 0.480 |

Within 0.04 of the march everywhere, and the ratio is as flat as the
march's own (0.57–0.71 against 0.57–0.73).  Neither layer equals `w.cloud`,
and neither should: a ray at a grazing angle crosses many cells, so cover
seen from *inside* a deck is always above cover seen from above it.

`ai/plan_2/sky.png` is the two layers on the same frame.

## 7. Four things the plan did not anticipate

**The radius has to scale with the cell, not with its square root.**  The
rings coarsen with distance, and the first build grew the cloud as
`cell^0.55` — a coverage that falls off as the square root of the ring.
The far ring covered 43 % of the sky it stood for, and an overcast came out
as a ceiling directly overhead with pale empty sky from fifteen degrees
down to the horizon, which is most of the sky.

**The budget is in lobes and is spent ring by ring.**  Nearest-first over
the whole sky is the obvious cap and the wrong one: the far ring holds most
of the cells and each of its clouds stands for much more sky, so a global
cap spends everything near the camera and empties the horizon.  Rings get a
share with rollover, and the far rings spend four lobes and two rather than
six.

**Eight bits of target clip a cel ramp flat.**  Ambient plus key on a white
tint is about 1.65 in linear, so every band above the darkest came out the
same white: three bands in, one band out.  Halving the key on the way in
puts a lit top at 0.95 and a shaded base at 0.46.

**An overcast is not more cloud, it is cloud you cannot see through**, and
a cel model has no way to know that from geometry.  `w.cloud` is a fraction
of sky and says nothing about depth — `lightRain` and `partly` differ by
what is falling out of them, not by how much of the sky they cover — so a
rainstorm drew as a field of bright fair-weather cumulus.  `uHeavy`, from
the cloud fraction and the rain, darkens the tint and takes the bases down.

Also: the outlines had to fade into the haze a long way before the clouds
do (3 to 9 km against a 17 km range).  A cluster at fifteen kilometres is a
few pixels of sliver and an outline around it is not a line, it is a
scribble — the far sky came out covered in pen marks that moved with the
drive.

## 8. What Part B did not settle

**The frame time.**  `gpu.mjs` works again, and on this box at `medium` the
three variants are inside each other's noise: 57.1 fps drawn, 56.1
marched, 58.5 with no cloud layer at all, and the per-pass timer queries
come back as zeros under headless ANGLE.  So **the saving this plan
expected is not demonstrated**, and the honest statement is that neither
layer is the bottleneck on an Intel HD 630 at 1280x720.  What is certainly
gone is structure rather than milliseconds: no temporal resolve, no
reprojection, no two half-float history targets, no 72-iteration march.
Measuring it properly wants a machine where the timer query extension
works, and a phone.

**The seam detector.**  `plan_2.md` §8 asks for it to be rebuilt before
anything near the horizon is tuned, and it has not been.  The layer's
clouds are geometry rather than sheets, so the iteration-4 fault cannot
come back in the same form — but "cannot come back in the same form" is an
argument, and the seam probe was a number.

**The march is still in the bundle.**  Both layers are imported
statically, so `clouds.js` ships to every visitor to serve `?clouds=march`.
A dynamic import would take its shader text out of the first load, which
is the one budget `CLAUDE.md` puts a number on.

## 9. Next, in the order I would do them

1. **The blend width in ground rather than in height** (§4).  It is the
   last of the corridor creases and the method is known.
2. **`nearest` on the inside of a tight bend** (§4).  A step in the ground
   and in the collider, pre-existing, and the ground shader's `roadA` has
   it too.
3. **Frame time on a machine that can be timed**, and on a phone (§8).
   Everything about the cloud layer's cost is currently an argument.
4. **The seam probe**, rebuilt (§8).
5. `clouds.js` behind a dynamic import (§8).
6. And the one that is taste rather than defect: whether the road should
   have a *deliberate* ink edge now that the accidental one is gone —
   drawn in `groundmat.js` at the tarmac boundary, `fwidth`-sized so it is
   one line at every distance and never quantised by the lattice.  The
   captures say it reads fine without one.
