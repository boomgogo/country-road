import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK, ChunkField } from '../world/chunks.js';

/* ------------------------------------------------------------------ *
 * The physics world.
 *
 * One rule holds this file together, and everything else follows from
 * it: **a collider is built from the numbers the mesh was built from.**
 * Never from `terrain.heightAt`, never from a lattice of its own.  The
 * fault this whole iteration is about is a car standing on a surface
 * nobody can see -- the analytic height field, while the eye watched a
 * mesh that had sampled it at 8 m and interpolated between.  A physics
 * engine that samples the ground independently reproduces that exactly,
 * with more machinery and a wasm blob on top.  So the chunk keeps its
 * heights (`ChunkField._takeHeights`) and they come straight through
 * here into a heightfield collider.
 *
 * What has colliders, and how far out:
 *
 *   terrain    every live chunk within `radius`      the ground
 *   guardrail  every furniture batch within reach    *this is the fence*
 *   trees      trunks, close in only                 so off-road has cost
 *
 * The guardrail is the interesting one.  "The car should be able to drive
 * off the road when there's no fence" makes `Furniture`'s placement rule
 * -- rail where the land falls away from the verge -- into a gameplay
 * rule: it is now the thing that decides where the world lets you leave.
 * ------------------------------------------------------------------ */

let ready = false;

/** Load the wasm.  Must resolve before a `Physics` can be constructed. */
export async function initRapier() {
  if (!ready) { await RAPIER.init(); ready = true; }
  return RAPIER;
}

export { RAPIER };

/** Distance from a point to an axis-aligned box, zero inside it. */
function boxDist(x, z, minX, minZ, size) {
  const dx = Math.max(minX - x, 0, x - (minX + size));
  const dz = Math.max(minZ - z, 0, z - (minZ + size));
  return Math.hypot(dx, dz);
}

export class Physics {
  constructor(opts = {}) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    /* 120 Hz.  A raycast vehicle at 45 m/s moves 37 cm per 60 Hz step,
     * which is enough for a wheel to walk over the top of a kerb-sized
     * feature rather than hit it; and the film wants a step that divides
     * the recorder's 1/30 exactly. */
    this.world.timestep = 1 / 120;
    this.hz = 1 / 120;

    this.radius = opts.radius ?? 190;
    this.railRadius = opts.railRadius ?? 170;
    this.treeRadius = opts.treeRadius ?? 95;

    this.terrain = new Map();     // chunk key -> { collider, chunk }
    this.rails = new Map();       // furniture batch key -> { colliders, group }
    this.trees = new Map();       // scatter chunk key -> colliders

