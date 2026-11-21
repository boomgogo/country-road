import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * What the places are made of.
 *
 * One procedural kit and no assets: every building is a few dozen boxes,
 * prisms and cylinders merged into one vertex-coloured geometry, built
 * once when `places.js` arrives and instanced from then on.  A house is
 * about 250 triangles; a town is about a dozen draw calls.
 *
 * Every archetype is drawn in its own frame: **x along the road, z away
 * from it, y up from the floor**.  The front of a building faces -z, at the
 * road.  `places.js` turns the frame to the road and stands it on the land.
 *
 * Three things ride along with the geometry, because they are part of
 * what a building *is* and not of where it stands:
 *
 *   windows   quads with a per-window pair of random numbers, drawn by
 *             their own unlit material -- dark glass by day, warm light at
 *             night, switched one window at a time.  See `places.js`.
 *   lamps     points that light their surroundings at night: a porch, a
 *             servo canopy, a street light.  See `lamps.js`.
 *   signs     text panels, drawn from one canvas atlas.
 *
 * `aMask` on every vertex says what an instance may recolour: 1 is roof
 * (Colorbond, per building), 2 is wall (weatherboard, per building), 0 is
 * everything else.  One geometry, a street of different houses.
 * ------------------------------------------------------------------ */

const _c = new THREE.Color();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();

/** Linear RGB of an sRGB hex, the way three reads vertex colours. */
function rgb(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }

/** The kit's palette: real-ish materials, a little desaturated for the
 *  cel ramp, which adds its own contrast. */
export const COL = {
  white: 0xf0eee6, cream: 0xe6dcc2, timber: 0x86684b, darkTimber: 0x5d4836,
  deck: 0x8a6e52, door: 0x3d4a3a, brick: 0x8c5240, concrete: 0xa29d93,
  iron: 0xa9afb1, rust: 0x8d5f43, zinc: 0xb9bec0, steel: 0x8b9195,
  dark: 0x2c3034, glassFrame: 0xe9e7df, red: 0xb5352e, sandstone: 0xcbb68d,
  gravel: 0xa69d8a, tank: 0xb3b8b9, blade: 0xd8dbdb, bowser: 0xc63b33,
  soffit: 0xcfc8b6,
};

/** Roofs: the Colorbond colours a country town is actually roofed in. */
export const ROOFS = [0x6e2a26, 0x304c3c, 0x8d9590, 0x364152, 0xbfb59c, 0xb4b9bb, 0x5b3a2e];
/** Walls: painted weatherboard. */
export const WALLS = [0xf4f2ea, 0xeadfc0, 0xe9d48f, 0xb5c9a0, 0xa9c4cc, 0xe2b49a, 0xc9c9c2];

/* ------------------------------------------------------------------ *
 * The builder.
 * ------------------------------------------------------------------ */

