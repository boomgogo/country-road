# plan_2 — the road's ink edges, and clouds that match the drawing

Answers `prompt_2.md`.  Two items, unrelated to each other:

1. **The sharp ink edges along the side of the road.**  Reproduced, traced to
   *two* creases in the height function, and the fix is measured below on a
   live build.  Nothing is landed — this is a plan — but the experiment that
   produced §1–§5 ran against the real game and the numbers are real.
2. **Clouds drawn like the rest of the world**: simple geometric shapes, cel
   shaded, with ink outlines.  §7–§14.  That one is a design, not a
   measurement: the shape of the change is settled, the constants are not.

`ai/plan_2/verge.png` is the before/after crop the first half is about.

---

# Part A — the ink on the verge

## 1. It is two creases, not one

The prompt guesses "the edges are from carving the road out of the terrain",
and that is right, but it is two separate carvings and they draw two separate
kinds of mark.  Both are in `src/world/terrain.js`.

Captured at seed `country`, s = 10520, 10:00, summer, sunny, `quality=high`,
1280x720, walked to along the road (a cold jump lands with the chase camera
still settling — see `ink.mjs`):

| what | where it comes from | what it looks like |
|---|---|---|
| **a broken dark band hugging the shoulder**, converging on the white line with distance | `crown()` — the 16 cm shoulder fall, spent over the last 0.95 m of carriageway | short dashes at a fixed lateral offset, the whole length of the road |
| **long diagonal strokes climbing the cutting** | the platform → batter hinge in `heightAt()` | strokes along the chunk lattice's own diagonals |

They separate cleanly under the knife.  Flattening `crown` to zero and leaving
the hinge alone kills the band and leaves the strokes; filleting the hinge and
leaving `crown` alone kills the strokes and leaves the band.  Doing both leaves
the verge clean.

The strokes are the tell that this is *geometry*, not the ink pass misbehaving:
they run along the triangulation.  The ink is a second difference of depth, a
crease in the surface is a step in the first difference, and a crease sampled on
a lattice is a row of small creases — one per vertex row — each of which the ink
resolves separately while the vertex spacing is more than a texel wide.  That is
why it reads as pen strokes rather than as one line.

## 2. The numbers

Two measurements, both on the frame above.

**(a) Ink actually drawn on the verge.**  The same frame rendered with
`pipeline.enabled.ink` true and false, mean absolute luminance difference over a
box on the left verge (x 300–660, y 330–440) and over the whole lower frame
(y 300–620, full width):

| | verge box | whole lower frame |
|---|---|---|
| as it stands | **1.879** | 1.465 |
| crown spread 3.5 m + hinge fillet 6 m | **0.668** | 1.213 |

Verge ink down 64 %, total ink down 17 % — i.e. the fence, the trees, the ridge
silhouettes and the distant road all keep their line work.  That ratio is the
point of the fix: the road's ink goes and nothing else does.

**(b) Ink mass in the verge box**, as darkness below a 15 px horizontal moving
mean — the same kind of detector `ink.mjs` uses, and it needs no paired frame.
The ink-off frame is the floor:

| variant | score |
|---|---|
| ink off (floor) | 1.990 |
| **as it stands** | **2.444** |
| hinge fillet 3 m | 2.225 |
| hinge fillet 6 m | 2.203 |
| hinge 6 m + C1 crown tail | 2.140 |
| hinge 12 m + C1 crown tail | 2.138 |
| crown flat, hinge untouched | 2.096 |
| crown flat + hinge 6 m | 1.874 |
| **crown spread 2 m + hinge 6 m** | 1.989 |
| **crown spread 3.5 m + hinge 6 m** | **1.931** |
| crown spread 5 m + hinge 6 m | 1.922 |
| crown spread 3.5 m + hinge 12 m | 1.931 |

Three things fall out of that table:

- Merely making the crown tail **C1** (ending the shoulder fall at zero slope
  instead of at slope 0.354) is worth almost nothing: 2.203 → 2.140.  Slope
  continuity is not the property the ink cares about.
- **Curvature is.**  Every row that helps spreads the same drop over more
  ground, and the score tracks the peak curvature and nothing else.
- Past 3.5 m of spread and 6 m of fillet it stops paying.  2.138 vs 2.140 and
  1.931 vs 1.922 are noise.

## 3. Why curvature is the right budget

The ink fires on `(dl + dr - 2*dc)/dc` against a threshold that is raised where
the surface is oblique (`core/post.js`, `ink()`).  Across a crease the second
difference is the *slope break* times the footprint of the tap; across a
smoothly curved surface it is the curvature times the square of the footprint.
The mesh converts the second into the first: a surface of curvature k sampled at
spacing s is a polyline whose every joint has a slope break of `k * s`.

