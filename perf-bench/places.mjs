/* ------------------------------------------------------------------ *
 * Are the places standing where they should, and what do they cost?
 * `ai/plan_5.md` §14.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/places.mjs                 # the checks
 *     HEADLESS=1 MODE=cost node perf-bench/places.mjs       # the frame rate
 *
 * **The checks** (`MODE=check`, the default), for the first `TOWNS` towns
 * and `LANDMARKS` landmarks of each seed in `SEEDS`, each visited by
 * teleport and sited by the game's own streaming:
 *
 *   clearance  no footprint within `CLEAR` of any carriageway, nor within
 *              `CLEAR_OTHER` of a different stretch of road
 *   standing   no floor below its own ground, and none more than its
 *              footing allows above it
 *   yards      no scatter trunk inside a place's clearing
 *   solid      every building has a collider, once the car is within 190 m
 *   signs      every distance sign's number within half a kilometre of the
 *              arc distance to its town, along 60 km of road
 *
 * and a still of each at 11:00 and at 22:00, put on two contact sheets in
 * `OUT` by `tools/play/sheet.py`.  **The sheets are for a person to look
 * at**: whether a town reads as a town is not a number.
 *
 * **The cost** (`MODE=cost`): the real frame loop, CPU-throttled by
 * `THROTTLE` (default 4), in `DEV=phone` emulation or at 1280x720, at the
 * quality in `Q`.  The car drives through the first town on full
 * autodrive, by day and by night, and the median frame rate there is
 * compared with the same stretch under `?places=off` and with open road.
 *
 * **Read it with its noise in mind.**  Twenty seconds of real frames is a
 * few hundred samples, and the chunk builder's share of a frame swings by
 * several milliseconds with how much ground is queued -- so two runs of
 * the same build differ by five to ten percent on their own.  Where the
 * number matters, the per-system timing is the better instrument: places
 * measured 0.13 ms a frame of script and 0.6 ms of rendering at 4x on the
 * phone emulation, against a 25 ms frame (`ai/next_5.md`).
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const PORT = process.env.PORT || 5178;
const MODE = process.env.MODE || 'check';
const SEEDS = (process.env.SEEDS || 'country,7').split(',');
const TOWNS = Number(process.env.TOWNS || 6);
const LANDMARKS = Number(process.env.LANDMARKS || 20);
const OUT = process.env.OUT || 'capture/places';

const c = await launch({ w: 1280, h: 720 });
await c.send('Page.enable');

async function open(query) {
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?${query}` });
  for (let i = 0; i < 480; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await c.evaluate('window.__game.loaded');
}


/* ------------------------------ the checks ----------------------------- */