export class Kit {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.m = [];
    /* Windows go to a kit of their own: a different material, the same
     * frame. */
    this.wp = []; this.wa = [];
    /** Everything else an archetype carries.  See the file header. */
    this.lamps = [];
    this.signs = [];
    this.colliders = [];
    this._win = 0;
  }

  _v(x, y, z, n, col, mask) {
    this.p.push(x, y, z);
    this.n.push(n.x, n.y, n.z);
    this.c.push(col[0], col[1], col[2]);
    this.m.push(mask);
  }

  /** A flat triangle, wound so its normal agrees with `out` if given. */
  tri(a, b, c, hex, mask = 0, out = null) {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    _n.crossVectors(_a, _b).normalize();
    if (out && _n.x * out[0] + _n.y * out[1] + _n.z * out[2] < 0) { [b, c] = [c, b]; _n.negate(); }
    const col = rgb(hex);
    this._v(a[0], a[1], a[2], _n, col, mask);
    this._v(b[0], b[1], b[2], _n, col, mask);
    this._v(c[0], c[1], c[2], _n, col, mask);
  }

  /** A flat quad, corners in order round its edge, facing `out`. */
  quad(a, b, c, d, hex, mask = 0, out = null) {
    if (!out) {
      _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      _n.crossVectors(_a, _b);
      out = [_n.x, _n.y, _n.z];
    }
    this.tri(a, b, c, hex, mask, out);
    this.tri(a, c, d, hex, mask, out);
  }

  /**
   * An axis-aligned box.  `col` is one colour, or one per face in the
   * order +x -x +y -y +z -z; a face whose colour is null is left out.
   * `mask` likewise.
   */
  box(x0, y0, z0, x1, y1, z1, col, mask = 0) {
    const C = Array.isArray(col) ? col : [col, col, col, col, col, col];
    const M = Array.isArray(mask) ? mask : [mask, mask, mask, mask, mask, mask];
    if (C[0] != null) this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], C[0], M[0], [1, 0, 0]);
    if (C[1] != null) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], C[1], M[1], [-1, 0, 0]);
    if (C[2] != null) this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], C[2], M[2], [0, 1, 0]);
    if (C[3] != null) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], C[3], M[3], [0, -1, 0]);
    if (C[4] != null) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], C[4], M[4], [0, 0, 1]);
    if (C[5] != null) this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], C[5], M[5], [0, 0, -1]);
  }

  /** A box between two points, `w` by `h` in section -- a beam, a brace,
   *  a leg, a rail.  `up` picks which way the section's `h` points. */
  beam(a, b, w, h, hex, mask = 0) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    if (len < 1e-4) return;
    d.divideScalar(len);
    const ref = Math.abs(d.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(d, ref).normalize().multiplyScalar(w / 2);
    const v = new THREE.Vector3().crossVectors(u, d).normalize().multiplyScalar(h / 2);
    const corner = (p, su, sv) => [p[0] + u.x * su + v.x * sv, p[1] + u.y * su + v.y * sv, p[2] + u.z * su + v.z * sv];
    const A = [corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1)];
    const B = [corner(b, -1, -1), corner(b, 1, -1), corner(b, 1, 1), corner(b, -1, 1)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const mid = [(A[i][0] + A[j][0]) / 2 - a[0], (A[i][1] + A[j][1]) / 2 - a[1], (A[i][2] + A[j][2]) / 2 - a[2]];
      this.quad(A[i], A[j], B[j], B[i], hex, mask, mid);
    }
    this.quad(A[0], A[1], A[2], A[3], hex, mask, [-d.x, -d.y, -d.z]);
    this.quad(B[0], B[1], B[2], B[3], hex, mask, [d.x, d.y, d.z]);
  }

  /**
   * A gable roof, ridge along x from `x0` to `x1`, eaves at `z0` and `z1`
   * at height `y0`, ridge at `y1`, with an overhang all round.  Gable ends
   * are wall (`gable` colour and mask 2 unless told otherwise); the soffit
   * is drawn so the roof is not a paper sheet from below.
   */
  gableX(x0, x1, z0, z1, y0, y1, o, hex, gable = 0xffffff, gableMask = 2) {
    const zc = (z0 + z1) / 2;
    const X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o;
    const drop = (y1 - y0) * o / (zc - z0);
    const yE = y0 - drop;
    this.quad([X0, yE, Z0], [X1, yE, Z0], [X1, y1, zc], [X0, y1, zc], hex, 1, [0, 1, -1]);
    this.quad([X0, yE, Z1], [X0, y1, zc], [X1, y1, zc], [X1, yE, Z1], hex, 1, [0, 1, 1]);
    /* Underside, a little in, so the eave has a thickness to the ink. */
    const t = 0.12;
    this.quad([X0, yE - t, Z0], [X0, y1 - t, zc], [X1, y1 - t, zc], [X1, yE - t, Z0], COL.soffit, 0, [0, -1, 1]);
    this.quad([X0, yE - t, Z1], [X1, yE - t, Z1], [X1, y1 - t, zc], [X0, y1 - t, zc], COL.soffit, 0, [0, -1, -1]);
    this.quad([X0, yE, Z0], [X0, yE - t, Z0], [X1, yE - t, Z0], [X1, yE, Z0], hex, 1, [0, 0, -1]);
    this.quad([X0, yE, Z1], [X1, yE, Z1], [X1, yE - t, Z1], [X0, yE - t, Z1], hex, 1, [0, 0, 1]);
    /* The gable triangles, on the wall line. */
    this.tri([x0, y0, z0], [x0, y0, z1], [x0, y1, zc], gable, gableMask, [-1, 0, 0]);
    this.tri([x1, y0, z0], [x1, y1, zc], [x1, y0, z1], gable, gableMask, [1, 0, 0]);
  }

  /** The same, ridge along z: a gable facing the road. */
  gableZ(x0, x1, z0, z1, y0, y1, o, hex, gable = 0xffffff, gableMask = 2) {
    const xc = (x0 + x1) / 2;
    const X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o;
    const drop = (y1 - y0) * o / (xc - x0);
    const yE = y0 - drop;
    this.quad([X0, yE, Z0], [xc, y1, Z0], [xc, y1, Z1], [X0, yE, Z1], hex, 1, [-1, 1, 0]);
    this.quad([X1, yE, Z0], [X1, yE, Z1], [xc, y1, Z1], [xc, y1, Z0], hex, 1, [1, 1, 0]);
    const t = 0.12;
    this.quad([X0, yE - t, Z0], [X0, yE - t, Z1], [xc, y1 - t, Z1], [xc, y1 - t, Z0], COL.soffit, 0, [1, -1, 0]);
    this.quad([X1, yE - t, Z0], [xc, y1 - t, Z0], [xc, y1 - t, Z1], [X1, yE - t, Z1], COL.soffit, 0, [-1, -1, 0]);
    this.quad([X0, yE, Z0], [X0, yE, Z1], [X0, yE - t, Z1], [X0, yE - t, Z0], hex, 1, [-1, 0, 0]);
    this.quad([X1, yE, Z0], [X1, yE - t, Z0], [X1, yE - t, Z1], [X1, yE, Z1], hex, 1, [1, 0, 0]);
    this.tri([x0, y0, z0], [x1, y0, z0], [xc, y1, z0], gable, gableMask, [0, 0, -1]);
    this.tri([x0, y0, z1], [xc, y1, z1], [x1, y0, z1], gable, gableMask, [0, 0, 1]);
  }

  /** A hip roof over a rectangle, ridge along its longer side. */
  hip(x0, x1, z0, z1, y0, y1, o, hex) {
    const X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o;
    const w = X1 - X0, d = Z1 - Z0;
    const inset = Math.min(w, d) / 2;
    const yE = y0 - 0.05;
    let r0, r1;
    if (w >= d) {
      const zc = (Z0 + Z1) / 2;
      r0 = [X0 + inset, y1, zc]; r1 = [X1 - inset, y1, zc];
      this.quad([X0, yE, Z0], [X1, yE, Z0], r1, r0, hex, 1, [0, 1, -1]);
      this.quad([X1, yE, Z1], [X0, yE, Z1], r0, r1, hex, 1, [0, 1, 1]);
      this.tri([X0, yE, Z1], [X0, yE, Z0], r0, hex, 1, [-1, 1, 0]);
      this.tri([X1, yE, Z0], [X1, yE, Z1], r1, hex, 1, [1, 1, 0]);
    } else {
      const xc = (X0 + X1) / 2;
      r0 = [xc, y1, Z0 + inset]; r1 = [xc, y1, Z1 - inset];
      this.quad([X0, yE, Z1], [X0, yE, Z0], r0, r1, hex, 1, [-1, 1, 0]);
      this.quad([X1, yE, Z0], [X1, yE, Z1], r1, r0, hex, 1, [1, 1, 0]);
      this.tri([X0, yE, Z0], [X1, yE, Z0], r0, hex, 1, [0, 1, -1]);
      this.tri([X1, yE, Z1], [X0, yE, Z1], r1, hex, 1, [0, 1, 1]);
    }
    this.quad([X0, yE - 0.1, Z0], [X0, yE - 0.1, Z1], [X1, yE - 0.1, Z1], [X1, yE - 0.1, Z0], COL.soffit, 0, [0, -1, 0]);
  }

  /** A skillion -- a single sloping sheet -- from `zHi` at `yHi` down to
   *  `zLo` at `yLo`, over x0..x1, with its underside. */
  skillion(x0, x1, zHi, zLo, yHi, yLo, hex) {
    this.quad([x0, yHi, zHi], [x1, yHi, zHi], [x1, yLo, zLo], [x0, yLo, zLo], hex, 1, [0, 1, zLo < zHi ? -0.3 : 0.3]);
    const t = 0.1;
    this.quad([x0, yHi - t, zHi], [x0, yLo - t, zLo], [x1, yLo - t, zLo], [x1, yHi - t, zHi], COL.soffit, 0, [0, -1, 0]);
    this.quad([x0, yLo, zLo], [x1, yLo, zLo], [x1, yLo - t, zLo], [x0, yLo - t, zLo], hex, 1, [0, 0, zLo < zHi ? -1 : 1]);
  }

  /** A vertical cylinder, smooth-sided, with a lid.  `seg` sides. */
  cyl(cx, cz, y0, y1, r, hex, seg = 12, mask = 0, lid = true) {
    const col = rgb(hex);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const n0 = { x: c0, y: 0, z: s0 }, n1 = { x: c1, y: 0, z: s1 };
      const p00 = [cx + c0 * r, y0, cz + s0 * r], p10 = [cx + c1 * r, y0, cz + s1 * r];
      const p01 = [cx + c0 * r, y1, cz + s0 * r], p11 = [cx + c1 * r, y1, cz + s1 * r];
      this._v(...p00, n0, col, mask); this._v(...p01, n0, col, mask); this._v(...p11, n1, col, mask);
      this._v(...p00, n0, col, mask); this._v(...p11, n1, col, mask); this._v(...p10, n1, col, mask);
      if (lid) this.tri([cx, y1, cz], p11, p01, hex, mask, [0, 1, 0]);
    }
  }

  /** A cone or a tapered cylinder, `r0` at the bottom and `r1` at the top. */
  cone(cx, cz, y0, y1, r0, r1, hex, seg = 12, mask = 0) {
    const col = rgb(hex);
    const slope = (r0 - r1) / (y1 - y0);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const k = 1 / Math.hypot(1, slope);
      const n0 = { x: c0 * k, y: slope * k, z: s0 * k }, n1 = { x: c1 * k, y: slope * k, z: s1 * k };
      const p00 = [cx + c0 * r0, y0, cz + s0 * r0], p10 = [cx + c1 * r0, y0, cz + s1 * r0];
      const p01 = [cx + c0 * r1, y1, cz + s0 * r1], p11 = [cx + c1 * r1, y1, cz + s1 * r1];
      this._v(...p00, n0, col, mask); this._v(...p01, n0, col, mask); this._v(...p11, n1, col, mask);
      this._v(...p00, n0, col, mask); this._v(...p11, n1, col, mask); this._v(...p10, n1, col, mask);
    }
  }

  /**
   * A window: a frame on the wall in this kit, and a pane in the window
   * kit.  `face` is the wall's outward axis: 'x+', 'x-', 'z+' or 'z-'.
   * `kind` 0 is a room, 1 a light left on all night (a porch, a shop),
   * 2 the pub, 3 the hall.  Each pane gets two random numbers of its own,
   * which decide when it comes on and when it goes off.
   */
  win(face, u, y, w, h, at, kind = 0) {
    const f = 0.09;   // the frame, each side
    const P = (du, dy, out) => {
      switch (face) {
        case 'z-': return [u + du, y + dy, at - out];
        case 'z+': return [u - du, y + dy, at + out];
        case 'x+': return [at + out, y + dy, u + du];
        default: return [at - out, y + dy, u - du];
      }
    };
    const n = face === 'z-' ? [0, 0, -1] : face === 'z+' ? [0, 0, 1] : face === 'x+' ? [1, 0, 0] : [-1, 0, 0];
    const hw = w / 2, hh = h / 2;
    this.quad(P(-hw - f, -hh - f, 0.02), P(hw + f, -hh - f, 0.02), P(hw + f, hh + f, 0.02), P(-hw - f, hh + f, 0.02),
      COL.glassFrame, 0, n);
    const a = winRand(this._win, 1), b = winRand(this._win, 2);
    this._win++;
    const q = [P(-hw, -hh, 0.04), P(hw, -hh, 0.04), P(hw, hh, 0.04), P(-hw, hh, 0.04)];
    /* Wound to face out, like everything else. */
    _a.set(q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]);
    _b.set(q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]);
    _n.crossVectors(_a, _b);
    if (_n.x * n[0] + _n.y * n[1] + _n.z * n[2] < 0) q.reverse();
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.wp.push(...q[i]);
      this.wa.push(a, b, kind);
    }
  }

  /** A lamp: a point that lights its surroundings at night.  `kind` as
   *  for windows. */
  lamp(x, y, z, reach, kind = 1) { this.lamps.push({ x, y, z, reach, kind }); }

  /** A text panel, facing -z by default.  See `places.js`, `SignAtlas`. */
  sign(text, style, x, y, z, w, h, yaw = 0) { this.signs.push({ text, style, x, y, z, w, h, yaw }); }

  /** A collider, in the archetype's frame. */
  solid(c) { this.colliders.push(c); }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.m, 1));
    g.computeBoundingSphere();
    let w = null;
    if (this.wp.length) {
      w = new THREE.BufferGeometry();
      w.setAttribute('position', new THREE.Float32BufferAttribute(this.wp, 3));
      w.setAttribute('aWin', new THREE.Float32BufferAttribute(this.wa, 3));
      w.computeBoundingSphere();
    }
    return { geo: g, win: w, lamps: this.lamps, signs: this.signs, colliders: this.colliders };
  }
}

