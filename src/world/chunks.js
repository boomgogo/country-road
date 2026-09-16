import * as THREE from 'three';
import { groundMaterial } from './groundmat.js';
import { ROAD_OFF, WATER_LEVEL } from './terrain.js';
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
    return this._capLod(Math.min(lodFor(dRoad), this._carLod(ox, oz)), ox, oz);
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
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(w * w * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(w * w * 3), 3));
    geo.setAttribute('roadU', new THREE.BufferAttribute(new Float32Array(w * w), 1));
    /* The mask, as a magnitude, and separate from the signed offset above
     * for the reason `terrain.js` gives at `ROAD_QUERY`.  Added here as
     * well as written in `_build` because geometries are *pooled*: a
     * recycled chunk missing the attribute reads zeros, and zero means
     * "you are on the carriageway", which would paint the whole chunk. */
    geo.setAttribute('roadA', new THREE.BufferAttribute(new Float32Array(w * w), 1));
    geo.setAttribute('roadS', new THREE.BufferAttribute(new Float32Array(w * w), 1));
    geo.setAttribute('curv', new THREE.BufferAttribute(new Float32Array(w * w), 1));
    const idx = new Uint32Array(n * n * 6);
    let o = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
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
        if (!this.live.has(k)) this._request(ix, iz, Math.hypot(dx, dz));
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
    this.queue.sort((a, b) => a.d - b.d);
    this._drain();
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
    for (const c of entries) {
      let why = 0;
      if (c.want < c.step) why = -1;                       // correctness, urgent
      else if (c.relax > c.step) why = 1;                  // a saving, can wait
      else if (c.nb) {
        for (let i = 0; i < 4; i++) {
          if (this._neighbourStep(c, i) !== c.nb[i]) { why = -1; break; }
        }
      }
      if (!why) continue;
      const k = ChunkField.key(c.ix, c.iz);
      if (this.pending.has(k)) continue;
      this.pending.add(k);
      this.queue.push({
        ix: c.ix, iz: c.iz, k,
        d: why < 0 ? -1 : this._carDist(c.ix * CHUNK, c.iz * CHUNK),
      });
      this.relodded++;
    }
  }

  /** A neighbour's current resolution: its own answer if it is live, else ours. */
  _neighbourStep(c, i) {
    const dx = i === 2 ? -1 : i === 3 ? 1 : 0;
    const dz = i === 0 ? -1 : i === 1 ? 1 : 0;
    const n = this.live.get(ChunkField.key(c.ix + dx, c.iz + dz));
    if (n) return n.want !== undefined ? n.want : n.step;
    /* A cell that is not live has no `dRoad` of its own, and asking the
     * road for one is five ring searches -- for every edge of every chunk
     * on the rim of the field, every frame.  That was 40 % of the CPU
     * profile of a drive, so it is remembered until the next scan. */
    const ix = c.ix + dx, iz = c.iz + dz;
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
      this.queue.push({ ix: c.ix, iz: c.iz, k, d: -2 });
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

  _request(ix, iz, d) {
    const k = ChunkField.key(ix, iz);
    if (this.pending.has(k)) return;
    this.pending.add(k);
    this.queue.push({ ix, iz, d, k });
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
    while (performance.now() - t0 < this.budgetMs) {
      if (!this.building) {
        const next = this.queue.shift();
        if (!next) return;
        this.buildingAt = next;
        this.building = this._build(next.ix, next.iz);
      }
      const r = this.building.next();
      if (r.done) { this.building = null; this.buildingAt = null; }
    }
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
  *_build(ix, iz) {
    const T = this.terrain;
    const ox = ix * CHUNK, oz = iz * CHUNK;

    // resolution comes from the midline and from the car -- see `_lodFor`
    const step = this._lodFor(ox, oz);
    const dRoad = this._roadDist(ox, oz);

    /* Neighbour resolutions, so the edges can be stitched.  A neighbour can
     * be asked what resolution it will be before it exists, because LOD is
     * a pure function of position -- which is what makes exact stitching
     * affordable here and fiddly in an engine whose LOD follows the camera.
     * It is no longer *fixed*, now that the car's band moves -- so the
     * chosen neighbour steps are kept on the chunk and `_relod` rebuilds
     * whenever one of them changes.  Without that the seam it was stitched
     * to would move out from under it and open a crack. */
    /* Through the same cache `_neighbourStep` reads, so the two agree:
     * a fresh answer here against a remembered one there reads as a
     * neighbour that changed, and rebuilds this chunk every frame until
     * the cache turns over. */
    const nb = [
      this._lodFor(ox, oz - CHUNK, this._cellRoadDist(ix, iz - 1)),   // -z
      this._lodFor(ox, oz + CHUNK, this._cellRoadDist(ix, iz + 1)),   // +z
      this._lodFor(ox - CHUNK, oz, this._cellRoadDist(ix - 1, iz)),   // -x
      this._lodFor(ox + CHUNK, oz, this._cellRoadDist(ix + 1, iz)),   // +x
    ];

    const geo = this._take(step);
    const w = geo.userData.w;
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const roadU = geo.attributes.roadU.array;
    const roadA = geo.attributes.roadA.array;
    const roadS = geo.attributes.roadS.array;
    const curv = geo.attributes.curv.array;

    const heights = this._takeHeights(step, w * w);
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const x = ox + i * step, z = oz + j * step;
        heights[j * w + i] = T.heightAt(x, z);
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

        // normals from the height field itself, so chunk edges agree
        const hl = i > 0 ? heights[k - 1] : T.heightAt(x - step, z);
        const hr = i < w - 1 ? heights[k + 1] : T.heightAt(x + step, z);
        const hd = j > 0 ? heights[k - w] : T.heightAt(x, z - step);
        const hu = j < w - 1 ? heights[k + w] : T.heightAt(x, z + step);
        _v.set(hl - hr, 2 * step, hd - hu).normalize();
        nor[k * 3] = _v.x; nor[k * 3 + 1] = _v.y; nor[k * 3 + 2] = _v.z;

        /* Where this vertex sits on the road, in road coordinates.  The
         * carriageway used to be a separate ribbon floating 9 cm over the
         * ground; it lost the depth test at close range and won it in the
         * distance, so the road appeared only beyond about eighty metres.
         * Painted into the ground instead, it cannot z-fight with a
         * surface it *is*. */
        const q = T.roadUV(x, z);
        roadU[k] = q ? q.u : ROAD_OFF;
        /* The mask, and this is the one the shader reads.  Two reasons it
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
         * cap at the last node, which is where it ends. */
        roadA[k] = q ? Math.min(q.d, ROAD_OFF) : ROAD_OFF;
        roadS[k] = q ? q.s : 0;
        /* Curvature is only worth sampling where it will be seen.  Four
         * extra height calls per vertex triples the cost of a 1 m chunk,
         * and at 8 m spacing the result is a 40 m Laplacian, which is not
         * the quantity anyone wanted anyway. */
        curv[k] = step <= 2 ? T.curvatureAt(x, z) : 0;
      }
      if ((j & 3) === 0) yield;
    }

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
      this.queue.push({ ix, iz, k: key, d: -2 });
      this.invalidated++;
    }
    this.built++;
    if (this.onChunk) this.onChunk(chunk);
  }
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
