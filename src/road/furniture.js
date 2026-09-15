import * as THREE from 'three';
import { patchSeason } from '../world/season.js';
import { patchClouds } from '../world/cloudfield.js';
import { cel } from '../core/toon.js';
import { STEP } from './trace.js';
import { CARRIAGEWAY } from '../world/terrain.js';

/* ------------------------------------------------------------------ *
 * Armco, and the posts that hold it up.
 *
 * A barrier goes wherever the ground falls away from the verge, and it is
 * a bigger part of the picture than its size suggests:
 * a bright horizontal line running down one side of the frame, catching
 * the light, following the curve.  Without it a road on an embankment
 * just stops at the grass.
 *
 * Where it goes is decided from the *lateral gradient at the node*, which the tracer already computed and
 * stored while it was steering.  Nothing new has to be sampled: if the
 * land falls away to the left of the road it gets a barrier on the left.
 * ------------------------------------------------------------------ */

const OFFSET = CARRIAGEWAY + 0.55;   // metres from the centreline
const RAIL_Y = 0.62;                 // rail centre height above the verge
const POST_EVERY = 4;                // metres
const RUN_MIN = 6;                   // nodes; shorter runs look like litter

/** Falls away by more than this (normalised gradient) and it wants a rail. */
const FALL = 0.85;

export class Furniture {
  constructor(scene, terrain, road, opts = {}) {
    this.scene = scene;
    this.T = terrain;
    this.road = road;
    this.spanNodes = opts.spanNodes ?? 26;      // 260 m per batch
    this.live = new Map();
    /* `cache: false`, because these are patched below and the material
     * cache in `toon.js` is keyed on the constructor arguments -- a cached
     * material handed out to something else would carry the season patch
     * with it. */
    this.matRail = cel({ color: 0xa8adb2, roughness: 0.42, metalness: 0.55, flat: true, cache: false });
    this.matPost = cel({ color: 0x6f747a, roughness: 0.65, metalness: 0.35, flat: true, cache: false });
    /* Snow on the rail tops and the post caps.  Small, and the sort of
     * thing whose *absence* is loud: a summer-grey guardrail standing in a
     * snowfield is more conspicuous than the snow is. */
    for (const m of [this.matRail, this.matPost]) {
      patchClouds(m, 'rail');
      patchSeason(m, {
        fragment: `
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.94, 0.96, 1.0 ),
                                  uSnow * 0.45 );
          diffuseColor.rgb *= 1.0 - uWet * 0.12;`,
      });
    }
    this.postGeo = new THREE.BoxGeometry(0.11, 1.15, 0.11);
    this.postGeo.translate(0, -0.2, 0);
    this.pool = [];
  }

  update(s0, s1) {
    const span = this.spanNodes * STEP;
    const a = Math.floor(s0 / span), b = Math.floor(s1 / span);
    for (let k = a; k <= b; k++) if (!this.live.has(k)) this._build(k);
    for (const [k, e] of this.live) {
      if (k < a || k > b) {
        if (e.group) {
          this.scene.remove(e.group);
          e.group.traverse((o) => { if (o.isMesh && o.geometry !== this.postGeo) o.geometry.dispose(); });
        }
        this.live.delete(k);
      }
    }
  }