function winRand(i, k) {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ------------------------------------------------------------------ *
 * The archetypes.
 *
 * Each returns `{ geo, win, lamps, signs, colliders, foot, footing,
 * stumps }`: `foot` is the footprint the site test checks, as
 * `[x0, z0, x1, z1]`; `footing` is what it stands on -- 'stumps', a
 * 'plinth', or a 'ring' -- and `stumps` lists where the stumps go.
 * ------------------------------------------------------------------ */

/** Weatherboard house, hip roof, front veranda, tank -- the east coast's
 *  default house, on stumps. */
function houseHip() {
  const k = new Kit();
  const W = 5, D = 3.5, H = 3.0;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, COL.darkTimber, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.hip(-W, W, -D, D, H, H + 2.1, 0.45, 0xffffff);
  verandaFront(k, -W, W, -D, -D - 2.5, 2.7);
  k.box(-0.45, 0, -D - 0.02, 0.45, 2.1, -D, [null, null, null, null, null, COL.door]);
  k.win('z-', -3.0, 1.6, 1.5, 1.3, -D);
  k.win('z-', 3.0, 1.6, 1.5, 1.3, -D);
  k.win('x+', -1.6, 1.6, 1.2, 1.2, W);
  k.win('x+', 1.6, 1.6, 1.2, 1.2, W);
  k.win('x-', -1.6, 1.6, 1.2, 1.2, -W);
  k.win('z+', -2.4, 1.6, 1.2, 1.2, D);
  k.win('z+', 2.4, 1.6, 1.2, 1.2, D);
  k.win('z-', 0.95, 2.35, 0.26, 0.26, -D, 1);
  k.lamp(0.95, 2.4, -D - 1.2, 9, 1);
  k.box(-3.9, 2.4, 0.6, -3.2, 5.7, 1.3, COL.brick);
  k.cyl(W + 1.3, 1.4, -2.8, 2.2, 1.15, COL.tank, 12);
  k.solid({ type: 'box', x0: -W - 0.2, z0: -D - 2.6, x1: W + 0.2, z1: D + 0.2, y0: -3, y1: H + 2 });
  k.solid({ type: 'cyl', x: W + 1.3, z: 1.4, r: 1.15, y0: -3, y1: 2.2 });
  const b = k.build();
  return { ...b, foot: [-W - 0.6, -D - 3.6, W + 2.6, D + 0.6], footing: 'stumps',
           stumps: grid([-4.8, -1.6, 1.6, 4.8], [-3.3, 0, 3.3]).concat(grid([-4.8, -1.6, 1.6, 4.8], [-D - 2.4])) };
}

/** Gable roof side-on to the road, bull-nose veranda. */
function houseGable() {
  const k = new Kit();
  const W = 5.5, D = 4, H = 3.0;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, COL.darkTimber, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.gableX(-W, W, -D, D, H, H + 2.4, 0.45, 0xffffff);
  verandaFront(k, -W, W, -D, -D - 2.6, 2.75);
  k.box(-1.6, 0, -D - 0.02, -0.7, 2.1, -D, [null, null, null, null, null, COL.door]);
  k.win('z-', -3.6, 1.6, 1.4, 1.3, -D);
  k.win('z-', 1.0, 1.6, 1.4, 1.3, -D);
  k.win('z-', 3.6, 1.6, 1.4, 1.3, -D);
  k.win('x+', 0, 1.6, 1.2, 1.2, W);
  k.win('x-', -1.8, 1.6, 1.2, 1.2, -W);
  k.win('x-', 1.8, 1.6, 1.2, 1.2, -W);
  k.win('z+', 0, 1.6, 1.2, 1.2, D);
  k.win('z-', -0.2, 2.35, 0.26, 0.26, -D, 1);
  k.lamp(-0.2, 2.4, -D - 1.2, 9, 1);
  k.box(3.6, 2.6, -0.4, 4.3, 6.0, 0.3, COL.brick);
  k.cyl(-W - 1.3, 2.2, -2.8, 2.2, 1.15, COL.tank, 12);
  k.solid({ type: 'box', x0: -W - 0.2, z0: -D - 2.7, x1: W + 0.2, z1: D + 0.2, y0: -3, y1: H + 2.4 });
  k.solid({ type: 'cyl', x: -W - 1.3, z: 2.2, r: 1.15, y0: -3, y1: 2.2 });
  const b = k.build();
  return { ...b, foot: [-W - 2.6, -D - 3.7, W + 0.6, D + 0.6], footing: 'stumps',
           stumps: grid([-5.3, -1.8, 1.8, 5.3], [-3.8, 0, 3.8]).concat(grid([-5.3, -1.8, 1.8, 5.3], [-D - 2.5])) };
}

/** A smaller cottage, gable end to the road, a porch over the door. */
function cottage() {
  const k = new Kit();
  const W = 3.8, D = 4.6, H = 2.9;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, COL.darkTimber, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.gableZ(-W, W, -D, D, H, H + 2.6, 0.4, 0xffffff);
  /* The porch: a little gable of its own over the steps. */
  k.box(-1.5, -0.15, -D - 1.8, 1.5, 0, -D, COL.deck);
  for (const x of [-1.4, 1.4]) k.box(x - 0.06, 0, -D - 1.75, x + 0.06, 2.5, -D - 1.63, COL.white);
  k.gableZ(-1.6, 1.6, -D - 1.9, -D, 2.5, 3.3, 0.15, 0xffffff, COL.white, 0);
  steps(k, 0, -D - 1.8, 1.0);
  k.box(-0.45, 0, -D - 0.02, 0.45, 2.1, -D, [null, null, null, null, null, COL.door]);
  k.win('z-', -2.4, 1.55, 1.1, 1.3, -D);
  k.win('z-', 2.4, 1.55, 1.1, 1.3, -D);
  k.win('x+', -2, 1.55, 1.1, 1.2, W);
  k.win('x+', 2, 1.55, 1.1, 1.2, W);
  k.win('x-', 0, 1.55, 1.1, 1.2, -W);
  k.win('z+', 0, 1.55, 1.1, 1.2, D);
  k.win('z-', 0.8, 2.2, 0.24, 0.24, -D, 1);
  k.lamp(0.8, 2.3, -D - 1.1, 8, 1);
  k.cyl(W + 1.2, 2.5, -2.8, 2.0, 1.0, COL.tank, 12);
  k.solid({ type: 'box', x0: -W - 0.2, z0: -D - 1.9, x1: W + 0.2, z1: D + 0.2, y0: -3, y1: H + 2.6 });
  const b = k.build();
  return { ...b, foot: [-W - 0.6, -D - 3.0, W + 2.4, D + 0.6], footing: 'stumps',
           stumps: grid([-3.6, 0, 3.6], [-4.4, -1.5, 1.5, 4.4]).concat([[-1.4, -D - 1.7], [1.4, -D - 1.7]]) };
}

/** The farmhouse: wider, a wraparound veranda, a big tank. */
function farmhouse() {
  const k = new Kit();
  const W = 7, D = 5, H = 3.1;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, COL.darkTimber, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.hip(-W, W, -D, D, H, H + 2.6, 0.45, 0xffffff);
  /* Round three sides: the front and both ends. */
  const V = 2.8, y = 2.75;
  k.box(-W - V, -0.15, -D - V, W + V, 0, D, COL.deck);
  k.skillion(-W - V - 0.2, W + V + 0.2, -D, -D - V - 0.2, H - 0.05, y - 0.35, 0xffffff);
  endVeranda(k, W, D, V, H, y, 1);
  endVeranda(k, W, D, V, H, y, -1);
  for (const x of [-W - V + 0.1, -W, -3.5, 0, 3.5, W, W + V - 0.1]) {
    k.box(x - 0.07, 0, -D - V + 0.03, x + 0.07, y - 0.3, -D - V + 0.17, COL.white);
  }
  for (const z of [-D, -1, D - 0.2]) {
    k.box(-W - V + 0.03, 0, z - 0.07, -W - V + 0.17, y - 0.3, z + 0.07, COL.white);
    k.box(W + V - 0.17, 0, z - 0.07, W + V - 0.03, y - 0.3, z + 0.07, COL.white);
  }
  steps(k, 0, -D - V, 1.2);
  k.box(-0.5, 0, -D - 0.02, 0.5, 2.1, -D, [null, null, null, null, null, COL.door]);
  for (const x of [-4.8, -2.4, 2.4, 4.8]) k.win('z-', x, 1.6, 1.3, 1.3, -D);
  for (const z of [-2.4, 2.4]) { k.win('x+', z, 1.6, 1.2, 1.2, W); k.win('x-', z, 1.6, 1.2, 1.2, -W); }
  for (const x of [-3.5, 0, 3.5]) k.win('z+', x, 1.6, 1.2, 1.2, D);
  k.win('z-', 1.1, 2.35, 0.26, 0.26, -D, 1);
  k.lamp(1.1, 2.4, -D - 1.4, 10, 1);
  k.box(-4.6, 2.5, 1.0, -3.8, 6.4, 1.8, COL.brick);
  k.box(3.8, 2.5, 1.0, 4.6, 6.4, 1.8, COL.brick);
  k.cyl(W + V + 2.4, 3.0, -2.8, 2.6, 2.2, COL.tank, 14);
  k.solid({ type: 'box', x0: -W - V, z0: -D - V, x1: W + V, z1: D + 0.2, y0: -3, y1: H + 2.6 });
  k.solid({ type: 'cyl', x: W + V + 2.4, z: 3.0, r: 2.2, y0: -3, y1: 2.6 });
  const b = k.build();
  return { ...b, foot: [-W - V - 0.6, -D - V - 1.4, W + V + 5, D + 0.8], footing: 'stumps',
           stumps: grid([-9.6, -7, -3.5, 0, 3.5, 7, 9.6], [-7.6, -4.8, -1.5, 1.5, 4.8]) };
}

/** A machinery shed: zincalume, gable, open at the front. */
function shed() {
  const k = new Kit();
  const W = 5, D = 4, H = 3.4;
  k.box(-W, 0, -D, W, H, D, [COL.iron, COL.iron, null, null, COL.iron, null]);
  k.gableX(-W, W, -D, D, H, H + 1.4, 0.3, COL.zinc, COL.iron, 0);
  /* The open front: the dark inside, and the two bay posts. */
  k.quad([-W, 0, -D + 0.3], [-W, H, -D + 0.3], [W, H, -D + 0.3], [W, 0, -D + 0.3], COL.dark, 0, [0, 0, -1]);
  for (const x of [-W, -W / 3, W / 3, W]) k.box(x - 0.1, 0, -D - 0.1, x + 0.1, H, -D + 0.1, COL.steel);
  k.box(-W, H - 0.5, -D - 0.08, W, H, -D, COL.iron);
  k.solid({ type: 'box', x0: -W, z0: -D, x1: W, z1: D, y0: -1, y1: H + 1.4 });
  const b = k.build();
  return { ...b, foot: [-W - 0.4, -D - 0.6, W + 0.4, D + 0.4], footing: 'plinth' };
}

/** The pub: two storeys, an upstairs veranda all along the front, a
 *  parapet with the name on it. */
function pub() {
  const k = new Kit();
  const W = 8, D = 5.5, H = 7.2, F = 3.4;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, COL.dark, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.hip(-W, W, -D + 1.2, D, H, H + 1.6, 0.3, 0xffffff);
  /* The parapet: the façade carried up past the roof, with a cornice. */
  k.box(-W - 0.15, H, -D - 0.15, W + 0.15, H + 1.7, -D + 1.0, 0xffffff, 2);
  k.box(-W - 0.3, H + 1.7, -D - 0.3, W + 0.3, H + 1.95, -D + 1.1, COL.cream);
  k.box(-W - 0.2, F - 0.25, -D - 0.12, W + 0.2, F, -D, COL.cream);
  /* Upstairs veranda: deck, balustrade, roof, and posts all the way down. */
  const V = 2.8;
  k.box(-W, F - 0.2, -D - V, W, F, -D, COL.deck);
  k.skillion(-W - 0.2, W + 0.2, -D, -D - V - 0.2, H - 0.3, H - 0.8, 0xffffff);
  k.beam([-W, F + 1.0, -D - V + 0.05], [W, F + 1.0, -D - V + 0.05], 0.1, 0.12, COL.white);
  k.beam([-W, F + 0.15, -D - V + 0.05], [W, F + 0.15, -D - V + 0.05], 0.1, 0.1, COL.white);
  for (let x = -W; x <= W + 0.01; x += W / 2.5) {
    k.box(x - 0.09, 0, -D - V + 0.0, x + 0.09, H - 0.85, -D - V + 0.18, COL.white);
    for (let j = 1; j < 8; j++) {
      const xx = x + (W / 2.5) * j / 8;
      if (xx < W) k.box(xx - 0.025, F, -D - V + 0.03, xx + 0.025, F + 1.0, -D - V + 0.08, COL.white);
    }
  }
  /* Doors and the big ground-floor windows. */
  k.box(-1.0, 0, -D - 0.02, 1.0, 2.5, -D, [null, null, null, null, null, COL.door]);
  for (const x of [-5.6, -3.0, 3.0, 5.6]) k.win('z-', x, 1.5, 1.8, 1.8, -D, 2);
  for (const x of [-6, -3.6, -1.2, 1.2, 3.6, 6]) k.win('z-', x, F + 1.7, 1.0, 1.6, -D, 0);
  for (const z of [-2.5, 1.5]) {
    k.win('x+', z, 1.5, 1.4, 1.6, W, 2); k.win('x-', z, 1.5, 1.4, 1.6, -W, 2);
    k.win('x+', z, F + 1.7, 1.0, 1.5, W, 0); k.win('x-', z, F + 1.7, 1.0, 1.5, -W, 0);
  }
  k.sign('HOTEL', 'pub', 0, H + 0.85, -D - 0.17, 6.2, 1.15);
  k.lamp(0, 3.1, -D - 1.6, 12, 2);
  k.lamp(-5, 3.1, -D - 1.6, 10, 2);
  k.lamp(5, 3.1, -D - 1.6, 10, 2);
  k.solid({ type: 'box', x0: -W, z0: -D - V, x1: W, z1: D, y0: -1, y1: H + 2 });
  const b = k.build();
  return { ...b, foot: [-W - 0.6, -D - V - 0.6, W + 0.6, D + 0.6], footing: 'plinth' };
}

/** The servo: a canopy over two bowsers, the shop behind, a price sign. */
function servo() {
  const k = new Kit();
  const CW = 6, CD = 4.2, CY = 4.6;
  k.box(-CW, CY, -CD, CW, CY + 0.6, CD, [COL.red, COL.red, COL.white, COL.white, COL.red, COL.red]);
  k.box(-CW - 0.02, CY + 0.6, -CD - 0.02, CW + 0.02, CY + 0.75, CD + 0.02, COL.white);
  for (const [x, z] of [[-4.2, -2.6], [4.2, -2.6], [-4.2, 2.6], [4.2, 2.6]]) {
    k.box(x - 0.18, 0, z - 0.18, x + 0.18, CY, z + 0.18, COL.white);
  }
  k.box(-3.6, 0, -0.6, 3.6, 0.18, 0.6, COL.concrete);
  for (const x of [-1.9, 1.9]) {
    k.box(x - 0.35, 0.18, -0.25, x + 0.35, 1.8, 0.25, [COL.bowser, COL.bowser, COL.white, null, COL.white, COL.white]);
    k.box(x - 0.36, 1.45, -0.26, x + 0.36, 1.75, 0.26, COL.dark);
  }
  /* The shop, behind. */
  const S0 = 7, S1 = 13;
  k.box(-5, 0, S0, 5, 3.4, S1, [COL.white, COL.white, COL.concrete, null, COL.white, COL.white]);
  k.box(-5.3, 3.4, S0 - 0.3, 5.3, 3.75, S1 + 0.3, COL.red);
  k.box(-0.6, 0, S0 - 0.02, 0.6, 2.2, S0, [null, null, null, null, null, COL.dark]);
  for (const x of [-3.3, 3.0]) k.win('z-', x, 1.5, 2.6, 1.8, S0, 1);
  k.win('x+', 10, 1.6, 1.2, 1.0, 5, 0);
  /* The price board, by the road. */
  k.box(CW + 1.5 - 0.12, 0, -CD - 1.5 - 0.12, CW + 1.5 + 0.12, 5.2, -CD - 1.5 + 0.12, COL.steel);
  k.box(CW + 1.5 - 1.0, 3.4, -CD - 1.5 - 0.2, CW + 1.5 + 1.0, 5.6, -CD - 1.5 - 0.05, COL.dark);
  k.sign('FUEL', 'servo', CW + 1.5, 4.5, -CD - 1.5 - 0.22, 1.8, 1.9);
  k.sign('STORE', 'servo', 0, 3.57, S0 - 0.33, 3.2, 0.55);
  k.lamp(0, CY - 0.2, 0, 16, 1);
  k.lamp(0, 3.0, S0 - 1.5, 9, 1);
  k.solid({ type: 'box', x0: -0.35 - 1.9, z0: -0.3, x1: -1.9 + 0.35, z1: 0.3, y0: 0, y1: 1.8 });
  k.solid({ type: 'box', x0: 1.9 - 0.35, z0: -0.3, x1: 1.9 + 0.35, z1: 0.3, y0: 0, y1: 1.8 });
  for (const [x, z] of [[-4.2, -2.6], [4.2, -2.6], [-4.2, 2.6], [4.2, 2.6]]) {
    k.solid({ type: 'box', x0: x - 0.18, z0: z - 0.18, x1: x + 0.18, z1: z + 0.18, y0: 0, y1: CY });
  }
  k.solid({ type: 'box', x0: -5, z0: S0, x1: 5, z1: S1, y0: -1, y1: 3.8 });
  k.solid({ type: 'box', x0: CW + 1.38, z0: -CD - 1.62, x1: CW + 1.62, z1: -CD - 1.38, y0: 0, y1: 5.2 });
  const b = k.build();
  return { ...b, foot: [-CW - 0.5, -CD - 2.2, CW + 2.6, S1 + 0.6], footing: 'plinth', apron: true };
}

/** The hall: a weatherboard gable end to the road, a little portico. */
function hall() {
  const k = new Kit();
  const W = 5, D = 8, H = 4.2;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, null, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.gableZ(-W, W, -D, D, H, H + 3.0, 0.4, 0xffffff);
  k.box(-1.9, -0.1, -D - 2.2, 1.9, 0.05, -D, COL.concrete);
  for (const x of [-1.7, 1.7]) k.box(x - 0.12, 0, -D - 2.1, x + 0.12, 3.0, -D - 1.86, COL.white);
  k.gableZ(-2.0, 2.0, -D - 2.3, -D, 3.0, 4.1, 0.15, 0xffffff, COL.white, 0);
  k.box(-0.9, 0, -D - 0.02, 0.9, 2.5, -D, [null, null, null, null, null, COL.door]);
  for (const z of [-5, -1.7, 1.7, 5]) { k.win('x+', z, 2.0, 1.1, 2.0, W, 3); k.win('x-', z, 2.0, 1.1, 2.0, -W, 3); }
  k.win('z-', -3.2, 2.0, 1.1, 2.0, -D, 3);
  k.win('z-', 3.2, 2.0, 1.1, 2.0, -D, 3);
  k.sign('HALL', 'hall', 0, 5.2, -D - 0.03, 2.6, 0.6);
  k.lamp(0, 2.9, -D - 1.6, 10, 3);
  k.solid({ type: 'box', x0: -W, z0: -D - 2.2, x1: W, z1: D, y0: -1, y1: H + 3 });
  const b = k.build();
  return { ...b, foot: [-W - 0.6, -D - 2.8, W + 0.6, D + 0.6], footing: 'plinth' };
}

/** A small timber church: steep gable, a belfry with a spire. */
function church() {
  const k = new Kit();
  const W = 3.8, D = 7, H = 3.8;
  k.box(-W, 0, -D, W, H, D, [0xffffff, 0xffffff, null, null, 0xffffff, 0xffffff], [2, 2, 0, 0, 2, 2]);
  k.gableZ(-W, W, -D, D, H, H + 4.0, 0.35, 0xffffff);
  /* The belfry, astride the ridge at the front, and its spire. */
  k.box(-1.0, H + 3.0, -D + 0.3, 1.0, H + 5.6, -D + 2.3, 0xffffff, 2);
  k.box(-0.7, H + 4.3, -D + 0.28, 0.7, H + 5.2, -D + 0.3, [null, null, null, null, null, COL.dark]);
  k.cone(0, -D + 1.3, H + 5.6, H + 8.6, 1.35, 0.02, 0xffffff, 4, 1);
  k.box(-1.1, -0.1, -D - 1.6, 1.1, 0.05, -D, COL.concrete);
  k.gableZ(-1.2, 1.2, -D - 1.7, -D, 2.6, 3.6, 0.12, 0xffffff, 0xffffff, 2);
  for (const x of [-1.05, 1.05]) k.box(x - 0.1, 0, -D - 1.6, x + 0.1, 2.6, -D - 1.4, COL.white);
  k.box(-0.6, 0, -D - 0.02, 0.6, 2.4, -D, [null, null, null, null, null, COL.door]);
  for (const z of [-4.5, -1.5, 1.5, 4.5]) { k.win('x+', z, 2.0, 0.7, 2.0, W, 3); k.win('x-', z, 2.0, 0.7, 2.0, -W, 3); }
  k.lamp(0, 2.5, -D - 1.2, 8, 3);
  k.solid({ type: 'box', x0: -W, z0: -D - 1.6, x1: W, z1: D, y0: -1, y1: H + 4 });
  const b = k.build();
  return { ...b, foot: [-W - 0.6, -D - 2.2, W + 0.6, D + 0.6], footing: 'plinth' };
}

/** The woolshed: long, raised on stumps, corrugated iron, with yards. */
function woolshed() {
  const k = new Kit();
  const W = 14, D = 5.5, H = 3.4;
  k.box(-W, 0, -D, W, H, D, [COL.iron, COL.iron, null, COL.darkTimber, COL.iron, COL.iron]);
  k.gableX(-W, W, -D, D, H, H + 2.6, 0.4, COL.rust, COL.iron, 0);
  /* The lean-to along the back, and the board-room door at one end. */
  k.box(-W, -1.0, D, W * 0.4, 2.4, D + 4.5, [COL.iron, COL.iron, null, null, COL.iron, null]);
  k.skillion(-W - 0.2, W * 0.4 + 0.2, D, D + 4.7, 2.9, 2.3, COL.rust);
  k.box(-W - 0.02, 0.2, -1.2, -W, 2.4, 1.2, [null, COL.dark, null, null, null, null]);
  for (const x of [-9, -3, 3, 9]) k.box(x - 1.1, 0.8, -D - 0.02, x + 1.1, 1.9, -D, [null, null, null, null, null, COL.dark]);
  /* Yards: post and three rails, in front and off to one side. */
  const Y0 = -D - 12, Y1 = -D - 2, X0 = -W, X1 = -W + 16;
  const ys = [-0.7, -0.3, 0.1];
  const run = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      k.box(x - 0.08, -1.6, z - 0.08, x + 0.08, 0.35, z + 0.08, COL.timber);
    }
    for (const y of ys) k.beam([ax, y, az], [bx, y, bz], 0.06, 0.14, COL.timber);
  };
  run(X0, Y0, X1, Y0); run(X0, Y0, X0, Y1); run(X1, Y0, X1, Y1); run(X0 + 8, Y0, X0 + 8, Y1);
  k.solid({ type: 'box', x0: -W, z0: -D, x1: W, z1: D + 4.5, y0: -2, y1: H + 2.6 });
  for (const [ax, az, bx, bz] of [[X0, Y0, X1, Y0], [X0, Y0, X0, Y1], [X1, Y0, X1, Y1]]) {
    k.solid({ type: 'box', x0: Math.min(ax, bx) - 0.1, z0: Math.min(az, bz) - 0.1, x1: Math.max(ax, bx) + 0.1,
              z1: Math.max(az, bz) + 0.1, y0: -1.6, y1: 0.4, low: true });
  }
  const b = k.build();
  return { ...b, foot: [-W - 0.6, -D - 12.6, W + 0.6, D + 5], footing: 'stumps', floorLift: 1.0,
           stumps: grid([-13.6, -9, -4.5, 0, 4.5, 9, 13.6], [-5.2, 0, 5.2]) };
}

