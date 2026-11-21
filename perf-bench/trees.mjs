/* ------------------------------------------------------------------ *
 * Does every tree you can hit have a collider?  `prompt_5.md` issue 1:
 * "why most trees have no collision detection?  Only one in a hundred
 * has?"
 *
 * Two measurements, both in recording mode on the stepped clock, so the
 * numbers are the same every run:
 *
 *   coverage   every 2 s of full autodrive, each non-scrub trunk within
 *              80 m of the car: is there a collider at its axis, half way
 *              up?  `intersectionsWithPoint`, so it is a question to the
 *              physics world and not to our own bookkeeping, and it reads
 *              the same against HEAD's code as against the fix.
 *   impact     the car put down 25 m from a trunk on open, level ground,
 *              aimed at it, full throttle, six seconds.  Pass is the front
 *              of the car stopping within a metre of the *drawn* bark --
 *              not through it (no collider) and not well short of it (a
 *              collider fatter than the tree).
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/trees.mjs
 *
 * `SEED`, `SECS` (autodrive seconds for coverage, default 60), `HITS`
 * (trunks to drive at, default 20).
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';

const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
const SECS = Number(process.env.SECS || 60);
const HITS = Number(process.env.HITS || 20);

const c = await launch({ w: 960, h: 540 });
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride',
             { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
await c.send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&seed=${SEED}&t=11:00&weather=sunny&dynres=0&places=off`,
});
for (let i = 0; i < 480; i++) {
  if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}
await c.evaluate('window.__game.loaded');

/* The page half of both measurements, installed once. */
await c.evaluate(`(() => {
  const g = __game;
  /* Scatter's own trunk records near the car.  Scrub is not in them, by
   * design: a bush brushes past. */
  window.__trunksNear = (R) => {
    const out = [];
    const p = g.car.pos;
    for (const list of g.scatter.trunks.values()) {
      for (const t of list) {
        if (Math.hypot(t.x - p.x, t.z - p.z) > R) continue;
        out.push(t);
      }
    }
    return out;
  };
  window.__hasCollider = (t) => {
    let hit = false;
    g.physics.world.intersectionsWithPoint(
      { x: t.x, y: t.y + Math.min(1.2, t.h / 2), z: t.z },
      () => { hit = true; return false; });
    return hit;
  };
})()`);

/* ---------------------------- coverage ---------------------------- */
let seen = 0, solid = 0;
const rows = [];
for (let t = 0; t < SECS; t += 2) {
  for (let i = 0; i < 60; i++) await c.evaluate('__game.step(1/30)');
  const r = await c.evaluate(`(() => {
    const ts = __trunksNear(80);
    let n = 0;
    for (const t of ts) if (__hasCollider(t)) n++;
    return { n: ts.length, solid: n, km: +(__game.odometer / 1000).toFixed(2) };
  })()`);
  seen += r.n; solid += r.solid;
  rows.push(r);
}
const cov = seen ? solid / seen : 0;
console.log(`coverage  ${solid} of ${seen} trunk-samples within 80 m have a collider`
  + `  (${(cov * 100).toFixed(1)} %)  over ${rows[rows.length - 1].km} km`);
const worst = rows.reduce((a, r) => (r.n && r.solid / r.n < a.v ? { v: r.solid / r.n, r } : a), { v: 2 });
if (worst.r) console.log(`          worst sample ${worst.r.solid}/${worst.r.n} at ${worst.r.km} km`);

/* ----------------------------- impact ----------------------------- */
/* Off the road and onto open ground for each run, so the autopilot and
 * the rails are out of it.  Candidates are trunks with 25 m of nearly
 * level, tree-free, road-free run-up in some direction. */
