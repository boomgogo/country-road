import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Time, and where the sun and the moon are because of it.
 *
 * Nothing else in the project is allowed to hold a time of day.  The sky,
 * the lights, the seasons, the weather, the headlights and the save all
 * read this one object, which is the only way they can be guaranteed to
 * agree about whether it is night.
 *
 * The periods are the brief's:
 *
 *   game hour        60 s      "1 game-hour is 1 minute of gameplay"
 *   day            1440 s      24 minutes
 *   year          17280 s      12 game-days
 *   synodic month 43200 s      30 game-days
 *
 * and two more that are *not* free parameters, which is the detail that
 * makes the night sky feel like a sky rather than like a backdrop:
 *
 *   sidereal day   1329.2 s    year / 13
 *   lunar day      1489.6 s    from the synodic month
 *
 * With a 12-day year the world turns 13 times against the stars for every
 * 12 turns against the sun, so a sidereal day is `YEAR / 13` and the stars
 * rise 110.8 s earlier every game-day -- nearly two game-hours.  On Earth
 * that drift takes months; here the constellations overhead at midnight
 * are completely different a season later, inside one sitting.
 *
 * The moon follows from the synodic month by the same relation, and lands
 * at 49.7 s later per day.  A full moon rises at sunset here because the
 * geometry says so, not because it was arranged to: the moon is placed at
 * the sun's ecliptic longitude plus the elongation, and the phase is
 * computed from that same elongation, so the two can never disagree.
 * ------------------------------------------------------------------ */

export const HOUR = 60;
/**
 * One game-minute, and the unit the clock is actually counted in.
 *
 * `t` runs at one unit per real second and a game-day is 1440 of them, so
 * a unit *is* a game-minute and `HOUR` is sixty of them.  Spelling it out
 * because the two readings of "60" are one keystroke apart and cost this
 * iteration an afternoon: `timelapse.js` was written with a sub-step of
 * `HOUR` believing it to be a game-minute, which made it fifteen degrees
 * of sun instead of a quarter of one.
 */
export const MINUTE = HOUR / 60;
/** Degrees of sun per game-minute.  360 / 1440. */
export const SUN_PER_MINUTE = 0.25;
export const DAY = 24 * HOUR;              // 1440 s
export const YEAR = 12 * DAY;              // 17280 s
export const MONTH = 30 * DAY;             // 43200 s
/** `YEAR / 13`: twelve solar days is thirteen turns against the stars. */
export const SIDEREAL_DAY = YEAR / 13;     // 1329.23 s
/** 1/T = 1/sidereal day − 1/sidereal month.  Comes out at 1489.6 s. */
export const SIDEREAL_MONTH = 1 / (1 / MONTH + 1 / YEAR);   // 12342.9 s
export const LUNAR_DAY = 1 / (1 / SIDEREAL_DAY - 1 / SIDEREAL_MONTH);

/**
 * Latitude, south.
 *
 * −30° is the NSW mid-north coast (Coffs Harbour is −30.3, 153.1), chosen
 * for consistency with the brief's "Australia, east coast" weather.  Three
 * things follow and all three are deliberate: the sun passes through the
 * **north** at noon; the seasons are southern, so `yearFrac = 0` is the
 * September equinox and southern summer sits at 0.25; and the stars are
 * the southern sky, with Crux and Carina circumpolar 30° above the south
 * horizon and Orion upside down.
 */
export const LAT = -30 * Math.PI / 180;
/** Axial tilt. */
const OBLIQ = 23.44 * Math.PI / 180;
/** The moon's orbit against the ecliptic -- one term, and it stops the
 *  moon from running down exactly the same track as the sun. */
const MOON_INC = 5.14 * Math.PI / 180;

const SIN_LAT = Math.sin(LAT), COS_LAT = Math.cos(LAT);
const TAU = Math.PI * 2;

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

/** Sun altitude, in radians, at which night is fully over / begun. */
const DAWN = 2 * Math.PI / 180;
const DUSK = -7 * Math.PI / 180;

const _dir = new THREE.Vector3();

