# plan_3 — smooth clouds, and the last of the verge streaks

Answers `ai/prompt_3.md`.  Both items are follow-ups to `plan_2.md`, and
both are the same kind of thing: the ink pass is drawing a **second
difference of depth off a low-resolution surface**, and a surface that is
faceted or latticed hands it creases that were never in the shape.  Part B
is that fault on the clouds, where the facets are an icosahedron's.  Part A
is the residue of it on the ground, where the lattice is the chunk mesh and
`next_2.md` §4 already named the crease it has left.

Part B is the one the user can see plainly in a still and the one with a
clean answer, so it goes first this time.

---

# Part B — clouds that read as overlapping spheres

## 1. What is wrong, precisely

`ai/capture/plan_2/sky.png`, lower half.  The clouds are not smooth masses
with a drawn outline; they are **crystal shards**.  Long straight ink
segments cross the middle of every cloud, the silhouette turns corners, and
the lobes read as angular blocks rather than as balls.

There are three separate causes and they need separating, because two of
them are cheap to fix and one is not.

**(a) The ink is drawing the facet edges.**  This is the big one.
`cloudgeo.js` builds each lobe as `IcosahedronGeometry(1, detail)` with
`detail = 1` on every tier — 80 triangles, 42 vertices.  Three's
`PolyhedronGeometry` normalises the vertex normals at any detail above
zero, so the *shading* is smooth and the faceting does not show in the
colour.  The **depth buffer is not smooth**: each of those 80 triangles is
planar, so the layer's depth field is piecewise linear with a slope break
at every shared edge.  A second difference of depth is exactly a slope
break, and `SKY_FRAG`'s `uSens = 0.08` was swept to be sensitive enough to
catch the few-metres-of-depth crease where two lobes meet.  A facet edge on
a 300 m lobe is a much bigger break than that.  So every facet edge that
faces the camera obliquely gets a line, and the cloud comes out crazed.

That also explains why `uSens` had to be tuned so tightly — "at 0.02 every
lobe was outlined and a cloud overhead read as a bunch of grapes" — the
window between *the crease we want* and *the facets we do not* is narrow
because the facets are in the same size range as the creases.

**(b) The silhouette is a polygon.**  A detail-1 icosphere's outline is
about a ten-gon.  On a cloud that is 200 px across, ten straight segments
with visible corners is what the eye calls pointy, and the ink traces it
faithfully.

**(c) The lobes do not overlap enough to be a union.**  `lobe()` puts the
ring lobes at `r = 0.30 .. 0.82` of the cloud radius with their own radius
at `s = 0.30 .. 0.56`, while the body lobe is `0.62`.  At the far end of
those ranges a ring lobe is *tangent to or nearly clear of* the body, so
the union outline has a deep cusp between them — a sharp inward V, which is
a genuine feature of the union of two barely-overlapping circles and is a
second source of "pointy" that no amount of tessellation removes.

## 2. The fix — analytic ellipsoid impostors

Replace the icosahedron with **two triangles per lobe and a ray/ellipsoid
intersection in the fragment shader**, writing true depth.  Every lobe
becomes a mathematically exact ellipsoid: exact smooth silhouette at any
screen size, exact smooth normal, exact smooth depth, at any distance,
for 2 triangles instead of 80.

This is the right trade for this layer specifically:

* The lobes are already non-uniformly scaled instances (`_s.set(rad*fat,
  thick*1.15, rad*fat)`), so the "sphere" is an axis-aligned ellipsoid in
  instance space.  Transform the ray into unit-sphere space by the inverse
  instance matrix, solve the quadratic, transform the hit back.  That is
  the standard impostor and it is about fifteen lines.
* **It fixes (a) and (b) at once and by construction**, rather than by
  pushing a tessellation number until the artefact is under a pixel.  There
  is no detail level at which a polygon silhouette is *smooth*; there is
  only one at which it is small.
* Triangle count falls from 115 000 to 2 900 at `high`, and vertex
  shading with it.

**What it costs, and the risk to be honest about.**  Writing
`gl_FragDepth` disables early-Z, and the lobes overlap heavily, so
fragment cost goes up where vertex cost goes down.  Overdraw in an overcast
is the worst case.  Two mitigations, both cheap:

* The quad is sized tightly to the ellipsoid's screen-space bound and
  fragments outside the intersection `discard`, so the wasted area is the
  corner of a circle in a square — about 21 %.
* The layer renders into its own target at scene resolution, and
  `next_2.md` §8 measured it as inside the noise of *no cloud layer at
  all*.  There is headroom, but it is unmeasured headroom, so §4 below
  makes measuring it a gate rather than an afterthought.

