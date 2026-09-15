import * as THREE from 'three';
import { cel } from '../core/toon.js';
import { canopyTexture } from '../core/textures.js';
import { chunkRng } from '../core/rng.js';
import { WATER_LEVEL } from './terrain.js';
import { CHUNK, cellKey } from './chunks.js';
import { patchSeason } from './season.js';
import { patchClouds } from './cloudfield.js';

/* ------------------------------------------------------------------ *
 * What grows on it.
 *
 * Trees are the single most visible system in the frame -- more than the
 * terrain, more than the road -- so this file gets more care than its
 * size suggests.  They are cross-planed cards rather than geometry, which
 * is what most real-time landscapes do: fifteen hundred trees of real
 * branches is not affordable and does not look better at 200 m.
 *
 * Placement is a pure function of the chunk index, so a chunk thrown away
 * behind the car and rebuilt in front of it grows the same wood back.
 *
 * Density comes from a slow noise -- woods, not a uniform sprinkle.  An
 * even scatter of trees at constant spacing is the most reliable way to
 * make a landscape look procedural, and clumping is most of the fix.
 * ------------------------------------------------------------------ */

/* Three species, not two.  Two silhouettes -- a conifer cone and a blobby
 * deciduous -- repeated at varying scale read as a pattern, and a third
 * form low to the ground does more for that than a fourth tree would: it breaks the line
 * where the canopies stop and the grass starts. */
const SPECIES = [
  {
    name: 'broadleaf', h: [4.5, 8.5], w: 0.66, trunk: 0.075, trunkH: 0.45, bark: 0x5c4f40,
    palette: ['#2f4423', '#456031', '#5d7a3c'],
  },
  {
    name: 'conifer', h: [6, 11], w: 0.42, trunk: 0.065, trunkH: 0.30, bark: 0x53463a,
    palette: ['#223a2c', '#31513a', '#43664a'],
  },
  {
    name: 'scrub', h: [0.9, 2.2], w: 1.05, trunk: 0.05, trunkH: 0.12, bark: 0x5a4e3c,
    palette: ['#3b4a24', '#55682f', '#6d8140'],
  },
];

/* The canopy was an outline cut into the mesh -- a lozenge for the
 * broadleaf, tiers for the fir.  Cheap, and wrong: a solid silhouette with
 * a smooth edge reads as a cardboard cut-out at every distance, and a
 * hillside of them reads as a hillside of cardboard.  What breaks it is
 * holes -- sky through the canopy at the edges -- and holes mean alpha.
 * `alphaTest` rather than blending, so there is still no sorting to do. */
function treeParts(sp) {
  const parts = [];
  /* The trunk is a fraction of the tree's height, not all of it.  The
   * canopy card's foliage only fills the lower four fifths of its texture
   * -- there has to be sky above the crown or the cut-out has no top edge
   * -- so a full-height trunk came out through the leaves and every wood
   * was a wood of bare poles. */
  const trunk = new THREE.CylinderGeometry(sp.trunk * 0.62, sp.trunk, sp.trunkH, 5, 1);
  trunk.translate(0, sp.trunkH / 2, 0);
  parts.push({ geo: trunk, kind: 'bark' });

  const w = sp.name === 'conifer' ? 0.92 : sp.name === 'scrub' ? 1.25 : 1.15;
  const card = new THREE.PlaneGeometry(w, 1, 1, 1);
  card.translate(0, 0.5, 0);
  const b = card.clone();
  b.rotateY(Math.PI / 2);
  /* A third card at 45 degrees.  Two crossed cards have two angles from
   * which the tree is a flat line; three has none that matter. */
  const c = card.clone();
  c.rotateY(Math.PI / 4);
  parts.push({ geo: card, kind: 'canopy' }, { geo: b, kind: 'canopy' },
              { geo: c, kind: 'canopy' });
  return parts;
}

