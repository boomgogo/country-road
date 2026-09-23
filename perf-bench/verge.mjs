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
/**
 * Where the ink starts drawing, in slope break per vertex row.
 *
 * Reported against, not asserted on: `plan_3.md` A0 has still to say which
 * spacing the streaks in `ref/prompt_3_1.png` were actually meshed at, and
 * a threshold set before that is a guess with a number on it.
 */
const KNEE = +(process.env.KNEE || 0.2);

const PROBE = `
/* One cross-section, printed.  A p99 says a change went the wrong way; a
 * cross-section says which part of the road did it, which is the question
 * every one of these iterations has actually turned on. */
window.__section = function (s, out, step) {
  var g = __game, T = g.terrain, R = g.road;
  var p = {};
  R.sampleAt(s, p);
  var rows = [];
  var m = Math.round(out / step);
  var ys = [];
  for (var j = -m; j <= m; j++) {
    var d = j * step;
    ys.push(T.heightAt(p.x + p.rx * d, p.z + p.rz * d));
  }
  for (var j = 1; j < ys.length - 1; j++) {
    var d = (j - m) * step;
    if (d < 0) continue;
    rows.push({
      d: d,
      y: +(ys[j] - p.y).toFixed(3),
      slope: +((ys[j+1] - ys[j-1]) / (2 * step)).toFixed(3),
      k: +(Math.abs(ys[j+1] - 2 * ys[j] + ys[j-1]) / (step * step)).toFixed(3),
      bare: +(T.bareAt(p.x + p.rx * d, p.z + p.rz * d) - p.y).toFixed(3),
    });
  }
  return rows;
};

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
  const SPACINGS = [1, 2, 4];
  const brkCor = SPACINGS.map(function () { return []; });
  const brkFar = SPACINGS.map(function () { return []; });
  const BANDS = 13;
  const band = [];
  for (let b = 0; b < BANDS; b++) band.push([]);
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

    /* Where the curvature lives, in 2 m bands out from the midline.  A
     * single p99 says a fix went the wrong way; this says which part of
     * the cross-section did it. */
    for (let j = 1; j < ys.length - 1; j++) {
      const d = Math.abs((j - m) * step);
      const b = Math.min(BANDS - 1, Math.floor(d / 2));
      const k = Math.abs(ys[j+1] - 2 * ys[j] + ys[j-1]) / (step * step);
      band[b].push(k);
    }

    /* **And the same cross-section as the mesher will actually sample it.**
     *
     * The curvature above is the shape; what the ink fires on is the slope
     * break the *lattice* hands it, which is the second difference taken
     * at the vertex spacing and divided by it.  Those are the same number
     * only while the crease is broad compared with the spacing -- and
     * chunks.js meshes the corridor at 1 m near the car, 2 m past
     * FAR_LOD's first band and 4 m past its second, so a fillet six
     * metres wide is three vertices at 2 m and one and a half at 4.
     *
     * Every phase, because a crease that falls between two vertices at one
     * offset falls on one at another, and the mesher's lattice is aligned
     * to the world and not to the road. */
    for (let b = 0; b < SPACINGS.length; b++) {
      const w = Math.round(SPACINGS[b] / step);
      let bc = 0, bf = 0;
      for (let j = w; j < ys.length - w; j++) {
        const d = (j - m) * step;
        const br = Math.abs(ys[j+w] - 2 * ys[j] + ys[j-w]) / SPACINGS[b];
        if (Math.abs(d) <= corridor) { if (br > bc) bc = br; }
        else if (br > bf) bf = br;
      }
      brkCor[b].push(bc); brkFar[b].push(bf);
    }
    if (kc > worstCor.k) worstCor = { k: kc, s: s, at: cAt };
    if (kf > worstFar.k) worstFar = { k: kf, s: s, at: fAt };
  }

  const pct = (a, q) => {
    const b = a.slice().sort((x, y) => x - y);
    return b[Math.min(b.length - 1, Math.floor(b.length * q))];
  };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return {
    n: n,
    corP99: pct(cor, 0.99), corMax: Math.max.apply(null, cor),
    corMean: mean(cor),
    farP99: pct(far, 0.99), farMax: Math.max.apply(null, far),
    worstCor: worstCor, worstFar: worstFar,
    spacings: SPACINGS,
    brkCor: brkCor.map((a) => ({ mean: mean(a), p99: pct(a, 0.99), max: Math.max.apply(null, a) })),
    brkFar: brkFar.map((a) => ({ mean: mean(a), p99: pct(a, 0.99), max: Math.max.apply(null, a) })),
    band: band.map((a, i) => ({ at: i * 2, mean: mean(a), p99: pct(a, 0.99) })),
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
/* `SECTION` needs one place on the road, not the whole twelve kilometres
 * of it, and the walk is nearly all of this probe's wall time. */
const WALK_TO = process.env.SECTION ? Number(process.env.SECTION) + 400 : TO + 400;
for (let s = 20; s <= WALK_TO; s += 500) await c.evaluate(`__game.jumpTo(${s}, 50)`);
await c.evaluate(`__game.jumpTo(${process.env.SECTION || FROM}, 50)`);
await c.evaluate(PROBE);

if (process.env.SECTION) {
  const at = Number(process.env.SECTION);
  const rows = JSON.parse(await c.evaluate(
    `JSON.stringify(__section(${at}, 30, 0.5))`));
  console.log(`cross-section at s = ${at}, metres right of the midline`);
  console.log('   d      y     slope   curv    bare');
  for (const r of rows) {
    console.log(`  ${r.d.toFixed(1).padStart(5)} ${r.y.toFixed(3).padStart(7)}`
      + ` ${r.slope.toFixed(3).padStart(7)} ${r.k.toFixed(3).padStart(7)}`
      + ` ${r.bare.toFixed(3).padStart(8)}`);
  }
  c.close();
  process.exit(0);
}

const o = JSON.parse(await c.evaluate(`JSON.stringify(__creases(${FROM}, ${TO}, ${N}))`));
const bad = o.corP99 > THRESHOLD;

console.log(`sections      ${o.n}, s = ${FROM} to ${TO}`);
console.log(`corridor      mean ${o.corMean.toFixed(3)}`
  + `  p99 ${o.corP99.toFixed(2)}  max ${o.corMax.toFixed(2)}`);
console.log(`outer         p99 ${o.farP99.toFixed(2)}  max ${o.farMax.toFixed(2)}`
  + `   (the daylight line: reported, not asserted)`);
console.log('');
console.log('slope break per vertex row, which is what the ink fires on'
  + ` (KNEE ${KNEE})`);
console.log('  spacing   corridor mean / p99 / max      outer p99 / max');
for (let i = 0; i < o.spacings.length; i++) {
  const b = o.brkCor[i], f = o.brkFar[i];
  console.log(`  ${String(o.spacings[i] + ' m').padEnd(9)}`
    + `${b.mean.toFixed(3)} / ${b.p99.toFixed(2)} / ${b.max.toFixed(2)}`.padEnd(31)
    + `${f.p99.toFixed(2)} / ${f.max.toFixed(2)}`
    + (b.p99 > KNEE ? '   <- over the knee' : ''));
}
if (process.env.BANDS) {
  console.log('');
  console.log('curvature by distance from the midline');
  for (const b of o.band) {
    console.log(`  ${String(b.at + '-' + (b.at + 2) + ' m').padEnd(9)}`
      + `mean ${b.mean.toFixed(3)}   p99 ${b.p99.toFixed(2)}`);
  }
}
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
