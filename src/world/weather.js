import { hash3, hashFloat } from '../core/rng.js';
import { Clock, HOUR, DAY, seasonAt } from './clock.js';

/** Scratch for `forecast`, which must not allocate per hour. */
const _season = { index: 0, name: '', blend: 0, weights: [0, 0, 0, 0] };

/* ------------------------------------------------------------------ *
 * The weather, on three timescales.
 *
 * The brief asks for two things that pull against each other -- weather
 * that changes from one game-hour to the next, *and* days that are simply
 * sunny all day -- and a single hourly Markov chain cannot give both.  A
 * chain with a high enough self-transition to produce whole clear days
 * never changes; one that changes hourly produces a day that is *mostly*
 * clear with a shower in it, every time, for ever.
 *
 * It also pins the *proportion*: **half the time a sky with nothing at all
 * in it, half the time cloud** -- anything from a few fair-weather cumulus
 * through broken and patchy to a black afternoon with rain under it.  That
 * split is exact by construction rather than tuned; see `_day`.
 *
 * So there are three timescales, and the middle one is the one the brief
 * actually specifies:
 *
 *   per game-day    a synoptic **regime** -- settled, unsettled, frontal,
 *                   or (summer only) storm -- and a **sunniness**, uniform
 *                   on 0..1, which is what makes a whole sunny day possible
 *   per game-hour   a **state**: sunny on the day's coin, otherwise drawn
 *                   from the regime's cloudy row for that hour
 *   per frame       a **blend** toward it, over either 4-12 clock units
 *                   (a front) or 240-600 (a drift)
 *
 * A clock unit is a **game-minute** -- see `clock.js` -- so a front lands
 * in ten game-minutes and a drift takes four to ten game-hours. Both are
 * measured in game time on purpose: a rest runs the same blend at twenty
 * thousand times real speed and has to arrive at the same place.
 *
 * That last one is the brief's "gradual and consistent at times and sudden
 * at other times", made explicit rather than hoped for.
 *
 * Everything downstream reads the blended parameter vector and never the
 * state name.  Nothing outside this file should ever branch on `sunny`.
 *
 * All of it is a pure function of `(seed, hourIndex)`: not of elapsed
 * play, not of frame rate, not of how many times the page has been
 * reloaded.  Scrub the clock back with `[` and the weather that was there
 * is the weather you get.
 * ------------------------------------------------------------------ */

const SALT_REGIME = 0x5eed1a;
const SALT_WEATHER = 0x7ea01e;
const SALT_SUN = 0x5c1ea7;

/**
 * The states, and what each one means as numbers.
 *
 * `sunBlock` is how much of the key light the cloud eats, which is not the
 * same as `cloud` -- a sunshower is half-covered and still bright, which
 * is the whole reason it can carry a rainbow.
 *
 * **`sunny` is `cloud: 0` and `cirrus: 0`, and both zeroes are the point.**
 * The brief asks for half the weather to be sunny with "not a single shred
 * of cloud", and the old 0.12 was not that: 12 % of the sky is four or
 * five cumulus standing around in it, and the cirrus term below was at its
 * *maximum* in exactly that state, so the clearest weather the model could
 * produce still had a high sheet over it.  A clear sky here is now empty.
 *
 * `cirrus` is the high sheet, and it is a state parameter rather than
 * something `clouds.js` derives from `cloud`, because the two are not the
 * same sky.  It belongs to the fair-but-not-clear end of the cloudy half
 * -- `fewClouds` and `partly` -- and goes away under a deck, where there
 * is nothing to see it against.
 *
 * The cloudy half is a *range*, which is the other half of the brief:
 * `fewClouds` through `partly` and `patchy` to `cloudy`, `lightRain`,
 * `heavyRain` and `snow`.  Nothing outside this file names any of them.
 */
