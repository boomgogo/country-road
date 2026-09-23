import { Heightmap } from '../core/noise.js';

/* ------------------------------------------------------------------ *
 * The land.
 *
 * `heightAt` is authoritative: the suspension rays, every scatter
 * placement, the chunk mesher and the road's own benching all call it,
 * and there is exactly one of it.
 *
 * The road is a *term in the height function*, not a thing that edits a
 * heightmap.  Terrain vertices near the midline are pulled toward the
 * carriageway across a blend band whose width depends on how steeply the
 * road is running -- wide where it is flat, narrow where it is steep.
 * That is softer than a constant-batter cut and fill, and it is what
 * makes the ground meet the tarmac rather than step down to it.
 *
 * The tracer must never see the road: `coarseAt` is the *unblended*
 * landform at reduced octave depth, and it is what the feelers read.
 * ------------------------------------------------------------------ */

export const WATER_LEVEL = 2;

/** Radius of the survey disc, metres.  See `coarseAt`. */
const SURVEY_R = 22;

/**
 * Batter slopes, as metres across per metre up.  1:1.5 in cutting and
 * 1:2 in fill are the ordinary highway numbers, and the asymmetry is not
 * decoration -- fill is loose material and will not stand as steeply as a
 * cut face, which is exactly why an embankment looks broader than a
 * cutting of the same depth.
 */
const CUT_BATTER = 1.5;
const FILL_BATTER = 2.0;

/**
 * Rounding at the crest of a cut and the toe of a fill.
 *
 * `gap` is how far the batter still is from natural ground -- positive
 * inside the earthwork, negative once the face has passed through the
 * hillside.  The result is what to add to the face: zero deep inside, the
 * whole of `gap` once we are clear, and a parabola in between.  Without it
 * the earthwork meets the hillside along a mathematically exact crease,
 * which reads as a fold in paper rather than as ground -- and which the
 * ink pass draws, because a crease is exactly what it looks for.
 *
 * **This replaces a rounding that had two faults and drew three lines.**
 * What was here was `0.5 * min(gap, ROUNDING * min(1, over / 6))`:
 *
 *  - It was keyed on `over` as well as `gap`, and the `over` ramp is a
 *    slope of 0.25 that switches on at the platform edge and off six
 *    metres later.  That is two slope breaks of a quarter -- one of them
 *    exactly on top of the hinge, where it cancelled the fillet `batter()`
 *    had just put there, and one six metres out in the grass, which is the
 *    line still running along the verge after the first two creases were
 *    dealt with.  Measured on the cross-section at s = 10520: breaks of
 *    0.15 at the hinge and 0.17 at over = 6, against 0.028 for the
 *    fillet's own curvature.
 *  - And `min(gap, 3) * 0.5` is nonzero for *every* gap, so it lifted the
 *    whole cut face by up to a metre and a half rather than easing its
 *    crest.  The batter was never the batter it said it was.
 *
 * The parabola below is C1 at both ends by construction and touches
 * neither fault: it is exactly zero once the face is `k` below natural
 * ground, exactly `gap` once it is `k` above, and its curvature in ground
 * terms is `m^2 / (2k)` where `m` is how fast the two surfaces are
 * closing -- about 0.06 per metre against a cut face on gentle ground,
 * which is under the knee the ink starts drawing at.  The cost is that
 * the crest is rounded off by `k / 4`, half a metre, which is what a
 * rounded crest is.
 *
 * **`k` still has to grow from nothing at the platform edge**, and that is
 * the one thing the old `over` ramp was right about.  A blend of scale `k`
 * pulls the surface `k / 4` off natural ground wherever the two are within
 * `k` of each other -- *including where they are merely close and never
 * cross* -- and the cut branch pulls it down while the fill branch pulls
 * it up.  At the platform edge, where the batter has no height yet and
 * which branch we are in is decided by a coin toss between `h` and `edge`,
 * that is a step of `k / 2` running the length of the road: breaks of 0.8
 * at s = 2500, worse than the crease it replaced.
 *
 * So `k` is ramped over twice the hinge, which keeps it under the batter's
 * own height everywhere -- `k <= batter(over)` for both slopes, checked
 * along the whole ramp -- and therefore keeps the branch change inside the
 * region where both branches return natural ground.  A smoothstep and not
 * a line, because the ramp's own slope lands in the answer at a quarter of
 * its value, and `0.25 / 4` is exactly the crease the old one drew.
 */
