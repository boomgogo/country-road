#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Play the game, from a script.  `prompt_4.md` item 1.
 *
 *     npx vite --port 5178
 *     node tools/play/autoplay.mjs                       # 20 minutes of play
 *     node tools/play/autoplay.mjs --minutes 120 --seed hills --log /tmp/p.jsonl
 *     node tools/play/autoplay.mjs --realtime --throttle 4 --quality low
 *
 * It drives the way a player does, and only with the keys a player has:
 * autodrive on, and then, on a seeded schedule, the things people do
 * with it -- look through the other cameras, nudge the wheel and let the
 * autopilot take it back, handbrake out of autodrive, run off into a
 * field and press T, try the part-auto modes, wind the clock, rest
 * through a night.  Every action states what should follow from it and
 * is checked; and `lib.mjs`'s `Watch` checks, on every sample, the
 * things that are wrong whatever is happening -- off the road under the
 * autopilot, stuck, fallen through the ground, no ground, an exception.
 *
 * Minutes of *play*: the game runs a game-hour to the real minute, so
 * `--minutes 20` is twenty game-hours -- most of a day and a night.
 *
 * Writes one JSON line per minute of play to `--log`, and exits non-zero
 * with a list of failures if anything fired.  On a failure in stepped
 * mode it saves the frame next to the log.
 *
 * Flags:
 *   --minutes n     minutes of play: game time stepped, wall time realtime
 *   --seed s        world seed, default `country`
 *   --quality q     low | medium | high; default is `?rec`'s `high`
 *   --realtime      the page's own frame loop instead of stepped frames
 *   --throttle n    CDP CPU slow-down, realtime only makes sense
 *   --calm          no scenario, just the autopilot -- the film's driving
 *   --log path      JSONL, default /tmp/autoplay.jsonl
 *   --port n        the dev server, default 5178
 * ------------------------------------------------------------------ */
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openGame, rng, Watch } from './lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const MINUTES = Number(arg('minutes', 20));
const SEED = String(arg('seed', 'country'));
const QUALITY = arg('quality', '');
const REALTIME = !!arg('realtime', false);
const THROTTLE = Number(arg('throttle', 1));
const CALM = !!arg('calm', false);
const LOG = String(arg('log', '/tmp/autoplay.jsonl'));
const PORT = Number(arg('port', 5178));

/* ----------------------------- the scenario ---------------------------- */

/**
 * Each action returns a list of failures, empty when it went as it
 * should.  `excuse` is set while an action is *meant* to be off the road,
 * so `Watch` does not report the excursion it asked for.
 */
const ACTIONS = {
  /** Another camera, for a while.  It must take. */
  async camera(g, r) {
    const want = ['chaseFar', 'bonnet', 'chase'][Math.floor(r() * 3)];
    return await g.camera(want) ? [] : [`camera did not reach ${want}`];
  },

  /** A touch of steering under full autodrive: the wheel is the
   *  driver's while held, and the autopilot's again after.
   *
   *  A tap, 0.2 to 0.5 s.  This held the key for up to 1.2 s at first,
   *  and at 20 m/s that is not a nudge: it put the car 13 to 45 m into
   *  the field (see `suggest_4.md` on steering at speed).  The autopilot
   *  came back from every one of those, in 5 to 12 s, so the return is
   *  given 15. */
  async nudge(g, r) {
    const key = r() < 0.5 ? 'KeyA' : 'KeyD';
    g.excuse = true;
    await g.hold([key], 0.2 + r() * 0.3);
    const mid = await g.state();
    let back = null;
    for (let i = 0; i < 15 && back === null; i++) {
      await g.advance(1);
      const st = await g.state();
      if (st.fromRoad !== null && st.fromRoad < 3.5) back = i + 1;
    }
    g.excuse = false;
    const out = [];
    if (mid.auto !== 'full') out.push(`a nudge took autodrive out of full (${mid.auto})`);
    if (back === null) out.push('not back in lane 15 s after a nudge');
    return out;
  },

  /** The handbrake is the one control that drops every autodrive mode. */
  async handbrake(g) {
    await g.press('Space');
    await g.advance(0.5);
    const st = await g.state();
    const out = st.auto === 'manual' ? [] : [`handbrake left autodrive in ${st.auto}`];
    await g.autodrive('full');
    return out;
  },

  /** Off into the field by hand, then T.  The car must end up on the
   *  road, facing along it, and the autopilot must drive on from there. */
  async excursion(g, r) {
    g.excuse = true;
    await g.autodrive('manual');
    await g.hold(['KeyW', r() < 0.5 ? 'KeyA' : 'KeyD'], 2.5 + r() * 1.5);
    const off = await g.state();
    await g.press('KeyT');
    await g.advance(1);
    const back = await g.state();
    await g.autodrive('full');
    await g.advance(8);
    const on = await g.state();
    g.excuse = false;
    const out = [];
    if (back.fromRoad > 3) out.push(`T left the car ${back.fromRoad} m from the road (was ${off.fromRoad})`);
    if (on.speed < 5) out.push(`autodrive did not get going after T (${on.speed} m/s)`);
    return out;
  },

  /** The two part-auto modes, briefly.  In `steer` the driver has the
   *  pedals, so hold W; in `speed` the driver has the wheel, and a
   *  script with no hands leaves the car to wander -- a few seconds only. */
  async modes(g) {
    const out = [];
    g.excuse = true;
    if (!await g.autodrive('steer')) out.push('F never reached auto steering');
    await g.hold(['KeyW'], 5);
    const steer = await g.state();
    if (steer.fromRoad > 3.5) out.push(`auto steering wandered ${steer.fromRoad} m`);
    if (!await g.autodrive('speed')) out.push('F never reached auto speed');
    await g.advance(2);
    const speed = await g.state();
    if (speed.speed < 3) out.push(`auto speed did not hold a speed (${speed.speed} m/s)`);
    await g.autodrive('full');
    await g.advance(8);
    g.excuse = false;
    return out;
  },

  /** `]`: half a game-hour, and the clock must actually move.  `t` is
   *  counted in game-minutes -- one to the real second -- so half an
   *  hour is 30 of it, plus the three seconds waited. */
  async wind(g) {
    const a = await g.state();
    await g.press('BracketRight');
    await g.advance(3);
    const b = await g.state();
    const moved = b.t - a.t;
    return moved >= 30 ? [] : [`] moved the clock ${moved.toFixed(0)} game-minutes`];
  },

  /** `Z`, at night only -- the rest must end at first light, which on a
   *  summer morning at 30 degrees south is about half past four. */
  async rest(g) {
    const a = await g.state();
    const h = Number(a.clock.split(':')[0]);
    if (h >= 6 && h < 20) return [];
    await g.hold(['KeyS'], 4);           // rest is for a stopped car
    await g.press('KeyZ');
    for (let i = 0; i < 60; i++) {
      await g.advance(1);
      if (!await g.c.evaluate('__game.lapse.active')) break;
    }
    const b = await g.state();
    const hb = Number(b.clock.split(':')[0]);
    await g.autodrive('full');
    return hb >= 3 && hb < 9 ? [] : [`resting from ${a.clock} ended at ${b.clock}`];
  },
};