export const STATES = {
  sunny:     { cloud: 0.00, cirrus: 0.00, rain: 0,    snow: 0,    sunBlock: 0.00, fogScale: 1.00, wind: 0.30, grip: 1.00, patchiness: 0.00 },
  fewClouds: { cloud: 0.22, cirrus: 0.34, rain: 0,    snow: 0,    sunBlock: 0.06, fogScale: 0.97, wind: 0.35, grip: 1.00, patchiness: 0.00 },
  partly:    { cloud: 0.52, cirrus: 0.26, rain: 0,    snow: 0,    sunBlock: 0.26, fogScale: 0.92, wind: 0.45, grip: 1.00, patchiness: 0.00 },
  cloudy:    { cloud: 0.85, cirrus: 0.06, rain: 0,    snow: 0,    sunBlock: 0.72, fogScale: 0.85, wind: 0.50, grip: 1.00, patchiness: 0.00 },
  lightRain: { cloud: 0.90, cirrus: 0.00, rain: 0.35, snow: 0,    sunBlock: 0.85, fogScale: 0.60, wind: 0.50, grip: 0.88, patchiness: 0.55 },
  heavyRain: { cloud: 1.00, cirrus: 0.00, rain: 1.00, snow: 0,    sunBlock: 0.95, fogScale: 0.32, wind: 0.90, grip: 0.80, patchiness: 0.15 },
  patchy:    { cloud: 0.45, cirrus: 0.22, rain: 0.30, snow: 0,    sunBlock: 0.20, fogScale: 0.80, wind: 0.60, grip: 0.90, patchiness: 1.00 },
  snow:      { cloud: 0.95, cirrus: 0.00, rain: 0,    snow: 0.80, sunBlock: 0.90, fogScale: 0.45, wind: 0.40, grip: 0.62, patchiness: 0.35 },
};

export const STATE_NAMES = Object.keys(STATES);

/** How dry each state is, for deciding whether a change is a front.
 *  Fractional at the dry end so that adding `fewClouds` and `partly`
 *  between `sunny` and `cloudy` does not move the `jump > 1` test that
 *  decides whether a change arrives as a squall. */
const DRYNESS = {
  sunny: 0, fewClouds: 0.5, partly: 1, patchy: 1, cloudy: 2,
  lightRain: 3, heavyRain: 4, snow: 3,
};

/**
 * The regimes, weighted by season.
 *
 * Modelled on the NSW mid-north coast: winter is the settled season there
 * and late summer is the wet one, which is the opposite way round from the
 * northern-hemisphere intuition and is why `storm` is a summer regime.
 *
 * Indexed [spring, summer, autumn, winter].
 */
const REGIME_WEIGHTS = {
  settled:   [0.35, 0.25, 0.35, 0.50],
  unsettled: [0.35, 0.25, 0.30, 0.25],
  frontal:   [0.25, 0.15, 0.30, 0.25],
  storm:     [0.05, 0.35, 0.05, 0.00],
};
const REGIMES = Object.keys(REGIME_WEIGHTS);

/**
 * What each regime draws from **once it is already cloudy**, hour by hour.
 *
 * The regime no longer decides *whether* there is cloud -- that is a fair
 * coin, see `_day` -- only what the cloud is like when there is some.  So
 * `sunny` appears in none of these rows: a row is the cloudy half of the
 * weather, from a few fair-weather cumulus to a black afternoon.
 *
 * A row is a list of `[state, weight]`.  `storm` and `frontal` are
 * functions of the hour, because the east-coast summer signature is cloud
 * building through the middle of the day and heavy rain in the late
 * afternoon -- and that shape is the whole reason those regimes exist.
 */
function row(regime, hour) {
  switch (regime) {
    /* Settled: fair-weather cloud and nothing that rains on you. */
    case 'settled':
      return [['fewClouds', 0.52], ['partly', 0.34], ['cloudy', 0.10],
              ['patchy', 0.04]];
    case 'unsettled':
      return [['fewClouds', 0.14], ['partly', 0.20], ['cloudy', 0.28],
              ['lightRain', 0.24], ['heavyRain', 0.06], ['patchy', 0.08]];
    case 'frontal':
      /* One side of the day unlike the other: dry before the change,
       * wet after it, with the change itself in the afternoon. */
      return hour < 13
        ? [['fewClouds', 0.32], ['partly', 0.34], ['cloudy', 0.28],
           ['patchy', 0.06]]
        : [['cloudy', 0.30], ['lightRain', 0.36], ['heavyRain', 0.26],
           ['patchy', 0.08]];
    case 'storm':
      if (hour < 11) return [['fewClouds', 0.55], ['partly', 0.45]];
      if (hour < 15) return [['partly', 0.34], ['cloudy', 0.58], ['patchy', 0.08]];
      if (hour < 19) return [['heavyRain', 0.50], ['lightRain', 0.26],
                             ['cloudy', 0.18], ['patchy', 0.06]];
      return [['cloudy', 0.46], ['lightRain', 0.18], ['partly', 0.36]];
    default:
      return [['cloudy', 1]];
  }
}

