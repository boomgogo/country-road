# plan_1 — the Surface Go rendering artefact

Answers `prompt_1.md`: a rendering issue in one quality setting on a Surface Go
tablet, `ref/render_issue.png`. Both questions are now answered — it reproduces,
and the cause is a single line in `core/post.js`. Nothing in `src/` has been
changed.

---

## 1. Reproduced

On the dev box's own Intel HD 630 (Gen9, the same family as the Surface Go's HD
615), headless Chrome under `--use-angle=gl`, driven through
`ai/perf-bench/cdp.mjs`:

```
/?rec=1&fresh&sound=0&seed=country&t=08:20&season=spring&weather=sunny
 &day=1&dynres=0&quality=medium          # then jumpTo along the road to s = 10520
```

The world has to be warm — the frame is reached by stepping `jumpTo` from s = 20
in 500 m increments, because a single cold jump leaves the chase camera
unsettled. It is deterministic: the same frame every run.

It is not a Surface Go problem and not an Intel problem. It reproduces on any
GPU, and at 3840 x 2160 it reproduces on the `high` tier too (§4).

**Detector.** Bars are rows that stay correlated with rows 42 px above them
after a horizontal high-pass; ground texture, trees and noise decorrelate over
that distance and a screen-space bar does not. Scored on the reference image and
on captures:

| frame | score |
|---|---|
| `ref/render_issue.png` (the tablet) | **0.312** |
| reproduction, `medium` | **0.194** |
| any clean frame | 0.00 – 0.05 |

---

## 2. The cause

`core/post.js`, in `setSize`:

```js
// scale ink weight with resolution so lines stay ~2 device px
look.uThickness.value = 1.0 + 0.5 * scale;
```

and in the ink shader:

```glsl
vec2 t = uTexel * uThickness;          // uTexel = 1/rw, 1/rh
float dl = linearDepth( vUv - vec2( t.x, 0.0 ) );
float dr = linearDepth( vUv + vec2( t.x, 0.0 ) );
```

`rtScene.depthTexture` is `NearestFilter` on both axes, so those taps snap to
whole texels. A fragment centre is at `vUv.x = (i + 0.5) / rw`, so a tap of
`1.5 / rw` lands at `(i + 2.0) / rw` — **exactly on the boundary between texel
i+1 and texel i+2**. Which side of that boundary the float sum actually falls on
depends on the rounding of `(i + 0.5)/rw + 1.5/rw`, and that flips with `i`.

So `dr` is taken one texel away for some columns and two for others, in a
quasi-periodic pattern across the screen, and the second difference
`(dl + dr - 2*dc)/dc` is computed on an inconsistent, asymmetric stencil. Both
axes tie independently, which is why the artefact is a grid: vertical bars from
the x tap, horizontal rungs from the y tap.

It only shows on grazing ground because that is where it matters: where the
depth gradient is large, a one-texel error in the stencil is a large error in
the second difference — large enough to cross `uSens` and fire the ink. Flat
ground, tarmac and sky (cut off by `uSkyDepth`) are unaffected. The bars are
dark, semi-transparent and tinted like what is under them because that is
exactly what `mix( col, line, edge )` does.

**`1.0 + 0.5 * scale` is exactly 1.5 when `scale` is exactly 1.0.**

### The evidence

Sweeping `uThickness` at the reproducing frame, everything else fixed:

| thickness | 1.3 | 1.4 | 1.45 | **1.5** | 1.55 | 1.6 | 1.75 | 2.0 | 2.2 | **2.5** | 3.0 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| score (scale 1.0) | .004 | .004 | .004 | **.194** | .028 | .028 | .028 | .028 | .028 | **.065** | .045 |
| score (scale 1.5) | — | -.003 | — | **.064** | -.002 | -.002 | -.002 | -.002 | -.002 | **.021** | — |

A delta function at 1.5 with a smaller echo at 2.5 — both half-integers, both
ties — and clean 0.05 either side of it. A sensitivity resonance would be broad;
this is not. It follows `uThickness`, not the tier: forcing 1.5 at render scale
1.5 reproduces it, and the tier's own 1.75 is clean.

The near-miss confirms the mechanism is an exact tie rather than a neighbourhood:
the `low` tier's governor ladder contains 0.996, giving thickness 1.498, and that
scores -0.011. At 1.498 the tap sits consistently just inside texel i+1, so the
stencil is wrong but *uniformly* wrong, and a uniform stencil produces no comb.

### What it is not

Ruled out by toggling each at the reproducing frame (score, 0.194 at base):

| shadow map off | cloud shadow off | grade off | FXAA off | fog off | **ink off** |
|---|---|---|---|---|---|
| 0.194 | 0.194 | 0.184 | 0.164 | 0.196 | **0.005** |

A scene-graph bisection puts all of it on one object: scene child 88, a
`chunks.mesh` terrain tile at (7552, -896), 128 m square, bounding box
128 x 32 x 128 — a perfectly ordinary chunk with no degenerate geometry. So it
is not the armco (hidden: no change), not the trees, and not a stray mesh.

---

## 3. Correction to the first draft of this plan

