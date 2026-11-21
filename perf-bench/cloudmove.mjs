/* ------------------------------------------------------------------ *
 * Does the sky move, or does it stand still and jump?  `prompt_5.md`
 * issue 2: "The cloud seems to be stationary for a while and then
 * suddenly jumps to the next state."
 *
 * A parked car, a pinned `partly`, noon, the stepped clock -- so the only
 * thing that changes between two frames is the sky -- and three readings:
 *
 *   motion   the upper half of the cumulus layer's own target, every
 *            0.5 s for `SECS`, as the mean absolute difference from the
 *            grab before.  A sky that drifts is a steady small number.  A
 *            sky that is rebuilt every so often and frozen in between is
 *            zeros with spikes.
 *   field    the cloud field's value under every drawn lobe, against
 *            what it was when the set was written.  The ground shadow is
 *            drawn from that field on the GPU every frame, so a lobe that
 *            moves with the field keeps its value, and one pinned to the
 *            ground while the field drifts under it does not -- which is a
 *            cloud walking away from its own shadow.
 *   cost     what one `_place` takes, at the throttle given.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/cloudmove.mjs
 *
 * `SECS` (default 90), `WEATHER` (default partly), `THROTTLE` (CPU
 * slow-down for the cost reading, default 1).
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
const SECS = Number(process.env.SECS || 90);
const WEATHER = process.env.WEATHER || 'partly';
const THROTTLE = Number(process.env.THROTTLE || 1);

const c = await launch({ w: 960, h: 540 });
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride',
             { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
await c.send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=${SEED}&t=12:00&weather=${WEATHER}`
     + '&dynres=0&quality=high&places=off',
});
for (let i = 0; i < 480; i++) {
  if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await c.evaluate('window.__game.loaded');

await c.evaluate(`(() => {
  const g = __game;
  /* Parked: the car stopped and nobody driving it, so the camera is
   * still and the sky is the only thing that can change. */
  g.auto.setMode('manual');
  g.input.scripted = true;
  Object.assign(g.input.axes, { throttle: 0, brake: 1, steer: 0, handbrake: 1 });
  for (let i = 0; i < 60; i++) g.step(1 / 30);
  /* Read off the cumulus layer's own target rather than the frame: the
   * cirrus and the rain veil are drawn per pixel from the drifting field
   * and move every frame whatever the cumulus does, which buries a frozen
   * set and its jumps under a steady background.  The target holds the
   * lobes and nothing else.  Every fourth pixel each way, upper half. */
  let prev = null;
  window.__skyDiff = () => {
    const rt = g.clouds.rt, w = rt.width, h = rt.height;
    const buf = new Uint8Array(w * h * 4);
    g.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    const px = [];
    for (let y = Math.floor(h / 2); y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        const o = (y * w + x) * 4;
        px.push(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
      }
    }
    let d = 0;
    if (prev) for (let i = 0; i < px.length; i++) d += Math.abs(px[i] - prev[i]);
    prev = px;
    return d / px.length;
  };
  /* The field under every drawn lobe, at the lobe's *current* world
   * position -- the mesh's own matrix included, since the fix moves it --
   * against what it was when the set was last written.  A lobe that moves
   * with the field reads the same value for ever; one the field drifts
   * under does not. */
  let base = null, ver = -1;
  window.__underLobes = () => {
    const L = g.clouds;
    if (!L || !L.mesh) return null;
    const f = g.cloudField;
    L.mesh.updateMatrixWorld();
    const mw = L.mesh.matrixWorld.elements;
    const arr = L.mesh.instanceMatrix.array;
    const n = L.mesh.count;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = f.rawAt(arr[i * 16 + 12] + mw[12], arr[i * 16 + 14] + mw[14], 0);
    if (L.mesh.instanceMatrix.version !== ver) {
      ver = L.mesh.instanceMatrix.version;
      base = v;
      return 0;
    }
    let sum = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (L.grown && L.grown(i) < 0.99) continue;
      sum += Math.abs(v[i] - base[i]); k++;
    }
    return k ? sum / k : 0;
  };
})()`);

const rows = [];
for (let t = 0; t < SECS; t += 0.5) {
  for (let i = 0; i < 15; i++) await c.evaluate('__game.step(1/30)');
  const r = await c.evaluate(`(() => {
    const g = __game;
    return { diff: __skyDiff(), field: __underLobes(), n: g.clouds.mesh.count, rb: g.clouds.rebuilds ?? 0 };
  })()`);
  rows.push({ t, ...r });
}
/* The first three seconds are the chase camera settling onto a car that
 * has just stopped, which moves the whole frame and is not the sky. */
const diffs = rows.filter((r) => r.t >= 3).map((r) => r.diff);
const sorted = [...diffs].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const max = sorted[sorted.length - 1];
const zeros = diffs.filter((d) => d < 0.005).length;
/* A spike is a grab that changed several times as much as a typical one. */
const spikes = diffs.filter((d) => d > Math.max(0.2, med * 6)).length;
console.log(`motion  median ${med.toFixed(3)}  max ${max.toFixed(3)}  still grabs ${zeros}/${diffs.length}  spikes ${spikes}`);
const fv = rows.map((r) => r.field).filter((v) => v !== null);
console.log(`field   under the lobes, worst mean change since the set was written ${Math.max(...fv).toFixed(4)}`
  + `  (0 is a cloud that stays on its own shadow)`);
if (process.env.ROWS) for (const r of rows) console.log(r.t.toFixed(1), r.diff.toFixed(3), r.field && r.field.toFixed(4), r.n, r.rb);

/* The cost of one rebuild, forced. */
await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
const ms = await c.evaluate(`(() => {
  const L = __game.clouds, cam = __game.camera;
  const out = [];
  for (let i = 0; i < 12; i++) {
    L.reset();
    const t0 = performance.now();
    L._place(cam.position);
    out.push(performance.now() - t0);
  }
  out.sort((a, b) => a - b);
  return out[Math.floor(out.length / 2)];
})()`);
console.log(`cost    _place ${ms.toFixed(2)} ms median at ${THROTTLE}x throttle`);
c.close();