/** Weighted pick from a row, using one uniform sample. */
function pick(list, u) {
  let total = 0;
  for (const [, w] of list) total += w;
  let x = u * total;
  for (const [name, w] of list) { x -= w; if (x <= 0) return name; }
  return list[list.length - 1][0];
}

/**
 * `patchiness` is how much of the rain is *where the cloud is* rather than
 * everywhere.
 *
 * 0 means the state's rain falls uniformly, 1 means it falls only under
 * the thick part of the cloud field.  `heavyRain` keeps 0.15 on purpose --
 * the prompt asks for rain in patches "instead of raining everywhere,
 * which can happen too", and a downpour that has gaps in it is not a
 * downpour.  `patchy` is the sunshower the whole idea is for.
 *
 * It blends with everything else, so the transition from a uniform band of
 * rain into a broken one is itself gradual.
 */
const KEYS = ['cloud', 'cirrus', 'rain', 'snow', 'sunBlock', 'fogScale', 'wind',
              'grip', 'patchiness'];

export class Weather {
  constructor(seed, opts = {}) {
    this.seed = seed;
    /** `?weather=heavyRain` pins everything.  The capture harnesses need
     *  this -- otherwise every re-shot still is a different world. */
    this.pinned = opts.pin && STATES[opts.pin] ? opts.pin : null;

    this.from = null;
    this.to = null;
    this.hourOf = null;      // which hourIndex `to` was drawn for
    this.k = 1;              // blend position, 0 at `from`, 1 at `to`
    this.rate = 1;           // per second
    this.sudden = false;

    /** The blended parameter vector everything downstream reads. */
    this.p = { ...STATES.sunny, wetness: 0 };
    /**
     * The same thing *at the car*: what is falling here rather than what
     * the region is doing.  A separate object rather than fields on `p`
     * so that nothing can read one when it meant the other.
     */
    this.here = { rain: 0, snow: 0, wind: 0.3, fogScale: 1, grip: 1 };
    /** Where "here" is.  Written by `main.js` before `update`. */
    this.at = { x: 0, z: 0 };
    /** The shared cloud field, set by `main.js`.  Null in a bare test. */
    this.field = null;
    /** Names, for the HUD and the probes only. */
    this.state = 'sunny';
    this.regime = 'settled';
    this._dayOf = null;
    this._dayTable = null;
  }

  /** The regime for a given game-day, as a pure function of the seed. */
  regimeFor(dayIndex, season) {
    const u = hash3(dayIndex, SALT_REGIME, season, this.seed) / 4294967296;
    const list = REGIMES.map((r) => [r, REGIME_WEIGHTS[r][season]]);
    return pick(list, u);
  }

