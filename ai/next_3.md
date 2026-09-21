# next_3 — what landed for `prompt_3.md`, and what it left

Implements `ai/plan_3.md`.  Both halves are in and measured.  Part B went
much as the plan said and for a reason the plan had *wrong*; Part A did
not, and most of this file is about how it got to where it got.

**Landed**

| file | what |
|---|---|
| `src/world/cloudgeo.js` | lobes are analytic ellipsoids, solved per fragment; the cluster's aspect is bounded and its lobes are made to overlap |
| `src/world/terrain.js` | the batter fillet widened 6 m → 16 m; the daylight blend keyed on the closing rate instead of on a written-down height, and branchless |
| `src/road/spline.js` | `nearest` returns the foot of the perpendicular, which is how `heightAt` knows which way *outward* is |
| `src/world/chunks.js`, `src/main.js` | `?lod=1`, a diagnostic that pins the corridor's vertex spacing |
| `ai/perf-bench/streak.mjs` | new — the ink on the verge, measured in the picture, bucketed by depth |
| `ai/perf-bench/shot.mjs` | new — one frame, on demand; every probe here had grown its own copy |
| `ai/perf-bench/verge.mjs` | a slope-break column per vertex spacing, a curvature-by-distance breakdown, and `SECTION=` to print one cross-section |
| `README.md` | `?lod` |

---

# Part B — clouds that read as overlapping spheres

## 1. The plan's diagnosis was half wrong, and the fix was right anyway

`plan_3.md` §1 blamed the crazing on the ink drawing the **facet edges** of
`IcosahedronGeometry(1, 1)`.  Magnifying `ai/capture/plan_2/sky.png` says
otherwise: every line in it is a silhouette — the cloud against the sky, or
one lobe against another — and not one of them runs across a lobe's
interior.  A facet edge on a 300 m lobe at 3 km is a slope break of about
`1e-3` in normalised depth against a `uSens` of 0.08, so it was never going
to draw and it never did.

What *is* in that capture is the silhouette itself, and it is a **polygon**:
a detail-1 icosphere outlines as about a ten-gon, the ink traces it
faithfully, and at a cloud two hundred pixels across that reads as straight
segments meeting at corners.  Pointy, which is the word the prompt uses.

So the cause was (b) and not (a) — and the fix the plan chose for (a) fixes
(b) as well, because it is the same fix: stop the lobe being a polygon.

## 2. The lobe is an ellipsoid now, and the geometry is only a hull

The fragment shader intersects the view ray with the ellipsoid itself.
Position, normal and depth all come out exact, the silhouette is a conic
section at every distance and every screen size, and the ink has a smooth
curve to trace.  `proxyGeometry` blows an icosahedron up by the reciprocal
of its own inradius — measured off the geometry, not written down — so the
hull encloses the lobe as tightly as its subdivision allows and `detail`
becomes a pure overdraw knob rather than a quality one.

Three things worth keeping in view:

* **`gl_FragDepthEXT`, not `gl_FragDepth`.**  three compiles every
  `ShaderMaterial` as `#version 300 es` on WebGL2 and defines one to the
  other, so that spelling works whichever way the material is declared.
* **The discriminant is not `b^2 - 4ac`.**  The eye is tens of lobe-radii
  away, so in unit-sphere units the two terms are both near `1e7` and agree
  to six digits, which is every digit a float has — the limb came out as
  noise, at precisely the place this whole change exists to make clean.
  The perpendicular form cancels componentwise and keeps five digits.
* **`projectionMatrix` is a vertex-stage built-in in three** and is not
  declared for the fragment stage, so the layer passes its own.

## 3. The cluster: two faults the capture also shows

**The lobes were prolate.**  The y scale was `s * thick * 1.15` against an
xz scale of `s * rad`, and those are unrelated numbers — `thick` runs to
650 m where `rad` is 200 to 330 — so a lobe came out between 1.4 and 3.8
times taller than it was wide.  The file's own comment said "squashed --
wider than tall".  A cloud drew as a bunch of vertical fingers.  The aspect
is now bounded (`VERT_MIN`, `VERT_MAX`, and `LOBE_SQUASH * VERT_MAX` is
0.99, so a lobe is never taller than it is wide) and the field still
decides it inside those bounds.

**And they did not reliably overlap.**  A ring lobe could be drawn at 0.82
of the cloud radius with a radius of 0.30 against a body of 0.62 — tangent,
or clear.  The union of two barely-overlapping spheres has a deep inward
cusp between them, which is a sharp corner no amount of tessellation
removes.  Ring lobes are now pulled back until they cut into the body by
`OVERLAP` of the smaller radius, and the test is done in the *unsquashed*
space, where both spheroids are spheres.

