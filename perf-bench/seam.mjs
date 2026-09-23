/* ------------------------------------------------------------------ *
 * Cracks in the ground, counted.
 *
 * `prompt_4.md`: "the ground can still crack open from time to time, the
 * background color would show".  So: make the background a colour
 * nothing else is, draw nothing but the ground, drive, and count the
 * places the background shows through the ground.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 THROTTLE=4 SECS=300 node perf-bench/seam.mjs
 *     DUMP=/tmp/seams node perf-bench/seam.mjs      # PNGs of the worst
 *
 * Frames are stepped through `?rec`, so the ones analysed are exactly the
 * ones drawn -- but the chunk builder still runs on its millisecond
 * budget inside each step, so the CPU throttle still decides how far the
 * builder falls behind, which is the whole point.
 *
 * **What counts as a crack.**  Everything but the chunk meshes is hidden
 * (sky, clouds, trees, rails, the car), ink and grade are off, and the
 * clear colour is magenta.  A magenta pixel is then either sky or a hole,
 * and a heightfield seen from above tells the two apart exactly: in any
 * one column of the screen, a ray that misses the ground has passed over
 * all of it, so every ray above it in the column misses too.  Magenta
 * with ground *above* it in its column is therefore a hole, whatever its
 * size, and nothing else is.  The fog is kept, and turned magenta too, so
 * what counts is what a player could see: ground the fog has swallowed
 * is background-coloured in the game as well.
 *
 * `SELFTEST=1` hides one chunk beside the road first, to show the probe
 * can see a hole at all.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.PORT || 5178;
const THROTTLE = Number(process.env.THROTTLE || 1);
const SECS = Number(process.env.SECS || 120);       // of game time
const SEED = process.env.SEED || 'country';
const Q = process.env.Q || 'quality=low';
const EVERY = Number(process.env.EVERY || 6);       // analyse every n-th step
const DUMP = process.env.DUMP || '';
const DUMP_MIN = Number(process.env.DUMP_MIN || 20);
const SELFTEST = !!process.env.SELFTEST;

const c = await launch({ w: 1280, h: 720 });
await c.send('Page.enable');
/* Explicit, because an emulated device persists in the shared profile
 * from whichever probe ran last -- `dpr.mjs` leaves a phone behind. */
await c.send('Emulation.setDeviceMetricsOverride',
             { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await c.send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=${SEED}&t=11:00`
     + `&weather=sunny&clouds=off&dynres=0&${Q}`,
});
for (let i = 0; i < 480; i++) {
  if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await c.evaluate('window.__game.loaded');

await c.evaluate(`(() => {
  const g = __game;
  g.pipeline.enabled.ink = false;
  g.pipeline.enabled.grade = false;
  const MAG = new g.scene.background.constructor(1, 0, 1);
  /* Everything but the ground, hidden at the last moment before each
   * render -- the world adds objects as it streams, so once is not enough. */
  g.scene.onBeforeRender = () => {
    const keep = new Set();
    for (const ch of g.chunks.live.values()) { keep.add(ch.mesh); if (ch.water) keep.add(ch.water); }
    for (const o of g.scene.children) o.visible = o.isLight || keep.has(o);
    /* The game does not replace the background, it *copies* the sky's
     * colour into it every tick -- so into this object too, once it is
     * the background.  Reset it every time. */
    g.scene.background = MAG.setRGB(1, 0, 1);
    /* The fog stays, and fades to the same magenta.  A hole a kilometre
     * and a half away is behind fog that has already turned the ground
     * the background's colour, so a player cannot see it and neither
     * should this; and the fog is also what hides the field's own rim,
     * which with the fog pushed out read as holes along every skyline.
     * Set here, after the tick has copied the sky's colour into it. */
    g.scene.fog.color.setRGB(1, 0, 1);
    if (${SELFTEST}) {
      const C = 128, p = g.car.pos, fx = Math.cos(g.car.yaw), fz = Math.sin(g.car.yaw);
      const ch = g.chunks.chunkAt(p.x + fx * 180, p.z + fz * 180);
      if (ch) ch.mesh.visible = false;
    }
  };
  const gl = g.renderer.getContext();
  window.__seam = () => {
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = window.__px && window.__px.length === w * h * 4 ? window.__px : (window.__px = new Uint8Array(w * h * 4));
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    /* Green under 30: the background is exactly (255, 0, 255), and ground
     * deep in the fog comes out at 60 to 80 -- which a looser test read as
     * holes in the far hills. */
    const mag = (i) => px[i] > 200 && px[i + 1] < 30 && px[i + 2] > 200;
    let n = 0;
    /* readPixels rows run bottom-up, so the top of a column is row h-1. */
    /* Ground means three pixels of it running, not one: FXAA softens a
     * far silhouette into one-pixel lips, and a lip over a pixel of sky
     * is not a hole in anything. */
    /* And not within a few pixels of the skyline.  The argument above
     * treats a screen column as a vertical plane, which it is only with
     * the camera level; the chase camera looks down, so at the very rim
     * of the field a far ridge can overhang a pixel or three of sky.  A
     * crack in the ground is in the ground, not at its edge. */
    for (let x = 0; x < w; x++) {
      let ground = false, run = 0, top = -1;
      for (let y = h - 1; y >= 0; y--) {
        const i = (y * w + x) * 4;
        if (!mag(i)) {
          if (top < 0) top = y;
          if (++run >= 3) ground = true;
          continue;
        }
        run = 0;
        if (ground && top - y > 8) { n++; window.__at = [x, h - 1 - y]; }
      }
    }
    return n;
  };
})()`);

if (DUMP) mkdirSync(DUMP, { recursive: true });
const steps = SECS * 30;
let bad = 0, worst = 0, total = 0, frames = 0, dumped = 0;
const t0 = Date.now();
for (let i = 0; i < steps; i += EVERY) {
  const n = await c.evaluate(`(() => { for (let k = 0; k < ${EVERY}; k++) __game.step(1 / 30); return __seam(); })()`);
  frames++;
  total += n;
  if (n > 0) bad++;
  if (n > worst) worst = n;
  if (n >= DUMP_MIN && DUMP && dumped < 12) {
    const u = await c.evaluate('__game.grab()');
    console.log('crack at', await c.evaluate('JSON.stringify(window.__at)'), n, 'px, step', i);
    writeFileSync(`${DUMP}/seam-${String(i).padStart(6, '0')}-${n}.png`, Buffer.from(String(u).split(',')[1], 'base64'));
    dumped++;
  }
  if (frames % 50 === 0) {
    const s = await c.evaluate('({ km: __game.odometer / 1000, live: __game.chunks.live.size, q: __game.chunks.queue.length })');
    console.log(`${(i / 30).toFixed(0).padStart(5)}s game  ${s.km.toFixed(2)} km  live ${s.live} queue ${s.q}  `
      + `frames with cracks ${bad}/${frames}  worst ${worst} px  (${((Date.now() - t0) / 1000).toFixed(0)}s wall)`);
  }
}
console.log(bad ? `FAIL ${bad}/${frames} frames, ${total} px, worst ${worst}` : `pass 0/${frames} frames`);
c.close();
process.exit(bad ? 1 : 0);
