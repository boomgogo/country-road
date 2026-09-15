import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Every texture in the project, drawn at runtime.
 *
 * Not one image asset, for two reasons.  The first is that every texture
 * is then ours, tunable in code, and seasonal for free.  The second is
 * that the sibling project proves it is not a hardship -- 4 530 lines of
 * Canvas2D and no images at all.
 *
 * Everything here is tileable.  A texture that does not wrap is a
 * texture with a seam every eight metres, and on ground that stretches to
 * the horizon that seam is a grid, and a grid is the single most reliable
 * way to announce that a landscape was generated.
 * ------------------------------------------------------------------ */

const cache = new Map();
let anisotropy = 8;

export function setAnisotropy(n) { anisotropy = Math.max(1, n | 0); }

function make(key, size, draw, opts = {}) {
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.colorSpace = opts.data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.needsUpdate = true;
  cache.set(key, t);
  return t;
}

/* ---------------------------- tileable noise ---------------------------- */

/** Value noise on a wrapping lattice.  `res` cells across the whole tile. */
function lattice(res, seed) {
  const a = new Float32Array(res * res);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    a[i] = (s >>> 8) / 16777216;
  }
  return a;
}

function sampleLattice(a, res, x, y) {
  const fx = x * res, fy = y * res;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const i0 = ((iy % res) + res) % res, i1 = (i0 + 1) % res;
  const j0 = ((ix % res) + res) % res, j1 = (j0 + 1) % res;
  const v00 = a[i0 * res + j0], v10 = a[i0 * res + j1];
  const v01 = a[i1 * res + j0], v11 = a[i1 * res + j1];
  return (v00 + (v10 - v00) * sx) * (1 - sy) + (v01 + (v11 - v01) * sx) * sy;
}

/** Tileable fBm in [0,1], written into a Float32Array of size*size. */
export function fbmField(size, { octaves = 4, base = 4, gain = 0.5, seed = 1 } = {}) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, res = base;
  for (let o = 0; o < octaves; o++) {
    const lat = lattice(res, seed + o * 7919);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out[y * size + x] += amp * sampleLattice(lat, res, x / size, y / size);
      }
    }
    total += amp;
    amp *= gain;
    res *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * The same lattice, in three dimensions, tiling in all of them.
 *
 * `clouds.js` needs a *volume* to erode with: the cloud silhouette is a 2D
 * field and extruding it reads as extruded, which is exactly what
 * `prompt_5.md` item 5 says about the current sky and what `clouds.js`'s
 * own comment predicted -- "if it ever reads as extruded rather than as
 * cloud, this is the line to replace with a 32^3 texture".
 *
 * 64^3 of one channel is 256 kB and takes about 40 ms to build at boot.
 * Tileable in every axis, so the march can sample it at any world position
 * without a seam.
 */
export function fbmVolume(size, { octaves = 3, base = 4, gain = 0.5, seed = 1 } = {}) {
  const out = new Float32Array(size * size * size);
  let amp = 1, total = 0, res = base;
  for (let o = 0; o < octaves; o++) {
    const lat = lattice3(res, seed + o * 6151);
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          out[(z * size + y) * size + x] +=
            amp * sampleLattice3(lat, res, x / size, y / size, z / size);
        }
      }
    }
    total += amp;
    amp *= gain;
    res *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function lattice3(res, seed) {
  const a = new Float32Array(res * res * res);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    a[i] = (s >>> 8) / 16777216;
  }
  return a;
}

function sampleLattice3(a, res, x, y, z) {
  const fx = x * res, fy = y * res, fz = z * res;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const sz = tz * tz * (3 - 2 * tz);
  const w = (i) => ((i % res) + res) % res;
  const x0 = w(ix), x1 = w(ix + 1);
  const y0 = w(iy), y1 = w(iy + 1);
  const z0 = w(iz), z1 = w(iz + 1);
  const at = (zz, yy, xx) => a[(zz * res + yy) * res + xx];
  const lerp = (p, q, t) => p + (q - p) * t;
  const b00 = lerp(at(z0, y0, x0), at(z0, y0, x1), sx);
  const b10 = lerp(at(z0, y1, x0), at(z0, y1, x1), sx);
  const b01 = lerp(at(z1, y0, x0), at(z1, y0, x1), sx);
  const b11 = lerp(at(z1, y1, x0), at(z1, y1, x1), sx);
  return lerp(lerp(b00, b10, sy), lerp(b01, b11, sy), sz);
}

