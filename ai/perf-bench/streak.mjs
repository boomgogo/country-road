/* ------------------------------------------------------------------ *
 * The ink on the verge, measured in the picture.
 *
 * `prompt_3.md` item 2: "I can still see the ink outline on road side at a
 * distance", with `ref/prompt_3_1.png` and `ref/prompt_3_2.png`.  What is
 * in those stills is a dark line in the grass running parallel to the road
 * -- **absent in the near field and present from about forty metres out**,
 * which is the half `verge.mjs` cannot see.
 *
 * `verge.mjs` measures the *ground*: curvature per metre, sampled at half
 * a metre, walking the road.  That is the right quantity and it is blind
 * to both of the things that make this a distance phenomenon.  It does not
 * know what lattice the ground will be meshed on -- a crease reaches the
 * screen as a slope break of curvature times *vertex spacing*, and
 * `chunks.js` runs the corridor at 1 m, then 2, then 4.  And it does not
 * know how far away the ground will be seen from -- the ink takes its
 * second difference over a fixed number of *texels*, so the world footprint
 * of its tap grows with depth, and the signal from a crease of fixed
 * curvature grows roughly in proportion to it.  So `verge.mjs` scored the
 * shipped build at a corridor p99 of 0.89 while the user was still looking
 * at lines.  That is a probe telling the truth about the wrong quantity.
 *
 * This is the other one.
 *
 * **Ink on minus ink off.**  `plan_2.md` tried a picture probe and
 * abandoned it: a band projected from the road runs through whatever is
 * standing on the verge and its far half lands on the landform silhouette,
 * and at s = 2500 it scored a fix as 20 % worse while the cross-sections
 * underneath it were three to six times better.  Differencing the two
 * renders is what fixes that.  Grass, texture, trees, shadows, the
 * hillside behind and the sky all cancel exactly, because the only thing
 * that changed between the two frames is the pass being measured.
 *
 * **Bucketed by depth**, because that is the whole complaint.  A single
 * number over the band averages a clean near field together with a
 * streaked middle distance and reports neither.
 *
 * **The band is built in the world and projected**, not cut out of the
 * screen: walk the midline, step out across the verge, ask `heightAt`, and
 * project.  So the band follows the road round a bend and up a rise, the
 * depth of every pixel in it is known exactly rather than guessed from its
 * height up the frame, and the tarmac and the far landform are excluded by
 * construction instead of by a rectangle.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node ai/perf-bench/streak.mjs
 *     HEADLESS=1 CASES=high,medium,low,lod1 node ai/perf-bench/streak.mjs
 *     HEADLESS=1 SHOTS=/tmp/streak node ai/perf-bench/streak.mjs
 *
 * What to read: the **ratio** column, the far buckets against the near
 * one.  The absolute numbers are a fraction of a grey level averaged over
 * a band and mean little on their own; what the stills show is that the
 * near verge is clean and the middle distance is not, and that is a shape
 * across the buckets and not a level.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
const AT = Number(process.env.AT || 10520);
const SHOTS = process.env.SHOTS || '';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);

/* The tiers, and the diagnostic.  `lod1` is `high` with the corridor
 * pinned to 1 m spacing however far from the car it is -- see
 * `ChunkField._lodFor`.  If the streaks do not move between `high` and
 * `lod1`, the lattice is not what is making them, and the spacing columns
 * in `verge.mjs` are a distraction rather than the answer. */
const ALL = {
  high: 'quality=high',
  medium: 'quality=medium',
  low: 'quality=low',
  lod1: 'quality=high&lod=1',
};
const CASES = (process.env.CASES || 'high,medium,low,lod1').split(',');

