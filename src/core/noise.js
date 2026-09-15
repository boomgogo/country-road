import { mulberry32, hash3 } from './rng.js';

/* ------------------------------------------------------------------ *
 * The heightmap generator.
 *
 * Gradient (Perlin) noise on an infinite grid of independently seeded
 * cells, with four deliberate departures from textbook fBm.  Each of the
 * four is doing visible work, so they are worth naming here rather than
 * leaving as parameters someone later "cleans up":
 *
 *  1. Octave resolutions are an explicit list -- [3, 12, 24] -- not a
 *     doubling.  The spectrum is chosen, and the gaps are wider than
 *     frequency doubling would give.
 *
 *  2. Amplitude falls off HARMONICALLY, 1/(d+1): 1, 1/2, 1/3.  Textbook
 *     fBm would use 1/2, 1/4, 1/8.  Fine detail therefore carries far
 *     more weight, and that is most of what makes the ground read as
 *     rough country rather than smooth dunes.
 *
 *  3. Interpolation is LINEAR, not smoothstep.  It leaves faint creases
 *     along the lattice lines, and that slight angularity is what keeps
 *     the hills from looking inflated.
 *
 *  4. An S-shaped remap before scaling, `h*h*(1-h)*4` (mirrored for
 *     negatives), which flattens the extremes and stretches the middle.
 *     Broad valley floors, broad tops, steep ground in between.
 *
 * Cells are generated on demand and cached, which is what lets the world
 * be infinite and still a pure function of the seed.
 * ------------------------------------------------------------------ */

export const DEFAULT_TOPO = {
  heightScale: 160,
  heightOffset: 95,
  resolutions: [3, 12, 24],
  squared: true,
  /** World size of one lattice cell, metres.  With [3, 12, 24] this puts
   *  the three octaves at 1500 m, 375 m and 188 m.
   *
   *  This is the single most consequential parameter in the project, because it sets
   *  how steep the land is and therefore how hard the road has to work.
   *  Chosen against `tools/tracesweep.mjs` over 24 seeds x 12 km: 6000
   *  traces almost straight roads (median turn 0.009 rad/node, a 1.1 km
   *  radius), 3500 winds well but reverts eight times a road and drops
   *  route efficiency to 0.75.  4500 sits between them -- median turn
   *  0.014 rad, 95th percentile 0.10 (a 99 m corner), 0.3 reverts, no
   *  failures. */
  cellSize: 4500,

  /** Broad low ground, so there is water to avoid.  See `base()`. */
  basinCell: 26000,
  basinAmp: 95,
  basinThreshold: -0.08,
  basinRange: 0.34,
};

export class Heightmap {
  constructor(seed = 1, topo = {}) {
    const t = { ...DEFAULT_TOPO, ...topo };
    this.seed = seed >>> 0;
    this.heightScale = t.heightScale;
    this.heightOffset = t.heightOffset;
    this.resolutions = t.resolutions;
    this.squared = t.squared;
    this.cellSize = t.cellSize;
    this.basinCell = t.basinCell;
    this.basinAmp = t.basinAmp;
    this.basinThreshold = t.basinThreshold;
    this.basinRange = t.basinRange;
    this.depth = this.resolutions.length;
    /** How many octaves the road tracer is allowed to see.  The midline is
     *  surveyed against the large-scale landform and is deliberately blind
     *  to the detail octaves -- otherwise it swerves around every hummock. */
    this.midlineDepth = Math.min(2, this.depth);
    this.cells = new Map();
    this.cellLimit = 4096;
  }

  /** One cell's stack of gradient lattices, generated on demand. */
  cell(cx, cz) {
    const key = cx * 73856093 ^ cz * 19349663;
    let c = this.cells.get(key);
    if (c !== undefined) return c;
    const rand = mulberry32(hash3(cx, 0, cz, this.seed));
    c = [];
    for (let d = 0; d < this.depth; d++) {
      const r = this.resolutions[d];
      const g = new Float32Array(r * r * 2);
      for (let i = 0; i < r * r; i++) {
        const a = rand() * Math.PI * 2;
        g[i * 2] = Math.cos(a);
        g[i * 2 + 1] = Math.sin(a);
      }
      c.push(g);
    }
    if (this.cells.size > this.cellLimit) this.cells.clear();
    this.cells.set(key, c);
    return c;
  }