/** Two concrete silos, their cones, and the conveyor that fills them. */
function silos() {
  const k = new Kit();
  const R = 3.6, H = 17;
  for (const x of [-4.2, 4.2]) {
    k.cyl(x, 0, 0, H, R, COL.concrete, 16, 0, false);
    k.cone(x, 0, H, H + 2.8, R + 0.1, 0.5, COL.zinc, 16, 1);
    k.cyl(x, 0, H + 2.8, H + 3.6, 0.5, COL.steel, 8);
    k.solid({ type: 'cyl', x, z: 0, r: R, y0: -1, y1: H + 2.8 });
  }
  k.box(-4.2, H + 3.3, -0.4, 4.2, H + 3.7, 0.4, COL.steel);
  k.beam([12, 0.5, -6], [4.2, H + 3.4, -0.4], 0.8, 0.5, COL.steel);
  k.beam([11, 0, -6], [11, 3, -6], 0.25, 0.25, COL.steel);
  k.box(9, 0, -9.5, 15, 3.2, -5.5, [COL.iron, COL.iron, null, null, COL.iron, COL.iron]);
  k.gableX(9, 15, -9.5, -5.5, 3.2, 4.2, 0.25, COL.zinc, COL.iron, 0);
  k.solid({ type: 'box', x0: 9, z0: -9.5, x1: 15, z1: -5.5, y0: -1, y1: 4.2 });
  const b = k.build();
  return { ...b, foot: [-8.4, -10, 15.6, 4.2], footing: 'ring', rings: [[-4.2, 0, R + 0.4], [4.2, 0, R + 0.4]] };
}