  _build(k) {
    const span = this.spanNodes * STEP;
    const s0 = k * span;
    /* **Which line**, since `prompt_5.md` item 4 gave the road a backward
     * half.  A span whose arc positions are negative belongs to the
     * backward tracer, and its node indices run the other way -- the whole
     * of the difference is that `i0` is measured from the origin outward
     * either way, and the side the barrier goes on flips with the tangent
     * (`nearest` mirrors `u` for the same reason).
     *
     * A span that straddles the origin is skipped rather than special
     * cased: it is one 200 m stretch of road in a world, the two lines
     * meet there at a tangent, and the alternative is a build path with a
     * seam in the middle of it. */
    const back = s0 < 0;
    if (back && s0 + span > 0) return;
    const line = back ? this.road.back : this.road.mid;
    const nodes = line.nodes;
    const len = (nodes.length - 1) * STEP;
    const from = back ? -(s0 + span) : s0;
    if (from + span > len || from < 0) return;

    const i0 = Math.floor(from / STEP);
    const i1 = Math.min(nodes.length - 2, i0 + this.spanNodes);

    /* Which side, per node.  `g` is the lateral gradient the tracer saw
     * when it chose this heading: positive means the ground falls one way,
     * negative the other. */
    const want = [];
    for (let i = i0; i <= i1; i++) {
      const n = nodes[i];
      if (!n) { want.push(0); continue; }
      const side = n.g > FALL ? -1 : n.g < -FALL ? 1 : 0;
      want.push(back ? -side : side);
    }

    // group into runs, and throw away the short ones
    const runs = [];
    let start = -1, side = 0;
    for (let i = 0; i <= want.length; i++) {
      const w = i < want.length ? want[i] : 0;
      if (w !== side) {
        if (side !== 0 && i - start >= RUN_MIN) runs.push({ from: start, to: i - 1, side });
        start = i; side = w;
      }
    }
    if (runs.length === 0) { this.live.set(k, { group: null, runs: [], cx: 0, cz: 0 }); return; }

    const group = new THREE.Group();
    const sm = {};
    let posts = 0;
    /* Along-line index to signed arc position.  The backward line runs to
     * negative `s`, so its two endpoints also swap over -- every loop below
     * walks from the lower signed value to the higher one and needs no
     * other change. */
    const arc = (idx) => (back ? -idx * STEP : idx * STEP);
    const ends = (run) => (back
      ? [arc(i0 + run.to), arc(i0 + run.from)]
      : [arc(i0 + run.from), arc(i0 + run.to)]);
    for (const run of runs) {
      const [sA, sB] = ends(run);
      group.add(this._rail(sA, sB, run.side, sm));
      posts += Math.floor((sB - sA) / POST_EVERY) + 1;
    }

    // all the posts of this batch as one instanced mesh
    if (posts > 0) {
      const inst = new THREE.InstancedMesh(this.postGeo, this.matPost, posts);
      inst.castShadow = true;
      inst.receiveShadow = false;
      let n = 0;
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const one = new THREE.Vector3(1, 1, 1);
      for (const run of runs) {
        const [sA, sB] = ends(run);
        for (let s = sA; s <= sB; s += POST_EVERY) {
          this.road.sampleAt(s, sm);
          const u = OFFSET * run.side;
          const x = sm.x + sm.rx * u, z = sm.z + sm.rz * u;
          p.set(x, this.T.heightAt(x, z) + RAIL_Y, z);
          q.setFromAxisAngle(UP, -Math.atan2(sm.tz, sm.tx));
          m.compose(p, q, one);
          inst.setMatrixAt(n++, m);
        }
      }
      inst.count = n;
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      group.add(inst);
    }

    group.matrixAutoUpdate = false;
    this.scene.add(group);

    /* What was drawn, in road coordinates, so the physics layer can put a
     * collider on it.
     *
     * The rail is now the rule that decides where the player may leave the
     * road, so the barrier they hit has to be the barrier they can see --
     * same runs, same offset, same side.  Deriving it twice from `n.g`
     * would agree until the day one of the two copies is tuned. */
    const mid = this.road.sampleAt(arc(i0 + this.spanNodes / 2), {});
    this.live.set(k, {
      group,
      cx: mid.x, cz: mid.z,
      runs: runs.map((r) => {
        const [sA, sB] = ends(r);
        return { sA, sB, side: r.side, u: OFFSET * r.side };
      }),
    });
  }

  /** One continuous run of rail, as a folded ribbon following the road. */
  _rail(sA, sB, side, sm) {
    const rows = Math.max(2, Math.round((sB - sA) / 2) + 1);
    /* The section is a W-beam flattened to three folds -- enough to catch
     * the light along two different planes, which is the whole reason a
     * barrier reads as metal at two hundred metres. */
    const prof = [
      { v: 0.16, out: 0.00 },
      { v: 0.05, out: 0.055 },
      { v: -0.02, out: 0.015 },
      { v: -0.09, out: 0.055 },
      { v: -0.19, out: 0.00 },
    ];
    const cols = prof.length;
    const pos = new Float32Array(rows * cols * 3);
    const nor = new Float32Array(rows * cols * 3);
    for (let j = 0; j < rows; j++) {
      const s = sA + (j / (rows - 1)) * (sB - sA);
      this.road.sampleAt(s, sm);
      const u = OFFSET * side;
      const bx = sm.x + sm.rx * u, bz = sm.z + sm.rz * u;
      const by = this.T.heightAt(bx, bz) + RAIL_Y;
      for (let i = 0; i < cols; i++) {
        const o = (j * cols + i) * 3;
        const out = prof[i].out * side;
        pos[o] = bx + sm.rx * out;
        pos[o + 1] = by + prof[i].v;
        pos[o + 2] = bz + sm.rz * out;
        nor[o] = sm.rx * side; nor[o + 1] = 0.25; nor[o + 2] = sm.rz * side;
      }
    }
    const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
    let o = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b;
        idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.matRail);
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
