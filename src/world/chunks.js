import * as THREE from 'three';
import { groundMaterial } from './groundmat.js';
import { ROAD_OFF, ROAD_QUERY, WATER_LEVEL } from './terrain.js';
import { cel } from '../core/toon.js';

/* ------------------------------------------------------------------ *
 * The ground, in chunks.
 *
 * A square grid in world XZ, and the thing worth knowing about it is
 * where the resolution comes from: **distance to the road's midline, and
 * distance to the car, whichever is finer**.
 *
 * The midline half came first, and it was right on its own
 * for as long as the camera was always *on* the road: lateral offset from
 * the midline is a stable proxy for how much of the screen a chunk will
 * ever occupy, and unlike camera distance it does not change as you drive,
 * so a chunk could be built once and never revisited.  Both halves of that
 * stopped being true in the same iteration -- the car can leave the road
 * now, and the tracer can delete road it has already laid -- so chunks are
 * rebuildable, and `_relod` decides when.
 *
 * The loaded set is an ellipse pointing up the road rather than a circle
 * around the car, because at 30 m/s the budget belongs on land about to
 * be seen and not on land already passed.
 *
 * Nothing allocates in the steady state: geometries are pooled by
 * resolution and rewritten in place, and the build is a generator the
 * frame loop drains against a millisecond budget.
 * ------------------------------------------------------------------ */

export const CHUNK = 128;

/** Vertex spacing by distance from the midline, metres. */
/* Widened once measuring LOD from the nearest chunk *corner* rather than
 * its centre, which correctly pulls a lot of chunks a band finer and, at
 * the old thresholds, quadrupled the vertex count of everything within
 * half a kilometre of the road. */
const LOD = [
  { within: 95, step: 1 },
  { within: 230, step: 2 },
  { within: 500, step: 4 },
  { within: 820, step: 8 },
  { within: Infinity, step: 16 },
];

/**
 * Vertex spacing by distance from *the car*, which is a different question
 * from distance to the road and only became one when the car was allowed
 * to leave the road.
 *
 * The header above explains why midline distance is the right key: the
 * camera is always on the road, so lateral offset is a stable proxy for
 * screen area and a chunk can be built once and never revisited.  The
 * first half of that stopped being true the moment there was a physics
 * engine and no fence -- five hundred metres out the ground was 8 m
 * spacing, which is a low-poly ramp to look at and, far worse, to drive
 * on, because the collider is built from these same heights.
 *
 * So resolution is now the finer of the two bands.  The car ring is
 * tighter than the road corridor because it follows a point rather than a
 * line: 72 m of 1 m ground is about nine chunks, and when the car is on
 * the road -- which is most of the time -- it costs nothing at all,
 * because the corridor already had them.
 */
const CAR_LOD = [
  { within: 72, step: 1 },
  { within: 160, step: 2 },
  { within: 340, step: 4 },
  { within: 700, step: 8 },
  { within: Infinity, step: 16 },
];

/**
 * The *coarsest* spacing allowed at a distance from the car, and the
 * reverse of the two tables above: those say how fine a chunk must be,
 * this says how fine it is allowed to stay.
 *
 * Without it the road corridor was 1 m for as far as the road was traced
 * -- 63 chunks and 2.06 million of the frame's 2.2 million triangles on
 * `?seed=country`, most of them a kilometre or more down the road, where a
 * 1 m triangle is a fraction of a pixel.  Sub-pixel triangles are the
 * worst case a GPU has: every one of them shades a full 2x2 block for the
 * derivatives, so the ground's fifteen-tap texture body ran several times
 * per pixel of distant hillside, each tap at 16x anisotropic.  Measured on
 * an Intel HD 630 with the 1 m chunks hidden, the scene pass went from 42
 * to 15 ms.
 *
 * The corridor half of the header's argument still holds -- a chunk with
 * the road in it must not be built so coarse that the carriageway falls
 * between two vertices -- so the cap stops at 4 m, which keeps two
 * vertices across the tarmac.  Chunks refine as the car approaches, and
 * the extra builds are cheap: a chunk is built at 4, 2 and then 1 m, and
 * the two coarse builds together cost 5/16 of the fine one.
 *
 * Per quality tier, from `core/quality.js`.  Distances are to the nearest
 * point of the chunk, like `CAR_LOD`, and the 1 m band is always wider
 * than `CAR_LOD`'s so the physics colliders near the car are unchanged.
 */
export const FAR_LOD = {
  high: [
    { within: 420, step: 1 },
    { within: 820, step: 2 },
    { within: Infinity, step: 4 },
  ],
  medium: [
    { within: 200, step: 1 },
    { within: 460, step: 2 },
    { within: Infinity, step: 4 },
  ],
  low: [
    { within: 150, step: 1 },
    { within: 340, step: 2 },
    { within: Infinity, step: 4 },
  ],
};

/**
 * How wide the road corridor is, for the diagnostic in `_lodFor`.
 *
 * Narrow on purpose.  This was 160, and 160 m of 1 m ground either side of
 * a winding road across the whole loaded ellipse is about a million
 * vertices -- which is the case `FAR_LOD` exists to prevent, measured at
 * 42 ms of scene pass on an HD 630, and the chunk builder never caught up
 * with it inside a probe's settle.  The road's own query radius is 26 m
 * and the verge lines live inside that, so a chunk within 48 m of the
 * midline is every chunk the question is about.
 */
const CORRIDOR = 48;

/**
 * The queue's three classes, and why the order is what it is.
 *
 * `MISSING` is ground that does not exist: a hole, and under the car a
 * fall.  `FIX` is ground that exists and is wrong -- a road that moved, a
 * resolution the car or the physics needs, a seam to restitch -- which is
 * a picture or a collider that is off, but is there.  `SAVE` is ground
 * that is finer than it need be, which costs frame time and nothing else.
 *
 * The queue used to be sorted on a signed distance, `-2` for an
 * invalidation and `-1` for an urgent rebuild, so both classes of *fix*
 * went ahead of every missing chunk; and a missing chunk's distance was
 * the one it had when it was requested, 2 km out at the front of the
 * field, and was never updated as the car drove toward it.  On a fast
 * CPU the queue is short and neither mattered.  At a 6x CPU throttle
 * (`perf-bench/void.mjs`) the queue grew without bound, `live` drained
 * from 427 chunks to 50, and the car drove off the edge of the built
 * world six times in five minutes.
 *
 * Now the order is recomputed every frame from where the car *is*: the
 * key is the distance to the car, plus `FIX_BIAS` for a fix, so a hole
 * within 150 m of the car's current distance outranks a fix, and a
 * saving goes last.
 */
