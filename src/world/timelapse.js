import { HOUR, MINUTE } from './clock.js';

/* ------------------------------------------------------------------ *
 * The only thing other than `advance(dt)` that is allowed to move the
 * clock.
 *
 * There were two ways to move time before this file, and both of them
 * were a single `clock.t +=`:
 *
 *   `[` and `]`   half a game-hour, in one frame.  That is **7.5 degrees
 *                 of sun between two rendered frames**, with the whole
 *                 atmosphere ramp arriving behind it -- and it is almost
 *                 certainly what `prompt_4.md` item 3 is describing when
 *                 it says the sun "jumps from one game-hour to the next".
 *                 The clock itself was never the problem; the *keys* were.
 *   the rest      did not exist, and item 2 asks for it.
 *
 * Both are the same thing at different speeds: run the world's clock much
 * faster than real time for a moment, and keep running everything that
 * integrates while it happens.  So they are one class.
 *
 * **The invariant, and the whole reason this is not a `+=`:** the clock
 * never moves by more than `SUB` -- one game-minute -- without the weather
 * being stepped.  A twelve-hour rest is 720 sub-steps of clock and weather,
 * not one jump.  The sun visits every position in between, the atmosphere
 * ramp is traversed rather than skipped, and the wetness that fell during
 * the night is still drying at dawn.
 *
 * Why a game-minute: it is a quarter of a degree of sun, which is under
 * any threshold that matters, and it divides both `HOUR` and `DAY`
 * exactly, so a sub-step can never straddle a game-hour boundary by a
 * fraction and leave the weather's hourly draw half-applied.
 *
 * Measured with the sub-step wrong -- a whole game-hour rather than a
 * game-minute -- resting through twelve hours agreed with living through
 * them on **8 of 12** hours, because the stop condition can only be tested
 * on a sub-step boundary and the rest was overshooting by up to an hour.
 * With the game-minute it is 12 of 12.  The sub-step is not a detail.
 *
 * What this deliberately does *not* do is step the physics, the road, the
 * chunk field or the grass.  `main.js` returns early while a lapse owns
 * the clock.  The car is stationary for every caller that skips more than
 * a few game-minutes, so there is nothing under it to rebuild -- and
 * running the chunk field at twenty thousand times real speed would queue
 * several thousand chunks for a landscape that is not moving.
 * ------------------------------------------------------------------ */

/** The largest step the clock may take without the weather being run. */
const SUB = MINUTE;               // one game-minute: a quarter degree of sun

/** Ease in and out, in real seconds, so a lapse does not start with a jolt. */
const RAMP = 0.3;

export class TimeLapse {
  /**
   * @param {Clock}   clock
   * @param {Weather} weather
   */
  constructor(clock, weather) {
    this.clock = clock;
    this.weather = weather;
    this.active = false;
    /** What the HUD says while this is running. */
    this.label = '';
    /** Game-seconds moved so far, signed. */
    this.elapsed = 0;
    /** Real seconds this run has been going. */
    this.real = 0;

    this._rate = 0;
    this._max = 0;
    this._min = 0;
    this._until = null;
    this._hold = false;
    this._holding = false;
    this._ease = 0;
    this._onDone = null;
    this._why = '';
  }

  /**
   * Start a run.  Starting one while another is going replaces it.
   *
   * @param {number}   rate    game-seconds per real second, signed
   * @param {number}   max     cap on |skip|, in game-seconds
   * @param {function} until   `(clock) => boolean`; stops the moment it is
   *                           true, on a sub-step boundary
   * @param {boolean}  hold    keep going until `release()`
   * @param {number}   min     a held run will not stop short of this much
   *                           |skip|, which is what makes a tap and a hold
   *                           the same code path
   * @param {string}   label   one line for the HUD
   * @param {function} onDone  called with the reason it stopped
   */
  run({ rate, max = Infinity, min = 0, until = null, hold = false,
        label = '', onDone = null }) {
    this.active = true;
    this.label = label;
    this.elapsed = 0;
    this.real = 0;
    this._rate = rate;
    this._max = max;
    this._min = min;
    this._until = until;
    this._hold = hold;
    this._holding = hold;
    this._ease = 0;
    this._onDone = onDone;
    this._why = '';
  }

  /** The key that started a held run has been let go. */
  release() { this._holding = false; }

  cancel() { this._finish('cancelled'); }

  /** 0..1 of `max`, for a progress bar.  0 when there is no cap. */
  get progress() {
    return Number.isFinite(this._max) && this._max > 0
      ? Math.min(1, Math.abs(this.elapsed) / this._max) : 0;
  }