Three notes for whoever writes it:

* The lobe material must declare `glslVersion: THREE.GLSL3` (or the
  `fragDepth` extension) — `gl_FragDepth` does not exist in the GLSL ES
  1.00 the ShaderMaterial compiles as by default.
* `vNormal` stops being a varying and becomes the analytic normal at the
  hit point; the inverse-transpose trick in `LOBE_VERT` goes away with it,
  since the normal now comes out of the unit-sphere solve directly.
* `vUp` (height within the cloud, for the base shading) must be computed
  from the *hit point*, not the quad vertex, or the flat-base shading
  inverts on the near face.

**The fallback, if the measurement in §4 says no.**  `cloudDetail = 2` on
`high` and `medium`, 1 on `low` — 320 triangles a lobe, a twenty-gon
silhouette, 460 000 triangles at `high`.  It makes (b) small and it does
not fix (a): facet edges get four times as numerous and four times
weaker, and at `uSens = 0.08` some of them will still draw.  Taking the
fallback therefore means also taking §3's second half.

## 3. Two things to do whichever way §2 goes

**Give the cloud ink the slope term the ground ink has.**  `core/post.js`
raises its threshold on oblique surfaces —

```
float grad = ( abs( dr - dl ) + abs( du - dd ) ) / dc;
float sens = uSens * ( 1.0 + uSlope * grad * 40.0 );
```

— and `cloudgeo.js`'s copy of the same detector does not have it.  It did
not need it against facets, because a facet is flat; it will need it
against a true ellipsoid, because the depth gradient near a limb goes to
infinity and a naive second difference will paint a thick band inside
every lobe's rim.  That is the "bunch of grapes" again, arriving by a new
road.  Port the term, then re-sweep `uSens` — the window should be much
wider than 0.08 was, because the only interior signal left is the genuine
lobe-to-lobe crease.

**Make the lobes overlap.**  In `lobe()`, constrain each ring lobe so it
is properly inside the union: require the gap to the body to be at least
about a third of the smaller radius, i.e. `r + s <= bodyS + s - 0.35 * s`
after the jitter, rather than letting `r` and `s` be drawn independently.
Concretely: draw `s` first, then draw `r` from a range whose top depends on
`s`.  Two neighbouring ring lobes want the same treatment where the
angular jitter puts them adjacent.  The result is a silhouette that is a
chain of circular arcs with shallow notches — which is what "overlapping
spheres" means and what the cumulus references in `ref/cloud/` look like.

This also removes the hole-in-the-middle failure mode `lobe()`'s comment
records, permanently, rather than by keeping a body lobe big enough to
plug it.

## 4. How Part B is judged

* **`ai/perf-bench/cover.mjs` is unchanged within 0.03** on all three
  weathers.  Impostors are slightly *larger* than the inscribed polyhedra
  they replace, so cover will drift up a little; `RAD_MIN` / `RAD_SPAN`
  absorb it if it drifts past that.
* **A frame time measurement that means something.**  `next_2.md` §8 is
  blunt that the current cloud numbers are arguments and not milliseconds:
  the per-pass timer queries return zeros under headless ANGLE and the
  three variants sit inside each other's noise.  So this iteration takes
  the smallest honest step: `ai/perf-bench/gpu.mjs` at `low` on a **1280 ×
  720 window with the layer forced to full overcast** (`?weather=cloudy`),
  drawn-old against drawn-new, same box, same session.  If the new layer
  is more than 10 % slower on that, take the §2 fallback.  A phone number
  would be better and there is still no phone in the loop.
* **A still**, `ai/capture/plan_3/sky.png`, the same three-way frame
  `plan_2` used: march, drawn-old, drawn-new.  This is the one the prompt
  is actually about and no number replaces looking at it.

---

# Part A — the streaks still on the verge

## 5. What the two references show

`ref/prompt_3_1.png` and `ref/prompt_3_2.png`: dark broken dashes in the
grass, five to twenty metres out from the tarmac, running parallel to the
road, **absent in the near field and present from roughly forty metres out
to the point where the haze takes everything**.  They follow the
triangulation's diagonals, which is the same tell `plan_2.md` §1 used:
the mark is in the geometry, not in the pass.

`next_2.md` §4 predicted exactly this and named it: the corridor's
curvature p99 is **0.89 per metre against a knee at about 0.2**, so about
one cross-section in a hundred still carries a crease the ink can find.
The source is the daylight blend — `round(gap, k)` is keyed on how far the
batter still is from natural ground **in height**, so its width *in ground*
is `2k/m` where `m` is how fast the two surfaces are closing, and its
curvature is `m^2 / 2k`.  On steep ground `m` reaches 2, the blend
collapses to about two metres wide, and the curvature is five times the
knee.