const results = [];
let s = 300;
while (results.length < HITS && s < 9000) {
  await c.evaluate(`__game.jumpTo(${s}, 20)`);
  const picks = JSON.parse(await c.evaluate(`(() => {
    const g = __game, T = g.terrain;
    const all = __trunksNear(150);
    const out = [];
    for (const t of all) {
      if (out.length >= 3) break;
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4 + 0.3;
        const dx = Math.cos(a), dz = Math.sin(a);
        const sx = t.x - dx * 25, sz = t.z - dz * 25;
        let ok = true;
        const y0 = T.heightAt(sx, sz);
        for (let d = 0; d <= 25 && ok; d += 2.5) {
          const x = sx + dx * d, z = sz + dz * d;
          const y = T.heightAt(x, z);
          if (Math.abs(y - (y0 + (T.heightAt(t.x, t.z) - y0) * d / 25)) > 0.6) ok = false;
          const q = g.road.nearest(x, z, {});
          if (q && q.d < 9) ok = false;
        }
        if (!ok) continue;
        if (Math.abs(T.heightAt(t.x, t.z) - y0) > 2) continue;
        /* Nothing else in the corridor, and nothing just behind the
         * target that the car could be stopped by instead -- out of every
         * live chunk, not only the ones near the car, because a target at
         * the edge of the 150 m pick has a corridor that leaves it. */
        for (const list of g.scatter.trunks.values()) for (const o of list) {
          if (o === t) continue;
          const ox = o.x - sx, oz = o.z - sz;
          const along = ox * dx + oz * dz;
          const across = Math.abs(-ox * dz + oz * dx);
          if (along > -2 && along < 28 && across < 2.6) { ok = false; break; }
        }
        if (!ok) continue;
        out.push({ t: { x: t.x, z: t.z, y: t.y, r: t.r, h: t.h }, sx, sz, a });
        break;
      }
    }
    return JSON.stringify(out);
  })()`));
  for (const p of picks) {
    if (results.length >= HITS) break;
    const r = JSON.parse(await c.evaluate(`(() => {
      const g = __game, car = g.car, T = g.terrain;
      const p = ${JSON.stringify(p)};
      g.auto.setMode('manual');
      g.input.scripted = true;
      const ax = g.input.axes;
      ax.throttle = 0; ax.brake = 0; ax.steer = 0; ax.handbrake = 0;
      car.teleport(p.sx, T.heightAt(p.sx, p.sz) + car.m.axleHeight + 0.3, p.sz, p.a);
      for (let i = 0; i < 20; i++) g.step(1 / 30);
      /* The trunk's drawn radius at the height the bumper meets it. */
      ax.throttle = 1;
      let best = Infinity, past = false, wide = false, vmax = 0;
      const dx = Math.cos(p.a), dz = Math.sin(p.a);
      const front = car.m.bodyLength / 2;
      for (let i = 0; i < 180; i++) {
        g.step(1 / 30);
        const along = (p.t.x - car.pos.x) * dx + (p.t.z - car.pos.z) * dz;
        best = Math.min(best, along);
        vmax = Math.max(vmax, Math.abs(car.speed));
        /* Past the trunk *and in line with it* is through it.  Past it
         * off to one side is a car the slope steered wide, which is a
         * miss and not a missing collider. */
        if (along < 0 && !past && !wide) {
          const across = Math.abs(-(p.t.x - car.pos.x) * dz + (p.t.z - car.pos.z) * dx);
          if (across < car.m.bodyWidth / 2 + p.t.r) past = true; else wide = true;
        }
      }
      ax.throttle = 0;
      g.input.scripted = false;
      /* What stopped it, when it was not the target: the nearest trunk to
       * the bumper and the ground under it. */
      const fx = car.pos.x + dx * front, fz = car.pos.z + dz * front;
      let near = Infinity;
      for (const list of g.scatter.trunks.values()) for (const o of list) {
        if (o.x === p.t.x && o.z === p.t.z) continue;
        near = Math.min(near, Math.hypot(o.x - fx, o.z - fz));
      }
      return JSON.stringify({ gap: best - front, past, wide, vmax, col: __hasCollider(p.t),
        other: +near.toFixed(1), slope: +T.gradientAt(fx, fz, 2).slope.toFixed(2) });
    })()`));
    results.push({ ...p, ...r });
    /* The drawn radius is the record's over its 1.05 margin -- see
     * `Scatter._build`.  (Against HEAD's code the record is the unit
     * geometry's 0.10 m, so this column is only meaningful after the fix;
     * `past` is meaningful on both.) */
    const drawn = p.t.r / 1.05;
    /* The bumper should stop at the bark: `gap` is centre-to-axis minus
     * the car's front overhang, so a hit on the bark leaves `gap` at about
     * the trunk's radius.  Through it is `past`; well short of it is a
     * collider fatter than the tree. */
    const ok = !r.past && r.gap > -0.3 && r.gap < drawn + 1.0;
    /* Steered wide by the ground is not a verdict on the collider either
     * way, so it does not count. */
    if (r.wide) {
      results.pop();
      console.log(`impact --  s=${s}  slope steered the car wide of the trunk; not counted`);
      continue;
    }
    results[results.length - 1].ok = ok;
    console.log(`impact ${String(results.length).padStart(2)}  s=${s}  r=${drawn.toFixed(2)} m  `
      + `closest bumper-to-axis ${r.gap.toFixed(2)} m  top ${r.vmax.toFixed(1)} m/s  `
      + `${r.past ? 'THROUGH' : ''}${r.col ? '' : ' (no collider)'}  ${ok ? 'ok' : 'FAIL'}`
      + `${ok ? '' : `  (other trunk ${r.other} m from the bumper, slope ${r.slope})`}`);
  }
  s += 700;
}
const hit = results.filter((r) => r.ok).length;
console.log(`impact  ${hit} of ${results.length} stopped at the bark`);
c.close();
process.exit(cov > 0.99 && hit === results.length ? 0 : 1);