/** Trunk and canopy as one geometry with two draw groups. */
function bakeTree(sp) {
  const parts = treeParts(sp);
  const bark = parts.filter((p) => p.kind === 'bark');
  const leaf = parts.filter((p) => p.kind === 'canopy');
  const ordered = [...bark, ...leaf];

  let vcount = 0, icount = 0;
  for (const p of ordered) {
    vcount += p.geo.attributes.position.count;
    icount += p.geo.index.count;
  }
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const idx = new Uint16Array(icount);
  let vo = 0, io = 0, barkIndices = 0, barkVerts = 0;
  for (const p of ordered) {
    const g = p.geo;
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = vo + gi[i];
    if (p.kind === 'bark') { barkIndices += gi.length; barkVerts += g.attributes.position.count; }
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  /* Canopy normals point *outward from the trunk*, not along the card.
   *
   * A flat quad has one normal, so a lit card is one flat tone whichever
   * way the sun is -- which reads as "flat unlit green
   * fills".  Splaying the normals out from the axis makes the
   * three cards shade like the surface of a rough sphere: the sunward side
   * lights, the far side falls away, and a stand of trees gets form
   * instead of being a field of identical green cut-outs.  One loop, no
   * extra geometry, no extra draw call. */
  for (let i = 0; i < vcount; i++) {
    const o = i * 3;
    // bark keeps its own normals; the canopy is everything after them
    if (o < barkVerts * 3) continue;
    const x = pos[o], y = pos[o + 1] - 0.62, z = pos[o + 2];
    const l = Math.hypot(x, y * 0.55, z) || 1;
    nor[o] = x / l;
    nor[o + 1] = (y * 0.55) / l + 0.35;
    nor[o + 2] = z / l;
    const n = Math.hypot(nor[o], nor[o + 1], nor[o + 2]) || 1;
    nor[o] /= n; nor[o + 1] /= n; nor[o + 2] /= n;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.addGroup(0, barkIndices, 0);
  geo.addGroup(barkIndices, icount - barkIndices, 1);
  return geo;
}

const _m = new THREE.Matrix4();
/* ------------------------------------------------------------------ *
 * The seasonal patches.
 * ------------------------------------------------------------------ */

/** Snow gathers on the up-facing side of a trunk, and not much else. */
const BARK_PATCH = {
  fragment: /* glsl */ `
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.86, 0.88, 0.93 ),
                            uSnow * 0.35 );
    diffuseColor.rgb *= 1.0 - uWet * 0.20;`,
};

/**
 * The canopy.
 *
 * Three things happen here and the middle one is the point:
 *
 *  - autumn is a *ramp* read by a per-tree hash, so one wood carries
 *    yellow, orange and rust rather than one flat red;
 *  - winter takes the broadleaves' leaves away -- the alpha is cut, so
 *    what is left is the sparse edge of the card, which reads as bare
 *    twigs at any distance a card is convincing at anyway.  Conifers
 *    (species 1) keep theirs, and get snow instead;
 *  - spring is pale and slightly yellow, with a hashed few going almost
 *    to blossom.
 */
function canopyPatch(species) {
  const evergreen = species === 1 ? '1.0' : '0.0';
  return {
    /* Per species, because the GLSL below differs per species -- see the
     * note on `key` in `patchSeason`. */
    key: 'canopy' + species,
    vertex: /* glsl */ `
      vec4 tw = instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
      vTree = fract( sin( dot( tw.xz, vec2( 34.71, 61.13 ) ) ) * 9271.31 );`,
    pars: /* glsl */ `
      varying float vTree;
      const float EVERGREEN = ${evergreen};`,
    fragment: /* glsl */ `
      /* Re-hue, do not multiply.
       *
       * The first version scaled the canopy colour by a seasonal tint, and
       * a multiply cannot turn a green leaf red -- it can only scale the
       * channels that are already there.  Against a canopy texture whose
       * green channel is three times its red, an "orange" tint of
       * (1.5, 1.0, 0.34) still comes out green, and the first autumn shot
       * had a hillside of yellow grass under trees in full summer leaf.
       *
       * So: take the texture's *luminance* -- which is where all its
       * structure lives, the dappling and the darker interior -- and hang
       * an absolute seasonal colour on it.  The wood keeps its form and
       * changes its colour, which is what autumn does. */
      float lum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
      float shade = 0.45 + 1.15 * lum;

      /* Autumn: a ramp *across the wood*, read by the per-tree hash, so
       * one hillside carries yellow, orange and rust rather than one flat
       * red -- which is the tell that gives away a global tint. */
      vec3 au = mix( mix( vec3( 0.86, 0.62, 0.16 ),      // yellow
                          vec3( 0.78, 0.38, 0.12 ),      // orange
                          smoothstep( 0.0, 0.55, vTree ) ),
                     vec3( 0.62, 0.22, 0.13 ),           // rust
                     smoothstep( 0.55, 1.0, vTree ) );
      vec3 sp = mix( vec3( 0.42, 0.62, 0.22 ),           // fresh light green
                     vec3( 0.78, 0.70, 0.62 ),           // and a few in blossom
                     step( 0.90, vTree ) * ( 1.0 - EVERGREEN ) );
      vec3 wi = vec3( 0.34, 0.28, 0.22 );                // bare twig brown

      /* Conifers do none of this.  They dull a little in autumn, darken in
       * winter, and are otherwise the same tree all year -- which is most
       * of what makes a mixed wood read as mixed. */
      vec3 ev = diffuseColor.rgb;
      au = mix( au * shade, ev * 0.88, EVERGREEN );
      sp = mix( sp * shade, ev * 1.06, EVERGREEN );
      wi = mix( wi * shade, ev * 0.72, EVERGREEN );

      diffuseColor.rgb = seasonMix( sp, ev, au, wi );

      /* Winter thins the broadleaves.  Cutting alpha rather than scaling
       * the card keeps the silhouette's *shape* and opens it up, which is
       * what a bare crown looks like at any distance a card is convincing
       * at anyway.  Not too far: at 0.62 the crowns vanished outright and
       * a winter hillside was a field of dark poles. */
      float strip = uSeason.w * ( 1.0 - EVERGREEN );
      diffuseColor.a *= 1.0 - strip * 0.34;

      /* ...and settles on what is left of the conifers. */
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.91, 0.94, 0.99 ),
                              uSnow * ( 0.20 + 0.42 * EVERGREEN ) );
      diffuseColor.rgb *= 1.0 - uWet * 0.14;`,
  };
}

const _q4 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Scatter {
  constructor(scene, terrain, road, opts = {}) {
    this.scene = scene;
    this.terrain = terrain;
    this.road = road;
    this.seed = opts.seed ?? 1;
    /** Trees are only placed in the two nearest LOD bands.  Beyond ~330 m a
     *  tree is four pixels, and four pixels of tree is what fog is for. */
    this.range = opts.range ?? 340;
    this.perChunk = opts.perChunk ?? 200;
    /* Bark and canopy, both seasonal.
     *
     * The canopy is the interesting one and the reason it is a *tint* and
     * not four textures: a single colour multiply makes every tree in a
     * wood exactly the same red in autumn, which is the tell.  So the
     * tint is read through a per-tree hash of the instance's own position
     * -- `instanceMatrix` is already in the vertex shader, the position
     * never changes for the life of a tree, and it costs nothing.  That
     * also means it survives the instance pool without any bookkeeping,
     * which an attribute would not: `_take` hands a mesh from one chunk
     * to another and only the matrices are rewritten. */
    this.materials = SPECIES.map((sp, i) => [
      patchClouds(
        patchSeason(cel({ color: sp.bark, roughness: 1, flat: true, cache: false }),
                    { ...BARK_PATCH, key: 'bark' }), 'bark'),
      /* The key carries the species, for the reason `patchSeason`'s own
       * comment gives: three canopies, three different injected shaders,
       * one cache key between them is three conifers in autumn colours. */
      patchClouds(patchSeason(cel({
        map: canopyTexture(sp.name, sp.palette), color: 0xffffff,
        roughness: 1, side: THREE.DoubleSide, alphaTest: 0.42, cache: false,
      }), canopyPatch(i)), 'canopy' + i),
    ]);
    this.geo = SPECIES.map(bakeTree);
    this.live = new Map();
    this.pool = SPECIES.map(() => []);
    /* Trunks, per chunk, for the colliders.  Recorded while scattering
     * rather than derived afterwards: the placement is a rejection sample
     * against four different tests and the only cheap way to know where a
     * tree ended up is to have been there when it was put down. */
    this.trunks = new Map();
  }

  /** Woods rather than a sprinkle: a slow field gates whole hillsides. */
  _density(x, z) {
    const h = this.terrain.hm;
    const n = h.base(x, z, 1) / 200;          // reuse octave 0 as a cheap field
    const t = (n - 0.30) / 0.34;
    return Math.max(0, Math.min(1, t));
  }

  update(px, pz) {
    const R = this.range;
    const ci = Math.floor(px / CHUNK), cj = Math.floor(pz / CHUNK);
    const span = Math.ceil(R / CHUNK);
    const wanted = new Set();
    for (let j = -span; j <= span; j++) {
      for (let i = -span; i <= span; i++) {
        const ix = ci + i, iz = cj + j;
        const wx = (ix + 0.5) * CHUNK, wz = (iz + 0.5) * CHUNK;
        if (Math.hypot(wx - px, wz - pz) > R + CHUNK) continue;
        const k = cellKey(ix, iz);
        wanted.add(k);
        if (!this.live.has(k)) this._build(ix, iz, k);
      }
    }
    for (const [k, group] of this.live) {
      if (!wanted.has(k)) {
        for (const m of group) { this.scene.remove(m); this.pool[m.userData.sp].push(m); }
        this.live.delete(k);
        this.trunks.delete(k);
      }
    }
  }

  _take(sp, cap) {
    const m = this.pool[sp].pop();
    if (m && m.instanceMatrix.count >= cap) return m;
    if (m) { m.dispose(); }
    const inst = new THREE.InstancedMesh(this.geo[sp], this.materials[sp], cap);
    inst.userData.sp = sp;
    inst.castShadow = true;
    inst.receiveShadow = false;
    inst.frustumCulled = true;
    return inst;
  }

  _build(ix, iz, key) {
    const T = this.terrain;
    const rand = chunkRng(ix, iz, 0x7ee, this.seed);
    const ox = ix * CHUNK, oz = iz * CHUNK;
    const counts = SPECIES.map(() => 0);
    const mats = SPECIES.map(() => []);
    /* Trunk records for the physics layer.  Scrub (species 2) is left out:
     * a bush should brush past, and a collider on every one of them would
     * treble the count for something the player would only feel as the car
     * catching on nothing. */
    const trunks = [];

    for (let n = 0; n < this.perChunk; n++) {
      const x = ox + rand() * CHUNK;
      const z = oz + rand() * CHUNK;
      if (rand() > this._density(x, z)) continue;

      const y = T.heightAt(x, z);
      if (y < WATER_LEVEL + 1.2) continue;
      if (y > 155 && rand() > 0.25) continue;              // tree line

      const g = T.gradientAt(x, z, 3);
      if (g.slope > 0.72) continue;

      // never in the road, and never so close that a branch is in the windscreen
      const q = this.road.nearest(x, z, {});
      if (q && q.d < 14) continue;

      /* Scrub outnumbers trees, which is what a hillside actually looks
       * like, and it is what fills the gap between the canopy line and the
       * verge grass. */
      const r2 = rand();
      const sp = r2 < 0.42 ? 2 : (y > 95 || r2 < 0.68 ? 1 : 0);
      const S = SPECIES[sp];
      const h = S.h[0] + rand() * (S.h[1] - S.h[0]);
      _p.set(x, y - 0.2, z);
      _q4.setFromAxisAngle(_up, rand() * Math.PI * 2);
      _s.set(h * S.w * (0.85 + rand() * 0.3), h, h * S.w * (0.85 + rand() * 0.3));
      mats[sp].push(new THREE.Matrix4().compose(_p, _q4, _s));
      counts[sp]++;
      if (sp !== 2) trunks.push({ x, z, y: y - 0.2, r: S.trunk * 1.35, h: h * S.trunkH + 0.8 });
    }

    const group = [];
    for (let sp = 0; sp < SPECIES.length; sp++) {
      if (!counts[sp]) continue;
      const inst = this._take(sp, Math.max(32, counts[sp]));
      inst.count = counts[sp];
      for (let i = 0; i < counts[sp]; i++) inst.setMatrixAt(i, mats[sp][i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      this.scene.add(inst);
      group.push(inst);
    }
    this.live.set(key, group);
    trunks.centre = { x: ox + CHUNK / 2, z: oz + CHUNK / 2 };
    this.trunks.set(key, trunks);
  }
}