  /**
   * Perlin corner dot.  `i`/`j` may be exactly `r`, which is the next
   * cell's index 0 -- the lattices stay independent per cell and still
   * join seamlessly, because the shared corner is the same gradient
   * fetched from whichever side asks for it.
   */
  _dot(cx, cz, d, i, j, sx, sz) {
    const r = this.resolutions[d];
    let ccx = cx, ccz = cz, ii = i, jj = j;
    if (ii >= r) { ii -= r; ccx += 1; }
    if (jj >= r) { jj -= r; ccz += 1; }
    const g = this.cell(ccx, ccz)[d];
    const k = (jj * r + ii) * 2;
    return (sx - i) * g[k] + (sz - j) * g[k + 1];
  }

  /**
   * One octave of the same lattice at a much larger scale, on its own
   * seed.  Used only for the basin field below.
   */
  _wide(x, z) {
    const cs = this.basinCell;
    const wx = x / cs, wz = z / cs;
    const ox = Math.floor(wx), oz = Math.floor(wz);
    const px = wx - ox, pz = wz - oz;
    // borrow octave 0's lattice from a cell grid offset far away, so the
    // basin field is independent of the terrain it sinks
    const r = this.resolutions[0];
    const sx = px * r, sz = pz * r;
    const ix = Math.floor(sx), iz = Math.floor(sz);
    const qx = sx - ix, qz = sz - iz;
    const O = 0x5f3a;
    const n00 = this._dot(ox + O, oz + O, 0, ix, iz, sx, sz);
    const n10 = this._dot(ox + O, oz + O, 0, ix + 1, iz, sx, sz);
    const n01 = this._dot(ox + O, oz + O, 0, ix, iz + 1, sx, sz);
    const n11 = this._dot(ox + O, oz + O, 0, ix + 1, iz + 1, sx, sz);
    const i0 = n00 + (n10 - n00) * qx;
    const i1 = n01 + (n11 - n01) * qx;
    return i0 + (i1 - i0) * qz;
  }

  /** Raw shaped noise in world units, before the road is blended in. */
  base(x, z, maxDepth) {
    const depth = maxDepth === undefined ? this.depth : Math.min(maxDepth, this.depth);
    const wx = x / this.cellSize, wz = z / this.cellSize;
    const ox = Math.floor(wx), oz = Math.floor(wz);
    const px = wx - ox, pz = wz - oz;
    let h = 0;

    for (let d = 0; d < depth; d++) {
      const r = this.resolutions[d];
      const sx = px * r, sz = pz * r;
      const ix = Math.floor(sx), iz = Math.floor(sz);
      const qx = sx - ix, qz = sz - iz;

      const n00 = this._dot(ox, oz, d, ix, iz, sx, sz);
      const n10 = this._dot(ox, oz, d, ix + 1, iz, sx, sz);
      const n01 = this._dot(ox, oz, d, ix, iz + 1, sx, sz);
      const n11 = this._dot(ox, oz, d, ix + 1, iz + 1, sx, sz);

      // linear, on purpose -- see note 3 at the top of the file
      const i0 = n00 + (n10 - n00) * qx;
      const i1 = n01 + (n11 - n01) * qx;
      h += (i0 + (i1 - i0) * qz) / (d + 1);
    }

    if (this.squared) {
      h = h < 0 ? h * -h * (1 + h) * 4 : h * h * (1 - h) * 4;
    }
    h = h * this.heightScale + this.heightOffset;

    /* Basins.  The shaped noise on its own puts under half a percent of
     * the world below the water line, which is not enough water for the
     * tracer's avoidance to ever be exercised, let alone seen.  A single
     * very-wide octave pulls broad connected regions down instead of
     * speckling puddles across the hills -- a lake wants to be somewhere
     * you drive around for a minute, not a wet patch. */
    if (this.basinAmp > 0) {
      const b = this._wide(x, z);
      const t = (this.basinThreshold - b) / this.basinRange;
      if (t > 0) {
        const s = t >= 1 ? 1 : t * t * (3 - 2 * t);
        h -= this.basinAmp * s;
      }
    }
    return h;
  }
}
