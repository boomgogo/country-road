/* ------------------------------------------------------------------ *
 * The ink pass's depth taps: a regression test.
 *
 * `ref/render_issue.png` came in as "a rendering issue in one quality
 * setting on a Surface Go": a grid of dark bars and rungs over every
 * hillside seen edge-on.  It was the ink in `core/post.js` tapping the
 * depth buffer half a texel out -- see `ink()` there, and `ai/plan_1.md`
 * for how it was found.  The tap is rounded to whole texels now, and this
 * is what says so.
 *
 * It is a *picture* test, so it needs a measurement of the picture.  The
 * bars are the one thing in the frame that is fixed in screen space: after
 * a horizontal high-pass, a row of the image stays correlated with a row
 * 42 px above it, which grass, trees, shadows and noise all do not.  That
 * one number separates the two states by an order of magnitude and is the
 * whole detector.
 *
 *     ref/render_issue.png (the tablet)   0.312
 *     medium, before the fix              0.194
 *     anything clean                      0.00 - 0.05
 *
 * Three cases, because the trigger is a render scale of *exactly* 1 and
 * there are three ways to land on it:
 *
 *   medium    `Q.scale` is 1, so it starts there -- the reported case
 *   high      the governor's ladder unshifts `minScale`, which is 1
 *   3840x2160 `scaleFor`'s budget branch returns exactly 1 past ~4.2 Mpx,
 *             on any tier, on any GPU -- nothing to do with tablets
 *
 * `low` is here to hold the line rather than because it ever broke: its
 * ladder holds 0.996 and not 1.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node ai/perf-bench/ink.mjs          # pass/fail
 *     HEADLESS=1 SWEEP=1 node ai/perf-bench/ink.mjs  # the thickness sweep
 *     HEADLESS=1 SHOTS=/tmp/ink node ai/perf-bench/ink.mjs   # and the frames
 *
 * The sweep is the diagnostic, not the test: it walks `uThickness` past
 * 1.5 and should now be flat.  Before the fix it spiked there, and at 2.5,
 * and nowhere else -- the shape of a nearest-filter tie.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

/** Above this and the bars are back.  Clean has never measured past 0.05. */
const THRESHOLD = +(process.env.THRESHOLD || 0.09);
const SHOTS = process.env.SHOTS || '';
const PORT = process.env.PORT || 5178;

/* The frame.  A hillside seen almost edge-on is what the artefact needs,
 * and this is one: seed `country`, 10.5 km along, half past eight on the
 * first morning.  The clock, the season and the weather are pinned because
 * a still of a 24-minute day is not comparable with itself otherwise. */
const SEED = 'country';
const TARGET = 10520;

const CASES = [
  { tag: 'medium', quality: 'medium', w: 1108, h: 541, dpr: 1.5 },
  { tag: 'high', quality: 'high', w: 1108, h: 541, dpr: 1.5 },
  { tag: 'low', quality: 'low', w: 1108, h: 541, dpr: 1.5 },
  /* `high` driven to the floor of its own ladder, which is where a slow
   * machine ends up and is scale 1 exactly. */
  { tag: 'high@gov-floor', quality: 'high', w: 1108, h: 541, dpr: 1.5, scale: 1 },
  { tag: 'high@3840x2160', quality: 'high', w: 3840, h: 2160, dpr: 1 },
];

/* The detector, run in the page against the drawing buffer.  `?rec=1` is
 * what makes the canvas readable at all -- it is the only mode that asks
 * for `preserveDrawingBuffer`. */