/**
 * Equatorial (right ascension, declination) to local horizontal, at hour
 * angle `H`.  Everything celestial in the project goes through here.
 */
function toHorizon(dec, H, out) {
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const sinAlt = SIN_LAT * sinDec + COS_LAT * cosDec * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(-cosDec * Math.sin(H),
                        sinDec * COS_LAT - cosDec * SIN_LAT * Math.cos(H));
  out.alt = alt;
  out.az = az;
  /* World directions: +X east, +Z south, +Y up -- azimuth measured from
   * north through east, which is the convention the formula above uses. */
  const c = Math.cos(alt);
  out.dir.set(c * Math.sin(az), Math.sin(alt), -c * Math.cos(az));
  out.above = alt > 0;
  return out;
}

/** Ecliptic longitude to equatorial, with a latitude term for the moon. */
function eclipticToEquatorial(lon, lat, out) {
  const sl = Math.sin(lon), cl = Math.cos(lon);
  const sb = Math.sin(lat), cb = Math.cos(lat);
  const se = Math.sin(OBLIQ), ce = Math.cos(OBLIQ);
  const sinDec = sb * ce + cb * se * sl;
  out.dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  out.ra = Math.atan2(sl * ce - (sb / cb) * se, cl);
  return out;
}

/**
 * The sun's altitude at an arbitrary time, without touching anything.
 *
 * The same arithmetic as `update()`'s first three lines, factored out
 * because two things now need to ask about a time that is not *this*
 * time: the rest (`timelapse.js` searches forward for first light) and
 * `tools/probe/rest.mjs`, which checks where the rest stopped against
 * this function.  Both computing it the same way is the point -- a
 * separate copy of the spherical astronomy in the probe would agree with
 * a bug as happily as with the truth.
 */
export function sunAltAt(t) {
  const dec = -OBLIQ * Math.sin(TAU * frac(t / YEAR));
  const H = TAU * (frac(t / DAY) - 0.5);
  const sinAlt = SIN_LAT * Math.sin(dec) + COS_LAT * Math.cos(dec) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt)));
}

/**
 * The season at an arbitrary time, written into `out`.
 *
 * Pure for the same reason: the weather forecast has to know which season
 * an hour two game-days out falls in, and a season two days out is not
 * always this one -- a season is only three game-days long.
 */
export function seasonAt(t, out = { index: 0, name: '', blend: 0, weights: [0, 0, 0, 0] }) {
  const s = frac(t / YEAR) * 4;
  const i = Math.floor(s) % 4;
  const f = s - Math.floor(s);
  const w = out.weights;
  w[0] = w[1] = w[2] = w[3] = 0;
  /* Cross-fade across the last quarter of each season, so three of the
   * four weights are zero for most of the year and no season is ever a
   * blur of all four. */
  const blend = f > 0.75 ? (f - 0.75) / 0.25 : 0;
  w[i] = 1 - blend;
  w[(i + 1) % 4] = blend;
  out.index = i;
  out.name = SEASONS[i];
  out.blend = f;
  return out;
}

export class Clock {
  /**
   * @param {number} t0      seconds into the world's own time
   * @param {number} phase0  the moon's elongation at t = 0, in turns
   */
  constructor(t0 = 0, phase0 = 0) {
    this.t = t0;
    this.phase0 = phase0;
    /** Scrubbing, for `[` and `]` -- a 24-minute day is a long time to
     *  wait to see a sunset. */
    this.scrub = 0;

    this.sun = { alt: 0, az: 0, dir: new THREE.Vector3(), above: true };
    this.moon = {
      alt: 0, az: 0, dir: new THREE.Vector3(), above: false,
      phase: 0, illum: 0, waxing: true,
    };
    this.season = { index: 1, name: 'summer', blend: 0, weights: [0, 1, 0, 0] };
    this._eq = { ra: 0, dec: 0 };
    this.update();
  }

  advance(dt) {
    this.t += dt;
    this.update();
  }

  /** Jump, for `[`/`]` and for `?t=`. */
  shift(seconds) {
    this.t += seconds;
    this.update();
  }