/** A windmill on its lattice tower, and the tank and trough it fills.
 *  The blades are a separate geometry so they can turn. */
function windmill() {
  const k = new Kit();
  const T = 10;
  const legs = [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]];
  for (const [x, z] of legs) k.beam([x, -0.5, z], [x * 0.2, T, z * 0.2], 0.12, 0.12, COL.steel);
  for (const y of [2.5, 5.2, 7.8]) {
    const s = 1 - (y / T) * 0.8;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
      k.beam([ax * s, y, az * s], [bx * s, y, bz * s], 0.07, 0.07, COL.steel);
    }
  }
  k.box(-0.5, T, -0.5, 0.5, T + 0.15, 0.5, COL.steel);
  k.box(-0.25, T + 0.15, -0.6, 0.25, T + 0.65, 0.4, COL.dark);
  /* The tail vane, pointing away from the blades. */
  k.beam([0, T + 0.4, 0.3], [0, T + 0.4, 2.8], 0.08, 0.08, COL.steel);
  k.box(-0.03, T - 0.2, 2.2, 0.03, T + 1.1, 3.6, COL.blade);
  k.cyl(7, 2, -0.4, 2.4, 3.1, COL.tank, 16);
  k.box(3.2, -0.3, -2.6, 6.2, 0.55, -1.8, COL.concrete);
  k.solid({ type: 'cyl', x: 7, z: 2, r: 3.1, y0: -1, y1: 2.4 });
  k.solid({ type: 'box', x0: -1.6, z0: -1.6, x1: 1.6, z1: 1.6, y0: -0.5, y1: T });
  const b = k.build();
  /* Blades: twelve thin sails round a hub, facing -z, centred on the hub. */
  const bk = new Kit();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const r0 = 0.35, r1 = 1.75, w0 = 0.12, w1 = 0.36;
    const P = (r, w) => [c * r - s * w, s * r + c * w, 0];
    bk.quad(P(r0, -w0), P(r1, -w1), P(r1, w1), P(r0, w0), COL.blade, 0, [0, 0, -1]);
    bk.quad(P(r0, -w0), P(r0, w0), P(r1, w1), P(r1, -w1), COL.steel, 0, [0, 0, 1]);
  }
  bk.box(-0.18, -0.18, -0.15, 0.18, 0.18, 0.1, COL.dark);
  return { ...b, blades: bk.build().geo, hub: [0, T + 0.4, -0.75], foot: [-2.2, -2.8, 10.6, 5.6], footing: 'none',
           spread: 1.2 };
}