  /**
   * A day's worth of weather: **half of it sunny, half of it cloudy**, as
   * spells rather than as independent hours.
   *
   * Two things are being asked for at once and they pull against each
   * other -- an even split between a sky with nothing in it and a sky with
   * something in it, *and* days that are simply sunny all day.  A single
   * hourly draw gives neither: twenty-four independent draws at even 88 %
   * dry come to 0.88^24, which is 5 %, so "sunny all day" is not something
   * a memoryless process does.  Measured over 240 game-hours the first
   * version of this had a mean spell of **1.6 hours** and **not one** dry
   * day in ten.
   *
   * So a day is partitioned into spells of two to five hours, and each
   * spell gets a coin rather than a draw from a big table:
   *
   *   per game-day    `sunniness`, uniform on 0..1
   *   per spell       sunny with probability `sunniness`, else a state
   *                   from the regime's cloudy row for that hour
   *
   * **The uniform is what makes the split exactly even.**  The mean of a
   * uniform is a half, so the expected fraction of sunny hours is a half
   * -- in every season, under every regime, without a single weight
   * needing to be tuned to make it come out.  And because the coin's bias
   * is drawn *per day* rather than per spell, the days at the ends of the
   * range are whole: with about seven spells in a day, P(all sunny) is
   * the integral of p^7, which is one in eight, and a day of unbroken
   * cloud is the same one in eight.  That is the "sunny all day" the
   * brief wants and the grey day that has to exist opposite it, and both
   * fall out of the distribution rather than being special-cased.
   *
   * The regime is still here and still seasonal -- it decides what the
   * cloudy half *is*, from fair-weather cumulus under `settled` to a black
   * afternoon under `storm`.  It no longer decides how much of the time
   * there is any cloud at all, which is the one thing the brief pins.
   *
   * Cached for one day, which is all the access pattern needs: the game
   * asks for the current hour and the probes sweep forward.
   */
  _day(dayIndex, season) {
    if (this._dayOf === dayIndex) return this._dayTable;
    const regime = this.regimeFor(dayIndex, season);
    /* How sunny this particular day is.  Uniform, so the average day is
     * half sunny and the year is half sunny with it. */
    const sunniness = hashFloat(dayIndex, SALT_SUN, season, this.seed);
    const table = new Array(24);
    let h = 0, n = 0;
    while (h < 24) {
      const len = 2 + Math.floor(hashFloat(dayIndex, SALT_WEATHER + 3, n, this.seed) * 4);
      const u = hashFloat(dayIndex, SALT_WEATHER, n * 31 + season, this.seed);
      let name;
      if (hashFloat(dayIndex, SALT_SUN + 1, n * 17 + season, this.seed) < sunniness) {
        name = 'sunny';
      } else {
        name = pick(row(regime, h), u);
        /* Snow substitutes for rain in winter, which the brief asks for and
         * the NSW coast does not provide. */
        if (season === 3 && (name === 'lightRain' || name === 'heavyRain')) {
          const cold = hashFloat(dayIndex, SALT_WEATHER + 1, n, this.seed);
          if (cold < 0.68) name = 'snow';
        }
      }
      for (let k = 0; k < len && h < 24; k++, h++) table[h] = name;
      n++;
    }
    this._dayOf = dayIndex;
    this._dayTable = table;
    return table;
  }

  /** The state for a given game-hour, as a pure function of the seed. */
  stateFor(hourIndex, dayIndex, hour, season) {
    if (this.pinned) return this.pinned;
    return this._day(dayIndex, season)[Math.floor(hour) % 24];
  }

  /**
   * The next `n` game-hours, without touching anything.
   *
   * Possible only because the state is already a pure function of the seed
   * and the hour -- this calls exactly the function the next `n` hours will
   * themselves call, so a forecast cannot disagree with the weather.
   * `timelapse.js` uses it to bound "rest until the rain is over"; what
   * actually stops that rest is `weather.here`, measured on every
   * sub-step.  See `nextDryHour` and `rest()` in `main.js`.
   *
   * **The day cache has to be put back.**  `_day` memoises one day, the
   * forecast walks across midnight, and evicting the current day's table
   * mid-frame would make the next `update()` rebuild it -- harmless today,
   * and exactly the kind of thing that stops being harmless the first time
   * a table is expensive.  The season has to be recomputed per hour for
   * the same reason: a season is three game-days, so an hour eighteen
   * hours out is not always in this one.
   */
  forecast(clock, n = 18) {
    const keepOf = this._dayOf, keepTable = this._dayTable;
    const out = [];
    const h0 = clock.hourIndex;
    for (let i = 0; i < n; i++) {
      const hi = h0 + i;
      const t = hi * HOUR;
      const day = Math.floor(t / DAY);
      const hour = (t % DAY) / HOUR;
      const season = seasonAt(t, _season).index;
      const name = this.stateFor(hi, day, hour, season);
      const p = STATES[name];
      out.push({ hourIndex: hi, t, state: name, rain: p.rain, snow: p.snow });
    }
    this._dayOf = keepOf;
    this._dayTable = keepTable;
    return out;
  }

