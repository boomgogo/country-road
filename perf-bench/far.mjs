/* ------------------------------------------------------------------ *
 * Is the world still solid a long way from where it started?
 *
 * Everything that is float32 -- Rapier, instanced matrices, vertex
 * positions, every shader that reads a world position -- loses precision
 * with distance from the origin: a float32 step is 1 cm at 2^16 m and
 * 3 cm at 2^18.  `plan_4.md` §4d: the two-day film drives about 58 km,
 * but a player's resumed drive can go much further.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/far.mjs                 # 2, 60, 150, 300 km
 *     HEADLESS=1 AT=2,100 OUT=/tmp/far node perf-bench/far.mjs
 *
 * At each distance: trace the road out to it, jump there, let the
 * autopilot drive ten seconds, and report how far from the origin the car
 * actually is (the road winds, so that is less than the arc length), how
 * much the suspension jitters -- the standard deviation of each wheel's
 * travel, frame to frame, which a coarse physics world shows first -- and
 * a still to look at for shimmer in the ground and the trees.  The 2 km
 * row is the control.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.PORT || 5178;
const AT = (process.env.AT || '2,60,150,300').split(',').map(Number);
const OUT = process.env.OUT || '/tmp/far';
mkdirSync(OUT, { recursive: true });

const c = await launch({ w: 1280, h: 720, port: 9336, profile: `${process.cwd()}/chrome-prof-far` });
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=country&t=10:00&weather=sunny&dynres=0`,
});
for (let i = 0; i < 480; i++) {
  if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await c.evaluate('window.__game.loaded');

console.log('   km   |x,z| m   float32 step   wheel jitter mm   pitch jitter mrad');
for (const km of AT) {
  const s = km * 1000;
  const t0 = Date.now();
  /* In big bites: `extendAhead` re-indexes the line on every call. */
  await c.evaluate(`(() => { const r = __game.road; for (let k = 0; k < 400; k++) { if (!r.extendAhead(0, ${s} + 3000, 20000)) break; } })()`, 3600000);
  await c.evaluate(`__game.jumpTo(${s}, 60)`, 3600000);
  const r = await c.evaluate(`(() => {
    const g = __game, w = [[], [], [], []], pitch = [];
    for (let k = 0; k < 300; k++) {
      g.step(1 / 30);
      for (let i = 0; i < 4; i++) w[i].push(g.car.wheelY[i]);
      pitch.push(g.car.pitch ?? 0);
    }
    /* Frame-to-frame: a second difference, so a hill is not jitter. */
    const jit = (a) => {
      let s = 0, n = 0;
      for (let i = 1; i < a.length - 1; i++) { const d = a[i + 1] - 2 * a[i] + a[i - 1]; s += d * d; n++; }
      return Math.sqrt(s / n);
    };
    const p = g.car.pos;
    return { d: Math.hypot(p.x, p.z), wheel: w.map(jit).reduce((a, b) => a + b) / 4, pitch: jit(pitch) };
  })()`, 3600000);
  const ulp = 2 ** (Math.floor(Math.log2(Math.max(1, r.d))) - 23);
  console.log(`${String(km).padStart(5)}  ${r.d.toFixed(0).padStart(9)}   ${(ulp * 1000).toFixed(2).padStart(8)} mm   `
    + `${(r.wheel * 1000).toFixed(3).padStart(10)}      ${(r.pitch * 1000).toFixed(3).padStart(10)}     (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const u = await c.evaluate('__game.grab()');
  writeFileSync(`${OUT}/far-${km}km.png`, Buffer.from(String(u).split(',')[1], 'base64'));
}
c.close();
process.exit(0);
