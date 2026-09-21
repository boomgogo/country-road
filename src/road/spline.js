import { Midline, STEP } from './trace.js';

/* ------------------------------------------------------------------ *
 * The traced midline, made queryable.
 *
 * Two questions get asked of the road, at very different rates:
 *
 *   sampleAt(s)      -- once per road-chunk vertex row, walking forward
 *   nearest(x, z)    -- once per *terrain* vertex, from anywhere
 *
 * The second is the hot one: a 128 m chunk at 1 m spacing is 16 641
 * queries, and it has to be answered from a hash grid rather than by
 * walking a list that is tens of thousands of nodes long.
 *
 * The grid is maintained incrementally, including on the tracer's
 * backtracks -- a reverted node has to leave the index or the terrain
 * keeps benching a road that is no longer there.
 *
 * **And the road goes both ways.**
 *
 * `prompt_5.md` item 4: *"The player should be able to drive in the
 * opposite direction and follow the road that way."*  Before this there
 * was one `Midline`, walking forward from node 0 at the origin, so
 * `nearest` returned null behind the start and `sampleAt` clamped to node
 * 0 -- turn round, drive thirty metres, and the tarmac simply stopped.
 *
 * There are two tracers now, planted at the same point on opposite
 * headings, and one **signed** arc coordinate over both of them:
 *
 *     s < 0   the backward line, at node index -s / STEP
 *     s = 0   the origin, which both lines share
 *     s > 0   the forward line, at node index  s / STEP
 *
 * Everything downstream reads `s` and almost none of it had to change,
 * because almost none of it ever assumed the sign.  Three things did:
 * `Autodrive` has to know which way along the road the car is pointing,
 * `Save` validated `s >= 0`, and `main.js` now leads the trace in both
 * directions at once.
 *
 * The two lines share a crossing index (see `Midline`'s constructor), so
 * neither can drive through the other, and the quadratic through the
 * origin is built from the back line's own control point -- which is the
 * one place the seam between them could show.
 * ------------------------------------------------------------------ */

/* The fine grid's cell, and the reach it guarantees.
 *
 * A node is registered into its own cell and the eight around it, so a
 * query is answered from one cell and is exact out to `CELL` metres.  That
 * was 32, which covered the old fixed blend band with room to spare.  The
 * batter earthworks daylight at whatever distance their depth requires --
 * a 12 m embankment at 1:2 reaches 28 m past the platform edge -- so the
 * guarantee has to cover that, or the earthwork is silently truncated at
 * the query horizon and leaves a step in the ground. */
const CELL = 48;                 // hash-grid cell, metres

/**
 * How far out `nearest` answers -- and it has to be inside what the index
 * *guarantees*, which is the trap the number above walked into.
 *
 * A node is registered into its own cell and the eight around it, so a
 * query in cell C sees every node whose own cell is within one of C.  A
 * node two cells away differs by more than a whole cell on one axis, so
 * **every node within `CELL` of the query point is in the list, and beyond
 * that it depends on where the cell boundaries happen to fall.**
 *
 * This was 56 against a `CELL` of 48.  In the band between them the answer
 * was a function of which 48 m cell you asked from, and `Terrain.heightAt`
 * is a `nearest` call: so the ground took its earthwork from the road on
 * one side of a cell boundary and not on the other, and stepped between
 * them.  The step follows the cell lattice, the mesher samples it per
 * vertex, and the ink pass in `core/post.js` -- a second difference of
 * depth, which is precisely a step detector -- drew the result as a thin
 * line running across a field in perfect right-angled zig-zags.  That is
 * `ref/silver_line_on_grass.png`, and it was not paint.
 *
 * 46 rather than 48 because the query is answered against *segments*, not
 * nodes: a foot point 46 m away on a `STEP` long segment has an endpoint
 * within `sqrt(47^2 + 5^2) = 47.3` m once `CHORD_SAG` is allowed for, which
 * is inside the guarantee with room left over.
 *
 * The earthwork is what needed the range, and it no longer relies on
 * getting one: `world/terrain.js` tapers it to nothing before this radius
 * rather than being cut off at it.  Two mechanisms, one for each half of
 * the fault -- the boundary is now in a place where nothing changes, and
 * nothing changes at the boundary.
 */
const MAX_QUERY = 46;