  /**
   * One frame.
   *
   * Draws a new target at every game-hour boundary; blends toward it at a
   * rate set by the transition style; integrates wetness, which is the
   * only piece of weather state that is *not* a pure function of the hour
   * and is the thing that makes rain feel like it happened rather than
   * like it is happening.
   */
  update(dt, clock) {
    const hi = clock.hourIndex;
    if (hi !== this.hourOf) {
      const next = this.stateFor(hi, clock.dayIndex, clock.hour, clock.season.index);
      /* **Only redraw when the target actually changes**, and that is a bug
       * fix rather than a shortcut.
       *
       * A spell is two to five game-hours long, so the same state is drawn
       * on two to five consecutive hour boundaries -- and this used to
       * restart the blend on every one of them: `from` reset to the
       * *current* blended vector, `k` reset to 0. A drift's `secs` is 240
       * to 600 clock units, one of which is a game-minute, so a full hour
       * of blending only advances `k` to 0.1-0.25, i.e. 3-16 % of the way
       * along the ease. Restart that hourly and the blend stops being a
       * ramp and becomes an exponential approach with a time constant of
       * most of a game-day: it never arrives.
       *
       * Measured, that is what "rest until the rain is over" ran into.
       * `lightRain` (rain 0.35) drawn over to `cloudy` (rain 0) was still
       * at 0.16 twenty game-hours later, so the rest either stopped in the
       * rain or refused to start. It is also visible without resting at
       * all: rain goes on falling for most of a game-day after the sky has
       * said it stopped.
       *
       * With this test the blend arrives in the `secs` it was given, and a
       * repeat draw of the same state simply lets it carry on. */
      if (this.to !== STATES[next]) {
        this.from = this.to ? { ...this.p } : { ...STATES[next] };
        this.to = STATES[next];
        const prevName = this.state;
        this.state = next;
        this.regime = this.regimeFor(clock.dayIndex, clock.season.index);
        this.k = 0;

        /* Sudden, or gradual?  A front when the regime is a changeable one,
         * or whenever the state jumps more than one step along the dryness
         * ordering -- a squall arriving in eight seconds is a real thing and
         * it is the more memorable of the two. */
        const jump = Math.abs((DRYNESS[next] ?? 0) - (DRYNESS[prevName] ?? 0));
        const u = hashFloat(hi, SALT_WEATHER + 2, 0, this.seed);
        this.sudden = jump > 1
          || ((this.regime === 'frontal' || this.regime === 'storm') && u < 0.62);
        const secs = this.sudden ? 4 + u * 8 : 240 + u * 360;
        this.rate = 1 / secs;
        /* The pin has to arrive instantly or a capture takes ten minutes to
         * become the weather it asked for. */
        if (this.pinned) this.k = 1;
      } else {
        this.state = next;
        this.regime = this.regimeFor(clock.dayIndex, clock.season.index);
      }
      this.hourOf = hi;
    }

    this.k = Math.min(1, this.k + this.rate * dt);
    /* Smoothstep the blend so a drift eases in and out rather than
     * starting and stopping at a corner. */
    const e = this.k * this.k * (3 - 2 * this.k);
    for (const key of KEYS) {
      this.p[key] = this.from[key] + (this.to[key] - this.from[key]) * e;
    }

    /* --- and where the car actually is -------------------------------- *
     * The regional state says it is raining; the field says whether it is
     * raining *here*.  Everything that can be local -- the particles, the
     * fog, the wetness, the rainbow -- reads `here` from now on, and
     * everything that is genuinely regional -- the cloud cover, the light
     * the sun is losing to it -- still reads `p`. */
    this.here.rain = this.localAt(this.at.x, this.at.z, this.p.rain);
    this.here.snow = this.localAt(this.at.x, this.at.z, this.p.snow);
    this.here.wind = this.p.wind;
    /* Fog closes in *in* the shower, not over the whole county. */
    const localWet = Math.max(this.here.rain, this.here.snow);
    const regionWet = Math.max(this.p.rain, this.p.snow);
    const frac = regionWet > 1e-4 ? localWet / regionWet : 1;
    this.here.fogScale = 1 - (1 - this.p.fogScale) * frac;
    /* Grip too, and for the same reason: a car that loses grip because it
     * is raining two kilometres away is a car that is slippery in the
     * sunshine.  Lying snow keeps its share of the penalty whatever the
     * sky is doing, which is what `seasonSnow` is about. */
    this.here.grip = 1 - (1 - this.p.grip) * Math.max(frac, this.p.snow > 0.05 ? 0.6 : 0);

    /* --- wetness ------------------------------------------------------
     * Not drawn; integrated.  Rises with rain and dries on a long time
     * constant in the sun, faster in wind.  The road staying dark and
     * reflective for twenty game-minutes after the shower has passed is
     * most of what makes the weather read as having *happened*.
     *
     * On the **local** amount, so driving out of a shower leaves a wet car
     * on a dry road and then dries it. */
    const wetTarget = Math.min(1, this.here.rain * 1.6 + this.here.snow * 0.4);
    const w = this.p.wetness;
    if (wetTarget > w) {
      this.p.wetness = w + (wetTarget - w) * Math.min(1, dt / (0.4 * HOUR));
    } else {
      const dry = 6 * HOUR / (1 + this.p.wind + 2 * (1 - this.p.cloud));
      this.p.wetness = w + (wetTarget - w) * Math.min(1, dt / dry);
    }

    return this.p;
  }