So the quantity to keep small is the slope break per vertex row, and near the
road the spacing is fixed at 1 m (`chunks.js`, `LOD`), so it is just the
curvature.  What the sweep measures:

| feature | peak curvature, /m | slope break at 1 m | inked? |
|---|---|---|---|
| shoulder fall, as it stands (0.16 m over 0.95 m) | ~1.1 | 0.35 at the edge | yes, hard |
| platform hinge, as it stands | infinite | 0.67 cut, 0.50 fill | yes, hard |
| hinge fillet R = 3 m, cut batter | 0.22 | 0.22 | faint |
| shoulder fall spread over 2 m | 0.24 | 0.24 | faint |
| hinge fillet R = 6 m | 0.11 | 0.11 | no |
| shoulder fall spread over 3.5 m | 0.08 | 0.08 | no |

**The knee is around 0.2 per metre and 0.1 is comfortably clear**, at 1 m
spacing and at this viewing distance.  That is a rule of thumb from one frame
and one seed; §6 is the sweep that would make it a number.

It also predicts what happens further out, and the prediction should be checked
rather than believed: the corridor goes to 2 m spacing past 95 m from the
midline and `FAR_LOD` caps it at 4 m, so the same curvature gives two and four
times the slope break out there — against an ink that is fading from 260 m and
gone by 900.  The two effects run opposite ways and only a capture settles it.

## 4. The fix

Both halves are in `src/world/terrain.js` and neither touches anything else:
the physics collider is built from these same heights (`chunks.js`
`_takeHeights`), so it follows automatically, and nothing else reads `crown`.

**(a) Spend the shoulder fall across the platform, not across the last metre of
tarmac.**  `crown` currently drops 16 cm between d = 3.35 and d = 4.3 and is
flat from there to the platform edge.  Instead, drop the same 16 cm with a
smoothstep from d = 0.78 * CARRIAGEWAY to **the platform edge `w`** — so the
fall ends exactly where the batter begins, with zero slope on both sides of the
join, and its length (about 3.2 to 4.2 m, since `platform()` returns 6.55 to
7.55) is self-adjusting rather than a second constant to keep in step.

That means passing `w` into `crown`, which is a small signature change at its
three call sites inside `heightAt`.  `crown(w)` is still exactly the full drop,
so `edge` — the height the batter starts from — is unchanged.

What it costs: the *tarmac* is flatter than it was.  The camber stays (the
`0.035 * (1 - t^2)` term is untouched) but the outer fall now mostly happens on
the gravel, so the drop at the white line goes from 16 cm to about 3 cm.  That
is what a road with a shoulder actually does, and the drawn edge does not move —
the ground shader's tarmac mask is keyed on distance (`groundmat.js`, `edge`)
and is deliberately hard.  Checked on the captures: the road still reads.

**(b) Fillet the platform → batter hinge.**  Replace the bare `over / BATTER`
with a C1 ramp of radius R:

```
over < R ?  over * over / ( 2 * R * BATTER )
         :  ( over - R * 0.5 ) / BATTER
```

value and slope both continuous at 0 and at R, constant curvature `1/(R*BATTER)`
across the fillet.  **R = 6 m**, which is 0.11 /m in cutting and 0.08 in fill —
under the knee with margin, and cheap: the toe and the crest move out by R/2 =
3 m and the earthwork volume changes by about the same fraction.

Interactions to keep in mind while writing it:

- `round()` at the daylight line stays; it solves the *other* end of the batter
  and the two do not overlap unless the earthwork is under ~6 m wide, where the
  fillet has already made the face shallow enough that `round` finds nothing to
  do.
- `EARTH_FADE` stays.  A 6 m fillet plus `ROUNDING` is comfortably inside the
  26 m query radius for any earthwork the tracer produces.
- `platform()`'s `ga` term makes `w` vary along the road, so the fillet's start
  moves with it.  That is a longitudinal curvature, not a lateral one, and it is
  already gentle — but it is the most likely place for a surprise, so it is on
  the check list in §6.

## 5. What was rejected, and why

**Suppressing the ink near the road in screen space.**  There is a way: the
scene target is RGBA half float and nothing uses the alpha, so `groundmat.js`
could write a road-proximity mask into it and `ink()` could multiply `edge` by
what it finds.  It is rejected because it papers over a real defect in the
ground — the crease is *there*, it is what the mesh has, and it will keep
showing up in the shading, in the shadow map and in any future pass that reads
normals — and because the alpha channel is shared with everything transparent
that draws over the same pixels (the water, the precipitation, the cloud
composite), which is a silent coupling nobody will remember in six months.