That accounts for the dashes being **broken**: the crease crosses the
threshold only where the hillside is steep enough, which along a road is
intermittent.

## 6. But "at a distance" is a second fact, and it needs its own answer

A crease of fixed curvature in the world does not have fixed strength on
the screen.  The ink takes its second difference over a **fixed number of
texels**, so the world footprint of its tap grows in proportion to depth,
and on ground seen at a grazing angle it grows again by `1 / sin θ`.  The
signal is `curvature × footprint²`, normalised by `dc` — so for a fixed
curvature it grows **roughly linearly with distance**.  The `uSlope * grad`
term is what is currently holding the lower half of the frame together and
it is a partial compensation, not a complete one.

There is a second candidate and it must be ruled in or out before anything
is tuned: **chunk LOD**.  A crease reaches the screen as a slope break of
`curvature × vertex spacing`, so the same crease is twice as strong where
`chunks.js` has meshed the ground at 2 m and four times as strong at 4 m.
`FAR_LOD` caps the corridor at 1 m out to 420 m on `high`, 200 m on
`medium` and 150 m on `low` — and then 2 m, and then 4 m.  If the
references were taken on `medium`, the streaks begin at about the distance
`FAR_LOD.medium` steps to 2 m, and LOD is most of the answer.  If they were
taken on `high`, where the whole visible verge is at 1 m, LOD is not
involved at all and §6's distance growth plus §5's residual curvature is
the whole story.

**So step one is a five-minute discriminating experiment, not a fix.**

## 7. The order of work

