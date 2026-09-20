/* ------------------------------------------------------------------ *
 * Creases in the road corridor: a regression test.
 *
 * `prompt_2.md` came in as "the sharp edges, i.e., ink outlines, on the
 * side of the road is a bit annoying", with the guess that they came from
 * carving the road out of the terrain.  They did, from three creases in
 * `world/terrain.js` -- the shoulder fall, the platform-to-batter hinge and
 * the crest rounding's own `over` ramp.  `ai/plan_2.md` is how they were
 * found; this is what says they are gone.
 *
 * **It measures the ground, not the picture, and that is deliberate.**
 *
 * The first version of this probe rendered the frame twice, with the ink
 * pass on and off, and scored the difference inside a band projected from
 * the road.  That works on a cutting and is hopeless on an embankment: the
 * band runs through whatever is standing on the verge, its far half lands
 * on the landform silhouette above the horizon, and at s = 2500 it scored
 * the fix as 20 % *worse* while the cross-sections underneath it were
 * three to six times better.  A proxy that disagrees with the thing it
 * stands for is not a measurement.
 *
 * So this walks the road and takes the second difference of ground height
 * across it, which is the quantity that decides whether the ink fires.
 * `plan_2.md` §3 is the link: the pass draws a second difference of depth,
 * the ground is a lattice, and a crease of any shape reaches the screen as
 * a slope break of `curvature x vertex spacing` -- so at the 1 m spacing
 * the corridor is meshed at, curvature per metre *is* the slope break per
 * vertex row, and the ink starts drawing at about 0.2 of one.
 *
 * Two zones, because they are two different things:
 *
 *   **corridor**  out to the platform edge plus the hinge fillet, about
 *                 13 m.  Everything this iteration fixed lives here, and
 *                 this is what the pass/fail is on.
 *   **outer**     from there to the road's query radius: the daylight
 *                 line, where the batter runs back into the hillside.
 *                 That is a real edge in the landform and a drawing is
 *                 entitled to draw it -- reported, never asserted, so it
 *                 cannot hide inside the number that matters.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node ai/perf-bench/verge.mjs
 *     HEADLESS=1 WORST=1 node ai/perf-bench/verge.mjs   # the worst sections
 *
 * Measured over 600 cross-sections of 12 km of `?seed=country`, curvature
 * per metre.  Deterministic: two runs agree to every digit.
 *
 *                   corridor mean / p99 / max     outer p99 / max
 *     before          1.336 / 2.03 / 2.31           1.19 / 2.16
 *     after           0.244 / 0.89 / 1.85           1.33 / 8.46
 *
 * The outer maximum going the wrong way is real and is not this probe
 * being noisy -- see `next_2.md`.  It is one section in six hundred, at
 * a place where the road doubles back within its own query radius and
 * `nearest` answers for whichever midline is closer.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

/**
 * Curvature per metre in the corridor, at the 99th percentile.
 *
 * **1.2 is a line held, not a goal reached**, and the difference matters.
 * The ink starts drawing at about 0.2 per metre, and the corridor's p99 is
 * 0.89 -- so one section in a hundred still carries a crease the pass can
 * find.  What this number is set against is the *other* side: 2.03 before
 * the fix, and a mean of 1.34 against 0.24 now.  It fails anything that
 * gives back what was won and passes what is there, which is what a
 * regression test is for; closing the last of the gap is `next_2.md`.
 */
const THRESHOLD = +(process.env.THRESHOLD || 1.2);
const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
/** How far along the road to sample, and how many sections. */
const FROM = +(process.env.FROM || 300);
const TO = +(process.env.TO || 12300);
const N = +(process.env.N || 600);