const MISSING = 0, FIX = 1, SAVE = 2;
const FIX_BIAS = 150;
/** A missing chunk nearer than this is built at 4 m first -- a sixth of
 *  the time of a 1 m chunk, even after `_build` got cheaper -- and
 *  refined through `_relod` like any other.  Only near: further out
 *  `FAR_LOD` already starts everything at 4 m. */
const COARSE_FIRST = 420;
/** While a chunk this near is missing, the build budget goes up.  A
 *  dropped frame is a better outcome than a fall. */
const HOLE_NEAR = 260;
const HOLE_BUDGET = 12;
/** Seams mended per frame.  Each is four edge rows of `heightAt` -- about
 *  0.7 ms for a 1 m chunk on this machine -- so a handful is a small,
 *  steady cost, and the rest wait a frame. */
const RESTITCH_PER_FRAME = 3;

function bandFor(table, dist) {
  for (const b of table) if (dist < b.within) return b.step;
  return 16;
}

function lodFor(dist) { return bandFor(LOD, dist); }

/**
 * A cell's identity, for any map keyed by chunk coordinates.  See the note
 * on `ChunkField.key`: this is a bijection and the thing it replaced was
 * not, which cost thirteen per cent of the ground near the world origin.
 * `Scatter` keys its own field the same way and had the same bug.
 */
export function cellKey(ix, iz) { return (ix + 0x100000) * 0x200000 + (iz + 0x100000); }

const _v = new THREE.Vector3();
const _scratch = {};

export class ChunkField {
  constructor(scene, terrain, road, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.road = road;
    this.radius = opts.radius ?? 620;
    this.forward = opts.forward ?? 1.6;
    this.budgetMs = opts.budgetMs ?? 4;
    /** The coarsest spacing allowed by distance from the car.  See `FAR_LOD`. */
    this.farLod = opts.farLod ?? FAR_LOD.high;
    /** Diagnostic: pin the corridor's spacing.  See `_lodFor`. */
    this.corridorStep = opts.corridorStep ?? null;
    /* Road distance for cells that are not live, for `_neighbourStep`.
     * See `_relod`. */
    this._roadDistCache = new Map();

    this.live = new Map();      // key -> chunk
    this.pool = new Map();      // step -> [geometry]
    this.queue = [];            // chunks waiting to be built
    /* Keys that are queued or half-built.
     *
     * Building a chunk is a generator, so between taking its geometry from
     * the pool and putting the finished mesh into `live` it exists in
     * neither -- and `update()`, running in that gap, saw a wanted chunk
     * that was not live and queued it a second time.  Both builds ran, both
     * called `live.set` on the same key, and the loser's mesh stayed in the
     * scene for ever holding a geometry the pool went on to hand to
     * somebody else.  That is one chunk drawn with another chunk's
     * vertices, and it is why whole hillsides came out missing after
     * several jumps while the chunk count looked perfectly healthy. */
    this.pending = new Set();
    this.building = null;
    this.material = groundMaterial();
    /* Water is drawn per chunk, from the same lattice as the ground, and
     * only over the parts of it that are actually below the surface.  It
     * was one 9 km plane at y = 2 that followed the car -- which is not a
     * body of water held by the shape of the land, it is a sheet of glass
     * laid over the world, and every hole in the ground showed it through.
     * Vertex colours carry depth, so shallow water is pale and a deep
     * basin is not. */
    this.waterMat = cel({
      vertexColors: true, transparent: true, opacity: 0.86,
      roughness: 0.25, metalness: 0.1, bands: 2, cache: false,
    });
    this.waterMat.depthWrite = false;
    this.wpool = new Map();
    this.built = 0;
    /** Times the chunk under the car had to be built on the spot. */
    this.rescued = 0;
    /** Missing chunks near the car, as of the last `_prioritise`. */
    this.holeNear = 0;
    this.buildTimes = {};
    /** Rebuilds queued by `_relod`, by reason.  Diagnostic. */
    this.reasons = {};
    this._buildMs = 0;
    this._lastStep = 0;
    this.drainMs = 0;
    this.recycled = 0;
    this.relodded = 0;
    this.invalidated = 0;
    /** The chunk whose build is in flight, so an invalidation can find it. */
    this.buildingAt = null;
    /** Chunks invalidated while their build was already under way.  See
     *  `invalidate` -- without this, one in flight silently keeps its
     *  stale ground for the rest of its life. */
    this.stale = new Set();

    /** Where the car is, for the car-distance LOD band.  Set by `update`. */
    this.cx = 0;
    this.cz = 0;
    /** Rolling cursor over `live`, for the road-distance re-check. */
    this._scan = 0;
    /** Heights kept per chunk for the physics colliders, pooled by step. */
    this.hpool = new Map();
    /** Anyone who needs to know a chunk's geometry changed (physics). */
    this.onChunk = null;
    this.onRetire = null;
  }

  /**
   * The identity of a chunk.  A *bijection*, and it has to be.
   *
   * This was `ix * 73856093 ^ iz * 19349663` -- a spatial hash, borrowed
   * from the one in `spline.js` where it is correct because that grid puts
   * a *list* in every bucket and compares the contents.  Here the value is
   * the chunk's identity in `live`, in `pending` and in `_retire`, and the
   * hash collides: `key(ix, iz) === key(-ix, -iz)` whenever the two have
   * the same parity, which is half of all mirrored pairs.
   *
   * A cell only collides when its mirror is *also* loaded, so the damage
   * is confined to about 1.4 km of the world origin -- which is where
   * every run starts, and where the capture harness's `jumpTo` lands.
   * Measured on a plain drive 300 m from the start: 42 of 329 wanted cells
   * (13 %) resolved to a different cell's chunk.  The second build
   * overwrote the first, one of the two cells ended up with no mesh at
   * all, and `live.has(k)` answered `true` for it -- so every consistency
   * check in this file said the field was healthy while the player drove
   * over a hole with the water plane showing through it.
   *
   * That is, with high confidence, the "teleport corruption" that
   * `reset()` below was written to paper over.  It was never about
   * teleporting; it was about being near the origin.
   *
   * Ranges: |ix| and |iz| below 2^20, so +/- 134 million metres.
   */
  static key(ix, iz) { return cellKey(ix, iz); }

  /**
   * How far ahead of the car this field will ask for ground, in metres.
   *
   * The road has to be traced at least this far or chunks get built where
   * there is no road yet -- and because resolution used to be chosen once
   * and never revisited, those chunks stayed roadless for as long as they
   * lived.  `main.js` extended 1600 m while this reached 2380, so there
   * was a 780 m band of ground that was permanently wrong, and the car
   * drove through all of it.  Chunks are rebuildable now (`_relod`), but
   * leading the field is still the cheap half of the fix: a rebuild costs
   * a chunk, and not needing one costs nothing.
   */
  reach() { return this.radius * (1 + this.forward); }