const SCORER = `
window.__inkScore = function () {
  const cv = __game.renderer.domElement;
  const c2 = window.__c2 || (window.__c2 = document.createElement('canvas'));
  c2.width = cv.width; c2.height = cv.height;
  const g = c2.getContext('2d');
  g.drawImage(cv, 0, 0);
  const W = cv.width, H = cv.height;
  const x0 = Math.floor(W * 0.32), y0 = Math.floor(H * 0.20);
  const w = W - x0, h = Math.floor(H * 0.78) - y0;
  const d = g.getImageData(x0, y0, w, h).data;
  const rows = [];
  for (let y = 0; y < h; y += 6) {
    const r = new Float64Array(w);
    for (let i = 0; i < w; i++) {
      const o = (y * w + i) * 4;
      r[i] = (d[o] + d[o + 1] + d[o + 2]) / 3;
    }
    /* Horizontal high-pass: a 15 px moving average taken off, so what is
     * left is the bars and not the hillside they are drawn over. */
    const pre = new Float64Array(w + 1);
    for (let i = 0; i < w; i++) pre[i + 1] = pre[i] + r[i];
    const hp = new Float64Array(w);
    for (let i = 0; i < w; i++) {
      const a = Math.max(0, i - 7), b = Math.min(w, i + 8);
      hp[i] = r[i] - (pre[b] - pre[a]) / (b - a);
    }
    rows.push(hp);
  }
  const ncc = (a, b) => {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      n += x * y; da += x * x; db += y * y;
    }
    return (da && db) ? n / Math.sqrt(da * db) : 0;
  };
  const gap = 7;                       // 42 rows
  let s = 0, k = 0;
  for (let i = 0; i + gap < rows.length; i++) { s += ncc(rows[i], rows[i + gap]); k++; }
  return k ? s / k : 0;
};
true`;

async function frame(c, { quality, w, h, dpr, scale }) {
  await c.send('Emulation.setDeviceMetricsOverride',
               { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  await c.send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=${SEED}`
       + `&t=08:20&season=spring&weather=sunny&day=1&dynres=0&quality=${quality}`,
  });
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await c.evaluate('window.__game.loaded');
  await c.evaluate(SCORER);
  /* Walked to, not jumped to.  One cold jump lands with the chase camera
   * still settling and the chunk field still arriving, and a still of that
   * is a photograph of the loader -- see `jumpTo` in `main.js`. */
  for (let s = 20; s <= TARGET; s += 500) {
    await c.evaluate(`__game.jumpTo(${s}, 50)`);
    await c.evaluate('__game.present()');
  }
  if (scale) {
    await c.evaluate(`(()=>{__game.pipeline.maxScale=${scale};`
                   + `dispatchEvent(new Event('resize'));})()`);
  }
  await c.evaluate('__game.present()');
  await c.evaluate('__game.present()');
}

async function shot(c, tag) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const u = await c.evaluate('window.__game.grab()');
  writeFileSync(`${SHOTS}/${tag}.png`, Buffer.from(String(u).split(',')[1], 'base64'));
}

const c = await launch({ w: 1280, h: 720 });
await c.send('Page.enable');
let failed = 0;

if (process.env.SWEEP) {
  const thicks = (process.env.THICKS
    || '1.0,1.2,1.4,1.45,1.5,1.55,1.6,1.75,2.0,2.4,2.5,2.6,3.0').split(',').map(Number);
  for (const cs of CASES.filter((x) => x.tag === 'medium' || x.tag === 'high')) {
    await frame(c, cs);
    const scale = await c.evaluate('__game.pipeline.scale');
    const out = [];
    for (const t of thicks) {
      await c.evaluate(`__game.pipeline.look.mat.uniforms.uThickness.value=${t};`);
      await c.evaluate('__game.present()');
      await c.evaluate('__game.present()');
      out.push(`${t}=${(await c.evaluate('__inkScore()')).toFixed(3)}`);
    }
    console.log(`${cs.tag} (scale ${scale})`);
    console.log('  ' + out.join('  '));
  }
} else {
  for (const cs of CASES) {
    await frame(c, cs);
    const v = await c.evaluate('__inkScore()');
    const scale = await c.evaluate('__game.pipeline.scale');
    const thick = await c.evaluate('__game.pipeline.look.mat.uniforms.uThickness.value');
    await shot(c, cs.tag);
    const bad = v > THRESHOLD;
    if (bad) failed++;
    console.log(`${bad ? 'FAIL' : 'ok  '}  ${cs.tag.padEnd(16)}`
      + ` scale=${String(scale).padEnd(6)} thickness=${String(thick).padEnd(6)}`
      + ` score=${v.toFixed(3)}`);
  }
  console.log(failed
    ? `\n${failed} of ${CASES.length} banded (threshold ${THRESHOLD}).`
    : `\nAll ${CASES.length} clean (threshold ${THRESHOLD}).`);
}

c.close();
process.exit(failed ? 1 : 0);