  /**
   * One real frame.  Returns true while this owns the clock, in which case
   * the caller must not step the physics or the world.
   */
  step(dtReal) {
    if (!this.active) return false;
    this.real += dtReal;

    /* Ease in while running, and out once a held run is let go *and* has
     * covered its minimum.  That minimum is what makes a tap and a hold
     * one code path: a tap is a release that arrives after 60 ms, and the
     * lapse simply runs on until it has moved the half-hour a tap has
     * always moved.
     *
     * A run that is not held stops dead when it arrives instead -- easing
     * out of a rest would carry the clock past the dawn it aimed at. */
    const done = !this._holding && Math.abs(this.elapsed) >= this._min;
    const target = done && this._hold ? 0 : 1;
    const d = dtReal / RAMP;
    this._ease += Math.max(-d, Math.min(d, target - this._ease));
    if (target === 0 && this._ease <= 0.001) return this._finish('released');

    let want = this._rate * this._ease * dtReal;
    /* Never overshoot the cap. */
    const room = this._max - Math.abs(this.elapsed);
    if (room <= 0) return this._finish('capped');
    if (Math.abs(want) > room) want = Math.sign(want) * room;

    /* The sub-stepping.  `SUB` at a time, weather on every one, and the
     * stop condition tested at every boundary -- which is what bounds a
     * rest's overshoot to one game-minute. */
    const sign = Math.sign(want) || 1;
    let left = Math.abs(want);
    while (left > 1e-9) {
      const dt = Math.min(SUB, left) * sign;
      this.clock.advance(dt);
      /* The game delta, not the real one, and that is not a shortcut: the
       * blend rates and the wetness time constants in `weather.js` are
       * written in seconds of *game* time (`0.4 * HOUR`, `6 * HOUR`), so
       * this is the unit they were always in. */
      this.weather.update(Math.abs(dt), this.clock);
      /* The cloud field too, or a rest ends with the sky in the right
       * colours and the shadows exactly where they were at dusk. */
      if (this.weather.field) this.weather.field.update(Math.abs(dt), this.weather.p, this.clock);
      this.elapsed += dt;
      left -= Math.abs(dt);
      if (this._until && this._until(this.clock)) return this._finish('arrived');
      if (Math.abs(this.elapsed) >= this._max) return this._finish('capped');
    }
    return true;
  }

  _finish(why) {
    if (!this.active) return false;
    this.active = false;
    this._why = why;
    this._holding = false;
    if (this._onDone) this._onDone(why, this.elapsed);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Where the night ends, as a pure search.
 *
 * This is here rather than in `main.js` because it is a *prediction*, and
 * predicting is only possible at all because the sun's altitude is a pure
 * function of the clock: `sunAltAt` is the same arithmetic `Clock.update`
 * runs, factored out, so the search cannot disagree with the sky.
 *
 * The rain's twin used to live beside it -- `nextDryHour`, an hour-grid
 * scan of `Weather.forecast`. It is gone, and the reason is `prompt_5.md`
 * item 3: the hour a dry state is *drawn* is not the hour it stops
 * raining, because the blend between states is measured in game-hours.
 * `Weather.projectDry` runs the real weather forward instead.
 * ------------------------------------------------------------------ */

/** Sun altitude, in radians, that counts as first light.  Civil dawn. */
export const FIRST_LIGHT = -6 * Math.PI / 180;

/**
 * When does the sun next climb through first light?
 *
 * Scanned at a game-minute and then bisected, rather than solved: the
 * closed form for the hour angle of a given altitude needs a branch for
 * the day the sun does not rise at all, and at latitude −30 that day does
 * not exist -- but a scan that is wrong is wrong by a minute, and a
 * closed form that is wrong is wrong by twelve hours.
 *
 * @param {function} altAt  `sunAltAt` from `clock.js`
 * @returns {number|null} absolute world time, or null if not within `max`
 */
export function nextFirstLight(altAt, t0, max = 20 * HOUR) {
  let prev = altAt(t0);
  for (let dt = SUB; dt <= max; dt += SUB) {
    const a = altAt(t0 + dt);
    if (prev < FIRST_LIGHT && a >= FIRST_LIGHT) {
      /* Four halvings of a one-game-minute bracket: a sixteenth of a
       * game-minute, which is a sixty-fourth of a degree of sun. */
      let lo = t0 + dt - SUB, hi = t0 + dt;
      for (let i = 0; i < 4; i++) {
        const mid = (lo + hi) / 2;
        if (altAt(mid) < FIRST_LIGHT) lo = mid; else hi = mid;
      }
      return hi;
    }
    prev = a;
  }
  return null;
}