The large random tilt went with them: up to three radians on two axes
stands a flattened lobe on its edge, and a spheroid flattened about y is
unchanged by a yaw anyway, so the big angles were buying variety in the one
direction that had none to give.

## 4. What it measures

**Sky cover against `w.cloud`** (`ai/perf-bench/cover.mjs`), which is the
one invariant `cloudfield.js` is built around:

| weather | `w.cloud` | was | now | marched |
|---|---|---|---|---|
| fewClouds | 0.22 | 0.137 | 0.124 | 0.160 |
| partly | 0.52 | 0.367 | 0.340 | 0.330 |
| cloudy | 0.85 | 0.492 | 0.485 | 0.480 |

Within 0.027 of the old layer everywhere, and `partly` and `cloudy` now land
on the march almost exactly.  Getting there needed `RAD_MIN` and `RAD_SPAN`
up by a seventh, and that is worth saying plainly: **the old layer was
buying its cover with lobes that were far too tall.**  A tall lobe covers a
great deal of sky seen from underneath at a shallow angle, which is most of
the upper half of the frame, so bounding the aspect cost cover and the
radius had to give it back.  Buying it through the radius is the honest way
round — the cloud is standing in for a cell's worth of *sky*, and sky is an
area.

## 5. What Part B did not do

**The slope term was not ported, and should not be.**  `plan_3.md` §3 asks
for `core/post.js`'s `uSens * (1 + uSlope * grad * 40)` to go into the cloud
ink, on the argument that a true limb needs it where a flat facet did not.
Run the numbers on this layer's depth range and it is the opposite: at a
silhouette against sky, `dc` is the cloud's depth and the far plane is
45 km, so `grad` is around 14 and the term would raise the threshold to 4.6
against a signal of 14 — and against a *nearer* background it kills the
silhouette outright.  The interior it was meant to protect turns out not to
need protecting: an ellipsoid's own curvature puts about `1.5e-5` into the
second difference, three orders under `uSens`, and the limb band that does
fire is a third of a metre wide in world terms, which is a tenth of a
texel.  So the detector is unchanged and `uSens` stays at 0.08.

**The frame time is still not demonstrated.**  `next_2.md` §8 said the
cloud layer's cost was an argument rather than milliseconds, and it still
is: the impostor trades vertex work (115 000 triangles of icosahedra, now
28 700 of hull at `detail` 1) for fragment work and loses early-Z, and this
box's timer queries come back as zeros under headless ANGLE.  The
`gpu.mjs` gate `plan_3.md` §4 asks for has not been run.

---

# Part A — the ink on the verge

## 6. First, a probe that can see the complaint

`verge.mjs` scored the shipped build at a corridor p99 of 0.89 while the
user was looking at lines, and that is a probe telling the truth about the
wrong quantity.  It measures world curvature at half-metre sampling, which
is blind to both of the things that make this a *distance* phenomenon: what
lattice the ground will be meshed on, and how far away it will be seen
from.

`ai/perf-bench/streak.mjs` is the other one.  It renders the frame twice,
ink on and ink off, differences them — so grass, texture, trees, shadows
and the hillside behind all cancel exactly — and scores the drop inside a
band built **in the world** from the road midline and then projected, so
the band follows the road round a bend and the depth of every pixel in it
is known rather than guessed.  Bucketed by depth, because the complaint is
a shape across distance and not a level.

It reproduced the complaint on the first honest run, at `high`:

| bucket | ink | inked px | vs near |
|---|---|---|---|
| 20–50 m | 4.94 | 9.7 % | — |
| 50–120 m | 12.18 | 24.0 % | **x2.46** |
| 120–300 m | 6.08 | 17.1 % | x1.23 |

## 7. A0's answer: at `high`, the lattice is not the multiplier

`plan_3.md` A0 asks whether chunk LOD or the ink's screen-space growth is
what makes the middle distance worse than the near field, and it is
answerable from the tables without running anything.  `LOD` gives 1 m for
any chunk within 95 m of the midline, `CAR_LOD`'s finer band is taken by a
`min`, and `FAR_LOD.high` does not coarsen inside 420 m — so **every
corridor chunk from 20 to 420 m is meshed at 1 m**, and the 2.46x above
happens at one spacing.  That leaves the ink's own footprint, which grows
with depth, and there is nothing to tune there that would not cost line
work everywhere else.