    this.acc = 0;
    this.steps = 0;
    this.stepMs = 0;
    /** The car, so ground queries can ignore it.  Set by `Vehicle`. */
    this.carBody = null;
  }

  /* ------------------------------- ground ------------------------------ */

  /**
   * Terrain colliders follow the chunk field.
   *
   * Identity, not just presence: a chunk that was rebuilt at a new
   * resolution is a *different object* under the same key, and its
   * collider has to be rebuilt with it or the car keeps driving on the
   * ground that used to be there.  That is the whole reason `_relod`
   * exists, and it would be quietly undone here by a `has()` test.
   */
  syncTerrain(chunks, x, z) {
    for (const [k, c] of chunks.live) {
      if (!c.heights) continue;
      if (boxDist(x, z, c.ix * CHUNK, c.iz * CHUNK, CHUNK) > this.radius) continue;
      const have = this.terrain.get(k);
      /* And revision: `ChunkField._restitch` rewrites a chunk's edge rows
       * in place, which is the same chunk with different heights. */
      if (have && have.chunk === c && have.rev === c.rev) continue;
      if (have) this.world.removeCollider(have.collider, false);
      this.terrain.set(k, { chunk: c, rev: c.rev, collider: this._heightfield(c) });
    }

    /* Drop what has gone out of range or out of existence.  The hysteresis
     * on the radius stops a chunk on the boundary being rebuilt every
     * frame as the car idles across the line. */
    for (const [k, e] of [...this.terrain]) {
      const c = chunks.live.get(k);
      const gone = !c || c !== e.chunk ||
        boxDist(x, z, e.chunk.ix * CHUNK, e.chunk.iz * CHUNK, CHUNK) > this.radius * 1.25;
      if (!gone) continue;
      this.world.removeCollider(e.collider, false);
      this.terrain.delete(k);
    }
  }

  _heightfield(c) {
    const n = c.w;
    /* Rapier wants the matrix column-major, and its rows run along z while
     * ours run along x -- so this is a transpose, and getting it wrong
     * gives a world that is mirrored about its diagonal and looks almost
     * right.  `probe()` below is the check that it is not. */
    const hf = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) hf[i * n + j] = c.heights[j * n + i];
    }
    const desc = RAPIER.ColliderDesc
      .heightfield(n - 1, n - 1, hf, { x: CHUNK, y: 1, z: CHUNK })
      .setTranslation(c.ix * CHUNK + CHUNK / 2, 0, c.iz * CHUNK + CHUNK / 2)
      .setFriction(1.0);
    return this.world.createCollider(desc);
  }

  /* ------------------------------ the fence ---------------------------- */

  /**
   * Armco, as a chain of thin boxes along each run.
   *
   * `Furniture` records the runs it drew; this walks them at the node
   * spacing and lays one cuboid per segment.  A rail is 70 cm of steel on
   * posts, so the collider is 70 cm tall and 12 cm thick and sits where
   * the drawn rail sits -- if these two ever disagree the player will find
   * it within a minute, because an invisible wall is the most conspicuous
   * bug a driving game can have.
   */
  syncRails(furniture, road, x, z) {
    for (const [k, entry] of furniture.live) {
      const runs = entry && entry.runs;
      if (!runs || !runs.length) continue;
      if (this.rails.has(k)) continue;
      if (Math.hypot(entry.cx - x, entry.cz - z) > this.railRadius) continue;
      const cols = [];
      const a = {}, b = {};
      for (const run of runs) {
        for (let s = run.sA; s < run.sB; s += RAIL_SEG) {
          const s2 = Math.min(run.sB, s + RAIL_SEG);
          road.sampleAt(s, a);
          road.sampleAt(s2, b);
          const ax = a.x + a.rx * run.u, az = a.z + a.rz * run.u;
          const bx = b.x + b.rx * run.u, bz = b.z + b.rz * run.u;
          const mx = (ax + bx) / 2, mz = (az + bz) / 2;
          const len = Math.hypot(bx - ax, bz - az);
          if (len < 0.2) continue;
          const y = (run.yAt ? run.yAt(s) : a.y) + RAIL_MID;
          const ang = Math.atan2(bz - az, bx - ax);
          cols.push(this.world.createCollider(
            RAPIER.ColliderDesc.cuboid(len / 2, RAIL_HALF_H, 0.06)
              .setTranslation(mx, y, mz)
              .setRotation(yawQuat(-ang))
              .setFriction(0.35)
              .setRestitution(0.1)));
        }
      }
      this.rails.set(k, cols);
    }

    for (const [k, cols] of [...this.rails]) {
      const entry = furniture.live.get(k);
      if (entry && Math.hypot(entry.cx - x, entry.cz - z) <= this.railRadius * 1.3) continue;
      for (const c of cols) this.world.removeCollider(c, false);
      this.rails.delete(k);
    }
  }

  /* -------------------------------- trees ------------------------------ */

  /**
   * Trunks, close in.  Not the canopy -- a tree you can drive the roof
   * under is right, and a cylinder per trunk is enough to make leaving
   * the road cost something.  95 m, because past that they are decoration
   * and the car cannot reach them before the ring moves.
   */
  syncTrees(scatter, x, z) {
    if (!scatter.trunks) return;
    for (const [k, list] of scatter.trunks) {
      if (this.trees.has(k) || !list.length) continue;
      const c0 = list.centre;
      if (c0 && Math.hypot(c0.x - x, c0.z - z) > this.treeRadius + CHUNK) continue;
      const cols = [];
      for (const t of list) {
        if (Math.hypot(t.x - x, t.z - z) > this.treeRadius) continue;
        cols.push(this.world.createCollider(
          RAPIER.ColliderDesc.cylinder(t.h / 2, t.r)
            .setTranslation(t.x, t.y + t.h / 2, t.z)
            .setFriction(0.6)));
      }
      if (cols.length) this.trees.set(k, cols);
    }

    for (const [k, cols] of [...this.trees]) {
      const list = scatter.trunks.get(k);
      const c0 = list && list.centre;
      if (list && c0 && Math.hypot(c0.x - x, c0.z - z) <= this.treeRadius + CHUNK * 1.5) continue;
      for (const c of cols) this.world.removeCollider(c, false);
      this.trees.delete(k);
    }
  }

  /* -------------------------------- time ------------------------------- */

  /**
   * Fixed step with an accumulator.  `before(h)` runs immediately ahead of
   * every substep, which is where the vehicle controller belongs -- its
   * wheel raycasts have to happen against the same world the solver is
   * about to advance.
   *
   * The cap is four substeps: if the tab was in the background for a
   * second, the car does not get a second of simulation delivered in one
   * frame, it gets a third of a second and the rest is dropped.  A dropped
   * third of a second is a discontinuity; a delivered one is the car in
   * the next valley.
   */
  step(dt, before) {
    const t0 = performance.now();
    this.acc = Math.min(this.acc + dt, this.hz * 4);
    let n = 0;
    while (this.acc >= this.hz) {
      this.acc -= this.hz;
      if (before) before(this.hz);
      this.world.step();
      n++;
    }
    this.steps += n;
    this.stepMs = performance.now() - t0;
    return n;
  }

  /**
   * The collider surface under a point: cast down from `y`, `reach` metres.
   *
   * The car is excluded, and it has to be -- a ray dropped from above a
   * point the car happens to be standing on hits the roof first and
   * reports the ground as being a metre *higher* than it is, which is a
   * remarkably convincing impersonation of the bug this file exists to
   * fix.
   */
  ground(x, y, z, reach = 400) {
    const hit = this.world.castRay(
      { origin: { x, y, z }, dir: { x: 0, y: -1, z: 0 } }, reach, true,
      undefined, undefined, undefined, this.carBody || undefined);
    return hit ? y - hit.timeOfImpact : null;
  }

  /**
   * Does the collider agree with the mesh?
   *
   * The one assertion worth having in this file: it catches a transposed
   * heightfield, an off-by-one on the scale, and a chunk whose collider was
   * not rebuilt when its geometry was.  All three look, from inside the
   * car, like the ground being in slightly the wrong place -- which is the
   * bug this iteration exists to remove, so it gets a check rather than a
   * hope.
   */
  probe(terrainHeightAt, x, z) {
    const field = terrainHeightAt(x, z);
    const y = this.ground(x, field + 60, z, 120);
    return { collider: y, field, delta: y === null ? null : y - field };
  }
}

const RAIL_SEG = 10;         // one box per node of road
const RAIL_HALF_H = 0.35;
const RAIL_MID = 0.62;       // matches Furniture.RAIL_Y

function yawQuat(a) {
  return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
}
