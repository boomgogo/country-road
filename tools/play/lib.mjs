/* ------------------------------------------------------------------ *
 * Playing the game from a script: the parts `autoplay.mjs` and
 * `film.mjs` share.
 *
 * Everything a player does goes through **real key presses** --
 * `Input.dispatchKeyEvent`, into the same `keydown` listener a keyboard
 * reaches -- rather than calls on `__game`.  That is the point of a
 * script that plays: a probe that calls `auto.setMode()` tests
 * `setMode`, and one that presses F tests F.  `__game` is only read,
 * never driven, except for `step()` in stepped mode, which is how the
 * films have always been made.
 *
 * Two clocks:
 *
 *   stepped    `?rec`.  The script calls `step(1/30)`, so thirty steps are
 *              one second of game however long the machine takes over
 *              them, and a run is the same run every time.  The films.
 *   realtime   `?auto=full`.  The page's own frame loop, at whatever rate
 *              the machine manages -- which is the only way to see what a
 *              slow CPU does, since the chunk builder's budget is in real
 *              milliseconds.  The soak tests.
 * ------------------------------------------------------------------ */
import { launch } from '../../perf-bench/cdp.mjs';

/** Key codes, with the `key` and virtual key code CDP also wants. */
const KEYS = {
  KeyW: ['w', 87], KeyA: ['a', 65], KeyS: ['s', 83], KeyD: ['d', 68],
  KeyF: ['f', 70], KeyC: ['c', 67], KeyT: ['t', 84], KeyZ: ['z', 90],
  KeyH: ['h', 72], KeyM: ['m', 77], KeyP: ['p', 80], Space: [' ', 32],
  BracketLeft: ['[', 219], BracketRight: [']', 221], Escape: ['Escape', 27],
};

/** A small, seeded generator, so a scenario is the same scenario each run. */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Open the game and wait until it is drivable.
 *
 * @param {object} o
 * @param {'stepped'|'realtime'} o.clock
 * @param {string} o.seed
 * @param {string} [o.query]   appended to the URL
 * @param {number} [o.throttle] CDP CPU slow-down
 */