The hypothesis this plan led with before the reproduction — that the FXAA pass
resolves the supersample with a single bilinear tap at a non-integer ratio, and
that the beat comes from there — **is wrong**. It predicted the artefact at
every scale except 1.0; the truth is the exact opposite, it appears *only* at
1.0. The sweep in §2 is what killed it.

Two observations from that draft survive, and both are real but separate:

- `Pipeline.setSize` calls `renderer.setPixelRatio(1)`, so the canvas backing
  store is CSS pixels while `main.js:164` set the ratio to `min(dpr, 2)`. On a
  HiDPI device the frame is supersampled, resolved down to CSS pixels and then
  upscaled again by the compositor. That costs picture quality on every HiDPI
  display. It is not this bug and should be filed on its own.
- The HUD overlap in §6 is unrelated and still stands.

---

## 4. Who is affected

`pipeline.scale` has to be **exactly** 1.0. Three ways to get there:

1. **`medium`, always, from the first frame.** `Pipeline` is constructed with
   `maxScale: Q.scale` (`main.js:1285`) and `medium.scale` is 1, so `scaleFor`
   returns exactly 1.0. This is the reported case: a Surface Go with its keyboard
   attached is a fine pointer with an Intel GPU name, which `pickTier` puts in
   `medium`. In tablet mode it is a coarse pointer and gets `low`, which is safe
   — hence "one quality setting".
2. **`high`, once the governor bottoms out.** `ResolutionGovernor` builds its
   ladder down to `minScale * 1.03` and then does
   `if (minScale < scale) levels.unshift(minScale)`, and `high.minScale` is 1 —
   so exactly 1.0 is the floor of the high ladder. On a machine slow enough to be
   driven there, `high` develops the same bars. Confirmed: forcing scale 1.0 at
   `quality=high` scores 0.176 – 0.194.
3. **Any tier on a window over the pixel budget.** `scaleFor`'s budget branch is
   `Math.max(Math.min(1, limit), Math.sqrt(budget / (w*h)))`, which returns
   exactly 1.0 whenever the square root falls below 1. Confirmed at 3840 x 2160,
   `quality=high`, dpr 1: score 0.080, same pattern, on a window that has nothing
   to do with tablets.

`low` is the only tier that cannot reach it on its own: its ladder holds 0.996,
not 1.0.

---

## 5. The fix

The ink's tap distance is in texels of a texture that cannot be filtered, so it
has to be a whole number of texels. A fractional tap is not a thinner line — it
is the same line with the tap snapped, and at a half-integer it is a coin toss
per column.

**F1 — round the tap, in the shader, so no caller can reintroduce it.**

```glsl
vec2 t = uTexel * max( 1.0, floor( uThickness + 0.5 ) );
```

and keep `post.js` honest about what the uniform now means (whole texels), with
the comment saying why. One line each, and it closes the whole class: any
`uThickness` any tier or the governor produces is then safe.

Rounding in `post.js` alone (`Math.round(1.0 + 0.5 * scale)`) also works and is
smaller, but leaves the shader still willing to misbehave if anything ever writes
the uniform directly — `setNight` already writes four of its neighbours.

**What it costs.** Thickness becomes 1 or 2 rather than 1.3 – 1.9, so the line
weight steps instead of sliding, and `uSens`, `uConcave` and `uSlope` were tuned
against the sliding value. The ink wants a look at each tier after the change —
`ai/perf-bench/` can capture the three tiers at a fixed frame for a side-by-side.
It costs nothing in frame time: it is the same four taps.

**Not worth doing:** special-casing 1.5, or nudging the scale off 1.0. Both leave
the bug in place and hide it.

---

## 6. The second bug in the same screenshot

Unrelated, and the other thing wrong with that frame: **the HUD hint line
overlaps the mode line.** `index.html` puts `.hud-hint` at `top: 20px` and
`.hud-mode` at `top: 44px`, both fixed. At 1108 px wide the hint wraps to two
lines and the second lands on `parked — W to drive F for autodrive`, which is
exactly what the screenshot shows.

Fix: one absolutely positioned column at `top: 20px` holding hint, mode, sky and
rest in flow order, rather than four fixed offsets. Check at 900, 1108 and
1440 px wide.

---

## 7. Verification

- The reproducing frame scores below 0.05 at `medium` after the fix, and the
  three tiers are visually compared at a fixed frame for line weight.
- The scan (24 positions over 12 km) scores clean at all three tiers; before the
  fix `medium` hit 0.05+ at six of the 24 and peaked at 0.194.
- 3840 x 2160 at `high` scores clean.
- The whole governor ladder is swept for each tier, not just the starting scale —
  that is what case 2 in §4 is.
- Frame rate unchanged against `ai/perf_findings.md` (it should be exactly
  unchanged; the pass does the same work).

## 8. Harness

The reproduction is currently in the session scratchpad, not in the repo:
`repro.mjs` (single capture), `scan.mjs` (walk the road, score, dump hits),
`sweep.mjs` / `thick.mjs` (scale and thickness sweeps), `bisect.mjs` (hide each
scene child in turn), `battery.mjs` (the toggle table in §2), and `scorer.js`
(the detector, in-page). They import `ai/perf-bench/cdp.mjs` and want the dev
server on 5178. Worth moving into `ai/perf-bench/` if this is to be regression-
tested; say the word.