  /**
   * What vertex spacing a chunk will be built at.  Measured from the
   * *nearest* of its centre and its four corners, not its centre alone: a
   * chunk the road only clips a corner of is still a chunk with a road in
   * it, and building that at 8 m spacing puts the carriageway between two
   * vertices.
   */
  _lodFor(ox, oz, dRoad = this._roadDist(ox, oz)) {
    const step = this._capLod(Math.min(lodFor(dRoad), this._carLod(ox, oz)), ox, oz);
    /* The diagnostic override, and it is *only* a diagnostic -- `?lod=1`.
     *
     * The creases on the verge reach the screen as a slope break of
     * `curvature x vertex spacing`, so a crease that is under the ink's
     * knee where the corridor is meshed at 1 m is twice over it at 2 m and
     * four times at 4 m, and `FAR_LOD` steps the corridor to 2 m and then
     * to 4 m as the ground gets further from the car.  That gives two
     * quite different explanations for why `ref/prompt_3_1.png` is clean
     * in the near field and streaked in the middle distance, and they want
     * different fixes.  Pinning the corridor's spacing is what separates
     * them: if the streaks do not move, the lattice is not the multiplier.
     *
     * Kept out of the frame-time path -- one comparison against a field
     * that is null on every ordinary run.  See `ai/plan_3.md` A0. */
    if (this.corridorStep && dRoad < CORRIDOR) {
      return Math.min(step, this.corridorStep);
    }
    return step;
  }

  /** `step`, made no finer than `FAR_LOD` allows.  `scale` as `_carLod`. */
  _capLod(step, ox, oz, scale = 1) {
    return Math.max(step, bandFor(this.farLod, this._carDist(ox, oz) * scale));
  }

  /** Distance from a chunk to the midline, from its nearest corner or centre. */
  _roadDist(ox, oz) {
    const h = CHUNK / 2;
    let best = Infinity;
    for (const [dx, dz] of [[h, h], [0, 0], [0, CHUNK], [CHUNK, 0], [CHUNK, CHUNK]]) {
      const d = this.road.roughDistance(ox + dx, oz + dz, 1200);
      if (d < best) best = d;
    }
    return best;
  }

  /** Distance from a chunk to the car -- zero inside it, exact outside. */
  _carDist(ox, oz) {
    const dx = Math.max(ox - this.cx, 0, this.cx - (ox + CHUNK));
    const dz = Math.max(oz - this.cz, 0, this.cz - (oz + CHUNK));
    return Math.hypot(dx, dz);
  }

  /** `scale` < 1 makes coarsening hang back -- see `_relod`. */
  _carLod(ox, oz, scale = 1) {
    return bandFor(CAR_LOD, this._carDist(ox, oz) * scale);
  }

  /* ------------------------------ geometry ----------------------------- */