/** A lookout: a gravel pad, a rail, a bench, and its sign. */
function lookout() {
  const k = new Kit();
  k.box(-7, -0.6, -4, 7, 0.06, 5, [COL.gravel, COL.gravel, COL.gravel, null, COL.gravel, COL.gravel]);
  const rail = (ax, az, bx, bz) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      k.box(x - 0.07, -0.4, z - 0.07, x + 0.07, 1.0, z + 0.07, COL.timber);
    }
    k.beam([ax, 0.95, az], [bx, 0.95, bz], 0.1, 0.1, COL.timber);
    k.beam([ax, 0.5, az], [bx, 0.5, bz], 0.06, 0.08, COL.timber);
  };
  rail(-6.8, 4.8, 6.8, 4.8); rail(-6.8, 1, -6.8, 4.8); rail(6.8, 1, 6.8, 4.8);
  k.box(-1.2, 0.06, 2.6, 1.2, 0.45, 3.0, COL.timber);
  for (const x of [-1, 1]) k.box(x - 0.06, 0, 2.7, x + 0.06, 0.45, 2.9, COL.darkTimber);
  k.box(-6.4 - 0.08, 0, -3.4 - 0.08, -6.4 + 0.08, 2.3, -3.4 + 0.08, COL.timber);
  k.sign('LOOKOUT', 'brown', -6.4, 2.0, -3.4 - 0.12, 1.9, 0.5);
  for (const [ax, az, bx, bz] of [[-6.8, 4.8, 6.8, 4.8], [-6.8, 1, -6.8, 4.8], [6.8, 1, 6.8, 4.8]]) {
    k.solid({ type: 'box', x0: Math.min(ax, bx) - 0.1, z0: Math.min(az, bz) - 0.1, x1: Math.max(ax, bx) + 0.1,
              z1: Math.max(az, bz) + 0.1, y0: -0.4, y1: 1.0, low: true });
  }
  const b = k.build();
  return { ...b, foot: [-7.4, -4.4, 7.4, 5.4], footing: 'none', spread: 1.8 };
}