/**
 * **And the two faults that were left in it, which are `prompt_3.md` item
 * 2.**  `ai/perf-bench/verge.mjs` with `SECTION=2500` is the evidence:
 * every crease this file has worked on is under 0.07 per metre there and
 * there is a single spike of **0.206 at nine metres from the midline**,
 * which is the daylight line and which is the dark line running along the
 * verge in `ref/prompt_3_1.png`.
 *
 * *One.*  `k` was a height written down as a constant, and the parabola's
 * curvature in ground terms is `m^2 / 2k` where `m` is how fast the two
 * surfaces are closing per metre out.  A constant `k` is therefore a blend
 * whose curvature is whatever the hillside happens to be doing.
 *
 * *Two, and it is the one that draws.*  `k` was ramped by `smoothstep01(
 * over / (2 * HINGE))` to keep it under the batter's own height -- and on
 * a **shallow** earthwork, which is most of the road, the daylight line
 * arrives while that ramp is still near zero.  At s = 2500 the earthwork
 * is 16 cm deep, it daylights two metres past the platform edge, and `k`
 * there is 0.15 against a gap that closes at 0.14 per metre: the surface
 * steps off the batter onto the hillside in half a metre of ground.  The
 * rounding was in the code and not in the ground.
 *
 * `daylight()` below solves for the `k` that puts the curvature at
 * `DAYLIGHT_K` instead of writing a height down, so the blend is a fixed
 * width **in ground** and a shallow daylight line gets a small blend
 * rather than none.  At s = 2500 that is `k` = 0.09 and a curvature of
 * 0.11, and the 0.206 spike is gone.
 *
 * And the ramp goes with it, because `heightAt` no longer needs one -- see
 * the note on branches there.  `FILL_ROUND` goes too: it widened the blend
 * at a toe because `m` there is the fill slope *plus* the hillside's where
 * in a cutting it is the cut slope *minus* it, and a `k` derived from `m`
 * is already wider at a toe by exactly that factor.
 */
/** The curvature the daylight blend aims at, per metre of ground. */
const DAYLIGHT_K = 0.10;
/**
 * ... and the most height it is allowed to spend getting there.
 *
 * `k` goes as `m^2`, so the steepest hillside the tracer will take asks
 * for a blend that reaches further than the road is queried at all.  This
 * is about what the constant it replaced was, so a steep daylight line is
 * rounded as it always was and the change is all at the shallow end.
 */
const DAYLIGHT_MAX = 1.6;
/** A floor on the closing rate, so a blend cannot collapse to nothing. */
const CLOSE_MIN = 0.12;
/**
 * How far out the hillside's own slope is sampled, for `m`.  Long enough
 * to be the slope the earthwork will actually meet rather than one hummock
 * of it, short enough to still be the slope *here*.
 */
const PROBE = 3;

/**
 * The lower of two surfaces, with the corner between them rounded off over
 * a height of `k`.  Exactly zero effect once they are `k` apart, exactly
 * `min` once they have crossed by `k`, a parabola in between -- so it is
 * C1 at both ends by construction, and its curvature in ground terms is
 * `m^2 / 2k` where `m` is how fast the two are closing.
 */
function smoothMin(a, b, k) {
  const d = a - b;
  if (d >= k) return b;
  if (d <= -k) return a;
  const u = d - k;
  return b - (u * u) / (4 * k);
}

/** ... and the upper. */
function smoothMax(a, b, k) {
  return -smoothMin(-a, -b, k);
}