/* ------------------------- Worley, and why -------------------------- *
 *
 * Value-noise fBm erodes a cloud into *smoke*.  Every reference in
 * `ref/cloud/` is made of rounded lumps with sharp gaps between them, and
 * a sum of smoothed lattices has neither: its level sets are blobby in the
 * middle and blobby at the edge, so subtracting it from a silhouette
 * thins the cloud evenly and reads as fog with a shape.
 *
 * Worley (cellular) noise is the standard answer and has been since
 * Schneider's Horizon cloud talk -- `~/Repos/others/three-geospatial`
 * builds exactly this pair of volumes in `cloudShape.frag` and
 * `cloudShapeDetail.frag`, and its clouds billow where ours smear.  What
 * makes it work is that **inverted** Worley (`1 - d^2` to the nearest
 * feature point) is a field of round bumps that meet at creases: erode
 * with it and you carve *cauliflower*, because the level sets themselves
 * are spherical.
 *
 * Both volumes are built on the CPU at boot rather than in a render
 * target, because everything else in this project's noise is (`fbmField`,
 * `fbmVolume`) and because the probes read the same arrays the GPU does.
 * Cost is measured in `CloudField`'s constructor and printed under
 * `?debug`.
 * ------------------------------------------------------------------- */

/**
 * One feature point per cell of a wrapping `c^3` lattice, in cell units.
 *
 * A point *per cell* rather than a random scatter is what makes this
 * tileable and O(27) per voxel: the nearest feature point to any voxel is
 * in one of the 27 cells around it, and the modulo makes the lattice wrap.
 */
function worleyPoints(c, seed) {
  const p = new Float32Array(c * c * c * 3);
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s >>> 8) / 16777216;
  };
  for (let i = 0; i < c * c * c; i++) {
    p[i * 3] = next(); p[i * 3 + 1] = next(); p[i * 3 + 2] = next();
  }
  return p;
}

/**
 * `out[i] += amp * (1 - min(1, d2))`, i.e. amplitude times *inverted*
 * Worley, over a `size^3` volume with `c` cells to a side.
 *
 * `d2` is the squared distance to the nearest feature point in cell units,
 * which is what three-geospatial's `getWorleyNoise` returns and is worth
 * keeping: the square puts the gradient at zero on the bump's crown and
 * steep in the crease, which is the shape of a billow.
 */
function worleyInto(out, size, c, seed, amp) {
  const pts = worleyPoints(c, seed);
  const step = c / size;
  for (let z = 0; z < size; z++) {
    const cz = z * step, iz = Math.floor(cz);
    for (let y = 0; y < size; y++) {
      const cy = y * step, iy = Math.floor(cy);
      const row = (z * size + y) * size;
      for (let x = 0; x < size; x++) {
        const cx = x * step, ix = Math.floor(cx);
        let best = 1e9;
        for (let dz = -1; dz <= 1; dz++) {
          const wz = (((iz + dz) % c) + c) % c;
          const pz = iz + dz;
          for (let dy = -1; dy <= 1; dy++) {
            const wy = (((iy + dy) % c) + c) % c;
            const py = iy + dy;
            const base = (wz * c + wy) * c;
            for (let dx = -1; dx <= 1; dx++) {
              const wx = (((ix + dx) % c) + c) % c;
              const j = (base + wx) * 3;
              const ex = ix + dx + pts[j] - cx;
              const ey = py + pts[j + 1] - cy;
              const ez = pz + pts[j + 2] - cz;
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 < best) best = d2;
            }
          }
        }
        out[row + x] += amp * (1 - (best > 1 ? 1 : best));
      }
    }
  }
}