/* The schedule: one action every 40-120 game seconds, weighted toward the
 * things people do most. */
const WEIGHTS = [
  ['camera', 4], ['nudge', 4], ['handbrake', 1], ['excursion', 2],
  ['modes', 1], ['wind', 1], ['rest', 1],
];
function pick(r) {
  const total = WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [n, w] of WEIGHTS) { if ((x -= w) < 0) return n; }
  return WEIGHTS[0][0];
}

/* -------------------------------- the run ------------------------------- */

mkdirSync(dirname(LOG), { recursive: true });
writeFileSync(LOG, '');
const q = [QUALITY ? `quality=${QUALITY}` : '', REALTIME ? '' : 'dynres=0'].filter(Boolean).join('&');
const g = await openGame({ clock: REALTIME ? 'realtime' : 'stepped', seed: SEED, query: q,
                           port: PORT, throttle: THROTTLE });
g.excuse = false;
const r = rng([...SEED].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
const watch = new Watch();
const failures = [];
const SAMPLE = 5;                         // seconds between checks
const total = MINUTES * 60;
let t = 0, lastCheck = 0, nextAction = 30, nextLog = 0;
console.log(`autoplay: ${SEED}, ${MINUTES} minutes of play, `
  + `${REALTIME ? 'realtime' : 'stepped'}${THROTTLE !== 1 ? `, ${THROTTLE}x throttle` : ''}${CALM ? ', calm' : ''}`);
await g.autodrive('full');

async function fail(what, st) {
  const f = { t: st.t, clock: st.clock, km: st.km, what };
  failures.push(f);
  console.log(`  FAIL ${st.clock} ${st.km} km: ${what}`);
  if (!REALTIME && failures.length <= 10) {
    const png = join(dirname(LOG), `fail-${failures.length}.png`);
    writeFileSync(png, await g.grab());
  }
}

while (t < total) {
  await g.advance(SAMPLE);
  t = g.elapsed;
  const st = await g.state();
  for (const f of watch.check(st, t - lastCheck, g.errors, g.excuse)) await fail(f, st);
  lastCheck = t;
  if (t >= nextLog) {
    appendFileSync(LOG, JSON.stringify(st) + '\n');
    nextLog += 60;
  }
  if (!CALM && t >= nextAction) {
    const name = pick(r);
    const res = await ACTIONS[name](g, r);
    const after = await g.state();
    console.log(`  ${after.clock} ${String(after.km).padStart(7)} km  ${name.padEnd(9)} ${res.length ? 'FAIL' : 'ok'}`);
    for (const f of res) await fail(`${name}: ${f}`, after);
    t = lastCheck = g.elapsed;
    nextAction = t + 40 + r() * 80;
  }
}
await g.releaseAll();
const end = await g.state();
g.close();
console.log(`${end.km} km, ${end.clock} ${end.season}, ${end.recovers} recovers, `
  + `${failures.length ? `${failures.length} FAILURES` : 'no failures'}`);
process.exit(failures.length ? 1 : 0);