  /**
   * When will it actually be dry here?
   *
   * `forecast` answers a different question and `prompt_5.md` item 3 is
   * the difference between them. The forecast names the game-hour at which
   * a dry state is *drawn*; at that instant `k` is 0 and it is still
   * raining exactly as hard as it was. And the blend that follows is not
   * quick: `update` measures it in clock units, one of which is a
   * game-minute, so a drift's `240 + u * 360` is **four to ten
   * game-hours** -- restarted on every hour boundary, so what it really
   * is, is a slow exponential approach. Measured, a rest that stopped two
   * game-hours past the forecast's first dry hour was still in the rain on
   * 7 of 16 tries.
   *
   * So this does not predict. It *runs the world forward* -- the real
   * `update`, on a scratch clock, in the same one-game-minute steps the
   * time-lapse uses -- until the rain at the car is actually below `dry`,
   * and then puts every mutable thing it touched back exactly where it
   * was. A bound computed by the same code that will produce the outcome
   * cannot disagree with the outcome, which is the property `forecast`
   * was built for and the reason this is a projection rather than a
   * second model.
   *
   * Cost: twenty game-hours at one game-minute is 1200 iterations of
   * `update` and 1200 of the field's. That happens once, on the press of
   * `Z`, and it is a fraction of a millisecond.
   *
   * @returns {number|null} absolute world time, or null if it does not dry
   *   out within `hours`.
   */
  projectDry(clock, { dry = 0.02, hours = 20, step = 1 } = {}) {
    const snap = {
      from: this.from, to: this.to, hourOf: this.hourOf, k: this.k,
      rate: this.rate, sudden: this.sudden, state: this.state,
      regime: this.regime, dayOf: this._dayOf, dayTable: this._dayTable,
      p: { ...this.p }, here: { ...this.here },
    };
    const fieldSnap = this.field ? this.field.snapshot() : null;
    /* A scratch clock, because the world's own must not move: the whole of
     * item 3 in `prompt_4.md` rests on nothing but `advance`, the lapse and
     * the `?t` pin being allowed to touch it. */
    const c = new Clock(clock.t, clock.phase0);
    let found = null;
    const n = Math.ceil((hours * HOUR) / step);
    for (let i = 0; i < n; i++) {
      c.advance(step);
      this.update(step, c);
      if (this.field) this.field.update(step, this.p, c);
      if (this.here.rain + this.here.snow < dry &&
          this.p.rain + this.p.snow < dry) { found = c.t; break; }
    }
    this.from = snap.from; this.to = snap.to; this.hourOf = snap.hourOf;
    this.k = snap.k; this.rate = snap.rate; this.sudden = snap.sudden;
    this.state = snap.state; this.regime = snap.regime;
    this._dayOf = snap.dayOf; this._dayTable = snap.dayTable;
    Object.assign(this.p, snap.p);
    Object.assign(this.here, snap.here);
    if (fieldSnap) this.field.restore(fieldSnap);
    return found;
  }

