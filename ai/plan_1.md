# plan_1 — the Surface Go rendering artefact

Answers `prompt_1.md`: a rendering issue in one quality setting on a Surface Go
tablet, `ref/render_issue.png`. It reproduces, the cause was one tap distance in
`core/post.js`, and it is fixed. Sections 1–4 are the diagnosis, §5 the fix as
applied, §6 a second bug that was in the same screenshot, §7 what the fix
measures at.

**Landed:** `src/core/post.js` (the tap rounding), `index.html` +
`src/core/hud.js` (the HUD stack), `ai/perf-bench/ink.mjs` (the regression
test), `.gitignore` (`chrome-prof/`, which `cdp.mjs` drops in the working
directory).

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

## 5. The fix, as applied

The ink's tap distance is in texels of a texture that cannot be filtered, so it
has to be a whole number of texels. A fractional tap is not a thinner line — it
is the same line with the tap snapped, and at a half-integer it is a coin toss
per column.

The rounding went in the **shader**, not in `setSize`, so no caller can
reintroduce it — `setNight` already writes four of this uniform's neighbours:

```glsl
vec2 t = uTexel * max( 1.0, floor( uThickness + 0.5 ) );
```

`floor( x + 0.5 )` rather than `round()`: these shaders compile as GLSL ES 1.00,
which has no `round()`. `max( 1.0, … )` keeps at least one texel, so a very small
render scale cannot collapse the stencil onto the centre tap and switch the ink
off. `setSize` still writes `1.0 + 0.5 * scale` and its comment now says what
that really chooses: one texel below a render scale of 1, two at or above it.

One trap worth recording, because it cost a run: that comment lives inside a
template literal, so a backtick in it ends the literal. `cloudfield.js` has the
same warning on its own GLSL block. The comment is written without them.

**What it costs.** The line weight steps between one texel and two instead of
sliding. That is not a regression — a NEAREST fetch was always doing it, it just
used to do it per column. Frame time is unchanged: the same four taps.

**Not worth doing:** special-casing 1.5, or nudging the scale off 1.0. Both
leave the bug in place and hide it.

---

## 6. The second bug in the same screenshot

Unrelated, and the other thing wrong with that frame: **the HUD hint line
overlaps the mode line.** `index.html` puts `.hud-hint` at `top: 20px` and
`.hud-mode` at `top: 44px`, both fixed. At 1108 px wide the hint wraps to two
lines and the second lands on `parked — W to drive F for autodrive`, which is
exactly what the screenshot shows.

Fixed by putting hint, mode, sky and rest in flow order inside one positioned
column (`.hud-stack`), instead of four blocks each pinned to its own `top`. The
rhythm is a bottom margin on every child rather than four absolute offsets, so a
hidden block takes its gap with it — which is what `.hud-hint` does on touch —
and a block that grows pushes the rest down instead of being drawn through.
`left`/`right` rather than padding gives a 24 px gutter without depending on
`box-sizing`. `.hud-cam` keeps its own positioning: on a desktop it is at the
bottom of the frame, not in this stack.

Measured (DOM rects, `?rec=1` with `clean(false)`):

| width | hint | mode | sky | rest | cam | overlaps |
|---|---|---|---|---|---|---|
| 1440 | 20 (1 line) | 44 | 68 | 92 | bottom | none |
| 1108 | 20 (2 lines) | 57 | 81 | 105 | bottom | none |
| 900 | 20 (2 lines) | 57 | 81 | 105 | bottom | none |
| touch | hidden | 48 | 70 | 92 | 114 | none |

The 1440 and touch rows are the old layout to the pixel; 1108 is the one that
used to collide. `scrollWidth === clientWidth` at 760, 900, 1108, 1440 and
1920 — the hint wraps inside the gutter now rather than running off both edges,
which it also did in the screenshot.

---

## 7. What it measures at

`HEADLESS=1 node ai/perf-bench/ink.mjs`, against a dev server on 5178:

| case | scale | before | after |
|---|---|---|---|
| `medium` | 1.0 | **0.194** | 0.028 |
| `high` | 1.5 | -0.002 | -0.002 |
| `low` | 1.25 | 0.006 | 0.006 |
| `high` at the governor's floor | 1.0 | **0.176** | 0.026 |
| `high` at 3840 x 2160 | 1.0 | **0.080** | -0.003 |

Threshold 0.09; clean has never measured past 0.05, the reference frame is 0.312.

`SWEEP=1` walks `uThickness` and is the diagnostic rather than the test. It is
now a step function — 0.004 for a one-texel stencil, 0.028 for two, 0.045 for
three — with no spike at 1.5 or 2.5. Before the fix those two stood at 0.194 and
0.065 above flat neighbours, which is the shape of a tie and not of a threshold
being grazed.

Also checked: `npm run build` succeeds, and the ink still draws — the fence, the
ridge silhouettes and the road edges are all present in the after-frames
(`SHOTS=<dir>` dumps them).

Still worth doing and not done here: a look at the three tiers side by side for
line weight, since `uSens`, `uConcave` and `uSlope` were tuned against a sliding
thickness rather than a stepping one.

## 8. Harness

`ai/perf-bench/ink.mjs`, self-contained apart from `cdp.mjs`, wants the dev
server on 5178.

```
npx vite --port 5178
HEADLESS=1 node ai/perf-bench/ink.mjs                  # pass/fail, exit code
HEADLESS=1 SWEEP=1 node ai/perf-bench/ink.mjs          # the thickness sweep
HEADLESS=1 SHOTS=/tmp/ink node ai/perf-bench/ink.mjs   # and the frames
```

The detector is in the file: after a horizontal high-pass, a row of the image
stays correlated with a row 42 px above it, which grass, trees, shadows and noise
all do not. `cdp.mjs` drops a `chrome-prof/` in the working directory, now
ignored.

The rest of the diagnosis — the road scan, the scale sweep, the scene-graph
bisection and the toggle table — was throwaway and is not in the repo. `ink.mjs`
is the part worth keeping; the others are reconstructible from §2 if another
artefact of this shape turns up.