export async function openGame({
  clock = 'stepped', seed = 'country', query = '', port = 5178,
  cdpPort = 9333, profile, w = 1280, h = 720, dpr = 1, throttle = 1, env = {},
  headless = process.env.HEADLESS === '1',
} = {}) {
  if (headless) process.env.HEADLESS = '1';
  const c = await launch({ w, h, port: cdpPort, profile, env });
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride',
               { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  if (throttle !== 1) await c.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const errors = [];
  c.on((d) => {
    if (d.method === 'Runtime.exceptionThrown') {
      errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
    }
  });
  const base = clock === 'stepped' ? 'rec=1' : 'auto=full';
  await c.send('Page.navigate', {
    url: `http://127.0.0.1:${port}/?${base}&fresh&sound=0&seed=${encodeURIComponent(seed)}${query ? '&' + query : ''}`,
  });
  for (let i = 0; i < 600; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.groundWatch)').catch(() => false)) break;
    await sleep(250);
  }
  await c.evaluate('window.__game.loaded');
  return new Game(c, clock, errors);
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export class Game {
  constructor(c, clock, errors) {
    this.c = c;
    this.clock = clock;
    this.errors = errors;
    this.held = new Set();
    /** Seconds advanced, game (stepped) or wall (realtime). */
    this.elapsed = 0;
  }

  /** Run the game on by `secs` of game time (stepped) or wall time. */
  async advance(secs) {
    this.elapsed += secs;
    if (this.clock === 'stepped') {
      let n = Math.round(secs * 30);
      while (n > 0) {
        const k = Math.min(n, 30);
        await this.c.evaluate(`(() => { for (let i = 0; i < ${k}; i++) __game.step(1 / 30); })()`);
        n -= k;
      }
    } else {
      await sleep(secs * 1000);
    }
  }

  async keyDown(code) {
    const [key, vk] = KEYS[code];
    this.held.add(code);
    await this.c.send('Input.dispatchKeyEvent',
                      { type: 'keyDown', code, key, windowsVirtualKeyCode: vk });
  }

  async keyUp(code) {
    const [key, vk] = KEYS[code];
    this.held.delete(code);
    await this.c.send('Input.dispatchKeyEvent',
                      { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  }

  /** A tap: down, one step of game, up -- so a stepped run sees it. */
  async press(code) {
    await this.keyDown(code);
    await this.advance(1 / 30);
    await this.keyUp(code);
  }

  /** Hold `codes` for `secs` of game time, then let go. */
  async hold(codes, secs) {
    for (const k of codes) await this.keyDown(k);
    await this.advance(secs);
    for (const k of codes) await this.keyUp(k);
  }

  async releaseAll() {
    for (const k of [...this.held]) await this.keyUp(k);
  }

  /** Press F until the autopilot is in `name`.  At most four presses. */
  async autodrive(name) {
    for (let i = 0; i < 4; i++) {
      if (await this.c.evaluate('__game.auto.name') === name) return true;
      await this.press('KeyF');
    }
    return await this.c.evaluate('__game.auto.name') === name;
  }

  /** Press C until the camera is in `name`. */
  async camera(name) {
    for (let i = 0; i < 4; i++) {
      if (await this.c.evaluate('__game.chase.mode') === name) return true;
      await this.press('KeyC');
    }
    return await this.c.evaluate('__game.chase.mode') === name;
  }

  /** Everything worth logging, in one round trip. */
  state() {
    return this.c.evaluate(`(() => {
      const g = __game, c = g.car, cl = g.clock, w = g.weather, i = g.renderer.info;
      const q = g.road.nearest(c.pos.x, c.pos.z, {});
      return {
        simTime: +g.simTime.toFixed(2), t: +cl.t.toFixed(1), day: cl.dayIndex,
        clock: cl.clockText, season: cl.season.name, weather: w.text, regime: w.state,
        km: +(g.odometer / 1000).toFixed(3), speed: +c.speed.toFixed(2),
        pos: [+c.pos.x.toFixed(1), +c.pos.y.toFixed(1), +c.pos.z.toFixed(1)],
        fromRoad: q ? +q.d.toFixed(2) : null, s: q ? +q.s.toFixed(1) : null,
        auto: g.auto.name, camera: g.chase.mode,
        ground: { ...g.groundWatch }, recovers: g.stats.recovers,
        live: g.chunks.live.size, queue: g.chunks.queue.length,
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        geometries: i.memory.geometries, textures: i.memory.textures,
        programs: i.programs ? i.programs.length : null,
        scene: g.scene.children.length,
      };
    })()`);
  }

  /** The frame as a PNG buffer.  Stepped mode only: needs `?rec`'s
   *  preserved drawing buffer. */
  async grab() {
    const u = await this.c.evaluate('__game.grab()');
    return Buffer.from(String(u).split(',')[1], 'base64');
  }

  close() { this.c.close(); }
}

/**
 * The things that are wrong whatever the scenario, checked on every
 * sample.  Each returns a string when it fires.
 *
 *   off road   more than `OFF_ROAD` metres from the midline for more
 *              than `OFF_FOR` game seconds while the autopilot has the
 *              wheel.  The shoulder ends at 5.65 m.
 *   stuck      under 1 m/s for `STUCK_FOR` seconds with the autopilot on
 *              the pedals.
 *   fell       the car more than 2 m under the ground (`groundWatch`).
 *   no ground  a frame with no chunk under the car.
 *   exception  anything thrown in the page.
 */
/* `OFF_FOR` is longer than the autopilot's slowest measured return from
 * a field -- 12 s, from 45 m out -- so it fires on a car that is not
 * coming back, not on one that is. */
export const OFF_ROAD = 6, OFF_FOR = 15, STUCK_FOR = 10;

export class Watch {
  constructor() {
    this.offFor = 0;
    this.stuckFor = 0;
    this.last = null;
    this.failures = [];
  }

  /** `dt` is game seconds since the last sample; `excused` suspends the
   *  driving checks while the scenario is deliberately misbehaving. */
  check(st, dt, errors, excused = false) {
    const out = [];
    const autoSteer = st.auto === 'full' || st.auto === 'steer';
    const autoPedal = st.auto === 'full' || st.auto === 'speed';
    /* null is beyond the road query's 46 m -- the most lost a car can be,
     * and `null > OFF_ROAD` is false, so it has to be said. */
    const off = st.fromRoad === null || st.fromRoad > OFF_ROAD;
    this.offFor = !excused && autoSteer && off ? this.offFor + dt : 0;
    this.stuckFor = !excused && autoPedal && Math.abs(st.speed) < 1 ? this.stuckFor + dt : 0;
    if (this.offFor > OFF_FOR) { out.push(`off the road ${st.fromRoad} m for ${this.offFor.toFixed(0)} s`); this.offFor = 0; }
    if (this.stuckFor > STUCK_FOR) { out.push(`stuck for ${this.stuckFor.toFixed(0)} s`); this.stuckFor = 0; }
    const p = this.last ? this.last.ground : { falls: 0, noChunk: 0 };
    if (st.ground.falls > p.falls) out.push(`fell (${st.ground.falls - p.falls})`);
    if (st.ground.noChunk > p.noChunk) out.push(`no ground under the car for ${st.ground.noChunk - p.noChunk} frames`);
    while (errors.length) out.push('exception: ' + String(errors.shift()).split('\n')[0]);
    this.last = st;
    for (const f of out) this.failures.push({ t: st.t, clock: st.clock, km: st.km, what: f });
    return out;
  }
}