**A0 — discriminate.**  Add a diagnostic-only `?lod=1` that clamps every
`FAR_LOD` and `LOD` band in the road corridor to 1 m (it exists nowhere
today; `?maxstep` is the cloud march's knob, not this one).  Shoot the
`prompt_3_2` viewpoint four ways: `high`, `medium`, `low`, and `high&lod=1`.

* Streaks unchanged across all four → pure §5 + §6; go to A1, and A2 is
  not needed.
* Streaks weaken with `?lod=1` and strengthen from `high` to `low` → LOD
  quantisation is a real multiplier; A1 alone will not be enough and A2 is
  in scope.

Either way this fixes the quality tier the rest of the work is judged on,
which `plan_2` did not pin down and should have.

**A1 — the blend width fixed in ground rather than in height.**  The item
`next_2.md` §9 already put first, and the method is known.  Today:

```
const k = DAYLIGHT * smoothstep01( over / ( 2 * HINGE ) );
... y = face + round( gap, k );
```

`k` is a height.  Make the blend a fixed width **`W` in ground** by
dividing the height gap by the closing rate:

* one extra `hm.base()` sample a metre further out along the outward
  direction gives the natural ground's gradient in that direction;
* the batter face's own gradient is `±1 / ratio` and already known;
* `m = |grad(face) − grad(natural)|`, clamped away from zero;
* feed `round()` a `k` of `m * W / 2`, so the curvature comes out at
  `1 / ( 2W )` — **independent of the terrain's steepness**, which is the
  whole point.

With `W = 10 m` that is 0.05 per metre against a 0.2 knee, with a factor
of four in hand for the distance growth of §6 and for a 2 m lattice.  The
`FILL_ROUND` asymmetry falls out of the algebra and can be deleted: it
exists only to compensate for `m` being bigger at a toe, which is exactly
what dividing by `m` now does.

The cost is one `base()` call per *corridor* vertex.  `heightAt` already
returns before the road is queried for almost every vertex in the world,
and `nearest` is by far the expensive half of the ones that do not, so this
is small — but it is on the path the physics colliders take, so it wants a
line in the benchmark rather than an assurance.

`k` must still ramp from nothing at the platform edge, for the reason
`round()`'s comment gives at length — a blend of scale `k` pulls the
surface off natural ground wherever the two are merely close, in opposite
directions in the two branches, and at the platform edge which branch you
are in is a coin toss.  Keep the `smoothstep01(over / (2 * HINGE))` factor
on top of the new `k`; it costs a little width right at the crest, where
the batter has no height to daylight yet anyway.

**A2 — only if A0 says LOD matters.**  The honest framing is that a
lattice-quantised crease is *aliasing*, and the fix for aliasing is to
band-limit the signal to the sample spacing.  The earthwork's blends are
the high-frequency content and they are cosmetic, so widen them with the
spacing they will be sampled at: `W`, `HINGE` and the shoulder fall all
scale up where the ground is meshed coarse.

Two constraints on how, and they are strict:

* **The widening must be a smooth function of world position, not of the
  chunk.**  Two chunks at different LOD share an edge, and if they
  disagree about the height there, the seam is a step — which is a far
  worse thing to draw than the crease it replaced.  Key it on distance
  from the car with a smooth ramp, the same quantity `FAR_LOD` keys on, so
  both chunks compute the same number at a shared vertex.
* **The collider must not move under the car.**  `FAR_LOD`'s 1 m band is
  always wider than `CAR_LOD`'s for this reason; the ramp has to start
  outside it, so the ground the suspension rays hit is bit-for-bit what it
  is today.

Note the thing this does *not* rescue: at 4 m spacing the carriageway is
two vertices across and the shoulder fall is not resolved at all — it
becomes one slope break at the platform edge no matter how it is shaped.
If A0 shows streaks in the 4 m band specifically, the answer there is not a
wider fall, it is that `FAR_LOD`'s corridor cap should stop at 2 m rather
than 4 m, and that is a frame-time decision with a measured number behind
it (`FAR_LOD`'s own comment: 42 ms → 15 ms on an HD 630) and not a
free one.

**A3 — the last resort, named so it is not reached for early.**
`prompt_2.md` offered "suppress ink outline on side of the road" and
`plan_2` did not take it.  It still should not be taken: the ink pass is
screen-space and reads only depth, so masking the verge means carrying a
road-proximity channel through to the post pass, and a mask that kills the
lattice creases also kills the fence posts, the trees on the verge and the
road's own silhouette against a cutting.  It is in this plan only as the
thing to fall back to if A1 and A2 both land and the picture is still
wrong.

**A4 — not in scope, and why.**  `next_2.md` §4's other item — `nearest`
jumping between two parts of the midline on the inside of a tight bend,
the 8.46-per-metre outer maximum at s = 10497 — is a *step*, one section
in six hundred, and it is not what `ref/prompt_3_*.png` show: those are
smooth, parallel, repeating dashes, not a single hard line. It is also a
step in the physics collider and in `groundmat.js`'s `roadA`, which makes
it its own iteration rather than a rider on this one.

## 8. How Part A is judged

**`verge.mjs` cannot be the whole test, and this is the important
methodological point of this plan.**  It measures world curvature at a
0.5 m sampling, which is blind to both mechanisms that make the streaks a
*distance* phenomenon: it does not know what lattice the ground will be
meshed on, and it does not know how far away it will be seen from.  It
scored the current build at a corridor p99 of 0.89 and the user is still
looking at streaks; that is the probe telling the truth about the wrong
quantity.

So Part A needs one addition of each kind:

* **`verge.mjs` gains a spacing column.**  Report the slope break per
  vertex row at 1, 2 and 4 m as well as the curvature per metre — it is
  the same walk with three differencing widths, it costs nothing, and it
  is the number the ink actually fires on.  Pass/fail stays on the
  corridor, and becomes: **under 0.2 at 1 m, and reported at 2 m and 4 m.**
* **A picture probe, `ai/perf-bench/streak.mjs`.**  Render the
  `prompt_3_2` viewpoint twice, ink on and ink off, difference the two —
  which is what makes it robust where `plan_2`'s abandoned picture probe
  was not, since trees, grass texture and the landform silhouette all
  cancel.  Then score inked pixels inside a band reprojected from the road
  midline, `platform + 1 m` out to `platform + 25 m`, **bucketed by depth**
  — 20–50 m, 50–120 m, 120–300 m.  The buckets are the whole point: the
  complaint is that the near field is clean and the middle distance is
  not, and a single number over the whole band averages that away.  Run it
  on the tier A0 identifies.

Acceptance: the 50–120 m and 120–300 m buckets come down to within about
1.5× of the 20–50 m bucket, on the same frame, and `ai/capture/plan_3/verge.png`
shows it.  `ink.mjs`'s five cases still pass — the ground's ink thresholds
are not touched by any of this, and if they are, that probe is what says so.

---

## 9. What this plan does not do

* It does not touch the march (`clouds.js`), and it does not put it behind
  a dynamic import — `next_2.md` §9 item 5 is still open and is still a
  first-load win worth having, but it is bundler work and does not belong
  in an iteration about lines.
* It does not rebuild the seam probe (`next_2.md` §8).  Impostor lobes
  make sheet-seams less possible still, but that remains an argument.
* It does not add a *deliberate* ink edge at the tarmac boundary
  (`next_2.md` §9 item 6).  That is taste, and the prompt is about
  removing lines, not adding one.