So the fix had to cut the curvature itself.  `?lod=1` is in anyway — it
pins the corridor's spacing whatever the tier would have chosen, and the
question comes back at every tier below `high` and past 420 m.  It is
expensive by construction: it is the case `FAR_LOD` exists to prevent.

`verge.mjs`'s new spacing column is the other half of the same answer, and
it is worth having because the lattice *is* a multiplier elsewhere: the
same creases measured as a slope break per vertex row came to 0.189 at 1 m,
0.275 at 2 m and 0.391 at 4 m against a knee at about 0.2.

## 8. What the curvature actually was, and it was not where anyone looked

`verge.mjs SECTION=2500` prints a cross-section, and it settled this in one
run.  At s = 2500 the earthwork is 16 cm deep and every crease this project
has worked on is under 0.07 per metre — and there is a **single spike of
0.206 at nine metres from the midline**, which is the daylight line, where
the batter runs back into the hillside.

`round`'s `k` — how much height the crest rounding is allowed — was ramped
by `smoothstep01(over / (2 * HINGE))` to keep it under the batter's own
height, for a reason that was real (see §9).  On a **shallow** earthwork,
which is most of the road, the daylight line arrives while that ramp is
still near zero: `k` there is 0.15 against a gap that closes at 0.14 per
metre, so the ground steps off the batter onto the hillside in half a metre
of ground.  The rounding was in the code and not in the ground.

And the hinge fillet — the thing `plan_2.md` widened to 6 m and then
measured as not worth widening further — is the *everywhere-present* term:
`1 / (HINGE * ratio)` is 0.111 per metre in cutting, which is a slope break
of 0.22 at 2 m spacing and 0.44 at 4 m.  `plan_2` measured it against a
probe reporting the per-section maximum, where it was hidden behind creases
that are now gone.

## 9. The fix, in two parts that only work together

**The blend is branchless.**  What was here chose a branch on `h > edge`
and rounded the hillside against the cut face or the fill face.  That
choice is a *step*: both roundings pull the surface `k / 4` off natural
ground wherever the two surfaces are merely close — down against the cut
face, up against the fill — so wherever the hillside crosses platform level
the ground jumps by `k / 2`, and it crosses along the length of the road.
That is what forced the ramp in the first place.  Written as

    y = max( min( natural, cut ), fill )

there is no choice to be on the wrong side of.  `fill <= edge <= cut`
always, so the hard version of that expression *is* the two branches with
the branch taken out, and rounding the two corners then costs nothing in
continuity: where the faces meet at the platform edge the two blends
overlap, and an overlap is an offset of about a seventh of `k` rather than
a step of half of it.

**And `k` is solved for rather than written down.**  The parabola's
curvature in ground terms is `m^2 / 2k`, so a constant `k` is a blend whose
curvature is whatever the hillside happens to be doing.  `daylight()`
measures `m` — one extra `hm.base()` a few metres further out along the
outward direction, which is what `nearest`'s new foot point is for — and
returns the `k` that puts the curvature at `DAYLIGHT_K`.  Every limit in it
is smooth: a hypotenuse rather than `Math.max` for the floor, and
`want / sqrt(1 + (want/max)^2)` rather than `Math.min` for the ceiling,
because a kink in `k` is a crease in the ground.

Neither blend may be wider than the gap between the two faces, which is
what stops them rounding each other at the platform edge —
`k * smoothstep(sep / 2k)` is at most `sep` for every `sep`, so that holds
by construction rather than by a tuned constant, and unlike the ramp it
replaced it is *symmetric*, so the daylight line keeps the whole of its
`k`.

**And `HINGE` goes from 6 m to 16 m**, which is only affordable because of
the above: the old ramp was keyed on `HINGE`, so widening the fillet pushed
the crest rounding out past the road's whole query radius and cost more
than it bought.

## 10. What it measures

`verge.mjs`, 600 cross-sections over 12 km of `?seed=country`.  The slope
break per vertex row is the number the ink fires on; the knee is about 0.2.

| | corridor mean / p99 (1 m) | 2 m | 4 m |
|---|---|---|---|
| before | 0.189 / 0.58 | 0.275 / 0.75 | 0.391 / 0.75 |
| hinge only | 0.116 / 0.58 | 0.143 / 0.57 | 0.197 / 0.56 |
| blend only | 0.176 / 0.64 | 0.268 / 0.69 | 0.400 / 0.74 |
| **both** | **0.100 / 0.49** | **0.133 / 0.51** | **0.192 / 0.52** |