/**
 * How much rounding the daylight line gets here: the `k` whose curvature
 * comes out at `DAYLIGHT_K` whatever the ground is doing.
 *
 * `slope` is the batter face's own, `nat` the hillside's outward from the
 * road, and `sign` is -1 against the cut face, which climbs away from the
 * platform while the hillside climbs with it so the two subtract, and +1
 * against the fill face, which falls while the ground falls faster still.
 *
 * Both limits are *smooth*: a hypotenuse rather than `Math.max` for the
 * floor, a harmonic mean rather than `Math.min` for the ceiling.  A kink
 * in `k` is a crease in the ground, which is the one thing this function
 * exists to remove, and `abs`, `min` and `max` are all kinks.
 */
function daylight(slope, nat, sign) {
  const v = slope + sign * nat;
  const m2 = v * v + CLOSE_MIN * CLOSE_MIN;
  const want = m2 / (2 * DAYLIGHT_K);
  /* A soft ceiling rather than `Math.min`, which is a kink.  The harmonic
   * mean is the obvious smooth one and it is far too lossy -- it takes a
   * fifth off a `want` that is only a quarter of the cap, which is most of
   * the road.  This one is within three per cent of `want` there and still
   * approaches the cap from below. */
  const r = want / DAYLIGHT_MAX;
  return want / Math.sqrt(1 + r * r);
}

/**
 * Over how many metres the earthwork is eased back to natural ground at
 * the outer limit of the road's query range.  See `heightAt`.
 *
 * Twelve, because it has to be long enough that easing a metre and a half
 * of batter across it is a slope of about 1:8 -- gentle enough that neither
 * the eye nor the ink pass finds it -- and short enough to stay clear of
 * the cut and fill faces themselves, which end within thirty metres of the
 * road even on the steepest ground the tracer will take.
 */
const EARTH_FADE = 12;

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Half-width of the drawn carriageway, tarmac plus its gravel shoulder. */
export const CARRIAGEWAY = 4.3;

/**
 * The gravel shoulder, beyond the tarmac.
 *
 * Its absence showed in nearly every still: a country road has a band of
 * speckled aggregate between the white edge line and the grass, and ours
 * put the paint straight onto the turf.  It was not missing, it was 45 cm wide -- the shader's gravel
 * ramp started inside the carriageway and had almost nothing left by the
 * time the tarmac ended.
 */
export const SHOULDER = 1.35;

/**
 * How far from the midline the ground shader is still told where it is.
 *
 * This matters more than it looks.  The lateral offset is a *vertex*
 * attribute and it gets interpolated across triangles, so a vertex marked
 * with an off-road sentinel next to one on the tarmac interpolates through
 * every value in between -- and if the sentinel is 999 the crossing point
 * lands wherever arithmetic puts it, which is how a still came out with
 * the road missing under the car and a strip of tarmac in a field.  The
 * sentinel has to be *close* to the road's real edge, and every vertex
 * within reach of a triangle that touches the road has to carry a true
 * value.
 *
 * **And the sentinel is not enough on its own.**  It is *signed* -- a
 * vertex to the left of the road carries a negative offset -- while the
 * off-road sentinel is positive, so an edge from a vertex 26 m to the left
 * (`-26`) to its neighbour beyond the query radius (`+30`) interpolates
 * through zero, and the shader paints a full carriageway across it about
 * thirty metres out in a field.  That is `ref/silver_line_on_grass.png`.
 * The same happens with no sentinel at all wherever the two midlines pass
 * within about fifty metres of each other, since `nearest` answers for
 * whichever line is closer and the two answers have opposite signs.
 *
 * So the *mask* -- is there a road here at all -- is carried separately,
 * as the distance to the curve (`roadA` in `chunks.js`), and a linear
 * interpolation between two distances can never dip below the smaller of
 * them.  The signed value below stays, for the one job it is trustworthy
 * for: the marking texture's coordinate across the carriageway, which is
 * only ever read inside the mask.
 */
export const ROAD_QUERY = 26;
export const ROAD_OFF = 30;

/**
 * Half-width of the built platform -- the flat ground the road is laid on,
 * before the batter starts falling away.
 *
 * It has to be wider than the *drawn* road, and it was not: the platform
 * was `roadHalfWidth + 0.4 + slope` -- about 3.4 to 4.4 m -- while the
 * carriageway is painted out to 4.3 and the gravel shoulder to 5.65.  So
 * the earthwork began underneath the paint, and every frame had a bank of
 * bare fill starting at the white line.  Carriageway, shoulder, and a
 * metre of verge to stand on, plus a little more where the road is running
 * across a slope and needs more built ground under it.
 */
