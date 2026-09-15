import { FAR_LOD } from '../world/chunks.js';

/* ------------------------------------------------------------------ *
 * How hard to work the GPU, and how to find out.
 *
 * Three tiers, and the middle one is the one this file exists for: a
 * laptop or a desktop drawing on the graphics built into its CPU.  Before
 * it there were two, `high` for anything with a mouse and `low` for
 * anything with a finger, and an Intel HD 630 at 1920x1080 counted as
 * `high` -- which drew the scene at 2849x1473, sampled every ground
 * texture at 16x anisotropic, and ran at **7.7 frames a second**.
 *
 * Measured on that machine, one change at a time, frames per second:
 *
 *     as shipped                                    7.7
 *     scene at 1x rather than 1.42x, 2x aniso      19.9
 *     ... and the cloud march at 1/4, history 1/2  22.5
 *     ... and nothing else drawn at all            33.9
 *
 * That last row is what found `FAR_LOD` in `chunks.js`: with the clouds,
 * the shadows and the post all switched off, a frame still cost 30 ms,
 * and most of it was a kilometre of 1 m ground drawn as sub-pixel
 * triangles.
 *
 * The tier picks a *starting point*.  `ResolutionGovernor` below then
 * watches the frame rate and moves the render scale, because a GPU name
 * is a guess about the machine and a frame time is a measurement of it.
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} Tier
 * @property {number} scale      the scene's render scale to start at, in CSS px
 * @property {number} maxScale   the most the governor may raise it to
 * @property {number} minScale   the least it may lower it to
 * @property {number} anisotropy the most anisotropic filtering any texture gets
 * @property {number} shadowMap  shadow map size, texels per side
 * @property {number} cloudScale fraction of the render target the clouds march at
 * @property {number} cloudHistory fraction the cloud history is kept at
 * @property {object[]} farLod   see `FAR_LOD`
 */

/** @type {Record<string, Tier>} */
export const TIERS = {
  /* The picture as it has always been drawn, plus the far LOD cap -- which
   * costs nothing that can be seen at 420 m -- and permission to give up
   * the supersample, and only the supersample, if the frame rate says so. */
  high: {
    scale: 1.75, maxScale: 1.75, minScale: 1,
    anisotropy: 16, shadowMap: 3072,
    cloudScale: 0.5, cloudHistory: 1,
    farLod: FAR_LOD.high,
  },
  /* Integrated graphics.  No supersample to start with, and the governor
   * may go below 1 -- a soft picture at 50 frames is a better drive than a
   * sharp one at 20. */
  medium: {
    scale: 1, maxScale: 1.5, minScale: 0.6,
    anisotropy: 4, shadowMap: 2048,
    cloudScale: 0.3, cloudHistory: 0.5,
    farLod: FAR_LOD.medium,
  },
  /* Phones.  The scale and the shadow map are what `?quality=low` already
   * was; the cloud march was 0.4 and comes down with the medium tier's. */
  low: {
    scale: 1.25, maxScale: 1.25, minScale: 0.6,
    anisotropy: 2, shadowMap: 1536,
    cloudScale: 0.3, cloudHistory: 0.5,
    farLod: FAR_LOD.low,
  },
};

/** The GPU's own name for itself, or '' where the browser will not say. */
export function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch {
    return '';
  }
}

/**
 * Graphics that share the CPU's memory and power budget.
 *
 * A list of names, which is exactly the thing `main.js` warns about -- but
 * the *pointer* cannot answer this question and nothing else in a browser
 * can, and a wrong answer here is corrected by the governor within a few
 * seconds rather than lived with.  Apple is here on purpose: an M-series
 * GPU is quick, but a Retina panel is four times the pixels and the
 * governor is what should decide whether it can have them.
 */
const INTEGRATED = /intel|iris|uhd graphics|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d|apple|mali|adreno|powervr|qualcomm|videocore|immortalis/i;
const SOFTWARE = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic/i;

/**
 * Which tier to start in.
 *
 * `?quality=` wins, then the films (which must be the same picture on every
 * machine), then a finger, then the GPU's name.
 */
export function pickTier({ param, recording, coarse, gpu }) {
  if (param && TIERS[param]) return { name: param, why: '?quality' };
  if (recording) return { name: 'high', why: 'recording' };
  if (coarse) return { name: 'low', why: 'coarse pointer' };
  if (SOFTWARE.test(gpu)) return { name: 'low', why: 'software renderer' };
  if (INTEGRATED.test(gpu)) return { name: 'medium', why: 'integrated graphics' };
  return { name: 'high', why: gpu ? 'discrete graphics' : 'unknown GPU' };
}