**Turning the ink down globally** (`uSens`, `uConcaveAmount`, `uSlope`).  Tried
at the reproducing frame; it takes the verge marks out along with the ridge
lines and the fence, which is the wrong trade and is the same objection plan_1
made to special-casing a thickness.

**Drawing the road edge deliberately instead.**  Worth remembering but not part
of this fix: once the geometric accident is gone, the ground shader could draw a
real ink line at the tarmac boundary, `fwidth`-sized so it is one line at every
distance and never quantised by the lattice.  That is an *aesthetic* decision —
whether a cel-shaded road should be outlined at all — and the captures say the
road reads fine without it.  File it, do not bundle it.

## 6. Before it lands

The evidence above is one frame, one seed, one time of day.  What has to be
checked, and what would go in the repo:

- **A probe, `ai/perf-bench/verge.mjs`**, on the pattern of `ink.mjs`: capture a
  frame with ink on and with ink off, score the mean absolute difference inside
  a band that follows the road's projected edge (the road's own spline gives
  that band — no hand-placed box), and assert it against a threshold.  Report
  the whole-frame difference next to it, because the test has to fail if the fix
  works by taking the ink out of the *world*.  Three or four road positions
  covering a cutting, an embankment and level ground.
- **Distance.**  The same frame at 2 m and 4 m corridor spacing (i.e. a road
  further away), which is where §3 says the prediction is weakest.
- **Night** (`setNight` moves `uStrength` and `uFadeStart`) and **rain**, which
  darken the road and change the contrast the lines are seen against.
- **The car's ride.** The tarmac's cross-fall drops from 0.35 to about 0.05 at
  the edge; nothing in `physics.js` should care, but a lap of autodrive with the
  suspension telemetry before and after is cheap insurance.
- **`quality=low` and `medium`**, since the render scale changes the ink's tap
  distance in world terms.

**How to reproduce §1–§2 without touching the repo.**  The experiment overrode
`__game.terrain.heightAt` from the page — the method is on the instance, so a
replacement with the same signature is picked up by the next chunk build — and
then forced a rebuild with

```js
__game.chunks.reset();  __game.jumpTo(s, 50);  __game.chunks.flush();
```

That sequence is worth keeping in mind for any terrain experiment: without the
`reset` the old chunks stay live and the change appears only where the field
happens to rebuild.

---

# Part B — clouds that belong to the drawing

## 7. What is there and why it does not match

`src/world/clouds.js` is a full volumetric raymarch: 72 iterations with a
geometric step schedule, a five-step light march with six multiple-scattering
octaves, two 3D Worley volumes, a Bayer dither turned by the golden ratio and a
reprojecting temporal resolve over a sixteen-frame window.  It is the most
sophisticated thing in the project and it is *photographic* — soft gradients,
continuous shading, no edges anywhere.  Everything under the horizon is the
opposite: three flat bands of light, a cool hue shift in shadow, and a line
around every silhouette.  The sky reads as a photograph pasted behind a drawing,
which is what the prompt is asking to fix.

So this is not a bug to repair.  It is a deliberate swap of a good
implementation of one thing for an implementation of a different thing, and the
old one should stay reachable behind `?clouds=march` until the new one is
clearly better — the same courtesy `?flat` does for the cel pass.

## 8. What must keep working

`cloudfield.js` is the contract and **none of it changes**.  One field, four
consumers: the sky marches it, every lit material multiplies its key light by
`cloudShadow`, `Weather.localAt` reads it for rain, and `coverAt` answers on the
CPU.  A cloud you see is the cloud whose shadow you drive through.  Replacing
the *renderer* of the sky must not break that, which means:

- **The geometry is placed from the field**, not from its own noise.  Same
  texture, same cut, same drift offset.
- `w.cloud` still means *that fraction of the sky*.  The quantile machinery in
  `cloudfield.js` is calibrated on it and `weather.js` drives it.
- The cloud shadow on the ground, the rain cut, and `snapshot`/`restore` are
  untouched.

Two more things the current layer does that are easy to lose by accident:

- **It occludes the moon and the stars per pixel** (they draw at renderOrder
  -900 and -890 with no depth write, the composite at -880).
- **It is what removed the horizon seam** that cost iteration 4 a week — the
  three textured sphere caps had rims, and any new implementation that puts
  geometry near the horizon can put a rim back.  Whatever `tools/probe/seam.mjs`
  measured (8.11/255 at y = 478, 0.66 with the caps hidden) is gone from the
  repo, so that detector has to be rebuilt as part of this work.  It is the one
  measurement that says the replacement did not reintroduce the original sin.

