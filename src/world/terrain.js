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
 * `gap` is how far the batter still is from natural ground and `over` how
 * far out from the platform edge we are; the result eases the last metre
 * or two of the join.  Without it the earthwork meets the hillside along a
 * mathematically exact crease, which reads as a fold in paper rather than
 * as ground.
 */
function round(gap, over) {
  const r = Math.min(gap, ROUNDING * Math.min(1, over / (ROUNDING * 2)));
  return r > 0 ? r * 0.5 : 0;
}
const ROUNDING = 3;

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
 * The crown.  A road sheds water because its middle is a few centimetres
 * higher than its edges, and while three centimetres sounds like nothing
 * it is the difference between a road and a painted stripe -- it catches
 * the light differently on each side of the centre line all the way to
 * the horizon.
 */
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

function crown(d) {
  if (d >= CARRIAGEWAY) return -0.16;
  const t = d / CARRIAGEWAY;
  return 0.035 * (1 - t * t) - 0.16 * Math.max(0, (t - 0.78) / 0.22) ** 2;
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
   *     in cutting      ground = min(natural, edge + (d - w) / CUT_BATTER)
   *     on embankment   ground = max(natural, edge - (d - w) / FILL_BATTER)
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
  heightAt(x, z) {
    const h = this.hm.base(x, z);
    if (!this.road) return h;

    const q = this.road.nearest(x, z, _q);
    if (!q) return h;

    const w = platform(q);
    const road = q.y + crown(q.d);
    if (q.d < w) return road;

    const edge = q.y + crown(w);
    const over = q.d - w;

    let y;
    if (h > edge) {
      /* Cutting: the hillside is above the carriageway, so it is cut back
       * at 1:CUT_BATTER until it meets itself. */
      const face = edge + over / CUT_BATTER;
      if (face >= h) return h;                      // daylighted already
      y = face + round(h - face, over);
    } else {
      /* Embankment: the ground falls away, so it is built up at 1:FILL. */
      const face = edge - over / FILL_BATTER;
      if (face <= h) return h;
      y = face - round(face - h, over);
    }

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

const _q = { d: 0, y: 0, g: 0, gfa: 0, s: 0, node: null };