function platform(q) {
  const ga = Math.min(1, Math.max(Math.abs(q.g), Math.abs(q.gfa)) / 3.6);
  return CARRIAGEWAY + SHOULDER + 0.9 + ga;
}

/**
 * The crown, and the shoulder fall -- the road's own cross-section, as
 * metres above the midline's elevation.
 *
 * **The crown.**  A road sheds water because its middle is a few
 * centimetres higher than its edges, and while three centimetres sounds
 * like nothing it is the difference between a road and a painted stripe --
 * it catches the light differently on each side of the centre line all the
 * way to the horizon.
 *
 * **The fall**, and this is the half that had to be rewritten.  The
 * carriageway sits 16 cm above the verge beside it, and that drop used to
 * be spent over the last 95 cm of tarmac: a quadratic reaching a slope of
 * 0.35 at `CARRIAGEWAY` and then flat.  A slope break is a step in the
 * first difference of depth, which is precisely what the ink in
 * `core/post.js` fires on -- and because the ground is a *lattice*, a
 * crease reaches the screen as one small crease per vertex row, so it drew
 * not as a line but as a broken band of dashes following the road the
 * whole way to the horizon.  That is the first half of `prompt_2.md`.
 *
 * What the ink actually cares about is **curvature**, not slope
 * continuity: the second difference is the curvature times the square of
 * the tap's footprint, and on a 1 m lattice it is the slope break per
 * vertex row, which is the curvature times a metre.  Merely landing the
 * old quadratic at zero slope is worth almost nothing (2.203 -> 2.140 on
 * the verge score in `ai/plan_2.md` s2); spending the same drop over more
 * ground is worth all of it.
 *
 * So the fall now runs from 0.78 of the carriageway out to **the platform
 * edge**, as a smoothstep: about 3.2 to 4.2 m of ground rather than 0.95,
 * which is a peak curvature of 0.08 per metre against the knee at about
 * 0.2.  Ending it at `w` rather than at a constant is what keeps it in
 * step with `platform()` -- the fall finishes exactly where the batter
 * begins, both with zero slope, so there is no second crease where they
 * meet and no second number to keep in agreement.
 *
 * The tarmac is flatter for it: the drop at the white line is about 3 cm
 * rather than 16, and the rest happens on the gravel.  That is what a road
 * with a shoulder does, and the *drawn* edge does not move -- the tarmac
 * mask in `groundmat.js` is keyed on distance and is deliberately hard.
 */
const FALL = 0.16;
const FALL_START = 0.78 * CARRIAGEWAY;

function crown(d, w) {
  const t = Math.min(1, d / CARRIAGEWAY);
  return 0.035 * (1 - t * t)
    - FALL * smoothstep01((d - FALL_START) / (w - FALL_START));
}

/**
 * Rounding at the top of the batter, where it leaves the platform.
 *
 * The other crease `prompt_2.md` is about, and the bigger of the two: the
 * ground is flat out to `w` and then falls or rises at 1:2 or 1:1.5, which
 * is a slope break of 0.5 to 0.67 at a single lattice row.  It drew as
 * long diagonal strokes climbing the cutting, along the triangulation's
 * own diagonals -- which is the tell that the mark is geometry and not the
 * ink pass misbehaving.
 *
 * A parabolic fillet: value and slope continuous at both ends, constant
 * curvature `1 / (HINGE * ratio)` in between -- 0.11 per metre in cutting
 * and 0.08 in fill at six metres, under the knee with margin.  Past six it
 * stops paying for itself (2.140 at 6 m against 2.138 at 12).
 *
 * What it costs is that the crest of a cut and the toe of a fill move out
 * by half the fillet, three metres, and the earthwork carries about that
 * much less material.  `daylight()` eases the *other* end of the batter,
 * where it daylights into the hillside, and the two blends are keyed on
 * different things -- this one on distance out from the platform, that one
 * on how far the face still is from natural ground -- so on an earthwork
 * too shallow to have room for both they simply overlap, which is a
 * shallower face still and not a crease.
 */