  /**
   * How much of a regional amount is falling at one point on the map.
   *
   * The rain cell is the *thick part of the cloud field* -- a higher cut
   * of the very same noise the sky is marching through -- so the dark mass
   * ahead of you is the mass you get wet under.  Not a second field: two
   * fields would need to be kept in agreement, and this one cannot
   * disagree with itself.
   */
  localAt(x, z, amount) {
    if (!this.field || amount <= 0) return amount;
    const k = this.p.patchiness;
    if (k <= 0.001) return amount;
    const cell = this.field.rainAt(x, z);
    return amount * (1 - k + k * cell);
  }

  /**
   * Can there be a rainbow, and how strong?
   *
   * Two constraints fall straight out of the physics and both are worth
   * keeping: the bow only exists when the sun is below 42°, because its
   * centre is the antisolar point and the whole arc is under the horizon
   * above that; and it wants sun *and* rain at once, which is exactly what
   * a sunshower is.  So this is nonzero only in the weather the brief asks
   * for it in, without anything having to check the state name.
   */
  rainbow(clock) {
    const altDeg = clock.sun.alt * 180 / Math.PI;
    if (altDeg <= 1 || altDeg >= 42) return 0;
    /* Fades out as the sun climbs toward 42°, which is also when the bow
     * sinks below the horizon -- so it leaves rather than switches off. */
    const geometry = Math.min(1, (42 - altDeg) / 14);

    /* **Sun on you, rain over there.**
     *
     * The first version of this gated the bow on the rain *at the car*,
     * which is both wrong and self-defeating: a rainbow is what you see
     * standing in sunshine looking at a shower, and requiring the observer
     * to be inside the rain means requiring the sun to be behind cloud,
     * which is the one condition that cannot produce one.  Measured, it
     * gave a peak strength of 0.000 in every state including the
     * sunshower.
     *
     * So it is two questions about two places.  Is there sun *here*: the
     * state's own `sunBlock`, and the cloud field directly overhead.  Is
     * there rain *there*: the field sampled along the antisolar direction,
     * which is exactly where the bow is drawn -- so the bow stands in the
     * shower it is made of, and driving out of a sunshower takes it with
     * you rather than leaving it hanging over dry ground.
     */
    let sun = 1 - this.p.sunBlock;
    if (this.field) sun *= 1 - 0.85 * this.field.coverAt(this.at.x, this.at.z);

    let rain = this.p.rain;
    if (this.field && this.p.patchiness > 0.01) {
      const d = clock.sun.dir;
      const h = Math.hypot(d.x, d.z) || 1;
      const ax = -d.x / h, az = -d.z / h;
      let m = 0;
      for (const dist of [1200, 2600, 4500]) {
        m = Math.max(m, this.field.rainAt(this.at.x + ax * dist,
                                          this.at.z + az * dist));
      }
      rain *= 1 - this.p.patchiness + this.p.patchiness * m;
    }
    const v = sun * Math.min(1, rain * 2.4) * geometry;
    /* And a floor.  `heavyRain` has `sunBlock` 0.95, not 1, so it used to
     * yield a bow of strength 0.05 -- invisible, but not zero, and
     * physically it should be: there is no sun getting through that. */
    return v < 0.08 ? 0 : v;
  }

  /**
   * For the HUD.  Prose, not a state name -- and **what it is doing here**.
   *
   * The rain terms read the local vector and the cloud terms read the
   * regional one, which is exactly right: whether it is raining is a
   * question about this square kilometre, and whether the sky is overcast
   * is not.  So driving out of a sunshower changes the line to "fair"
   * while the shower is still visible in the mirror, which is the truth.
   */
  get text() {
    const p = this.p, h = this.here;
    if (h.snow > 0.3) return 'snow';
    if (h.rain > 0.6) return 'heavy rain';
    if (h.rain > 0.12) return p.sunBlock < 0.5 ? 'sunshower' : 'light rain';
    if (p.cloud > 0.68) return 'cloudy';
    if (p.cloud > 0.36) return 'partly cloudy';
    /* The cloudy half's bottom end still has cloud in it, and saying
     * "clear" there would make the one state that is genuinely empty
     * indistinguishable from the one that is not. */
    if (p.cloud > 0.06) return 'a few clouds';
    return 'clear';
  }
}