/* A second, much coarser index, for the one question the fine grid cannot
 * answer: *how far away* is the road, out to a kilometre.  The fine grid
 * registers each node into its own cell and the eight around it, so a
 * query finds nothing further off than about a cell and a half -- fine for
 * benching the ground, useless for choosing a chunk's resolution.  It
 * returned Infinity for every chunk the road did not physically pass
 * through, so the five LOD bands were in practice two: 1 m where the road
 * ran, 16 m everywhere else. */
const COARSE = 256;

function key(cx, cz) {
  return cx * 73856093 ^ cz * 19349663;
}

/* How far a segment's quadratic can stray from its chord before the
 * difference is worth spending arithmetic on.  Two centimetres is a
 * fiftieth of the vertex spacing the road is meshed at, so a segment under
 * it is a straight as far as anything downstream can tell. */
const FLAT_SAG = 0.02;
/* ...and the most it can ever stray, which the broad phase's cull has to
 * allow for or a vertex outside `MAX_QUERY` by the chord -- but inside it
 * by the curve -- gets thrown away before anyone measures it properly.
 * `STEP^2 / 8R` at the tightest corner the tracer produces, rounded up. */
const CHORD_SAG = 1;

/** Scratch for the refinement -- `nearest` runs per terrain vertex. */
const _hit = { d2: 0, i: 0, t: 0, x: 0, z: 0, tx: 0, tz: 0 };

/**
 * Closest point on segment `i`'s quadratic, kept if it beats `best`.
 *
 * `B(t) = A t^2 + B t + P0`, and the foot of the perpendicular is the root
 * of `(B(t) - p) . B'(t)`, a cubic.  Newton from the chord's parameter
 * finds it in two or three steps because the curve is never far from the
 * chord, and clamping inside the loop keeps a step that would leave the
 * segment on its end instead -- the neighbour, if it has a better answer,
 * is tried separately.
 */
function curveFoot(ns, i, t0, x, z, best) {
  const n0 = ns[i], n1 = ns[i + 1];
  if (!n1) return;
  const ax = n1.x - 2 * n0.cx + n0.x, az = n1.z - 2 * n0.cz + n0.z;
  const bx = 2 * (n0.cx - n0.x), bz = 2 * (n0.cz - n0.z);
  const cx = n0.x - x, cz = n0.z - z;

  /* |A| / 4 is the segment's sag off its own chord.  Below the threshold
   * the chord *is* the curve and the seed parameter is already the answer. */
  let t = t0;
  if (ax * ax + az * az > (4 * FLAT_SAG) * (4 * FLAT_SAG)) {
    for (let k = 0; k < 3; k++) {
      const px = (ax * t + bx) * t + cx, pz = (az * t + bz) * t + cz;
      const dx = 2 * ax * t + bx, dz = 2 * az * t + bz;
      const f = px * dx + pz * dz;
      const fp = dx * dx + dz * dz + 2 * (px * ax + pz * az);
      if (fp <= 1e-9) break;
      const step = f / fp;
      t -= step;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      if (step * step < 1e-8) break;
    }
  }

  const px = (ax * t + bx) * t + cx, pz = (az * t + bz) * t + cz;
  const d2 = px * px + pz * pz;
  if (d2 >= best.d2) return;
  best.d2 = d2; best.i = i; best.t = t;
  best.x = x + px; best.z = z + pz;
  best.tx = 2 * ax * t + bx; best.tz = 2 * az * t + bz;
}

export class RoadPath {
  constructor(terrain, opts = {}) {
    this.terrain = terrain;
    /* One crossing index for both tracers.  Without it the two roads are
     * invisible to each other and cross about two kilometres out. */
    const shared = { grid: new Map(), lines: [] };
    const heading = opts.heading || 0;
    this.mid = new Midline(terrain, { ...opts, heading, shared });
    this.back = new Midline(terrain, { ...opts, heading: heading + Math.PI, shared });
    /** Both lines, indexed by the tag stored in the grids: 0 fwd, 1 back. */
    this.lines = [this.mid, this.back];
    this.grid = new Map();
    this.coarse = new Map();
    /** How many nodes of each line are in the index. */
    this.indexed = [0, 0];
    /**
     * World box of the nodes laid since anyone last asked, **per line**.
     *
     * Not one box for both, and that distinction cost a whole debugging
     * session.  The two tracers run in opposite directions, so a single
     * box round both of them spans the entire road -- twelve kilometres
     * once the forward tip is five out and the backward one is seven --
     * and `main.js` hands it to `ChunkField.invalidate`.  Which duly threw
     * away and rebuilt the ground *under the car*, every frame, so the
     * wheels raycast into a hole, the car fell through the world, and the
     * symptom was `road.nearest` returning null 800 m into a perfectly
     * good backward road.  Two boxes are two boxes.
     */
    this.laidBoxes = [null, null];
    this._index();
  }