async function check() {
  await c.send('Emulation.setDeviceMetricsOverride',
               { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  for (const dir of ['day', 'night']) {
    rmSync(`${OUT}/${dir}`, { recursive: true, force: true });
    mkdirSync(`${OUT}/${dir}`, { recursive: true });
  }
  const fails = [];
  let visited = 0, refused = 0;
  for (const seed of SEEDS) {
    await open(`rec=1&fresh&sound=0&dynres=0&seed=${seed}&t=11:00&weather=fewClouds`);
    await c.evaluate(PAGE);
    const entries = JSON.parse(await c.evaluate(`(() => {
      const P = __game.plan;
      const all = P.between(0, 160000).filter((e) => e.kind !== 'sign');
      const towns = all.filter((e) => e.kind === 'town').slice(0, ${TOWNS});
      const marks = all.filter((e) => e.kind !== 'town').slice(0, ${LANDMARKS});
      return JSON.stringify([...towns, ...marks].map((e) => ({ s: e.s, d: e.d, line: e.line, kind: e.kind, name: e.name || '' })));
    })()`));
    /* The signs, along 60 km of the forward line, from the schedule the
     * built signs are drawn from. */
    const signBad = await c.evaluate(`(() => {
      const P = __game.plan;
      let bad = 0, n = 0;
      for (const e of P.between(0, 60000)) {
        if (e.kind !== 'sign') continue;
        for (const t of P.signTowns(e)) {
          const km = Math.max(1, Math.round(Math.abs(t.s - e.s) / 1000));
          if (Math.abs(km * 1000 - Math.abs(t.s - e.s)) > 500 && km > 1) bad++;
          n++;
        }
      }
      return bad + '/' + n;
    })()`);
    console.log(`${seed}: distance signs off by more than 0.5 km: ${signBad}`);
    if (!signBad.startsWith('0/')) fails.push(`${seed} signs ${signBad}`);

    for (const e of entries) {
      const r = JSON.parse(await c.evaluate(`__visit(${JSON.stringify(e)})`));
      visited++;
      const tag = `${seed}-${e.kind}-${e.s}`;
      if (r.refused) {
        refused++;
        console.log(`  ${tag.padEnd(28)} refused  ${JSON.stringify(r.why)}`);
        continue;
      }
      const bad = [];
      if (r.clear) bad.push(`${r.clear} too near the road`);
      if (r.stand) bad.push(`${r.stand} floating or buried`);
      if (r.yard) bad.push(`${r.yard} trunks in yards`);
      if (r.solid) bad.push(`${r.solid} buildings without a collider`);
      console.log(`  ${tag.padEnd(28)} ${String(r.items).padStart(2)} buildings  ${bad.length ? 'FAIL ' + bad.join(', ') : 'ok'}`
        + `${e.name ? '  ' + e.name : ''}`);
      if (bad.length) fails.push(`${tag}: ${bad.join(', ')}`);
      for (const [dir, t] of [['day', 11], ['night', 22]]) {
        const url = await c.evaluate(`(() => { __game.setTime(${t}); __game.step(1 / 30); __look(); return __game.grab(); })()`);
        writeFileSync(`${OUT}/${dir}/${tag}.png`, Buffer.from(url.split(',')[1], 'base64'));
      }
      await c.evaluate('__game.setTime(11)');
    }
  }
  for (const dir of ['day', 'night']) {
    try { execFileSync('python3', ['tools/play/sheet.py', `${OUT}/${dir}`, `${OUT}/${dir}.png`, '6'], { stdio: 'inherit' }); }
    catch { console.log('(no contact sheet: tools/play/sheet.py needs Pillow)'); }
  }
  console.log(`${visited} visited, ${refused} refused by their ground, ${fails.length} failing`);
  if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
}

/* The page half of the checks. */
const PAGE = `(() => {
  const g = __game;
  const CW = 4.3, CLEAR = 8.5, OTHER = 22;
  let last = null;
  window.__visit = (e) => {
    const P = g.places, r = g.road;
    const back = e.line === 1;
    if (back) r.extendBehind(0, e.d + 3000, 1e7); else r.extendAhead(0, e.d + 3000, 1e7);
    const dir = back ? -1 : 1;
    g.jumpTo(e.s - 60 * dir, 30);
    const key = e.line + ':' + e.d + ':' + e.kind;
    for (let i = 0; i < 400 && !P.live.has(key) && !P.refused.has(key); i++) g.step(1 / 30);
    const p = P.live.get(key);
    if (!p) return JSON.stringify({ refused: true, why: P.why });
    /* The car is within 190 m of a place it has just been put beside, so
     * its colliders exist by now. */
    for (let i = 0; i < 3; i++) g.step(1 / 30);
    const out = { items: 0, clear: 0, stand: 0, yard: 0, solid: 0 };
    const q = {};
    for (const it of p.layout) {
      if (it.light) continue;
      out.items++;
      const a = it.a, [x0, z0, x1, z1] = a.foot;
      let lo = Infinity, hi = -Infinity;
      /* The nine points the siting itself samples: a floor is measured
       * against the highest of them, and a hump in the middle of a lot is
       * ground under the house as much as a corner is. */
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      for (const [lx, lz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [mx, z0], [mx, z1], [x0, mz], [x1, mz], [mx, mz]]) {
        const wx = it.f.x + it.f.tx * lx + it.f.zx * lz, wz = it.f.z + it.f.tz * lx + it.f.zz * lz;
        const n = r.nearest(wx, wz, q);
        if (n && (n.d < CW + CLEAR - 0.05 || (Math.abs(n.s - it.s) > 250 && n.d < CW + OTHER - 0.05))) out.clear++;
        const y = g.terrain.heightAt(wx, wz);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
      const above = it.floor - hi;
      const most = a.footing === 'stumps' ? 0.6 + (a.floorLift || 0) : (a.footing === 'none' ? 2.5 : 0.4);
      const least = a.footing === 'none' ? -(a.spread || 3) : 0;
      if (above < least - 0.01 || above > most) out.stand++;
      let hit = false;
      g.physics.world.intersectionsWithPoint({ x: it.f.x, y: it.floor + 1.0, z: it.f.z }, () => { hit = true; return false; });
      if (!hit && a.colliders.length && a.colliders.some((c) => c.type === 'box' && c.x0 < 0 && c.x1 > 0 && c.z0 < 0 && c.z1 > 0)) out.solid++;
    }
    for (const list of g.scatter.trunks.values()) {
      for (const t of list) {
        const b = p.box;
        if (t.x < b.minX || t.x > b.maxX || t.z < b.minZ || t.z > b.maxZ) continue;
        if (P.blocked(t.x, t.z)) out.yard++;
      }
    }
    last = p;
    return JSON.stringify(out);
  };
  /* A still: from the road short of the place, looking at the middle of
   * what was built, from a little above a driver's eye. */
  window.__look = () => {
    const p = last;
    if (!p) return;
    let x = 0, y = 0, z = 0, n = 0;
    for (const it of p.layout) if (!it.light) { x += it.f.x; y += it.floor; z += it.f.z; n++; }
    x /= n; y /= n; z /= n;
    /* From the road side of the place, back along the way you would come,
     * at a distance that frames it: a town is a few hundred metres of
     * street, a farm is a house and a shed. */
    const town = p.e.kind === 'town';
    const s = p.e.s - (p.e.line ? -1 : 1) * (town ? 200 : 60);
    const a = g.road.sampleAt(s, {});
    let dx = a.x - x, dz = a.z - z;
    const l = Math.hypot(dx, dz) || 1;
    const far = town ? 230 : 75;
    const cx = x + dx / l * far, cz = z + dz / l * far;
    const cam = g.camera;
    cam.position.set(cx, Math.max(g.terrain.heightAt(cx, cz), y) + (town ? 30 : 12), cz);
    cam.lookAt(x, y + 2, z);
    cam.updateMatrixWorld();
    g.sky.update(0, cam, g.atmos, g.weather.p.wind);
    if (g.clouds) g.clouds.update(cam, g.atmos, g.weather.p, g.clock);
    g.celestial.update(g.clock, cam, g.weather.p.cloud * 0.35, g.renderer.getPixelRatio());
    g.places.paint(0, cam, g.clock, g.car, g.headlights, g.atmos, g.pipeline.rtScene.height);
  };
})()`;

/* ------------------------------- the cost ------------------------------ */

async function cost() {
  const THROTTLE = Number(process.env.THROTTLE || 4);
  const PHONE = process.env.DEV === 'phone';
  const Q = process.env.Q || (PHONE ? 'low' : 'medium');
  const SECS = Number(process.env.SECS || 20);
  const seed = SEEDS[0];
  await c.send('Emulation.setDeviceMetricsOverride', PHONE
    ? { width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true }
    : { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  console.log(`throttle ${THROTTLE}x  quality ${Q}  ${PHONE ? 'phone 393x851@2.75' : '1280x720'}  seed ${seed}`);
  for (const t of ['11:00', '22:00']) {
    const row = {};
    for (const [label, places, where] of [['town', '', 'town'], ['town, places off', '&places=off', 'town'],
                                          ['open road', '', 'open']]) {
      await c.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      /* `dynres=0`: the governor would otherwise answer a slower frame
       * with a smaller one, and the A/B would measure the governor. */
      await open(`auto=full&fresh&sound=0&dynres=0&seed=${seed}&t=${t}&quality=${Q}${places}`);
      /* The places arrive after the first frame; give them a moment. */
      for (let i = 0; i < 40; i++) {
        if (places || await c.evaluate('!!__game.places')) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const start = await c.evaluate(`(() => {
        const t = __game.plan.town(0, 0);
        return '${where}' === 'town' ? t.s - 380 : Math.max(200, t.s - 2600);
      })()`);
      await c.evaluate(`(() => {
        const g = __game;
        g.road.extend(0, ${start} + 4000, 1e6, 600);
        g.jumpTo(${start}, 30);
        g.setTime(${Number(t.slice(0, 2))});
      })()`);
      await new Promise((r) => setTimeout(r, 3000));
      await c.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      const r = JSON.parse(await c.evaluate(`new Promise((done) => {
        const g = __game;
        const times = [];
        let last = performance.now(), calls = 0, n = 0;
        /* Counted over the whole frame, every pass, rather than the last
         * render call's -- which, with the post chain, is one quad. */
        g.renderer.info.autoReset = false;
        g.renderer.info.reset();
        const s0 = g.auto.s;
        const end = last + ${SECS} * 1000;
        const f = () => {
          const now = performance.now();
          times.push(now - last); last = now;
          calls += g.renderer.info.render.calls; n++;
          g.renderer.info.reset();
          if (now < end) requestAnimationFrame(f);
          else {
            const mean = times.reduce((a, b) => a + b, 0) / times.length;
            times.sort((a, b) => a - b);
            done(JSON.stringify({ fps: 1000 / times[times.length >> 1], mean, p95: times[Math.floor(times.length * 0.95)],
              calls: Math.round(calls / n), metres: Math.round(g.auto.s - s0),
              live: g.places ? g.places.live.size : 0 }));
          }
        };
        requestAnimationFrame(f);
      })`));
      row[label] = r;
      console.log(`  ${t}  ${label.padEnd(18)} median ${r.fps.toFixed(1)} fps  mean ${r.mean.toFixed(1)} ms  p95 ${r.p95.toFixed(0)} ms  `
        + `${r.calls} draw calls  ${r.metres} m driven  ${r.live} places live`);
    }
    const a = row.town.fps, b = row['town, places off'].fps, o = row['open road'].fps;
    console.log(`  ${t}  town against places off: ${((a / b - 1) * 100).toFixed(1)} %   against open road: ${((a / o - 1) * 100).toFixed(1)} %`);
  }
}

/* Last, so everything above is defined by the time it runs. */
if (MODE === 'cost') await cost();
else await check();
c.close();