const HINGE = 16;

function batter(over, ratio) {
  return over < HINGE
    ? (over * over) / (2 * HINGE * ratio)
    : (over - HINGE * 0.5) / ratio;
}

/** ... and its slope, which is the derivative of the line above. */
function batterSlope(over, ratio) {
  return over < HINGE ? over / (HINGE * ratio) : 1 / ratio;
}

export class Terrain {
  constructor(seed = 1, topo = {}) {
    this.hm = new Heightmap(seed, topo);
    /** Set once the road exists.  Until then the land is bare. */
    this.road = null;
    this.roadHalfWidth = 3;
  }

  /**
   * The landform the road tracer surveys.
   *
   * This used to be the heightmap at reduced octave depth -- two octaves
   * out of three -- which is right about the thing it is for: a road that can see every hummock swerves around
   * every hummock.  But it is the wrong *kind* of blindness.  Truncating
   * the spectrum does not make the third octave smaller, it makes it
   * **invisible**, and the third octave here is a +/-15 m undulation on a
   * 188 m wavelength -- which is precisely the scale a road has to
   * negotiate.  The result was a road that sat within +/-2.4 m of the
   * landform it had surveyed and up to 25 m from the one it was drawn on,
   * with 6.6 m of earthwork on average and 64 % of its length in a cutting
   * or on an embankment.
   *
   * A surveyor does not see a different landform.  They see a smoothed
   * one.  So this is a genuine low-pass of the *drawn* ground: the mean of
   * seven samples over a 22 m disc, which still knows a 15 m hummock is
   * there and simply does not care about a 3 m one.
   *
   * Seven samples rather than four because the hexagon plus centre has no
   * preferred direction; a square would put a bias along the axes, and the
   * lattice this noise is built on already has creases along them.
   */
  coarseAt(x, z) {
    const b = this.hm;
    let sum = b.base(x, z);
    for (let i = 0; i < 6; i++) {
      const a = i * (Math.PI / 3);
      sum += b.base(x + Math.cos(a) * SURVEY_R, z + Math.sin(a) * SURVEY_R);
    }
    return sum / 7;
  }

  /** Full-detail landform, no road. */
  bareAt(x, z) {
    return this.hm.base(x, z);
  }