All three spacings are under the knee on the mean, every p99 is down by a
third, and the curvature-by-distance breakdown is *flat* — about 0.04 per
metre everywhere from six metres out to twenty-four, with no spike
anywhere, where before it ran 0.10 at eight to twelve and 0.206 at the
daylight line.  Either change alone is worth much less than both: the hinge
alone leaves the daylight crease, and the blend alone leaves the fillet.

The corridor p99 in the old units went 0.89 to 1.00, which is the one
column that did not improve; it is still inside `verge.mjs`'s threshold of
1.2 and it is the tail that `next_2.md` §4 attributes to `nearest` on the
inside of a tight bend, which nothing here touches.

## 11. And in the picture

`streak.mjs`, occlusion-guarded, the same frame both ways at `high`:

| bucket | before | after |
|---|---|---|
| 20–50 m | 5.68, 11.1 % of band inked | **3.82, 7.7 %** |
| 50–120 m | 17.11, 33.7 % | **6.58, 13.9 %** |
| 120–300 m | 7.03, 19.4 % | 17.04, 44.7 % |

The middle distance — which is where `ref/prompt_3_1.png` and
`ref/prompt_3_2.png` are looking — is down **62 %**, and its ratio to the
near field, which is the shape the whole complaint is about, comes from
3.01x to 1.72x.  `plan_3.md` §8's acceptance asked for 1.5x and this is
1.7x.

`ai/capture/plan_3/verge.png` is the frame, and its lower two panels are
the evidence: each frame minus a blur of itself, which leaves the line work
and throws away the shading.  **The baseline has two parallel lines along
each verge** — the road's own drawn edge, and outboard of it the
earthwork's daylight line — and on the left of that frame it has three
strands.  The new one has one line, the road's own.  That is the thing the
prompt is about and it is gone.

**The far bucket disagrees, and it is the number I do not trust.**  Two
other measurements say it should not: `verge.mjs`'s curvature-by-distance
is flat at about 0.04 per metre from six metres out to twenty-four with no
spike anywhere, and the line-work panels at that depth show fewer lines and
not more.  The likely fault is in the probe rather than the ground -- the
band is built in the world and projected, so what a band pixel actually
shows at two hundred metres is often the road further on, a fence, or the
skyline, and those ink strongly and legitimately.  An occlusion guard is in
(marched against the *finished* ground; the first version marched the bare
landform, which in a cutting is precisely the material that has been dug
out of the way, and it rejected every point in the frame) and it moved the
far bucket by about a tenth, so it is not the whole of it.  The near and
middle buckets are unaffected either way, because the band there is large
on screen and unoccluded.

Settling it properly wants the band mask dumped as an image and looked at,
which is half an hour and is item 1 below.

**The picture at other tiers, and on a phone.**  Everything above is
`high` at 1280x720 on an Intel HD 630.

**`EARTH_FADE` and the query radius.**  The fillet now runs to twenty-three
metres from the midline and the earthwork is eased back to natural ground
over the last twelve of the road's twenty-six.  Those overlap, and they did
not before.  Nothing in the numbers says it is hurting, but two blends
sharing nine metres of ground is the kind of thing this project has been
bitten by three times.

## 12. Regressions

`npm run build` is clean.  `verge.mjs` passes its own threshold (corridor
p99 1.00 against 1.2).  `cover.mjs` is in §4.  `ink.mjs` — the probe that
guards the ink pass's texel rounding, which nothing here touches — passes
all five of its cases, against a threshold of 0.09:

    medium           0.022      low              0.006
    high             0.003      high@gov-floor   0.020
                               high@3840x2160   0.002

which is all three tiers and both of the other routes to a render scale of
exactly 1 — the governor's ladder and `scaleFor`'s pixel budget — those
being the nearest-filter tie the probe exists to catch.

## 13. Next, in the order I would do them

1. **Dump `streak.mjs`'s band as an image** and find out what the far
   bucket is actually looking at (§11).  Every other measurement in this
   iteration agrees with the picture and that one does not, and an
   unexplained probe is worse than no probe.
2. **`nearest` on the inside of a tight bend** — `next_2.md` §4's other
   item, untouched, a step in the collider as well as in the picture, and
   now the largest single number in the corridor.
3. **Frame time on a machine whose timer queries work, and on a phone.**
   Owed since `plan_2`, and the impostor lobes add a reason: they trade
   vertex work for fragment work and give up early-Z, and nothing here
   measures that.
4. **Widen the road's query radius** so `EARTH_FADE` and the fillet stop
   sharing ground (§11).
5. `clouds.js` behind a dynamic import — still the one first-load win with
   a number on it.
6. The seam probe, rebuilt (`next_2.md` §8).