  get nodes() { return this.mid.nodes; }
  get tail() { return this.mid.tail; }
  /** The far end of the backward line. */
  get tailBack() { return this.back.tail; }
  /** Arc length of the road ahead of the origin, metres. */
  /**
   * How far out `nearest` answers, published because it is not only this
   * file's business: `Terrain.heightAt` is a `nearest` call, so the road's
   * query radius is a **boundary in the height field**, and anything still
   * happening at that radius steps across it.  See `MAX_QUERY` above and
   * the taper in `world/terrain.js`; neither half works without the other.
   */
  get maxQuery() { return MAX_QUERY; }

  get length() { return (this.mid.nodes.length - 1) * STEP; }
  /** ...and behind it, as a positive number. */
  get lengthBack() { return (this.back.nodes.length - 1) * STEP; }

  /** Tagged index -> the line it belongs to, and the node index in it. */
  _at(tag) { return this.lines[tag & 1].nodes[tag >> 1]; }

  /**
   * Tell the tracers how much road is not theirs to take back.
   *
   * A revert deletes nodes, and a cascade of escalating reverts can delete
   * hundreds -- which is fine two kilometres ahead of the car and
   * catastrophic under it: the index loses the road, `nearest` returns
   * null, the autopilot has nothing to follow and the safety net teleports
   * the player.  Measured on a reverse drive before this existed: five
   * hundred nodes of backward road down to twenty-two in one frame.
   *
   * `s` is the car's signed arc position; the margin is generous because
   * the cost of protecting too much is only that the tracer has to find
   * another way out, and the cost of protecting too little is the world
   * disappearing.
   */
  protect(s, margin = 400) {
    const m = Math.ceil(margin / STEP);
    const fwd = Math.max(0, Math.ceil(s / STEP) + m);
    const back = Math.max(0, Math.ceil(-s / STEP) + m);
    this.mid.protect = Math.min(fwd, this.mid.nodes.length - 1);
    this.back.protect = Math.min(back, this.back.nodes.length - 1);
  }

  /* --------------------------- the index ---------------------------- */

  /**
   * Register every node not yet in the grid; drop any that were reverted.
   *
   * Run once per line.  The grids hold **tagged** indices -- `i * 2 + id`,
   * `id` being 0 for the forward line and 1 for the backward one -- so a
   * single cell can hold nodes of both and `_at` resolves either.
   */
  _index() {
    for (let id = 0; id < 2; id++) this._indexLine(id);
  }