## 9. Where the new layer draws

**Keep the existing integration exactly.**  `Clouds` already renders offscreen
before the main frame and composites with a fullscreen quad whose vertex shader
writes depth exactly 1.0, `depthTest` on and `depthWrite` off — so it paints
every pixel the world has not drawn into and skips the rest, for free.  That
mechanism is right for geometry too, and it solves the problem geometry would
otherwise have:

**Clouds do not fit in the main camera.**  `camera.far` is 2030 m and the deck
is at 1150–1800 m *above* the camera, so a cloud at 30 degrees of elevation is
already past the far plane, and one at the horizon is 12 km out.  Putting cloud
meshes in the main scene therefore means either compressing them into the last
few hundred metres of a depth buffer shared with a 1.9 km ridge — z-fighting at
the horizon, which is exactly where cloud bottoms meet the skyline — or
restructuring the frame into a background pass.  Rendering them into the layer's
own target with **their own camera** (same position and orientation, `near` 200,
`far` 45000) costs neither.

So `Clouds` keeps `render(renderer)`, `update(camera, atmos, w, clock)`,
`setSize(w, h)` and `composite`, and `main.js` does not change.  Inside:

- the render target gains a depth buffer and a `DepthTexture` (it has
  `depthBuffer: false` today), and drops the two half-float history targets and
  the resolve pass with them;
- it renders at the render target's full size rather than `Q.cloudScale`.  Half
  resolution was the right call for a march and is the wrong one for ink lines;
  geometry is cheap enough to pay for it (§13).  `samples: 4` on the target,
  tier-gated, is worth trying for the line quality;
- `?clouds=march` selects the old class, `?clouds=off` still gives the bare
  dome.

## 10. The clouds themselves

**Shape.**  A cloud is a cluster of 4–9 low-poly spheres — icosahedron at detail
0 or 1 — merged into one geometry, squashed toward a flat base, with the whole
cluster scaled and rotated per instance.  Half a dozen prebuilt clusters chosen
by a hash of the cell is enough variety; the silhouette comes from the cluster,
not from noise, and that is the point: the eye should be able to see it is made
of spheres, the same way it can see the trees are made of cones.

**Placement, from the field.**  A grid of cells (about 500 m) over a disc
around the camera in the field's drifting frame.  For each cell: a deterministic
jitter for the centre, then the *same* test the march makes —
`cloudShape(f) > uShapeCut`, where `f = cloudRaw3(p.xz)` — decides whether there
is a cloud, and the amount by which it clears the cut sets the radius.  Base
height from the same expression `coverage()` uses (`uBase - (f.y - 0.5) * 220 -
(f.z - 0.5) * 160`) and the per-cloud top from the same `f.z` term, so no two
clouds sit on one base and no two are the same height — the two properties the
march's header argues hardest for.

Rebuild the instance list when the camera has moved far enough or the drift has
turned over, not every frame; sort or budget by distance; cull to the frustum.
A per-tier instance cap (high ~300, low ~120) is the quality knob that replaces
`cloudScale`.

**Cel shading.**  A custom `ShaderMaterial` rather than three's lighting: the
clouds are outside the sun's shadow camera and outside the fog's useful range,
and they want the atmosphere's own colours, which `update` already receives
(`uSunCol`, `uAmbient`, `uHaze`, and `uNight`).  Quantise `dot(n, sunDir)` into
the same steps `toon.js` uses for pale masses — `RAMPS.soft3`, 168/212/255,
which exists in that file precisely because the sky's old sheets needed a ramp
that stays light on its shadow side — and hue-shift the dark band toward the
cool side exactly as `shadowTint` does for everything else.  Aerial perspective
by the *true* distance (the existing `FADE_FROM` = 5000 and `MAX_DIST` = 34000
are tuned and should be kept), and `fog: false`, because the layer's camera is
not the world's.

## 11. The ink outline

Two ways, and they are worth writing down together because the second is the
fallback for the first.

**(a) The project's own ink, on the layer's own depth buffer.**  A second
fullscreen pass over the cloud target running the same second difference of
linearised depth that `core/post.js` runs, with the cloud camera's near and far
and the same `PAL.ink`.  It draws the silhouette against the sky (a depth step
is a second difference — plan_1 §2) *and* the creases where two spheres of a
cluster intersect, which is exactly the line a cel-shaded drawing wants.  One
formula, one ink colour, one place to tune: the sky and the ground cannot drift
apart, for the same reason `atmosphere.js` keeps the fog and the horizon
together.  The outline has to be allowed to paint into transparent pixels
(alpha `max(a, edge)`), so it sits half outside the cloud the way the world's
ink sits half outside a tree.