  _take(step) {
    /* Pooling was suspected of the teleport corruption and cleared: with
     * reuse disabled the fault survived unchanged, and `reset()` below is
     * what actually fixed it.  So the pool stays -- nothing allocating in
     * the steady state is the property that keeps a two-hour drive from
     * sawtoothing, and it was innocent. */
    const list = this.pool.get(step);
    if (list && list.length) return list.pop();
    const n = CHUNK / step;              // cells per side
    const w = n + 1;                     // vertices per side
    /* The grid, then a skirt: one more vertex under each edge vertex.
     * See `writeSkirt`. */
    const nv = w * w + 4 * w;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setAttribute('roadU', new THREE.BufferAttribute(new Float32Array(nv), 1));
    /* The mask, as a magnitude, and separate from the signed offset above
     * for the reason `terrain.js` gives at `ROAD_QUERY`.  Added here as
     * well as written in `_build` because geometries are *pooled*: a
     * recycled chunk missing the attribute reads zeros, and zero means
     * "you are on the carriageway", which would paint the whole chunk. */
    geo.setAttribute('roadA', new THREE.BufferAttribute(new Float32Array(nv), 1));
    geo.setAttribute('roadS', new THREE.BufferAttribute(new Float32Array(nv), 1));
    geo.setAttribute('curv', new THREE.BufferAttribute(new Float32Array(nv), 1));
    const idx = new Uint32Array(n * n * 6 + 4 * n * 12);
    let o = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    /* The skirt, both windings: the ground material is front-faced, and a
     * crack can be looked into from either chunk's side. */
    for (let e = 0; e < 4; e++) {
      for (let t = 0; t < n; t++) {
        const a = edgeIndex(w, e, t), b = edgeIndex(w, e, t + 1);
        const c = w * w + e * w + t, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
        idx[o++] = a; idx[o++] = b; idx[o++] = c;
        idx[o++] = b; idx[o++] = d; idx[o++] = c;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.userData.step = step;
    geo.userData.w = w;
    return geo;
  }

  _give(geo) {
    const step = geo.userData.step;
    let list = this.pool.get(step);
    if (!list) { list = []; this.pool.set(step, list); }
    if (list.length < 24) list.push(geo);
    else geo.dispose();
  }

  /**
   * The heights, kept rather than dropped.
   *
   * `_build` used to allocate this as a local and let it go once the
   * positions were written, which was right when nothing else wanted it.
   * The physics colliders want it: a heightfield collider has to be built
   * from *the same numbers the mesh was built from*, stitched edges
   * included, or the car rides a surface a metre or two from the one on
   * screen -- which is the bug this whole iteration is about, reintroduced
   * by the fix for it.  66 KB per 1 m chunk, pooled like the geometry.
   */
  _takeHeights(step, n) {
    const list = this.hpool.get(step);
    if (list && list.length) return list.pop();
    return new Float32Array(n);
  }

  /**
   * Re-stitch a chunk to neighbours that have changed resolution, in
   * place.
   *
   * `_relod` used to rebuild the whole chunk for this, and it was most of
   * the rebuilding there was: in a minute of driving at a 6x CPU throttle,
   * 142 of 220 rebuilds were seams, each one a 1 m or 2 m chunk rebuilt
   * from nothing -- 135 ms of main thread for the 1 m ones -- because the
   * chunk *next door* had been refined.  All that changes is the edge.
   *
   * So: put the four edge rows back to the terrain's own heights, stitch
   * them against the neighbours as they are now, exactly as `_build`
   * does, and rewrite the positions and normals of the two outer rings.
   * The base is rounded through a float the way `_build`'s grid rounds
   * it, so an unstitched edge comes out bit-identical to the neighbour's
   * copy of the same edge.  Water is left alone: an edge row moves by
   * centimetres, and a water mesh that is a row out at a shoreline is not
   * a crack.  `rev` tells the physics its collider is stale.
   */
  _restitch(c) {
    const T = this.terrain;
    const { w, step, heights } = c;
    const ox = c.ix * CHUNK, oz = c.iz * CHUNK;
    const last = w - 1;
    const hAt = (x, z) => T.heightAt(x, z, Math.fround(T.hm.base(x, z)));
    for (let i = 0; i < w; i++) {
      heights[i] = hAt(ox + i * step, oz);
      heights[last * w + i] = hAt(ox + i * step, oz + last * step);
      heights[i * w] = hAt(ox, oz + i * step);
      heights[i * w + last] = hAt(ox + last * step, oz + i * step);
    }
    const nb = [
      this._stepOf(c.ix, c.iz - 1), this._stepOf(c.ix, c.iz + 1),
      this._stepOf(c.ix - 1, c.iz), this._stepOf(c.ix + 1, c.iz),
    ];
    stitchEdge(heights, w, step, nb[0], (i) => i, 1);
    stitchEdge(heights, w, step, nb[1], (i) => (w - 1) * w + i, 1);
    stitchEdge(heights, w, step, nb[2], (j) => j * w, w);
    stitchEdge(heights, w, step, nb[3], (j) => j * w + (w - 1), w);

    const geo = c.mesh.geometry;
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const ring = (i, j) => {
      const k = j * w + i;
      pos[k * 3 + 1] = heights[k];
      vertexNormal(T, heights, w, step, i, j, ox + i * step, oz + j * step, nor);
    };
    for (let i = 0; i < w; i++) {
      for (const j of [0, 1, last - 1, last]) ring(i, j);
      for (const j of [0, 1, last - 1, last]) ring(j, i);
    }
    writeSkirt(geo, w, step);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.computeBoundingSphere();
    c.nb = nb;
    c.rev = (c.rev || 0) + 1;
  }

  /** One scratch grid for `_build`'s landform samples.  One is enough:
   *  a single build is in flight at a time, in `_drain` and in `flush`. */
  _baseGrid(n) {
    if (!this._base || this._base.length < n) this._base = new Float32Array(n);
    return this._base;
  }

  _giveHeights(step, arr) {
    let list = this.hpool.get(step);
    if (!list) { list = []; this.hpool.set(step, list); }
    if (list.length < 24) list.push(arr);
  }

  /* ------------------------------ the set ------------------------------ */

  /** Decide which chunks should exist, given where the car is and is going. */
  update(px, pz, hx, hz, dt) {
    const r = this.radius;
    this.cx = px; this.cz = pz;
    const cx = Math.floor(px / CHUNK), cz = Math.floor(pz / CHUNK);
    const fwdR = r * (1 + this.forward);
    const backR = r * 0.55;
    const span = Math.ceil(fwdR / CHUNK) + 1;
    const wanted = new Set();

    /* An ellipse pointing up the road, not a circle around the car: at
     * 30 m/s the budget belongs on land about to be seen.  (The first
     * version wrote this as `d - forward*ahead > r`, which for forward > 1
     * is negative for everything in front of you and therefore culls
     * nothing -- 1058 chunks and 1058 draw calls.) */
    for (let j = -span; j <= span; j++) {
      for (let i = -span; i <= span; i++) {
        const ix = cx + i, iz = cz + j;
        const wx = (ix + 0.5) * CHUNK, wz = (iz + 0.5) * CHUNK;
        const dx = wx - px, dz = wz - pz;
        const along = dx * hx + dz * hz;
        const across = dx * hz - dz * hx;
        const la = along >= 0 ? along / fwdR : along / backR;
        const lc = across / r;
        if (la * la + lc * lc > 1) continue;
        const k = ChunkField.key(ix, iz);
        wanted.add(k);
        if (!this.live.has(k)) this._request(ix, iz);
      }
    }

    for (const [k, c] of this.live) {
      if (!wanted.has(k)) { this._retire(k, c); }
    }
    this.queue = this.queue.filter((q) => {
      if (wanted.has(q.k)) return true;
      this.pending.delete(q.k);
      return false;
    });
    this._relod();
    this._prioritise();
    this._ensureUnder(px, pz);
    this._drain();
  }

  /** Re-key the queue from where the car is now.  See `MISSING`. */
  _prioritise() {
    this.holeNear = 0;
    for (const q of this.queue) {
      const d = this._carDist(q.ix * CHUNK, q.iz * CHUNK);
      q.key = q.cls === SAVE ? 1e7 + d : q.cls === FIX ? d + FIX_BIAS : d;
      if (q.cls === MISSING && d < HOLE_NEAR) this.holeNear++;
    }
    this.queue.sort((a, b) => a.key - b.key);
  }

  /**
   * The chunk under the car exists, whatever the queue thinks.
   *
   * Everything above makes this rare.  This makes it impossible: if the
   * cell the car is in is not live, it is built now, at 4 m, in this
   * frame -- a few milliseconds even on a slow CPU, because 4 m is 1 089
   * vertices.  The physics picks it up on the next tick.  If the cell's
   * build is the one already in flight it is finished instead, since a
   * second build of the same key is the bug `pending` exists to prevent.
   */
  _ensureUnder(px, pz) {
    const ix = Math.floor(px / CHUNK), iz = Math.floor(pz / CHUNK);
    const k = ChunkField.key(ix, iz);
    if (this.live.has(k)) return;
    this.rescued++;
    if (this.building && this.buildingAt && this.buildingAt.k === k) {
      while (!this.building.next().done);
      this.building = null; this.buildingAt = null;
      return;
    }
    const i = this.queue.findIndex((q) => q.k === k);
    if (i >= 0) this.queue.splice(i, 1);
    this.pending.add(k);
    const gen = this._build(ix, iz, 4);
    while (!gen.next().done);
  }

  /**
   * Rebuild chunks whose resolution is no longer right.
   *
   * The old contract was "built once, at one resolution, and never rebuilt"
   * -- which is only sound if a chunk's LOD cannot change after it is
   * baked.  Two things now change it.  The car's own band moves with the
   * car, which is the whole point of `CAR_LOD`; and the road moves, because
   * the tracer *deletes nodes it has already laid* when a watchdog trips --
   * up to 2.7 km of them.  A chunk baked over ground the road has since
   * left holds a benched carriageway through an empty field, and the ground
   * where the road actually went is unbenched.
   *
   * Finer is applied at once, because it is a correctness fault: the road
   * or the car is there *now*.  Coarser hangs back by a quarter of the band
   * (`_carLod(.., 0.8)`), so a chunk sitting on a boundary does not
   * oscillate between two resolutions as the car idles across it.  Drawing
   * something finer than it needs to be costs frame time; drawing it
   * coarser than it needs to be costs the player a hole in the world.
   *
   * The road-distance half of the test is on a rolling cursor rather than
   * every chunk every frame: `roughDistance` rings outward from the query
   * cell and a chunk far from the road pays for the whole disc, so 400 of
   * them five times over is not a frame budget, it is the frame.  A slice
   * of 24 revisits the whole field about three times a second, which is
   * several seconds before anything the car can reach at 45 m/s.
   */
  _relod() {
    if (!this.live.size) return;
    const entries = [...this.live.values()];
    const slice = Math.min(entries.length, 24);

    /* Pass one: what resolution does each live chunk want now? */
    for (let n = 0; n < entries.length; n++) {
      const c = entries[n];
      const ox = c.ix * CHUNK, oz = c.iz * CHUNK;
      if (n >= this._scan && n < this._scan + slice) c.dRoad = this._roadDist(ox, oz);
      const roadStep = lodFor(c.dRoad);
      c.want = this._capLod(Math.min(roadStep, this._carLod(ox, oz)), ox, oz);
      /* The same hang-back on the far cap: `_capLod` at 0.8 of the distance
       * is never coarser than at 1.0, so `relax <= want` still holds and a
       * chunk between the two is left alone. */
      c.relax = this._capLod(Math.min(roadStep, this._carLod(ox, oz, 0.8)), ox, oz, 0.8);
    }
    this._scan += slice;
    if (this._scan >= entries.length) {
      this._scan = 0;
      /* The neighbour cache goes stale on the same cycle as `c.dRoad` does,
       * which is the staleness the live chunks already accept. */
      this._roadDistCache.clear();
    }

    /* Pass two: rebuild anything at the wrong resolution, or stitched to a
     * neighbour that has since changed its own. */
    let restitched = 0;
    for (const c of entries) {
      let why = 0, reason = '';
      if (c.want < c.step) { why = -1; reason = 'finer'; }          // correctness, urgent
      else if (c.relax > c.step) { why = 1; reason = 'coarser'; }   // a saving, can wait
      else if (c.nb) {
        for (let i = 0; i < 4; i++) {
          if (this._neighbourStep(c, i) !== c.nb[i]) { why = -1; reason = 'seam'; break; }
        }
      }
      if (!why) continue;
      const k = ChunkField.key(c.ix, c.iz);
      if (this.pending.has(k)) continue;
      /* A seam is one edge row, not a chunk.  See `_restitch`. */
      if (reason === 'seam' && restitched < RESTITCH_PER_FRAME) {
        this._restitch(c);
        restitched++;
        this.reasons.restitch = (this.reasons.restitch || 0) + 1;
        continue;
      }
      if (reason === 'seam') continue;
      this.pending.add(k);
      this.reasons[reason] = (this.reasons[reason] || 0) + 1;
      this.queue.push({ ix: c.ix, iz: c.iz, k, cls: why < 0 ? FIX : SAVE });
      this.relodded++;
    }
  }

  /** A neighbour's current resolution.  See `_stepOf`. */
  _neighbourStep(c, i) {
    const dx = i === 2 ? -1 : i === 3 ? 1 : 0;
    const dz = i === 0 ? -1 : i === 1 ? 1 : 0;
    return this._stepOf(c.ix + dx, c.iz + dz);
  }

  /**
   * The resolution a cell's edge is drawn at: what it *is* if it is live,
   * what it will be built at if it is not.
   *
   * What it is, and not what it wants to be.  This returned `want` for a
   * live chunk, so a chunk was stitched to its neighbour's *next* mesh
   * for however long that neighbour's rebuild sat in the queue -- a seam
   * that did not match either side, for a frame on a fast CPU and for
   * seconds on a slow one.  `COARSE_FIRST` makes want and is differ on
   * purpose, so it had to stop.  And `_build` asked `_lodFor` for every
   * neighbour, live or not, which disagreed with this function whenever
   * a live chunk's own road distance and the cache's did.
   */
  _stepOf(ix, iz) {
    const n = this.live.get(ChunkField.key(ix, iz));
    if (n) return n.step;
    /* A cell that is not live has no `dRoad` of its own, and asking the
     * road for one is five ring searches -- for every edge of every chunk
     * on the rim of the field, every frame.  That was 40 % of the CPU
     * profile of a drive, so it is remembered until the next scan. */
    return this._lodFor(ix * CHUNK, iz * CHUNK, this._cellRoadDist(ix, iz));
  }

  /** `_roadDist` for a cell, remembered until the scan wraps.  See above. */
  _cellRoadDist(ix, iz) {
    const k = ChunkField.key(ix, iz);
    let d = this._roadDistCache.get(k);
    if (d === undefined) {
      d = this._roadDist(ix * CHUNK, iz * CHUNK);
      this._roadDistCache.set(k, d);
    }
    return d;
  }

  /**
   * Throw away every chunk overlapping a world-space box.
   *
   * The tracer's backtracking is the caller: it hands over the ground its
   * deleted nodes used to run through, and everything baked against that
   * road has to be baked again.  Rare -- 5.6 reverts per road in the sweep
   * -- and cheap when it happens, because the rebuild goes through the same
   * queue and budget as everything else.
   */
  invalidate(minX, minZ, maxX, maxZ) {
    /* The road moved, so every remembered distance to it may be wrong. */
    this._roadDistCache.clear();
    /* A chunk whose build is already under way cannot simply be queued
     * again -- `pending` would swallow the request, and the generator now
     * in flight is the one holding the stale heights.  So it is noted
     * here and re-queued the moment it finishes.  Rare, and the reason it
     * matters is that a chunk built *from* a road that arrived mid-build
     * is exactly the chunk the road is running through. */
    for (const [k, c] of this.live) {
      const ox = c.ix * CHUNK, oz = c.iz * CHUNK;
      if (ox > maxX || ox + CHUNK < minX || oz > maxZ || oz + CHUNK < minZ) continue;
      if (this.pending.has(k)) { this.stale.add(k); continue; }
      /* Queued, not retired: the stale chunk keeps drawing until its
       * replacement is finished.  Retiring first would open a hole in the
       * ground for however long the build queue takes, which is trading a
       * wrong hillside for no hillside. */
      this.pending.add(k);
      this.queue.push({ ix: c.ix, iz: c.iz, k, cls: FIX });
      this.invalidated++;
    }
    /* And the one being built right now, if it is inside the box: it is
     * not in `live` yet, so the loop above cannot see it at all. */
    if (this.building && this.buildingAt) {
      const { ix, iz, k } = this.buildingAt;
      const ox = ix * CHUNK, oz = iz * CHUNK;
      if (!(ox > maxX || ox + CHUNK < minX || oz > maxZ || oz + CHUNK < minZ)) this.stale.add(k);
    }
  }

  _request(ix, iz) {
    const k = ChunkField.key(ix, iz);
    if (this.pending.has(k)) return;
    this.pending.add(k);
    this.queue.push({ ix, iz, k, cls: MISSING });
  }

  _retire(k, c) {
    if (this.onRetire) this.onRetire(c);
    this.scene.remove(c.mesh);
    if (c.water) { this.scene.remove(c.water); this._giveWater(c.water.geometry); }
    this._give(c.mesh.geometry);
    if (c.heights) this._giveHeights(c.step, c.heights);
    this.live.delete(k);
    this.pending.delete(k);
    this.recycled++;
  }

  /**
   * Throw the whole field away and start again.
   *
   * Teleporting the car -- which only the capture harness does -- leaves
   * the field in a state I have not been able to pin down: `live` holds
   * four hundred chunks with correct heights, correct mesh transforms and
   * correct bounding spheres, and the ground within a hundred metres of
   * the camera does not draw.  It survives disabling pooling, disabling
   * frustum culling, and rebuilding the road index.  A full reset clears
   * it every time.
   *
   * So this is a workaround at the one place a workaround is legitimate:
   * a jump is not something the game does, it is something the *camera
   * rig* does, and rebuilding the world after one is cheap and honest.
   * The bug is still there and still unexplained, and this is a
   * workaround, not a fix.
   */
  reset() {
    for (const [k, c] of this.live) {
      if (this.onRetire) this.onRetire(c);
      this.scene.remove(c.mesh);
      if (c.water) { this.scene.remove(c.water); c.water.geometry.dispose(); }
      c.mesh.geometry.dispose();
    }
    this.live.clear();
    this.pending.clear();
    this.stale.clear();
    this._roadDistCache.clear();
    this.queue.length = 0;
    this.building = null;
    this.buildingAt = null;
    this._scan = 0;
    for (const list of this.pool.values()) { for (const g of list) g.dispose(); }
    this.pool.clear();
    this.hpool.clear();
    for (const list of this.wpool.values()) { for (const g of list) g.dispose(); }
    this.wpool.clear();
  }

  /** Build everything outstanding, however long it takes.  Captures only. */
  flush(limit = 4000) {
    let n = 0;
    while ((this.queue.length || this.building) && n++ < limit) {
      if (!this.building) {
        const next = this.queue.shift();
        if (!next) break;
        this.buildingAt = next;
        this.building = this._build(next.ix, next.iz);
      }
      if (this.building.next().done) { this.building = null; this.buildingAt = null; }
    }
  }

  /** Spend at most `budgetMs` on construction, then stop mid-chunk. */
  _drain() {
    const t0 = performance.now();
    const budget = this.holeNear ? Math.max(this.budgetMs, HOLE_BUDGET) : this.budgetMs;
    while (performance.now() - t0 < budget) {
      if (!this.building) {
        const next = this.queue.shift();
        if (!next) break;
        this.buildingAt = next;
        const coarse = next.cls === MISSING &&
          this._carDist(next.ix * CHUNK, next.iz * CHUNK) < COARSE_FIRST ? 4 : 0;
        this.building = this._build(next.ix, next.iz, coarse);
        this._buildMs = 0;
      }
      const a = performance.now();
      const r = this.building.next();
      this._buildMs += performance.now() - a;
      if (r.done) {
        this.building = null; this.buildingAt = null;
        this._timed(this._lastStep, this._buildMs);
      }
    }
    this.drainMs = performance.now() - t0;
  }

  /** Main-thread milliseconds per chunk build, by step.  For `?debug`
   *  and `perf-bench/void.mjs`: the whole question on a slow CPU is how
   *  many of these a 4 ms slice can finish. */
  _timed(step, ms) {
    if (!step) return;
    const t = this.buildTimes[step] || (this.buildTimes[step] = { n: 0, ms: 0 });
    t.n++; t.ms += ms;
  }

  /** The live chunk under a world point, or undefined. */
  chunkAt(x, z) {
    return this.live.get(ChunkField.key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  }

  /* -------------------------------- water ------------------------------ */

  /**
   * The water surface over one chunk, or null if none of it is flooded.
   *
   * Built from the chunk's own heights, so the shoreline is exactly where
   * the drawn ground crosses the water level -- not where an infinite
   * plane happens to intersect whatever mesh is in front of it.  A quad is
   * kept only if all four of its corners are under water, which leaves the
   * surface a fraction *inside* the true shore; the ground shader's sand
   * band covers the difference and the alternative (keeping quads with any
   * corner under) puts water visibly up the beach.
   *
   * Vertex colour is depth: shallow water is pale and picks up the sand
   * under it, deep water goes to the colour a lake actually is from a
   * hillside above it.
   */
  _water(ox, oz, step, w, heights) {
    let any = false;
    for (let i = 0; i < heights.length; i++) {
      if (heights[i] < WATER_LEVEL) { any = true; break; }
    }
    if (!any) return null;

    const geo = this._takeWater(step, w);
    const pos = geo.attributes.position.array;
    const col = geo.attributes.color.array;
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        pos[k * 3] = i * step;
        pos[k * 3 + 1] = WATER_LEVEL;
        pos[k * 3 + 2] = j * step;
        const depth = Math.max(0, WATER_LEVEL - heights[k]);
        const t = Math.min(1, depth / 9);
        col[k * 3] = 0.30 - 0.19 * t;
        col[k * 3 + 1] = 0.47 - 0.24 * t;
        col[k * 3 + 2] = 0.55 - 0.16 * t;
      }
    }

    const idx = geo.index.array;
    const n = w - 1;
    let o = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        if (heights[a] >= WATER_LEVEL || heights[b] >= WATER_LEVEL ||
            heights[c] >= WATER_LEVEL || heights[d] >= WATER_LEVEL) continue;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    if (o === 0) { this._giveWater(geo); return null; }

    geo.setDrawRange(0, o);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.index.needsUpdate = true;
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, this.waterMat);
  }