const PROBE = `
window.__creases = function (from, to, n) {
  const g = __game, T = g.terrain, R = g.road;
  /* Half a metre: finer than the corridor is ever meshed at, and fine
   * enough to resolve a fillet six metres wide.  The reported number is a
   * curvature, so it does not depend on this. */
  const step = 0.5;
  const out = 26;                       // the road's own query radius
  const corridor = 13;                  // platform edge plus the fillet
  const p = {};
  const cor = [], far = [];
  let worstCor = { k: 0, s: 0, at: 0 }, worstFar = { k: 0, s: 0, at: 0 };

  for (let i = 0; i < n; i++) {
    const s = from + (to - from) * i / (n - 1);
    R.sampleAt(s, p);
    const m = Math.round(out / step);
    const ys = [];
    for (let j = -m; j <= m; j++) {
      const d = j * step;
      ys.push(T.heightAt(p.x + p.rx * d, p.z + p.rz * d));
    }
    let kc = 0, cAt = 0, kf = 0, fAt = 0;
    for (let j = 1; j < ys.length - 1; j++) {
      const d = (j - m) * step;
      const k = Math.abs(ys[j+1] - 2 * ys[j] + ys[j-1]) / (step * step);
      if (Math.abs(d) <= corridor) { if (k > kc) { kc = k; cAt = d; } }
      else if (k > kf) { kf = k; fAt = d; }
    }
    cor.push(kc); far.push(kf);
    if (kc > worstCor.k) worstCor = { k: kc, s: s, at: cAt };
    if (kf > worstFar.k) worstFar = { k: kf, s: s, at: fAt };
  }

  const pct = (a, q) => {
    const b = a.slice().sort((x, y) => x - y);
    return b[Math.min(b.length - 1, Math.floor(b.length * q))];
  };
  return {
    n: n,
    corP99: pct(cor, 0.99), corMax: Math.max.apply(null, cor),
    corMean: cor.reduce((a, b) => a + b, 0) / cor.length,
    farP99: pct(far, 0.99), farMax: Math.max.apply(null, far),
    worstCor: worstCor, worstFar: worstFar,
  };
};
true`;

const c = await launch({ w: 800, h: 600 });
await c.send('Page.enable');
await c.send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=${SEED}`
     + `&t=10:00&season=summer&weather=sunny&day=1&dynres=0&quality=high`,
});
for (let i = 0; i < 240; i++) {
  if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await c.evaluate('window.__game.loaded');

/* The road has to have been traced this far before it can be measured, and
 * `jumpTo` is what extends it -- so walk, rather than ask for ground that
 * does not exist yet. */
for (let s = 20; s <= TO + 400; s += 500) await c.evaluate(`__game.jumpTo(${s}, 50)`);
await c.evaluate(`__game.jumpTo(${FROM}, 50)`);
await c.evaluate(PROBE);

const o = JSON.parse(await c.evaluate(`JSON.stringify(__creases(${FROM}, ${TO}, ${N}))`));
const bad = o.corP99 > THRESHOLD;

console.log(`sections      ${o.n}, s = ${FROM} to ${TO}`);
console.log(`corridor      mean ${o.corMean.toFixed(3)}`
  + `  p99 ${o.corP99.toFixed(2)}  max ${o.corMax.toFixed(2)}`);
console.log(`outer         p99 ${o.farP99.toFixed(2)}  max ${o.farMax.toFixed(2)}`
  + `   (the daylight line: reported, not asserted)`);
if (process.env.WORST) {
  console.log(`worst corridor  ${o.worstCor.k.toFixed(2)} at s = ${o.worstCor.s.toFixed(0)},`
    + ` ${o.worstCor.at.toFixed(2)} m from the midline`);
  console.log(`worst outer     ${o.worstFar.k.toFixed(2)} at s = ${o.worstFar.s.toFixed(0)},`
    + ` ${o.worstFar.at.toFixed(2)} m from the midline`);
}
console.log(bad
  ? `\nFAIL  corridor p99 ${o.corP99.toFixed(2)} is over ${THRESHOLD} per metre -- the ink draws that.`
  : `\nok    corridor p99 ${o.corP99.toFixed(2)}, under ${THRESHOLD} per metre.`);

c.close();
process.exit(bad ? 1 : 0);
