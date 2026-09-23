/* ------------------------------------------------------------------ *
 * Does the ground keep up with the car on a slow CPU?
 *
 * `prompt_4.md`: on a phone and on a Surface Go "the terrain can fail to
 * generate at times and my car would fall into the void".  Both have a
 * CPU a fraction of this machine's, and the chunk builder is main-thread
 * work on a millisecond budget -- so this drives the real frame loop, not
 * `step()`, with the CPU throttled, and reads `__game.groundWatch`.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 THROTTLE=6 SECS=600 node perf-bench/void.mjs
 *
 * `THROTTLE` is CDP's CPU slow-down factor (1 = none).  `DEV=phone`
 * emulates a 393x851 screen at DPR 2.75; otherwise 1280x720 at 1.  `Q` is appended
 * to the query string.  `RECOVER=n` presses T every n seconds, since
 * `recover()` is a teleport and `ChunkField.reset()` says teleports once
 * left the ground undrawn.
 *
 * Pass: no frame with the car over a missing chunk or a stale collider,
 * and no fall.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5178;
const THROTTLE = Number(process.env.THROTTLE || 6);
const SECS = Number(process.env.SECS || 300);
const SEED = process.env.SEED || 'country';
const Q = process.env.Q || 'quality=low';
const RECOVER = Number(process.env.RECOVER || 0);

const c = await launch({ w: 1280, h: 720 });
await c.send('Page.enable');
/* The window, explicitly: an emulated device persists in the shared
 * profile from whichever probe ran last.  `DEV=phone` is the phone. */
const PHONE = process.env.DEV === 'phone';
await c.send('Emulation.setDeviceMetricsOverride', PHONE
  ? { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true }
  : { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await c.send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/?auto=full&fresh&sound=0&seed=${SEED}&t=10:00&${Q}`,
});
for (let i = 0; i < 480; i++) {
  if (await c.evaluate('!!(window.__game && window.__game.groundWatch)').catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await c.evaluate('window.__game.loaded');
/* Frames per second from the page's own rAF, since the governor's view
 * of it is not exported. */
await c.evaluate(`(() => { window.__fps = { n: 0 }; const f = () => { __fps.n++; requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);

const t0 = Date.now();
let lastT = 0, lastN = 0, lastRecover = 0;
console.log(`throttle ${THROTTLE}x  ${Q}  seed ${SEED}`);
while ((Date.now() - t0) / 1000 < SECS) {
  await new Promise((r) => setTimeout(r, 10000));
  const t = (Date.now() - t0) / 1000;
  if (RECOVER && t - lastRecover >= RECOVER) {
    lastRecover = t;
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyT', key: 't' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyT', key: 't' });
  }
  const s = await c.evaluate(`(() => {
    const g = __game, ch = g.chunks, w = g.groundWatch;
    const bt = {};
    for (const [k, v] of Object.entries(ch.buildTimes)) bt[k] = +(v.ms / v.n).toFixed(1) + 'ms x' + v.n;
    const cls = { missing: 0, fix: 0, save: 0 };
    for (const q of ch.queue) q.cls === 0 ? cls.missing++ : q.cls === 1 ? cls.fix++ : cls.save++;
    return { km: +(g.odometer / 1000).toFixed(2), v: +g.car.speed.toFixed(1),
             w: { ...w }, queue: ch.queue.length, cls, live: ch.live.size, bt, rescued: ch.rescued, reasons: ch.reasons, inval: ch.invalidated,
             frames: __fps.n, scale: g.pipeline.scale };
  })()`);
  const fps = ((s.frames - lastN) / (t - lastT)).toFixed(1);
  lastT = t; lastN = s.frames;
  console.log(`${t.toFixed(0).padStart(4)}s  ${String(s.km).padStart(6)} km  ${String(s.v).padStart(5)} m/s  `
    + `fps ${fps.padStart(5)}  live ${s.live}  queue ${s.queue} ${JSON.stringify(s.cls)}  `
    + `noChunk ${s.w.noChunk} noCollider ${s.w.noCollider} ahead ${s.w.aheadMissing} `
    + `below ${s.w.below} falls ${s.w.falls} rescued ${s.rescued}  ${JSON.stringify(s.bt)} ${JSON.stringify(s.reasons)} inval ${s.inval}`);
}
const w = await c.evaluate('__game.groundWatch');
const bad = w.noChunk + w.noCollider + w.falls;
console.log(bad ? `FAIL ${JSON.stringify(w)}` : `pass ${JSON.stringify(w)}`);
c.close();
process.exit(bad ? 1 : 0);