/** The war memorial: a stepped plinth and an obelisk, at the middle of
 *  town, with a low post-and-chain fence round it. */
function memorial() {
  const k = new Kit();
  k.box(-2.4, -0.8, -2.4, 2.4, 0.3, 2.4, COL.sandstone);
  k.box(-1.6, 0.3, -1.6, 1.6, 0.9, 1.6, COL.sandstone);
  k.box(-0.95, 0.9, -0.95, 0.95, 2.4, 0.95, COL.sandstone);
  k.box(-1.1, 2.4, -1.1, 1.1, 2.6, 1.1, COL.sandstone);
  k.cone(0, 0, 2.6, 7.4, 0.78, 0.4, COL.sandstone, 4);
  k.cone(0, 0, 7.4, 8.2, 0.4, 0.0, COL.sandstone, 4);
  for (const [x, z] of [[-4, -4], [4, -4], [4, 4], [-4, 4]]) k.box(x - 0.1, -0.5, z - 0.1, x + 0.1, 0.6, z + 0.1, COL.white);
  k.solid({ type: 'box', x0: -2.4, z0: -2.4, x1: 2.4, z1: 2.4, y0: -0.8, y1: 8 });
  const b = k.build();
  return { ...b, foot: [-4.4, -4.4, 4.4, 4.4], footing: 'plinth' };
}