  /**
   * Ground height including the road.  `q` is a scratch object so this can
   * be called per vertex without allocating.
   *
   * **The earthwork is a batter, and it daylights itself.**
   *
   * What was here was a blend: pull the ground toward the carriageway
   * across a band of 4 to 16 m, wider where the road is flat.  That is
   * fine for two or three metres of reconciliation.  Ours was doing 6.6 m on average and 25 m at
   * worst, in the same band -- a 45-degree wall of bare dirt, the same
   * width whether it was hiding a kerb or a five-storey embankment, and at
   * any vertex spacing above 2 m it fell between the vertices and the road
   * was not in the mesh at all.
   *
   * A real earthwork has a *slope*, and its width is whatever that slope
   * needs to reach natural ground:
   *
   *     in cutting      ground = min(natural, edge + batter(d - w, CUT))
   *     on embankment   ground = max(natural, edge - batter(d - w, FILL))
   *
   * -- where `batter` is `over / ratio` with the first six metres of it
   * rounded into the platform, for the reason that function gives.
   *
   * The `min`/`max` finds the daylight line by itself -- no band, no
   * parameter, no smoothstep -- and both of the properties the brief asks
   * for fall out of the algebra rather than out of tuning: natural ground
   * is never above the carriageway inside the corridor, so there is
   * nothing to see through; and the carriageway is never below the ground
   * beside it, so the road is always the top surface.
   *
   * The rounding is the only cosmetic part, and it earns its place: a
   * batter that meets the hillside at a hard crease reads as folded paper.
   */
  heightAt(x, z, h = this.hm.base(x, z)) {
    /* `h` may be handed in: the chunk mesher samples the landform on a
     * grid of its own, for the curvature, and would otherwise pay for
     * every vertex's base twice.  See `ChunkField._build`.
     *
     * `lastRoad` is the nearest-road answer this call used, or null --
     * the same answer `roadUV` would give for the same point, and the
     * mesher wants both.  It is `_q`, shared, so it is good until the
     * next call into this file and no longer. */
    this.lastRoad = null;
    if (!this.road) return h;

    const q = this.road.nearest(x, z, _q);
    if (!q) return h;
    this.lastRoad = q;

    const w = platform(q);
    const road = q.y + crown(q.d, w);
    if (q.d < w) return road;

    /* The fall has run its course by `w` -- that is what `crown` ends it
     * there for -- so the batter starts from the bottom of it, flat. */
    const edge = q.y + crown(w, w);
    const over = q.d - w;

    /* **And there is no cut branch and no fill branch.**
     *
     * What was here chose one: `h > edge` picked the cut face or the fill
     * face and rounded the hillside against it.  That choice is a *step*.
     * Both roundings pull the surface `k / 4` off natural ground wherever
     * the two surfaces are merely close -- downward against the cut face,
     * upward against the fill -- so wherever the hillside crosses platform
     * level the ground jumps by `k / 2`, and it crosses along the length
     * of the road.  That is what forced `k` to be ramped to nothing at the
     * platform edge, and that ramp is what left the daylight line of a
     * shallow earthwork with no rounding at all.  See `daylight`.
     *
     * Both faces, and the hillside taken against both:
     *
     *     y = max( min( natural, cut ), fill )
     *
     * `fill <= edge <= cut` always, so the hard version of that expression
     * *is* the two branches, written without the choice -- deep in a
     * cutting the `min` returns the cut face and the `max` leaves it, deep
     * in fill the `min` passes the hillside through and the `max` returns
     * the fill face, and in between both pass it through and the ground is
     * the ground.  Rounding the two corners then costs nothing in
     * continuity, because there is no longer a branch to be on the wrong
     * side of: where the two faces meet at the platform edge the blends
     * simply overlap, and an overlap is an offset of about a seventh of
     * `k` and not a step of half of it.  With `k` at a tenth of a metre
     * there, that is a centimetre. */
    const ox = (x - q.px) / q.d, oz = (z - q.pz) / q.d;
    const nat = (this.hm.base(x + ox * PROBE, z + oz * PROBE) - h) / PROBE;

    const cut = edge + batter(over, CUT_BATTER);
    const fill = edge - batter(over, FILL_BATTER);
    /* ... and neither blend may be wider than the gap between the two
     * faces.  At the platform edge they are the same surface, so without
     * this the fill blend rounds the cut face and the cut blend rounds the
     * fill, each lifting the other by a quarter of its own `k` -- and that
     * lift tapers off over the metre it takes the faces to separate, which
     * is a crease of its own.  Measured at s = 2500: 0.132 per metre at
     * the platform edge against 0.070 before, which is trading one line
     * for another.
     *
     * `k * smoothstep(sep / 2k)` is at most `sep` for every `sep`, because
     * `smoothstep(t) <= 2t` on the whole interval -- so the property is
     * held by construction rather than by a tuned constant.  And unlike
     * the ramp this file used to have, it is *symmetric*: both blends shut
     * down together as the faces close, so nothing depends on which side
     * of anything the hillside is, and the daylight line -- where the
     * faces are long since apart -- keeps the whole of its `k`. */
    const sep = cut - fill;
    let kc = daylight(batterSlope(over, CUT_BATTER), nat, -1);
    let kf = daylight(batterSlope(over, FILL_BATTER), nat, 1);
    kc *= smoothstep01(sep / (2 * kc));
    kf *= smoothstep01(sep / (2 * kf));

    /* The common case by a distance: the hillside is clear of both faces,
     * so the ground is the ground and the fade below is a no-op. */
    if (h < cut - kc && h > fill + kf) return h;

    const y = smoothMax(smoothMin(h, cut, kc), fill, kf);

    /* --- and out, before the road stops being asked about ---------------
     *
     * `nearest` gives up at its own radius and this function then returns
     * the bare landform, so the road's query range is a **boundary in the
     * height field**: wherever an earthwork had not daylighted by then, the
     * ground stepped from a batter face back to the hillside in one go.
     * The step is up to a metre and a half, it follows a contour of
     * constant distance from the road, and the mesher samples it on a
     * lattice -- so it reaches the screen as a perfectly axis-aligned
     * staircase, which the ink pass in `core/post.js` then draws as a line,
     * because a second difference of depth is exactly what a step is.
     * `ref/silver_line_on_grass.png` is that line.
     *
     * A wider radius does not fix it, it moves it: a steep enough hillside
     * beats any radius, and every vertex in the world pays for the search.
     * Tapering does fix it, by construction -- the earthwork is eased back
     * to natural ground over the last `EARTH_FADE` metres of the range, so
     * the two sides of the boundary are the same number and there is
     * nothing left to step.  Smoothstep rather than a ramp, so the join has
     * no crease of its own for the same pass to find.
     *
     * What it costs is the outer twelve metres of the deepest cuttings,
     * which now ease into the hill instead of ending against it.  That is
     * the same argument `round` above makes at the daylight line, one scale
     * up. */
    const fade = this.road.maxQuery;
    if (q.d <= fade - EARTH_FADE) return y;
    return y + (h - y) * smoothstep01((q.d - (fade - EARTH_FADE)) / EARTH_FADE);
  }