/**
 * Dynamic resolution, from the one number that cannot be wrong about the
 * machine: how long frames are actually taking.
 *
 * It moves the scene's render scale a step at a time between the tier's
 * `minScale` and `maxScale`, and every step is a reallocation of four
 * render targets and a reset of the cloud history -- so it moves rarely,
 * waits for the frame after a move to settle before judging it, and
 * remembers what did not work.
 *
 *  - **Down** when the median frame is slower than about 48 frames a
 *    second.  A median, over most of a second, so a chunk build or a
 *    garbage collection is not a reason to blur the picture.
 *  - **Up** only after several seconds held at the display's rate, and a
 *    scale that was tried and dropped straight back becomes the ceiling
 *    for a minute.
 *  - **Not at all** when a step down bought nothing.  A browser holding
 *    the page to 30 frames a second on battery looks exactly like a slow
 *    GPU, and without this it would be driven to the floor for no gain.
 */
export class ResolutionGovernor {
  /**
   * @param {object} o
   * @param {number} o.scale      where to start
   * @param {number} o.minScale
   * @param {number} o.maxScale
   * @param {(scale: number) => number} o.effective  the scale the pipeline
   *   would really draw at if asked for this one -- it caps by the screen's
   *   pixel density and a pixel budget, so neighbouring levels can be the
   *   same picture, and a step between two of those is not a step
   * @param {(scale: number) => void} o.apply
   * @param {boolean} [o.enabled]
   */
  constructor({ scale, minScale, maxScale, effective, apply, enabled = true }) {
    this.enabled = enabled && maxScale > minScale;
    this.effective = effective;
    this.apply = apply;
    /* Steps of 12 % in linear scale, so about a quarter in pixels, counted
     * out from the tier's starting scale so that one is a level exactly. */
    const levels = [scale];
    for (let s = scale / 1.12; s > minScale * 1.03; s /= 1.12) levels.unshift(+s.toFixed(3));
    if (minScale < scale) levels.unshift(minScale);
    for (let s = scale * 1.12; s < maxScale / 1.03; s *= 1.12) levels.push(+s.toFixed(3));
    if (maxScale > scale) levels.push(maxScale);
    this.levels = levels;
    this.i = closest(levels, scale);
    this.ceiling = levels.length - 1;
    this.ceilingUntil = 0;
    this.floor = 0;

    this.dts = [];
    this.settle = 90;           // frames to ignore: the first few are loading
    this.held = 0;              // seconds spent comfortably at speed
    this.clock = 0;             // seconds, from the frames themselves
    this.lastUp = -Infinity;
    /** The frame time before the last step down, to judge that step by. */
    this.before = 0;
  }

  get scale() { return this.levels[this.i]; }

  /** One rendered frame, `dt` in seconds as measured by the wall clock. */
  frame(dt) {
    if (!this.enabled) return;
    /* A pause, a hidden tab, a debugger: not a frame time. */
    if (dt > 0.25) { this.dts.length = 0; this.settle = Math.max(this.settle, 20); return; }
    this.clock += dt;
    if (this.settle > 0) { this.settle--; return; }
    this.dts.push(dt);
    if (this.dts.length < 45) return;

    const med = median(this.dts);
    this.dts.length = 0;
    if (this.clock > this.ceilingUntil) this.ceiling = this.levels.length - 1;

    /* The verdict on the last step down, now that there is a frame time
     * from after it.  No real gain means the rate was never the GPU's to
     * give, so go back and do not come down this far again. */
    if (this.before) {
      const gained = med < this.before * 0.92;
      this.before = 0;
      if (!gained) {
        const back = this._next(+1);
        if (back !== this.i) { this.floor = back; this._move(back); }
        return;
      }
    }

    if (med > 1 / 48) {
      this.held = 0;
      const down = this._next(-1);
      if (down !== this.i && down >= this.floor) {
        /* Straight back down from a step up: that scale is too much. */
        if (this.clock - this.lastUp < 4) {
          this.ceiling = down;
          this.ceilingUntil = this.clock + 60;
        }
        this.before = med;
        this._move(down);
      }
    } else if (med < 1 / 56) {
      this.held += med * 45;
      const up = this._next(+1);
      if (this.held > 6 && up !== this.i && up <= this.ceiling) {
        this.held = 0;
        this.lastUp = this.clock;
        this._move(up);
      }
    } else {
      this.held = 0;
    }
  }

  /** The nearest level in direction `dir` that actually draws differently. */
  _next(dir) {
    const now = this.effective(this.scale);
    for (let i = this.i + dir; i >= 0 && i < this.levels.length; i += dir) {
      if (Math.abs(this.effective(this.levels[i]) - now) > 1e-3) return i;
    }
    return this.i;
  }

  _move(i) {
    this.i = i;
    /* Half a second of frames after a resize are not about the new scale:
     * the first of them are paying for the reallocation. */
    this.settle = 30;
    this.dts.length = 0;
    this.apply(this.scale);
  }
}

function closest(levels, v) {
  let best = 0;
  for (let i = 1; i < levels.length; i++) {
    if (Math.abs(levels[i] - v) < Math.abs(levels[best] - v)) best = i;
  }
  return best;
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
}