const PROBE = `
window.__streak = function (opts) {
  var g = __game, R = g.road, T = g.terrain, cam = g.camera;
  var gl = g.renderer.getContext();
  var w = g.renderer.domElement.width, h = g.renderer.domElement.height;

  /* --- the band, in the world ---------------------------------------- *
   * Out from the platform edge rather than from the midline: the tarmac
   * and its shoulder are not what is being measured and the drawn edge of
   * the road is a line the picture is entitled to have. */
  var from = opts.from, to = opts.to;
  var near = opts.near, far = opts.far;
  var edges = opts.edges;                 // bucket boundaries, metres
  var bucket = new Int16Array(w * h);
  bucket.fill(-1);
  /* A Vector3 without the namespace: the module is bundled and there is
   * no global THREE on the page, so borrow one off the camera. */
  var p = {}, v = cam.position.clone();
  var sN = g.car.s === undefined ? opts.at : opts.at;

  for (var s = sN + from; s < sN + to; s += 0.5) {
    R.sampleAt(s, p);
    for (var side = -1; side <= 1; side += 2) {
      for (var d = near; d <= far; d += 0.5) {
        var x = p.x + p.rx * d * side, z = p.z + p.rz * d * side;
        var wy = T.heightAt(x, z);
        v.set(x, wy, z);
        var dist = v.distanceTo(cam.position);

        /* --- is it actually visible? ---------------------------------- *
         * The band is built in the world and then projected, and without
         * this a point behind a rise still claims its pixel -- and the
         * pixel shows whatever *is* in front, which at two hundred metres
         * is usually the road further on, a fence, or the skyline.  Those
         * ink strongly and legitimately, and counting them as verge is how
         * the far bucket came back saying a fix had trebled the ink while
         * the frames were indistinguishable.  It is the same fault
         * plan_2.md's picture probe was abandoned for; differencing the
         * two renders removes the *texture* under the band and does
         * nothing whatever about what is standing in front of it.
         *
         * Marched against the *finished* ground and not the bare
         * landform, which is the version of this that rejected every
         * point in the frame: where the road is in a cutting the bare
         * landform is precisely the material that has been dug out of the
         * way, so it stands above the eye for most of the ray and the test
         * says nothing is ever visible.
         *
         * A metre of tolerance and a sixteen-metre step, because the
         * question is whether a hill is in the way and not whether a tuft
         * is: a tight test on a lattice-sampled surface rejects points
         * that are plainly visible, which biases the near buckets exactly
         * where they are most trustworthy. */
        var vis = true;
        var steps = Math.min(40, Math.max(3, Math.round(dist / 16)));
        for (var t = 1; t < steps; t++) {
          var f = t / steps;
          var sx = cam.position.x + (x - cam.position.x) * f;
          var sz = cam.position.z + (z - cam.position.z) * f;
          var sy = cam.position.y + (wy - cam.position.y) * f;
          if (T.heightAt(sx, sz) > sy + 1.0) { vis = false; break; }
        }
        if (!vis) continue;

        v.project(cam);
        if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1 || v.z > 1) continue;
        var px = Math.round((v.x * 0.5 + 0.5) * (w - 1));
        var py = Math.round((1 - (v.y * 0.5 + 0.5)) * (h - 1));
        var b = -1;
        for (var k = 0; k < edges.length - 1; k++) {
          if (dist >= edges[k] && dist < edges[k + 1]) { b = k; break; }
        }
        if (b < 0) continue;
        /* Nearest bucket wins where two land on one pixel, so a pixel is
         * scored at the depth of the surface actually in front. */
        var i = py * w + px;
        if (bucket[i] < 0 || b < bucket[i]) bucket[i] = b;
      }
    }
  }

  window.__band = bucket;
  return { px: w * h };
};

/* The frame, off the canvas.  present() is what has to drive the draw --
 * it renders inside the browser's own frame callback, which is the one
 * ordering a read-back can rely on, and it is the path grab() and every
 * other capture here already take. */
window.__frame = function () {
  var gl = __game.renderer.getContext();
  var w = __game.renderer.domElement.width, h = __game.renderer.domElement.height;
  var buf = new Uint8Array(w * h * 4);
  gl.finish();
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return buf;
};

window.__score = function (on, off, edges) {
  var g = __game;
  var w = g.renderer.domElement.width, h = g.renderer.domElement.height;
  var bucket = window.__band;

  /* --- score ---------------------------------------------------------- *
   * The ink only ever darkens, so the signed drop is the signal and a
   * brightening is noise -- which is what lets a single-sided sum separate
   * the pass from the dither and the eight-bit rounding under it. */
  var n = edges.length - 1;
  var sum = new Float64Array(n), cnt = new Float64Array(n), hit = new Float64Array(n);
  for (var y = 0; y < h; y++) {
    for (var xx = 0; xx < w; xx++) {
      /* readPixels is bottom-up and the band was built top-down. */
      var bi = (h - 1 - y) * w + xx;
      var b = bucket[bi];
      if (b < 0) continue;
      var o = (y * w + xx) * 4;
      var lOn = on[o] * 0.2126 + on[o+1] * 0.7152 + on[o+2] * 0.0722;
      var lOff = off[o] * 0.2126 + off[o+1] * 0.7152 + off[o+2] * 0.0722;
      var drop = lOff - lOn;
      if (drop > 0) { sum[b] += drop; if (drop > 6) hit[b]++; }
      cnt[b]++;
    }
  }
  var out = [];
  for (var k = 0; k < n; k++) {
    out.push({
      lo: edges[k], hi: edges[k + 1], px: cnt[k],
      ink: cnt[k] ? sum[k] / cnt[k] : 0,
      frac: cnt[k] ? hit[k] / cnt[k] : 0,
    });
  }
  return out;
};
true`;