  /**
   * Where a point sits on the road, for the ground shader: signed metres
   * across, and metres along.  Null off the road, which is most of the
   * world and therefore worth returning cheaply.
   */
  roadUV(x, z) {
    if (!this.road) return null;
    const q = this.road.nearest(x, z, _q);
    if (!q || q.d > ROAD_QUERY) return null;
    return q;
  }

  /**
   * Signed road proximity, carried on every terrain vertex: negative on the carriageway, 0..1 across the verge,
   * 0 beyond.  The mesher hands this to the shader to paint the shoulder.
   */
  roadProxAt(x, z) {
    if (!this.road) return 0;
    const q = this.road.nearest(x, z, _q);
    if (!q) return 0;
    const w = platform(q);
    if (q.d < w) return -1 + q.d / w * 0.2;
    /* The verge is a metre or three of gravel, not a shoulder you could
     * park a bus on.  It was nine, and combined with the benching that put
     * a fifty-metre grey apron down either side of the road and turned the
     * whole near field into an airfield. */
    const verge = 3;
    if (q.d < w + verge) return 1 - (q.d - w) / verge;
    return 0;
  }

  /** Central-difference slope of the finished ground, per metre. */
  gradientAt(x, z, e = 2) {
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return { dx, dz, slope: Math.hypot(dx, dz) };
  }

  /**
   * A discrete Laplacian of the landform -- the mean of four neighbours
   * at +/-5 m, minus the centre.  Positive is a hollow, negative is a
   * ridge.  Carried per vertex, it decides where rock breaks through and
   * where sediment gathers, which is a much better rule than height or slope alone and costs four extra samples.
   */
  curvatureAt(x, z) {
    const c = this.hm.base(x, z);
    const s =
      this.hm.base(x - 5, z) + this.hm.base(x + 5, z) +
      this.hm.base(x, z - 5) + this.hm.base(x, z + 5);
    return 0.02 * (s / 4 - c);
  }

  /** What the ground is made of here -- drives grip, scatter and texture. */
  surfaceAt(x, z) {
    const y = this.heightAt(x, z);
    const { slope } = this.gradientAt(x, z);
    let cls;
    if (this.road) {
      const p = this.roadProxAt(x, z);
      if (p < -0.2) cls = 'road';
      else if (p > 0.35) cls = 'gravel';
    }
    if (!cls) {
      if (y < WATER_LEVEL) cls = 'water';
      else if (y < WATER_LEVEL + 2.5) cls = 'shore';
      else if (slope > 0.62) cls = 'rock';
      else cls = 'grass';
    }
    return { y, slope, cls, wet: y < WATER_LEVEL + 1 };
  }
}

const _q = { d: 0, y: 0, g: 0, gfa: 0, s: 0, px: 0, pz: 0, node: null };