  _takeWater(step, w) {
    const list = this.wpool.get(step);
    if (list && list.length) return list.pop();
    const n = w - 1;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(w * w * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(w * w * 3), 3));
    /* Normals, all straight up, and they are not optional: a lit material
     * with no normal attribute shades every fragment as if it faced
     * nowhere, and the lake comes out pure black.  Which it did. */
    const nor = new Float32Array(w * w * 3);
    for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(n * n * 6), 1));
    geo.userData.step = step;
    return geo;
  }

  _giveWater(geo) {
    const step = geo.userData.step;
    let list = this.wpool.get(step);
    if (!list) { list = []; this.wpool.set(step, list); }
    if (list.length < 12) list.push(geo);
    else geo.dispose();
  }

  /**
   * Build one chunk, yielding every few rows.  A 128 m chunk at 1 m
   * spacing is 16 641 vertices with four terrain samples each for the
   * normal; done in one go that is a visible hitch, and the whole point of
   * the frame budget is that it never is.
   */
  *_build(ix, iz, minStep = 0) {
    const T = this.terrain;
    const ox = ix * CHUNK, oz = iz * CHUNK;

    // resolution comes from the midline and from the car -- see `_lodFor`
    // -- unless the chunk is a hole being filled in a hurry (`COARSE_FIRST`)
    const step = Math.max(minStep, this._lodFor(ox, oz));
    const dRoad = this._roadDist(ox, oz);

    /* Neighbour resolutions, so the edges can be stitched.  A neighbour can
     * be asked what resolution it will be before it exists, because LOD is
     * a pure function of position -- which is what makes exact stitching
     * affordable here and fiddly in an engine whose LOD follows the camera.
     * It is no longer *fixed*, now that the car's band moves -- so the
     * chosen neighbour steps are kept on the chunk and `_relod` rebuilds
     * whenever one of them changes.  Without that the seam it was stitched
     * to would move out from under it and open a crack. */
    /* Through the same function `_neighbourStep` reads, so the two
     * agree: a fresh answer here against a remembered one there reads as
     * a neighbour that changed, and rebuilds this chunk every frame until
     * the cache turns over.
     *
     * Read at the *start* of a build that yields.  A neighbour rebuilt
     * while this one is in flight is caught by `_relod` on the next pass,
     * which compares these against `_neighbourStep`. */
    const nb = [
      this._stepOf(ix, iz - 1),   // -z
      this._stepOf(ix, iz + 1),   // +z
      this._stepOf(ix - 1, iz),   // -x
      this._stepOf(ix + 1, iz),   // +x
    ];

    this._lastStep = step;
    const geo = this._take(step);
    const w = geo.userData.w;
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const roadU = geo.attributes.roadU.array;
    const roadA = geo.attributes.roadA.array;
    const roadS = geo.attributes.roadS.array;
    const curv = geo.attributes.curv.array;

    /* The landform on a grid of its own, `m` vertices wider than the
     * chunk on every side, so the curvature's four neighbours are lookups
     * rather than four more samples of the noise.
     *
     * That was most of the cost of a fine chunk, and on a slow CPU the
     * cost of a fine chunk is the whole of `prompt_4.md`'s "my car would
     * fall into the void": measured at a 6x CPU throttle, a 1 m chunk was
     * 470 ms of main thread -- 62 % of it `curvatureAt`, five calls into
     * the noise per vertex -- and the 4 ms slice could not keep up with
     * the ground the car was driving onto.
     *
     * The curvature was a +/-5 m Laplacian and at 1 m it still is, exactly.
     * At 2 m the nearest the lattice has is +/-6 m, so it is taken there
     * and scaled by (5/6)^2, which is what a smooth field's Laplacian does
     * with distance.  Coarser than 2 m it is not carried at all, as
     * before. */
    const fine = step <= 2;
    const m = fine ? Math.round(5 / step) : 0;
    const bw = w + 2 * m;
    const base = this._baseGrid(bw * bw);
    for (let j = 0; j < bw; j++) {
      for (let i = 0; i < bw; i++) {
        base[j * bw + i] = T.hm.base(ox + (i - m) * step, oz + (j - m) * step);
      }
      if ((j & 15) === 0) yield;
    }
    const curvScale = fine ? 0.02 * (5 / (m * step)) ** 2 : 0;

    const heights = this._takeHeights(step, w * w);
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const x = ox + i * step, z = oz + j * step;
        const b = (j + m) * bw + (i + m);
        heights[k] = T.heightAt(x, z, base[b]);

        /* Where this vertex sits on the road, in road coordinates -- off
         * the query `heightAt` has just made for the same point, which is
         * the query `roadUV` would make.  See the second loop for what
         * each of the three is for. */
        const q = T.lastRoad;
        if (q && q.d <= ROAD_QUERY) {
          roadU[k] = q.u;
          roadA[k] = Math.min(q.d, ROAD_OFF);
          roadS[k] = q.s;
        } else {
          roadU[k] = ROAD_OFF;
          roadA[k] = ROAD_OFF;
          roadS[k] = 0;
        }
        curv[k] = fine
          ? curvScale * ((base[b - m] + base[b + m] + base[b - m * bw] + base[b + m * bw]) / 4 - base[b])
          : 0;
      }
      if ((j & 7) === 0) yield;
    }

    /* Snap each border row onto a coarser neighbour's lattice.  Without
     * this the two resolutions disagree between shared corners and the
     * seam opens into a crack you can see the sky through. */
    stitchEdge(heights, w, step, nb[0], (i) => i, 1);
    stitchEdge(heights, w, step, nb[1], (i) => (w - 1) * w + i, 1);
    stitchEdge(heights, w, step, nb[2], (j) => j * w, w);
    stitchEdge(heights, w, step, nb[3], (j) => j * w + (w - 1), w);
    yield;

    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const x = ox + i * step, z = oz + j * step;
        const y = heights[k];
        pos[k * 3] = i * step;
        pos[k * 3 + 1] = y;
        pos[k * 3 + 2] = j * step;

        vertexNormal(T, heights, w, step, i, j, x, z, nor);

        /* Where this vertex sits on the road, in road coordinates -- which
         * the first loop has already written, off `heightAt`'s own query.
         * The carriageway used to be a separate ribbon floating 9 cm over
         * the ground; it lost the depth test at close range and won it in
         * the distance, so the road appeared only beyond about eighty
         * metres.  Painted into the ground instead, it cannot z-fight with
         * a surface it *is*.
         *
         * `roadA`, the mask, and this is the one the shader reads.  Two reasons it
         * is a separate number rather than `abs( roadU )` in the shader:
         *
         * The signed offset crosses zero on any edge running from the left
         * of the road out past the query radius -- the sentinel is
         * positive -- and the shader dutifully paints a carriageway
         * wherever it does.  A distance cannot cross zero between two
         * vertices that are both off the road, whichever side of it, and
         * whichever of the two midlines each of them answered for.
         *
         * And it is `d`, the distance to the curve, not the lateral
         * offset.  The two agree wherever the nearest point is interior to
         * the line, which is almost everywhere -- but off the *end* of the
         * road they do not: a vertex twenty metres beyond the last node
         * traced so far sits on the tangent's extension, so its offset is
         * near zero while its distance is twenty metres.  Masking on the
         * offset paints a tongue of tarmac off the end of the road, which
         * is 1929 of the fabrications the probe still found after the sign
         * was dealt with.  Masking on distance ends the road in a rounded
         * cap at the last node, which is where it ends.
         *
         * `curv`, likewise written above, and only where it will be seen:
         * at 8 m spacing it would be a 40 m Laplacian, which is not the
         * quantity anyone wanted anyway. */
      }
      if ((j & 3) === 0) yield;
    }

    writeSkirt(geo, w, step);
    const water = this._water(ox, oz, step, w, heights);
    yield;

    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.roadU.needsUpdate = true;
    geo.attributes.roadA.needsUpdate = true;
    geo.attributes.roadS.needsUpdate = true;
    geo.attributes.curv.needsUpdate = true;
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(ox, 0, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.receiveShadow = true;
    /* **Last of the opaque world**, so the depth test throws away the ground
     * behind every tree, rail and the car before it is shaded, rather than
     * shading it and painting over it.  The ground is by far the most
     * expensive fragment in the frame, and three.js would otherwise draw it
     * first: opaque objects sort by material id before depth, and this
     * material is made before any of theirs.  Worth about 2 ms a frame on an
     * Intel HD 630 at 1080p, for an identical picture -- nothing opaque in
     * the scene skips its depth write except the sky dome, which is at
     * -1000 and still draws first. */
    mesh.renderOrder = 1;
    /**
     * **And the ground casts**, which it never did.
     *
     * `prompt_5.md` item 8 asks why the shadows do not move.  Half the
     * answer was the cascade (see `main.js`); the other half is that the
     * single largest and slowest-moving shadow in a real landscape did not
     * exist at all -- a ridge never shaded the valley behind it and a
     * cutting never put the road in shade at six o'clock.
     *
     * Only the two fine resolutions.  An 8 m or 16 m triangle is a
     * straight-line approximation to a hillside, and its shadow is a
     * faceted lie with hard diagonal edges where the real ground is
     * smooth -- worse than no shadow, and it would appear and disappear as
     * a chunk changed LOD, which is the one thing the LOD system is
     * supposed to be invisible about.
     */
    mesh.castShadow = step <= 2;
    const key = ChunkField.key(ix, iz);

    /* A rebuild replaces its predecessor here, at the last possible
     * moment, so the old ground is on screen until the new ground is ready
     * to take over.  The previous version of this line simply overwrote
     * the map entry, which left the old mesh in the scene for ever holding
     * a geometry the pool went on to hand to somebody else. */
    const old = this.live.get(key);
    if (old) this._retire(key, old);

    this.scene.add(mesh);
    if (water) {
      water.position.set(ox, 0, oz);
      water.matrixAutoUpdate = false;
      water.updateMatrix();
      water.renderOrder = 1;
      this.scene.add(water);
    }
    const chunk = { mesh, water, ix, iz, step, heights, w, dRoad, nb };
    this.live.set(key, chunk);
    this.pending.delete(key);
    /* Invalidated while it was being built: everything above was computed
     * against a road that has moved or arrived since, so go round again. */
    if (this.stale.delete(key)) {
      this.pending.add(key);
      this.queue.push({ ix, iz, k: key, cls: FIX });
      this.invalidated++;
    }
    this.built++;
    if (this.onChunk) this.onChunk(chunk);
  }
}