const EDGES = (process.env.EDGES || '20,50,120,300').split(',').map(Number);

const c = await launch({ w: W, h: H });
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride',
             { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const rows = [];
for (const tag of CASES) {
  const q = ALL[tag] || tag;
  await c.send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&dynres=0&day=1`
       + `&seed=${SEED}&t=08:20&season=spring&weather=sunny&${q}`,
  });
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await c.evaluate('window.__game.loaded');
  /* Walked, not jumped -- `ink.mjs` explains why. */
  for (let s = 20; s <= AT; s += 500) {
    await c.evaluate(`__game.jumpTo(${s}, 50)`);
    await c.evaluate('__game.present()');
  }
  await c.evaluate(`__game.jumpTo(${AT}, 50)`);
  for (let i = 0; i < 4; i++) await c.evaluate('__game.present()');
  process.stderr.write(tag + ': in place, scoring\n');
  await c.evaluate(PROBE);
  await c.evaluate(`__streak({ at: ${AT}, from: 10, to: 420, near: 8, far: 26,`
    + ` edges: [${EDGES.join(',')}] })`);

  /* The two frames stay in the page: they are three and a half megabytes
   * each and CDP would serialise them to JSON to hand them over. */
  for (const [on, into] of [[true, '__on'], [false, '__off']]) {
    await c.evaluate(`__game.pipeline.enabled.ink = ${on}`);
    await c.evaluate('__game.present()');
    await c.evaluate(`window.${into} = __frame(), 1`);
  }
  await c.evaluate('__game.pipeline.enabled.ink = true');
  const o = JSON.parse(await c.evaluate(
    `JSON.stringify(__score(window.__on, window.__off, [${EDGES.join(',')}]))`));
  rows.push({ tag, o });

  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    const u = await c.evaluate('window.__game.grab()');
    writeFileSync(`${SHOTS}/${tag}.png`, Buffer.from(String(u).split(',')[1], 'base64'));
  }

  const base = o[0].ink || 1e-9;
  console.log(`${tag}`);
  for (const b of o) {
    console.log(`   ${String(b.lo + '-' + b.hi + ' m').padEnd(11)}`
      + `ink ${b.ink.toFixed(2).padStart(6)}   inked px ${(b.frac * 100).toFixed(1).padStart(5)} %`
      + `   x${(b.ink / base).toFixed(2).padStart(6)}   (${b.px} px)`);
  }
}

console.log('');
console.log('summary, far bucket against near');
console.log('  case      ' + EDGES.slice(0, -1).map((e, i) => `${e}-${EDGES[i+1]}`.padStart(10)).join(''));
for (const { tag, o } of rows) {
  const base = o[0].ink || 1e-9;
  console.log(`  ${tag.padEnd(10)}` + o.map((b) => `x${(b.ink / base).toFixed(2)}`.padStart(10)).join(''));
}

c.close();
process.exit(0);