**(b) Inverted hull.**  A second instanced draw with `side: BackSide` and the
vertices pushed along their normals by an amount proportional to view depth, so
the line is a constant width on screen.  Classic, needs no depth pass, and gives
a cleaner line on a sphere than a screen-space edge detect does.  It draws no
interior creases, it needs the fill and the outline correctly ordered, and it is
a *second* definition of what ink is in this project.  Reach for it only if (a)
turns out to have a precision problem at the deck's scale.

Note that the world's ink pass will not draw these clouds whichever way this
goes: `uFadeEnd` is 900 m and `uSkyDepth` cuts at 1900, so the layer is outside
the post pass's reach by construction.  That is a feature — no double lines —
but it does mean the cloud ink has its own weight and fade to tune, and they
should be tuned against a frame with a ridge line in it.

## 12. The two things that come along for free

Both the **rain shafts** and the **cirrus** are single-tap analytic terms in the
march fragment (`clouds.js`, the blocks guarded by `uRainVisible` and
`uCirrus`), not part of the march loop at all — a shaft is a smooth vertical
gradient and marching it buys nothing, and the cirrus is one stretched tap of
the shape channel at 7 km.  They lift almost verbatim into a small fullscreen
pass that runs *before* the cloud geometry is drawn, which is where they already
are in the compositing order.  Keeping them is a few dozen lines and loses
nothing.

Their constants carry their own hard-won notes — the cirrus cap above ten
degrees of elevation, the 3:1 stretch turned thirty degrees off the world axes —
and those comments should move with the code rather than be re-derived.

## 13. What it should cost

The march is 72 iterations with ~50 texture reads per fragment over a third to a
half of the render target, plus a nine-tap temporal resolve over the whole of
it, plus two half-float history targets.  The replacement is a few hundred
instances of 140–560 triangles, drawn twice at most, into a target with no
history.  It should be substantially cheaper, and on the tiers this project
cares about — integrated graphics and phones, per the spec — that is the largest
single saving available in the frame.

**It has not been measured, and the measurement is blocked.**
`ai/perf-bench/gpu.mjs` is the tool for it and it is stale: it wraps
`P.ink.quad` and `P.grade.quad`, which no longer exist — the ink and the grade
were merged into one `look` pass.  Fixing that one line is a prerequisite for
any claim about what this saves.  (An `fps.mjs` A/B of `?clouds=off` against
`?clouds=on` on this box was inconclusive: both pinned at a 33.3 ms p50, which
is a refresh cap and not a GPU measurement.)

## 14. Order of work

1. `gpu.mjs` back to life, and a before-reading of the march on the medium tier.
2. The new layer behind `?clouds=geo`, old one still the default: field-driven
   placement, cel material, no ink.  Compare sky cover against `w.cloud` with a
   CPU probe to prove the placement still honours the quantile contract.
3. The ink pass, and the seam detector rebuilt from plan_4's description before
   tuning anything near the horizon.
4. Rain shafts and cirrus lifted across.
5. Night, sunrise and sunset, which is where a cel ramp on a pale mass is
   hardest and where the march's `uNight` handling should be read closely
   before it is replaced.
6. Flip the default, keep `?clouds=march`, re-measure, and only then delete the
   history targets and the resolve.

## 15. Acceptance

- Sky cover tracks `w.cloud` across the four weathers, to the tolerance the
  march holds today.
- The cloud shadow crossing the ground still lines up with a cloud overhead —
  the probe `cloudfield.js` was built around, rebuilt.
- No horizon seam: the second difference of the row means near the skyline, in
  cloudy and heavy-rain skies, at every daylight hour.
- Frame time on the medium tier at or below the march's, at full render-target
  resolution rather than a third.
- And the one that matters and cannot be scored: a still of the sky beside a
  still of the road, and the same hand drew both.

---

## Appendix — where the Part A evidence came from

The dev server on 5178, `ai/perf-bench/cdp.mjs` for the browser, and a
throwaway driver that overrode `terrain.heightAt` from the page.  Nothing in
`src/` was edited; the repo was clean before and after.  The captures are at
seed `country`, s = 10520 (and 2500, 7000 as controls), `t=10:00`,
`season=summer`, `weather=sunny`, `quality=high`, `dynres=0`, 1280x720.
`ai/plan_2/verge.png` is the s = 10520 crop, as it stands above and with crown
spread 3.5 m + hinge fillet 6 m below.

The scoring code is twenty lines and is described in §2 rather than kept:
`verge.mjs` (§6) is the version worth having, and it should be written against
the road's own spline rather than against a box that happens to fit this frame.