/** Inverted-Worley fBm in [0,1]: `cells` doubling per octave. */
function worleyFbm(size, cells, octaves, seed) {
  const out = new Float32Array(size * size * size);
  let amp = 1, total = 0, c = cells;
  for (let o = 0; o < octaves; o++) {
    worleyInto(out, size, c, seed + o * 4211, amp);
    total += amp;
    amp *= 0.5;
    c *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * The **shape** volume: Perlin-Worley, one channel, in [0,1].
 *
 * `remap(perlin, worleyFbm - 1, 1)` is Schneider's construction and
 * three-geospatial's `cloudShape.frag` reproduces it exactly.  What it
 * does is use the Worley fBm as a *floor* that varies in space: where the
 * cells are dense the floor is high and the Perlin field is compressed
 * against the top of the range, so the volume is solid; where they are
 * sparse the floor drops and the Perlin variation shows through.  The
 * result has round lumps (Worley) which are themselves lumpy (Perlin),
 * which is what a cumulus is made of and what a plain fBm never gives.
 */
export function perlinWorleyVolume(size, { cells = 4, seed = 1 } = {}) {
  const perlin = fbmVolume(size, { octaves: 3, base: cells * 2, seed: seed ^ 0x71c3 });
  const wf = worleyFbm(size, cells * 2, 3, seed ^ 0x2f19);
  const out = new Float32Array(size * size * size);
  for (let i = 0; i < out.length; i++) {
    /* getPerlinWorley: the Worley fBm is the floor the Perlin sits on. */
    const pw = wf[i] + perlin[i] * (1 - wf[i]);
    /* ... and the outer remap stretches the result back over the range,
     * which is what keeps the volume's histogram wide enough to erode
     * with. */
    out[i] = clamp01((pw - wf[i] + 1) / (2 - wf[i]));
  }
  return out;
}

/**
 * The **detail** volume: Worley fBm alone, in [0,1].
 *
 * No Perlin in it, because this one is not a shape -- it is the fringe,
 * and a fringe wants to be all creases.  32^3 is plenty: it is sampled at
 * an eighth of the shape volume's world scale, so its finest cell is about
 * fifteen metres.
 */
export function worleyDetailVolume(size, { cells = 2, seed = 1 } = {}) {
  /* Three octaves, not four.  The fourth is 44 m across at the world scale
   * `clouds.js` samples this at, and the march's *step* is 55 m at its
   * shortest -- so it was pure aliasing, and it showed as a dark speckle
   * along every lit cloud edge. */
  return worleyFbm(size, cells, 3, seed ^ 0x5b77);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function put(g, size, fn) {
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = fn(x, y, y * size + x);
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/* ------------------------------ the ground ------------------------------ */

/**
 * A ground texture is three fields: a coarse blotch that gives it large
 * shapes, a fine grain that gives it tooth, and a sparse speckle of
 * something else -- stones in the grass, lichen on the rock.  All three
 * are needed; drop the coarse one and it reads as sandpaper.
 */
function groundTex(key, size, cfg) {
  return make(key, size, (g) => {
    const coarse = fbmField(size, { octaves: 3, base: cfg.coarseBase, seed: cfg.seed });
    const fine = fbmField(size, { octaves: 4, base: cfg.fineBase, seed: cfg.seed + 101 });
    const spot = fbmField(size, { octaves: 2, base: cfg.spotBase, seed: cfg.seed + 202 });
    put(g, size, (x, y, i) => {
      const c = coarse[i], f = fine[i], s = spot[i];
      let t = cfg.mix(c, f, s, x, y);
      const out = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        out[k] = clamp255(cfg.a[k] + (cfg.b[k] - cfg.a[k]) * t);
      }
      if (cfg.speck && s > cfg.speck.at) {
        const w = Math.min(1, (s - cfg.speck.at) / cfg.speck.soft);
        for (let k = 0; k < 3; k++) {
          out[k] = clamp255(out[k] + (cfg.speck.c[k] - out[k]) * w);
        }
      }
      return out;
    });
  });
}

export const TEX = {
  grass: () => groundTex('grass', 512, {
    seed: 11, coarseBase: 3, fineBase: 24, spotBase: 12,
    a: [104, 118, 60], b: [170, 176, 108],
    mix: (c, f, s) => 0.55 * c + 0.38 * f + 0.07 * s,
    speck: { at: 0.72, soft: 0.22, c: [176, 178, 112] },
  }),
  grassDry: () => groundTex('grassDry', 512, {
    seed: 23, coarseBase: 3, fineBase: 22, spotBase: 10,
    a: [138, 140, 82], b: [200, 194, 134],
    mix: (c, f, s) => 0.5 * c + 0.42 * f + 0.08 * s,
    speck: { at: 0.76, soft: 0.2, c: [202, 194, 140] },
  }),
  heather: () => groundTex('heather', 512, {
    seed: 37, coarseBase: 4, fineBase: 20, spotBase: 8,
    a: [86, 76, 66], b: [122, 104, 96],
    mix: (c, f, s) => 0.6 * c + 0.32 * f + 0.08 * s,
    speck: { at: 0.70, soft: 0.26, c: [128, 100, 116] },
  }),
  /* Rock is the one ground texture that is not isotropic.  Sedimentary
   * faces are *banded*, and a cutting of "uniform grey-brown with no
   * strata" reads as clay, not rock.  The bands come from folding a
   * low-frequency ripple into the mix -- one extra term. */
  rock: () => groundTex('rock', 512, {
    seed: 53, coarseBase: 2, fineBase: 16, spotBase: 6,
    a: [88, 83, 77], b: [156, 150, 140],
    mix: (c, f, s, x, y) => {
      /* Strata, but not stripes.  A clean sine in y tiles into regular
       * corduroy the moment the texture is laid over a hillside -- worse
       * than the flat rock it replaced.  Driving the *phase* hard from the
       * coarse field breaks the periodicity while keeping the local sense
       * of layers running along the face. */
      const band = 0.5 + 0.5 * Math.sin((y / 512) * Math.PI * 2 * 4 + c * 26.0 + f * 3.0);
      return 0.46 * c + 0.30 * f + 0.06 * s + 0.18 * band;
    },
    speck: { at: 0.80, soft: 0.16, c: [176, 170, 156] },
  }),
  gravel: () => groundTex('gravel', 512, {
    seed: 71, coarseBase: 6, fineBase: 40, spotBase: 26,
    a: [110, 106, 98], b: [156, 150, 140],
    mix: (c, f, s) => 0.3 * c + 0.55 * f + 0.15 * s,
    speck: { at: 0.66, soft: 0.3, c: [176, 170, 158] },
  }),
  sand: () => groundTex('sand', 512, {
    seed: 89, coarseBase: 3, fineBase: 28, spotBase: 14,
    a: [168, 158, 126], b: [204, 194, 162],
    mix: (c, f, s) => 0.45 * c + 0.48 * f + 0.07 * s,
  }),

  /** Multi-scale blend noise, sampled at three world scales by the shader. */
  fade: () => make('fade', 256, (g, size) => {
    const f = fbmField(size, { octaves: 5, base: 4, seed: 131 });
    put(g, size, (x, y, i) => {
      const v = clamp255(f[i] * 255);
      return [v, v, v];
    });
  }, { data: true }),
};

/* ------------------------------- the road ------------------------------- */

/**
 * The carriageway, markings and all, baked into one tile.
 *
 * The cross-section used to be geometry -- a column of vertices per
 * colour band -- and that had two problems a texture does not: a 15 cm
 * line drawn as two vertices is a 15 cm line only at the exact distance
 * where it is more than a pixel wide, and everything between the bands
 * had to be another pair of columns.  With a texture the mipmap chain
 * does the filtering, anisotropy keeps the lines sharp at grazing angles,
 * and the geometry goes back to being a plain ribbon.
 *
 * `WORLD` is how many metres of road one tile covers along its length.
 */
export const ROAD_TILE_LENGTH = 16;

export function roadTexture(totalWidth) {
  return make('road', 1024, (g, size) => {
    const px = size / totalWidth;                       // pixels per metre across
    const pz = size / ROAD_TILE_LENGTH;                 // pixels per metre along

    // tarmac base, with a longitudinal grain -- tyres wear it that way
    const coarse = fbmField(size, { octaves: 3, base: 4, seed: 5 });
    const fine = fbmField(size, { octaves: 4, base: 48, seed: 6 });
    const streak = fbmField(size, { octaves: 3, base: 2, seed: 7 });
    put(g, size, (x, y, i) => {
      const u = x / size * totalWidth - totalWidth / 2;   // metres from centre
      const half = totalWidth / 2;
      const shoulder = Math.abs(u) > half - 1.1;
      const t = 0.55 * coarse[i] + 0.45 * fine[i];
      /* Lighter than instinct says.  Fresh asphalt is nearly black and
       * weathered asphalt is a mid grey with a blue cast, and a
       * country road is the second -- our first tarmac read as a
       * tar-black stripe through a pale landscape. */
      let base = shoulder
        ? [116 + t * 44, 112 + t * 42, 104 + t * 40]
        : [78 + t * 30, 78 + t * 30, 84 + t * 30];
      if (!shoulder) {
        // two darker wheel tracks, and a lighter crown between them
        const track = Math.min(Math.abs(Math.abs(u) - 1.55) / 0.9, 1);
        const wear = (1 - track) * (0.45 + 0.55 * streak[i]);
        for (let k = 0; k < 3; k++) base[k] *= 1 - 0.16 * wear;
      }
      return base.map(clamp255);
    });

    /* Markings on top, drawn rather than computed, because a 2D context
     * anti-aliases them and hand-rolled per-pixel edges do not. */
    g.lineCap = 'butt';
    const mid = size / 2;
    const half = totalWidth / 2;

    const paint = (xMetres, wMetres, dash) => {
      g.save();
      /* White, and only slightly warm.  It was 226,222,205 -- an ivory that
       * read like a flat unlit material rather than road paint. */
      g.strokeStyle = 'rgba(243,242,238,0.94)';
      g.lineWidth = wMetres * px;
      if (dash) g.setLineDash([dash[0] * pz, dash[1] * pz]);
      g.beginPath();
      g.moveTo(mid + xMetres * px, 0);
      g.lineTo(mid + xMetres * px, size);
      g.stroke();
      g.restore();
    };

    // continuous edge lines, and a broken centre line: 4 m on, 4 m off
    paint(-(half - 1.45), 0.14, null);
    paint(half - 1.45, 0.14, null);
    paint(0, 0.13, [4, 4]);

    // a soft dark line where the tarmac meets the gravel
    g.strokeStyle = 'rgba(38,36,34,0.35)';
    g.lineWidth = 0.10 * px;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(mid + s * (half - 1.1) * px, 0);
      g.lineTo(mid + s * (half - 1.1) * px, size);
      g.stroke();
    }
  });
}

/* -------------------------------- foliage -------------------------------- */

/**
 * A canopy card: an alpha cut-out with clumped leaf mass rather than a
 * solid blob.  Trees are what the eye goes to first, and a flat lozenge
 * of green is the fastest way to lose that look -- the silhouette has to
 * be broken, and the breaks have to be at the *edge*.
 */
export function canopyTexture(kind, palette) {
  return make('canopy-' + kind, 256, (g, size) => {
    g.clearRect(0, 0, size, size);
    const rnd = mulberry(kind === 'conifer' ? 4242 : 1717);
    const blob = (cx, cy, r, col, a) => {
      g.globalAlpha = a;
      g.fillStyle = col;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    };
    const [dark, mid, light] = palette;
    if (kind === 'scrub') {
      /* Low, wide and lumpy, with a flat-ish top -- gorse and bramble read
       * as a mass sitting *on* the ground rather than standing above it. */
      for (let i = 0; i < 130; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.pow(rnd(), 0.5);
        const cx = size / 2 + Math.cos(a) * rr * size * 0.46;
        const cy = size * 0.74 + Math.sin(a) * rr * size * 0.26;
        const r = size * 0.085 * (1 - rr * 0.35) * (0.55 + rnd() * 0.8);
        const shade = cx < size * 0.44 ? light : cy > size * 0.80 ? dark : mid;
        blob(cx, cy, r, shade, 1);
      }
    } else if (kind === 'conifer') {
      // stacked tiers, wide at the base, each broken into needles clumps
      for (let tier = 0; tier < 7; tier++) {
        const ty = size * (0.90 - tier * 0.115);
        const tw = size * (0.46 - tier * 0.052);
        const n = 16 - tier;
        for (let i = 0; i < n; i++) {
          const f = (i / (n - 1)) * 2 - 1;
          const cx = size / 2 + f * tw;
          const cy = ty - Math.abs(f) * tw * 0.42 + (rnd() - 0.5) * 8;
          const r = size * (0.055 - tier * 0.004) * (0.7 + rnd() * 0.6);
          blob(cx, cy, r, f < -0.1 ? light : f > 0.25 ? dark : mid, 1);
        }
      }
    } else {
      for (let i = 0; i < 200; i++) {
        const a = rnd() * Math.PI * 2;
        const rr = Math.pow(rnd(), 0.55);
        const cx = size / 2 + Math.cos(a) * rr * size * 0.42;
        const cy = size * 0.52 + Math.sin(a) * rr * size * 0.40;
        const r = size * 0.075 * (1 - rr * 0.45) * (0.6 + rnd() * 0.8);
        const shade = cx < size * 0.45 ? light : cy > size * 0.62 ? dark : mid;
        blob(cx, cy, r, shade, 1);
      }
    }
    g.globalAlpha = 1;
  });
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------- sky ---------------------------------- */

/** Soft cloud sheet, alpha, for the two drifting layers on the dome. */
export function cloudTexture(seed = 3) {
  return make('cloud' + seed, 512, (g, size) => {
    const f = fbmField(size, { octaves: 5, base: 3, seed });
    const img = g.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      /* Clouds are a *threshold* of noise, not noise.  Painting the field
       * straight in gives an even grey haze; cutting it at 0.55 and
       * letting only what is above through gives edges, and edges are what
       * make a cloud a cloud. */
      const v = Math.max(0, (f[i] - 0.54) / 0.30);
      const a = Math.min(1, v * v * (3 - 2 * Math.min(1, v)));
      /* Kept as-is, but see `sky.js`: drawn on a *sphere* the same tile
       * wrapped five times round showed as five identical horizontal
       * streaks. */
      d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255;
      d[i * 4 + 3] = clamp255(a * 235);
    }
    g.putImageData(img, 0, 0);
  });
}