/**
 * The index of the `t`-th vertex along edge `e` of a `w`-wide grid, in the
 * order `stitchEdge` is called in: -z, +z, -x, +x.
 */
function edgeIndex(w, e, t) {
  return e === 0 ? t : e === 1 ? (w - 1) * w + t : e === 2 ? t * w : t * w + (w - 1);
}

/**
 * A skirt round the chunk: every edge vertex copied straight down.
 *
 * `prompt_4.md`: "the ground can still crack open from time to time, the
 * background color would show".  Stitching is exact only while both
 * sides of a seam agree about each other's resolution, and they cannot
 * always: a chunk is stitched to its neighbour as it is *when it is
 * built*, and the neighbour can be rebuilt before this one is restitched
 * -- a frame on a fast CPU, longer on a slow one, and for as long as the
 * queue is behind.  Every one of those windows is a sliver of sky.
 *
 * A skirt does not care why.  Each edge vertex has a twin `depth` metres
 * below it, with the same normal and the same road attributes, so the
 * strip between them shades as the edge does and fills any gap under it.
 * Where the seam is closed the skirt is under the neighbour's ground and
 * the depth test throws it away.  `depth` grows with the spacing because
 * the error a stitch can be out by does: it is the ground's departure
 * from a straight line over one of the coarser side's cells.
 *
 * The collider has no skirt -- it is built from `heights`, which this
 * never touches -- and neither does the water.
 */