  _indexLine(id) {
    const line = this.lines[id];
    const nodes = line.nodes;
    /* Anything at or above the tracer's low-water mark has been rewritten
     * since we last indexed, so it has to come out of both grids and go
     * back in.  Comparing `indexed` against the current length is not
     * enough: a revert followed by re-tracing leaves the length equal or
     * larger while every index in between now means something else. */
    const from = Math.min(line.lowWater, this.indexed[id]);
    line.lowWater = Infinity;
    if (from < this.indexed[id]) {
      /* The tracer backtracked -- pull the vanished nodes out of the grid.
       * Only this line's: the twin's tags are untouched, which is the
       * whole reason the tag carries the line. */
      for (const g of [this.grid, this.coarse]) {
        for (const [k, arr] of g) {
          let w = 0;
          for (let i = 0; i < arr.length; i++) {
            const tag = arr[i];
            if ((tag & 1) !== id || (tag >> 1) < from) arr[w++] = tag;
          }
          if (w === 0) g.delete(k); else arr.length = w;
        }
      }
      this.indexed[id] = from;
    }
    for (let i = this.indexed[id]; i < nodes.length; i++) {
      const n = nodes[i];
      const tag = i * 2 + id;
      this._laid(id, n.x, n.z);
      const cx = Math.floor(n.x / CELL), cz = Math.floor(n.z / CELL);
      /* A node is registered into its own cell and the eight around it, so
       * a query only ever has to look in one cell.  Nine inserts per node
       * against nine lookups per vertex is the right way round: there are
       * three orders of magnitude more vertices than nodes. */
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const k = key(cx + dx, cz + dz);
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push(tag);
        }
      }
      // one entry per node in the coarse index, own cell only
      const kk = key(Math.floor(n.x / COARSE), Math.floor(n.z / COARSE));
      let ca = this.coarse.get(kk);
      if (!ca) { ca = []; this.coarse.set(kk, ca); }
      ca.push(tag);
    }
    this.indexed[id] = nodes.length;
  }

  /** Grow one line's box of newly-laid road.  Consumed by `takeLaidBoxes`. */
  _laid(id, x, z) {
    const b = this.laidBoxes[id];
    if (!b) { this.laidBoxes[id] = { minX: x, minZ: z, maxX: x, maxZ: z }; return; }
    if (x < b.minX) b.minX = x; else if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z; else if (z > b.maxZ) b.maxZ = z;
  }

  /**
   * The ground the tracer has newly laid road *through* since this was
   * last called, as a world-space box, or null.
   *
   * The twin of `takeDirtyBoxes`, and it turns out to be the more important
   * of the two.  Road leaving is rare -- 5.6 reverts per road -- and was
   * handled a whole iteration ago; road *arriving* in ground that has
   * already been built happens constantly and was not handled at all.
   *
   * Why it happens with no backtracking whatsoever: the chunk field is an
   * ellipse measured in straight lines, and the tracer's lead is measured
   * in arc length.  A road that winds -- and ours has a route efficiency
   * of about 0.75 -- covers three quarters of a metre of ground per metre
   * of tarmac, so an arc lead equal to the field's reach leaves the far
   * side of the ellipse with no road in it.  That ground gets built bare.
   * Then the road arrives, and nothing rebuilds it: `_relod` only reacts
   * to a change of *resolution*, and a chunk the road already ran near was
   * built at 1 m spacing to begin with, so its resolution never changes
   * and it stays wrong for as long as it lives.  Measured on
   * `?seed=country`: up to twelve such chunks live at once, disagreeing
   * with the terrain by as much as 16 m -- which is a bare hillside
   * standing across a carriageway.
   */
  takeLaidBoxes() {
    const out = this.laidBoxes;
    this.laidBoxes = [null, null];
    return out;
  }

  /* --------------------------- extension ---------------------------- */

  /**
   * The ground the tracer has abandoned since this was last called, as a
   * world-space box, or null.  The chunk field rebuilds what it covers --
   * see `ChunkField.invalidate`.  Handed over once and cleared, because two
   * consumers of a backtrack would both have to remember to reset it and
   * one of them would forget.
   */
  takeDirtyBoxes() {
    const out = [this.mid.dirtyBox, this.back.dirtyBox];
    this.mid.dirtyBox = null;
    this.back.dirtyBox = null;
    return out;
  }

  /**
   * Trace until at least `lead` metres past arc position `s`, both ways.
   *
   * `ahead` and `behind` are separate because they are wanted in different
   * amounts: a player driving away from the origin needs a kilometre in
   * front and a few hundred metres behind, and which of those is the
   * forward line depends on which way they are pointing.  `main.js` swaps
   * them off the sign of `car.speed`.
   */
  extend(s, lead, budget = 48, behind = 0) {
    let n = 0;
    n += this.extendAhead(s, lead, budget);
    if (behind > 0) n += this.extendBehind(s, behind, budget);
    return n;
  }

  /** Trace the forward line to `s + lead`.  Does nothing if `s + lead < 0`. */
  extendAhead(s, lead, budget = 48) {
    const want = Math.ceil((s + lead) / STEP);
    if (want <= 0) return 0;
    const n = this.mid.extendTo(want, budget);
    if (n > 0 || this.indexed[0] !== this.mid.nodes.length) this._indexLine(0);
    return n;
  }

  /** Trace the backward line to `s - lead`, i.e. to node `(lead - s)/STEP`. */
  extendBehind(s, lead, budget = 48) {
    const want = Math.ceil((lead - s) / STEP);
    if (want <= 0) return 0;
    const n = this.back.extendTo(want, budget);
    if (n > 0 || this.indexed[1] !== this.back.nodes.length) this._indexLine(1);
    return n;
  }

  /* ---------------------------- queries ----------------------------- */

  /**
   * Nearest point on the midline.  Returns null beyond `MAX_QUERY`, which
   * is the caller's cue that this vertex is bare land and needs no further
   * work -- most of them are.
   *
   * **This measures to the curve, not to the chords.**
   *
   * `sampleAt` has always drawn the road as the quadratic through each
   * node's control point -- that is what `furniture` lines up against and
   * what the camera follows.  `nearest` measured to the straight line
   * between node centres, and *this* is the function the road is painted
   * with: `Terrain.roadUV` and `heightAt` are per-vertex `nearest` calls,
   * and the shader paints tarmac wherever `|u| < CARRIAGEWAY`.  So the
   * visible carriageway was the chord polygon, however smooth the curve
   * underneath it was.
   *
   * On a straight that is exact.  In a corner it is not, and the tracer's
   * corners are tight: `TURN` is 0.463 rad per 10 m node and the redirect
   * blends push the sharpest ones past 0.69, a 14 m radius, so consecutive
   * chords meet at up to 40 degrees.  The chord then sags `STEP^2 / 8R`
   * off the curve -- 0.85 m measured over a 3 km trace, a fifth of the
   * 4.3 m half-width, once every ten metres.  That is the faceting: the
   * painted edge is the offset of a polygon, and it kinks at every node.
   *
   * The fix is a projected Newton refinement of the winning segment's
   * parameter against the quadratic, seeded from the chord's `t`.  The
   * curve is never far from its chord so it converges in two or three
   * steps, and it is skipped outright on segments straight enough for the
   * chord to be within a couple of centimetres -- well under the 1 m
   * vertex spacing the field is sampled at -- which is most of them.
   * Worst-case error against a densely-sampled ground truth, over the
   * thirty sharpest corners of that trace: 0.85 m before, 0.06 m after,
   * with the median at zero and the cost about 20 % of a `nearest` call.
   */
  nearest(x, z, out) {
    const arr = this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!arr || arr.length === 0) return null;
    let bd = Infinity, bi = -1, bt = 0;

    let bLine = null;
    for (let a = 0; a < arr.length; a++) {
      const tag = arr[a];
      const line = this.lines[tag & 1];
      const i = tag >> 1;
      const ns = line.nodes;
      const n0 = ns[i], n1 = ns[i + 1];
      if (!n1) continue;
      const ex = n1.x - n0.x, ez = n1.z - n0.z;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 0 ? ((x - n0.x) * ex + (z - n0.z) * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (n0.x + ex * t), dz = z - (n0.z + ez * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; bi = i; bt = t; bLine = line; }
    }
    if (bi < 0) return null;
    if (Math.sqrt(bd) > MAX_QUERY + CHORD_SAG) return null;

    /* Refine against the curve.  The winner's neighbours are tried only
     * when the chord's foot landed on a shared node, which is the one case
     * where the curve can pull the closest point into the next segment --
     * the outside of a corner, and the crease on its inside. */
    const ns = bLine.nodes;
    const best = _hit;
    best.d2 = Infinity;
    curveFoot(ns, bi, bt, x, z, best);
    if (bt < 0.15 && bi > 0) curveFoot(ns, bi - 1, 1, x, z, best);
    if (bt > 0.85 && bi + 2 < ns.length) curveFoot(ns, bi + 1, 0, x, z, best);

    const d = Math.sqrt(best.d2);
    if (d > MAX_QUERY) return null;
    const i = best.i, t = best.t;

    /* Which way this segment runs in the signed coordinate: the backward
     * line's node 1 is at s = -STEP, so its arc positions and its lateral
     * sign are both mirrored. */
    const back = bLine !== this.mid;
    const n0 = ns[i], n1 = ns[i + 1];
    const o = out || {};
    o.d = d;
    /* Signed lateral offset, which the ground shader needs: |d| tells it
     * how far from the road a fragment is, but not which side, and the
     * carriageway is not symmetric about its own centre once there are
     * lane markings on it.  Across the curve's own tangent, so the sign
     * flips where the curve is, not where the chord was. */
    {
      const el = Math.hypot(best.tx, best.tz) || 1;
      o.u = ((x - best.x) * -best.tz + (z - best.z) * best.tx) / el;
      /* The backward line's tangent points the other way, so left and
       * right swap with it.  `groundmat.js` paints the carriageway from
       * this sign, and a road whose lane markings mirror at the origin is
       * the one visible tell a signed coordinate can leave. */
      if (back) o.u = -o.u;
    }
    /* The foot itself, which `Terrain.heightAt` needs to know which way
     * *outward* is -- the direction the earthwork daylights along, and so
     * the direction the hillside's own slope has to be measured in.  It is
     * already computed for `o.u` above. */
    o.px = best.x; o.pz = best.z;
    o.s = back ? -(i + t) * STEP : (i + t) * STEP;
    o.y = n0.y + (n1.y - n0.y) * t;
    o.g = n0.g + (n1.g - n0.g) * t;
    o.gfa = n0.gfa + (n1.gfa - n0.gfa) * t;
    o.node = n0;
    return o;
  }

  /**
   * Roughly how far the road is, out to `max` metres.  Rings outward from
   * the query cell and stops as soon as a further ring could not beat what
   * has already been found, so a point on the road costs one cell and a
   * point in the middle of nowhere costs the whole disc -- which is the
   * right way round, because most queries are near the road.
   */
  roughDistance(x, z, max = 1200) {
    const cx = Math.floor(x / COARSE), cz = Math.floor(z / COARSE);
    let best = Infinity;
    const maxRing = Math.ceil(max / COARSE) + 1;
    for (let r = 0; r <= maxRing; r++) {
      // anything in ring r is at least (r-1)*COARSE away
      if (best < (r - 1) * COARSE) break;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const arr = this.coarse.get(key(cx + dx, cz + dz));
          if (!arr) continue;
          for (let a = 0; a < arr.length; a++) {
            const n = this._at(arr[a]);
            if (!n) continue;
            const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
            if (d2 < best * best) best = Math.sqrt(d2);
          }
        }
      }
    }
    return best;
  }

  /**
   * Point and frame at arc position `s`.  The curve between nodes is the
   * quadratic through the tracer's control point, not the chord -- a road
   * drawn as 10 m straights reads as a polygon at speed.
   */
  sampleAt(s, out) {
    /* Which line, and where in it.  The sign of `s` is the whole of it:
     * the backward line's node k is at s = -k * STEP, and its tangent
     * points away from the origin, so everything directional is negated on
     * the way out.  At s = 0 both lines give the same point and the
     * negation makes their tangents agree, so the join is continuous by
     * construction rather than by a special case. */
    const back = s < 0;
    const line = back ? this.back : this.mid;
    const nodes = line.nodes;
    const f = (back ? -s : s) / STEP;
    let i = Math.floor(f);
    if (i < 0) i = 0;
    if (i > nodes.length - 2) i = nodes.length - 2;
    const t = Math.max(0, Math.min(1, f - i));
    const n0 = nodes[i], n1 = nodes[i + 1];
    const u = 1 - t;

    // quadratic Bezier P0 = n0, control = n0.c, P1 = n1
    const x = u * u * n0.x + 2 * u * t * n0.cx + t * t * n1.x;
    const z = u * u * n0.z + 2 * u * t * n0.cz + t * t * n1.z;
    const y = n0.y + (n1.y - n0.y) * t;

    // derivative for the tangent
    let tx = 2 * u * (n0.cx - n0.x) + 2 * t * (n1.x - n0.cx);
    let tz = 2 * u * (n0.cz - n0.z) + 2 * t * (n1.z - n0.cz);
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;

    const o = out || {};
    o.x = x; o.y = y; o.z = z;
    if (back) { tx = -tx; tz = -tz; }
    o.tx = tx; o.tz = tz;
    o.rx = -tz; o.rz = tx;
    o.a = Math.atan2(tz, tx);
    // signed curvature from the turn taken at this node, 1/m
    o.k = back ? -n0.da / STEP : n0.da / STEP;
    o.grade = (back ? -(n1.y - n0.y) : (n1.y - n0.y)) / STEP;
    o.i = back ? -i : i;
    return o;
  }
}