/** A street light: a pole, an arm out over the road (-z), a head. */
function streetLight() {
  const k = new Kit();
  k.cyl(0, 0, -0.5, 7.4, 0.09, COL.steel, 6);
  k.beam([0, 7.2, 0], [0, 7.6, -2.1], 0.08, 0.08, COL.steel);
  k.box(-0.18, 7.42, -2.6, 0.18, 7.62, -1.8, COL.dark);
  k.lamp(0, 7.3, -2.2, 16, 1);
  k.solid({ type: 'cyl', x: 0, z: 0, r: 0.12, y0: -0.5, y1: 7.4 });
  const b = k.build();
  return { ...b, foot: [-0.3, -0.3, 0.3, 0.3], footing: 'none' };
}

/* ------------------------------ helpers ------------------------------ */

function grid(xs, zs) {
  const out = [];
  for (const x of xs) for (const z of zs) out.push([x, z]);
  return out;
}

/** A front veranda from the wall at `z0` out to `z1`, with posts, a rail
 *  and a skillion roof, and steps in the middle. */
function verandaFront(k, x0, x1, z0, z1, y) {
  k.box(x0, -0.15, z1, x1, 0, z0, COL.deck);
  k.skillion(x0 - 0.2, x1 + 0.2, z0, z1 - 0.2, y + 0.25, y - 0.15, 0xffffff);
  const n = Math.max(2, Math.round((x1 - x0) / 3.2));
  for (let i = 0; i <= n; i++) {
    const x = x0 + 0.1 + (x1 - x0 - 0.2) * i / n;
    k.box(x - 0.07, 0, z1 + 0.03, x + 0.07, y - 0.15, z1 + 0.17, COL.white);
  }
  const zr = z1 + 0.1;
  k.beam([x0 + 0.1, 0.9, zr], [-0.8, 0.9, zr], 0.06, 0.08, COL.white);
  k.beam([0.8, 0.9, zr], [x1 - 0.1, 0.9, zr], 0.06, 0.08, COL.white);
  steps(k, 0, z1, 1.6);
}

/** Steps down from a deck edge at `z` toward -z, `w` wide.  They run a
 *  metre and a bit below the floor; the stumps make up the rest. */
function steps(k, x, z, w) {
  for (let i = 0; i < 4; i++) {
    k.box(x - w / 2, -0.15 - 0.3 * (i + 1), z - 0.32 * (i + 1), x + w / 2, -0.15 - 0.3 * i, z - 0.32 * i,
      [COL.timber, COL.timber, COL.deck, null, null, COL.timber]);
  }
}

/** The ends of the farmhouse veranda: the same deck turned along the
 *  sides, and the roof sheet over each. */
function endVeranda(k, W, D, V, H, y, side) {
  const x0 = side > 0 ? W : -W, x1 = side > 0 ? W + V : -W - V;
  /* A skillion sloping out along x: written as a quad directly, since the
   * kit's own skillion slopes along z. */
  k.quad([x0, H - 0.05, -D], [x0, H - 0.05, D], [x1 + 0.2 * side, y - 0.35, D], [x1 + 0.2 * side, y - 0.35, -D],
    0xffffff, 1, [0.3 * side, 1, 0]);
  k.quad([x0, H - 0.15, -D], [x1 + 0.2 * side, y - 0.45, -D], [x1 + 0.2 * side, y - 0.45, D], [x0, H - 0.15, D],
    COL.soffit, 0, [0, -1, 0]);
}

/* ------------------------------------------------------------------ *
 * The set, built once.
 * ------------------------------------------------------------------ */

let ARCH = null;

/** Every archetype, by name.  Built on first call. */
export function archetypes() {
  if (ARCH) return ARCH;
  ARCH = {
    houseHip: houseHip(), houseGable: houseGable(), cottage: cottage(),
    farmhouse: farmhouse(), shed: shed(), pub: pub(), servo: servo(),
    hall: hall(), church: church(), woolshed: woolshed(), silos: silos(),
    windmill: windmill(), lookout: lookout(), memorial: memorial(),
    streetLight: streetLight(),
  };
  for (const [name, a] of Object.entries(ARCH)) a.name = name;
  return ARCH;
}

/** The houses a town and a farm choose from. */
export const HOUSES = ['houseHip', 'houseGable', 'cottage'];

/** A unit box, centred in x and z, from y 0 to 1: a stump, a plinth, a
 *  post, a sign's back -- anything that is scaled per instance. */
export function unitBox(hex) {
  const k = new Kit();
  k.box(-0.5, 0, -0.5, 0.5, 1, 0.5, hex);
  return k.build().geo;
}

/** A unit cylinder, likewise: a ring footing. */
export function unitCyl(hex) {
  const k = new Kit();
  k.cyl(0, 0, 0, 1, 1, hex, 16);
  return k.build().geo;
}