function writeSkirt(geo, w, step) {
  const depth = 1 + 1.5 * step;
  const at = geo.attributes;
  const pos = at.position.array, nor = at.normal.array;
  const lists = [at.roadU.array, at.roadA.array, at.roadS.array, at.curv.array];
  for (let e = 0; e < 4; e++) {
    for (let t = 0; t < w; t++) {
      const k = edgeIndex(w, e, t), s = w * w + e * w + t;
      pos[s * 3] = pos[k * 3];
      pos[s * 3 + 1] = pos[k * 3 + 1] - depth;
      pos[s * 3 + 2] = pos[k * 3 + 2];
      nor[s * 3] = nor[k * 3]; nor[s * 3 + 1] = nor[k * 3 + 1]; nor[s * 3 + 2] = nor[k * 3 + 2];
      for (const a of lists) a[s] = a[k];
    }
  }
}

/** Normals from the height field itself, so chunk edges agree. */
function vertexNormal(T, heights, w, step, i, j, x, z, nor) {
  const k = j * w + i;
  const hl = i > 0 ? heights[k - 1] : T.heightAt(x - step, z);
  const hr = i < w - 1 ? heights[k + 1] : T.heightAt(x + step, z);
  const hd = j > 0 ? heights[k - w] : T.heightAt(x, z - step);
  const hu = j < w - 1 ? heights[k + w] : T.heightAt(x, z + step);
  _v.set(hl - hr, 2 * step, hd - hu).normalize();
  nor[k * 3] = _v.x; nor[k * 3 + 1] = _v.y; nor[k * 3 + 2] = _v.z;
}

/**
 * Replace a border row's heights with samples of the coarser neighbour's
 * lattice, linearly interpolated.  Only ever coarsens: the chunk with the
 * finer step gives way, so both sides agree without either having to know
 * the other's vertex data.
 */
function stitchEdge(heights, w, step, nbStep, indexOf, _stride) {
  if (!(nbStep > step)) return;
  const every = Math.round(nbStep / step);
  if (every < 2) return;
  const last = w - 1;
  for (let i = 0; i <= last; i++) {
    const lo = Math.floor(i / every) * every;
    const hi = Math.min(last, lo + every);
    if (lo === hi) continue;
    const t = (i - lo) / (hi - lo);
    const a = heights[indexOf(lo)], b = heights[indexOf(hi)];
    heights[indexOf(i)] = a + (b - a) * t;
  }
}