  /** Set the time of day, keeping the day of the year. */
  setTimeOfDay(hours) {
    const day = Math.floor(this.t / DAY);
    this.t = day * DAY + (hours / 24) * DAY;
    this.update();
  }

  get dayFrac() { return frac(this.t / DAY); }
  get hour() { return this.dayFrac * 24; }
  get dayIndex() { return Math.floor(this.t / DAY); }
  get hourIndex() { return Math.floor(this.t / HOUR); }
  get yearFrac() { return frac(this.t / YEAR); }
  /** Local sidereal time, in radians.  Drives the star field. */
  get lst() { return frac(this.t / SIDEREAL_DAY) * TAU; }

  /** hh:mm, for the HUD. */
  get clockText() {
    const h = this.hour;
    const hh = Math.floor(h);
    const mm = Math.floor((h - hh) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  update() {
    const yf = this.yearFrac;

    /* --- the sun ---------------------------------------------------- *
     * Southern hemisphere: declination is *negative* at yearFrac 0.25,
     * which is southern summer.  Day length then falls out of the
     * geometry rather than being tuned -- 13 h 56 m at the summer
     * solstice and 10 h 04 m at the winter one, for latitude −30°. */
    const dec = -OBLIQ * Math.sin(TAU * yf);
    this.dec = dec;
    const H = TAU * (this.dayFrac - 0.5);
    this.hourAngle = H;
    toHorizon(dec, H, this.sun);

    /* --- the season ------------------------------------------------- *
     * A weight vector rather than an index and a blend, so a shader can
     * mix four colours in one expression and the change is gradual by
     * construction.  A season is 3 game-days = 72 minutes of driving. */
    seasonAt(this.t, this.season);

    /* --- the moon --------------------------------------------------- *
     * Elongation from the sun, by definition, so the synodic period is
     * exact.  Position is the sun's ecliptic longitude plus that
     * elongation; phase is computed from the same number.  A full moon
     * therefore rises at sunset without anything having to arrange it. */
    const E = TAU * frac(this.t / MONTH + this.phase0);
    const sunLon = TAU * yf + Math.PI;          // longitude of the sun
    const moonLon = sunLon + E;
    /* The moon's height above the ecliptic swings once per *sidereal*
     * month, which is not the synodic one -- hence the separate term. */
    const moonLat = MOON_INC * Math.sin(TAU * frac(this.t / SIDEREAL_MONTH));
    eclipticToEquatorial(moonLon, moonLat, this._eq);
    /* The moon's hour angle is the sun's, less the elongation: that is
     * what makes the moon cross the sky once per *lunar* day, 49.7 s
     * longer than a solar one. */
    toHorizon(this._eq.dec, H - E, this.moon);
    this.moon.phase = E / TAU;                  // 0 new, 0.5 full
    this.moon.illum = (1 - Math.cos(E)) / 2;
    this.moon.waxing = this.moon.phase < 0.5;
    this.moon.ra = this._eq.ra;

    /* --- night ------------------------------------------------------ *
     * One scalar, from the sun's *altitude* rather than from the clock,
     * so it is automatically right at both solstices.  The moon's
     * opacity, the stars' opacity and the headlights all read this, which
     * is the only way those three can never disagree. */
    this.night = 1 - smoothstep(DUSK, DAWN, this.sun.alt);
    /* How much sun is actually landing on the ground.  Separate from
     * `night` because the light dies before the sky does. */
    this.daylight = smoothstep(-0.09, 0.16, this.sun.alt);
  }

  /** Sunrise and sunset, in hours, for today's declination.  Used by the
   *  probes and by the HUD's readout; `null` if the sun does not set. */
  daylightHours() {
    const c = -Math.tan(LAT) * Math.tan(this.dec);
    if (c <= -1) return 24;
    if (c >= 1) return 0;
    return (2 * Math.acos(c) / TAU) * 24;
  }
}

function frac(x) { return x - Math.floor(x); }

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export { frac, smoothstep, toHorizon, _dir };
