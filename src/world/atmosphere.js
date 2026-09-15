import * as THREE from 'three';
import { PAL } from '../core/palette.js';

/* ------------------------------------------------------------------ *
 * What colour everything is, given where the sun is and what the
 * weather is doing.
 *
 * One function, six consumers.  The lesson is already written into
 * `main.js` in three separate comments -- *"the fog colour is the sky's
 * own horizon colour, exactly"*, and the white far-ridge cliff that came
 * of it not being -- and this makes it structural instead of a comment:
 * there is exactly one place that decides the palette and it writes to all
 * six of them every frame, so they cannot drift apart.
 *
 *   skyTop / skyMid / skyHaze    -> Sky.set()
 *   haze                         -> scene.fog.color and scene.background
 *   key { dir, colour, level }   -> the one directional light
 *   hemi { sky, ground, level }  -> the hemisphere light
 *   cloud { tint, opacity }      -> the volumetric layer's lighting
 *   grade { lift, gain, sat }    -> post.js
 *
 * **The key light is one light, not two.**  At night it is re-aimed at the
 * moon and given a cool colour, and it keeps casting the shadow map.  What
 * must never happen is lights being added and removed with the sun:
 * three.js recompiles *every material in the scene* when the light count
 * changes, so that would stall for several hundred milliseconds at every
 * dawn and every dusk.  The headlights obey the same rule -- they exist
 * from boot at zero intensity.
 * ------------------------------------------------------------------ */

const D = Math.PI / 180;

/**
 * The ramp, keyed on the sun's altitude in degrees.
 *
 * Five named stops, linearly interpolated.  The horizon haze is the stop
 * that matters most: it is also the fog colour, so it is what the far
 * ridge dissolves into, and getting it wrong at any hour puts a white
 * cliff across the frame.
 */
const STOPS = [
  {
    alt: -18, name: 'night',
    top: 0x05080f, mid: 0x0a1120, haze: 0x141c2e,
    key: 0x9db4dc, keyLevel: 0.16,
    hemiSky: 0x1b2740, hemiGround: 0x131720, hemiLevel: 0.30,
    cloud: 0x2a3448, cloudOp: 0.85,
    grade: { lift: -0.012, gain: 0.86, sat: 0.72 },
  },
  {
    alt: -8, name: 'nautical',
    top: 0x0d1730, mid: 0x1e2c4c, haze: 0x33405c,
    key: 0x9db4dc, keyLevel: 0.20,
    hemiSky: 0x2b3a5c, hemiGround: 0x1c202c, hemiLevel: 0.42,
    cloud: 0x3d4760, cloudOp: 0.80,
    grade: { lift: -0.008, gain: 0.90, sat: 0.80 },
  },
  {
    alt: -3, name: 'civil',
    top: 0x2b3f6b, mid: 0x6a6a90, haze: 0xb08277,
    key: 0xd8a07a, keyLevel: 0.34,
    hemiSky: 0x60708f, hemiGround: 0x3a3a42, hemiLevel: 0.72,
    cloud: 0x8c7286, cloudOp: 0.72,
    grade: { lift: 0.004, gain: 0.97, sat: 1.06 },
  },
  {
    alt: 3, name: 'golden',
    top: 0x4d7cb0, mid: 0x9fa8c0, haze: 0xe6b183,
    key: 0xffc98a, keyLevel: 1.35,
    hemiSky: 0xa8bcd8, hemiGround: 0x6b6250, hemiLevel: 0.95,
    cloud: 0xf0c3a0, cloudOp: 0.58,
    grade: { lift: 0.003, gain: 1.01, sat: 1.10 },
  },
  {
    alt: 12, name: 'morning',
    /* Deepened with `PAL.skyTop`, or the ramp between this stop and `day`
     * runs the wrong way and the sky gets *paler* as the sun climbs. */
    top: 0x5787bf, mid: 0xa8c0dc, haze: 0xe4dcd2,
    key: 0xfff0d2, keyLevel: 1.90,
    hemiSky: 0xcadcf0, hemiGround: 0x7a7660, hemiLevel: 1.08,
    cloud: 0xfdf3ea, cloudOp: 0.46,
    grade: { lift: 0.0, gain: 1.0, sat: 1.03 },
  },
  {
    alt: 34, name: 'day',
    top: PAL.skyTop, mid: PAL.skyMid, haze: PAL.skyHaze,
    key: PAL.sun, keyLevel: 2.15,
    hemiSky: PAL.hemiSky, hemiGround: PAL.hemiGround, hemiLevel: 1.15,
    cloud: PAL.cloud, cloudOp: 0.42,
    grade: { lift: 0, gain: 1, sat: 1 },
  },
];

/**
 * Seasonal bias on the whole palette, as a **multiplier**.
 *
 * It was a lerp toward an absolute colour -- spring five per cent toward a
 * milky blue, and so on -- and that is wrong in a way that only shows up
 * after dark.  three.js blends in *linear* space, so mixing five per cent
 * of a pale sky into a near-black night sky is not a five per cent change:
 * measured, the midnight zenith went from `#05080f` to `#363a3f`, a
 * flat grey, and the horizon haze with it.  A night that looks like an
 * overcast afternoon is exactly the failure the whole day cycle exists to
 * avoid.
 *
 * A multiply cannot do that: it scales what is there, so a dark sky stays
 * dark and a bright one takes the tint.  Which is also the right model
 * physically -- a season changes the *light*, not the sky's floor.
 */
const SEASON_TINT = [
  [1.00, 1.02, 1.05],   // spring: cool and soft
  [1.00, 1.00, 1.00],   // summer: the palette as it stands
  [1.07, 1.00, 0.92],   // autumn: warm
  [0.95, 0.99, 1.08],   // winter: cold
];

const _a = new THREE.Color();
const _b = new THREE.Color();
const _grey = new THREE.Color();

/**
 * The palette, rebuilt in place every frame.
 *
 * Every colour is a `THREE.Color` that is reused, so a frame costs no
 * allocation at all -- this runs before everything else in `tick`.
 */
export class Atmosphere {
  constructor() {
    this.top = new THREE.Color();
    this.mid = new THREE.Color();
    this.haze = new THREE.Color();
    this.key = { dir: new THREE.Vector3(0, 1, 0), colour: new THREE.Color(), level: 1 };
    this.hemi = { sky: new THREE.Color(), ground: new THREE.Color(), level: 1 };
    this.cloud = { tint: new THREE.Color(), opacity: 0.42, extra: 0 };
    this.grade = { lift: 0, gain: 1, sat: 1 };
    this.fog = { near: 180, far: 1500 };
    /** How lit the world is, 0..1.  The ink pass and the HUD read it. */
    this.light = 1;
  }

  /**
   * @param {Clock}   clock
   * @param {object}  w      the weather's blended parameter vector
   * @param {number}  snow   how much snow is lying, 0..1
   * @param {object}  here   the weather *at the car*, or null
   */
  update(clock, w, snow = 0, here = null) {
    const altDeg = clock.sun.alt / D;
    const s = sample(altDeg);

    this.top.copy(s.top);
    this.mid.copy(s.mid);
    this.haze.copy(s.haze);
    this.key.colour.copy(s.key);
    this.hemi.sky.copy(s.hemiSky);
    this.hemi.ground.copy(s.hemiGround);
    this.cloud.tint.copy(s.cloud);
    let keyLevel = s.keyLevel;
    let hemiLevel = s.hemiLevel;

    /* --- the key light points at whichever body is up ---------------- *
     * One light, re-aimed.  The blend across dusk rides `clock.night`,
     * the same scalar the moon's opacity and the headlights use, so the
     * shadow never comes from a body that is not in the sky. */
    const night = clock.night;
    if (night > 0.5) {
      this.key.dir.copy(clock.moon.dir);
      keyLevel *= 0.35 + 0.65 * clock.moon.illum;
      /* A moon below the horizon casts nothing.  Without this the world
       * gets a shadow from underneath on a new-moon night. */
      if (clock.moon.alt < 0) keyLevel *= Math.max(0, 1 + clock.moon.alt / (12 * D));
    } else {
      this.key.dir.copy(clock.sun.dir);
    }

    /* --- season ------------------------------------------------------ *
     * A multiply, weighted by the season vector.  See `SEASON_TINT`. */
    let tr = 0, tg = 0, tb = 0;
    const sw = clock.season.weights;
    for (let i = 0; i < 4; i++) {
      tr += SEASON_TINT[i][0] * sw[i];
      tg += SEASON_TINT[i][1] * sw[i];
      tb += SEASON_TINT[i][2] * sw[i];
    }
    for (const c of [this.top, this.mid, this.haze]) {
      c.setRGB(c.r * tr, c.g * tg, c.b * tb);
    }

    /* --- cloud ------------------------------------------------------- *
     * Overcast is not "darker blue", it is *less saturated and flatter*:
     * the top and the horizon converge on the same grey, which is why a
     * cloudy sky has almost no gradient in it.
     *
     * **But this is the dome, and the dome is what shows between the
     * clouds.**  The coefficients were 0.62 / 0.52 / 0.34, chosen when the
     * only way to say "there is cloud up there" was to grey the whole sky
     * -- and `clouds.js` now paints the cloud itself, per pixel, in front
     * of this.  Fading the gap between two cumulus by the regional cover
     * counts the same cloud twice: measured, a `patchy` sky at 45 % cover
     * had its zenith lerped 28 % of the way to grey, which is why the blue
     * between the clouds came out pale against every reference photograph
     * in `ref/cloud/`.
     *
     * This is the third time the same double-count has been found in the
     * same place.  `plan_4.md` §4 took it out of the ground shadow
     * (`uCloudAmt` fades as `sunBlock` comes in) and `next_4.md` took two
     * thirds of it out of the star fade for exactly this reason.  What is
     * left here is the honest part: a sky with cloud in it really is
     * hazier everywhere, and the horizon keeps most of its share of that
     * because that is where the haze is.
     *
     * `sunBlock`, not `cloud`, on the two upper stops: a broken sky is
     * blue between the clouds however much of it is covered, and a solid
     * overcast is grey because the light cannot get through it. */
    const cloud = w ? w.cloud : 0;
    const block = w ? w.sunBlock : 0;
    if (cloud > 0.01) {
      lumOf(this.mid, _grey);
      _grey.lerp(this.haze, 0.35);
      this.top.lerp(_grey, block * 0.58);
      this.mid.lerp(_grey, block * 0.48);
      this.haze.lerp(_grey, cloud * 0.30);
    }
    keyLevel *= 1 - 0.88 * block;
    hemiLevel *= 1 + 0.22 * cloud;          // overcast fills shadow in
    this.cloud.opacity = 0.30 + 0.62 * cloud;
    this.cloud.extra = smooth(0.55, 0.95, cloud);

    /* Rain and snow take the last of the contrast out. */
    const wet = w ? w.wetness : 0;
    if (w && (w.rain > 0.01 || w.snow > 0.01)) {
      const g = Math.max(w.rain, w.snow);
      lumOf(this.haze, _grey);
      this.haze.lerp(_grey, g * 0.30);
      keyLevel *= 1 - 0.25 * g;
    }

    /* --- snow on the ground bounces light back up -------------------- *
     * A snowfield lit by a summer-grass hemisphere puts green under the
     * car.  This is the cheapest possible fix and it is worth having. */
    if (snow > 0.01) {
      _a.setHex(0xdfe8f2);
      /* Scaled by how much light there is to bounce, for the same reason
       * the season tint is a multiply: a snowfield at midnight reflects
       * almost nothing, and lerping toward white regardless would light
       * the underside of the car like an overcast noon. */
      this.hemi.ground.lerp(_a, snow * 0.8 * Math.max(0.08, clock.daylight));
      hemiLevel *= 1 + 0.18 * snow;
    }

    this.key.level = Math.max(0, keyLevel);
    this.hemi.level = hemiLevel;

    /* --- fog --------------------------------------------------------- *
     * Linear, as it has been since iteration 0, scaled by the weather.
     * Heavy rain closing the view to ~480 m is also a frame-rate rebate
     * at exactly the moment the particles cost most. */
    /* The **local** fog scale when there is one.  Driving into a shower
     * closes the view down over the ten or twenty seconds it takes to
     * cross the cell edge, and coming out of it opens back up; a regional
     * value would drop the fog on a car standing in sunshine two
     * kilometres from the rain. */
    const scale = here ? here.fogScale : (w ? w.fogScale : 1);
    this.fog.near = 180 * (0.35 + 0.65 * scale);
    this.fog.far = 1500 * scale;

    /* --- the grade --------------------------------------------------- */
    this.grade.lift = s.grade.lift;
    this.grade.gain = s.grade.gain * (1 - 0.10 * wet);
    this.grade.sat = s.grade.sat * (1 - 0.18 * cloud);

    this.light = clock.daylight * (1 - 0.55 * block) + (1 - clock.daylight) * 0.06;
    return this;
  }
}

/* ------------------------------------------------------------------ */

const _s = {
  top: new THREE.Color(), mid: new THREE.Color(), haze: new THREE.Color(),
  key: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
  cloud: new THREE.Color(),
  keyLevel: 1, hemiLevel: 1, cloudOp: 0.4,
  grade: { lift: 0, gain: 1, sat: 1 },
};

/** Interpolate the stop table at a sun altitude in degrees. */
function sample(altDeg) {
  let i = 0;
  while (i < STOPS.length - 1 && altDeg > STOPS[i + 1].alt) i++;
  const a = STOPS[i];
  const b = STOPS[Math.min(STOPS.length - 1, i + 1)];
  const t = b === a ? 0
    : Math.max(0, Math.min(1, (altDeg - a.alt) / (b.alt - a.alt)));
  /* Smoothstep rather than linear: the stops are close together around
   * the horizon and a linear ramp between them makes the twilight change
   * speed visibly as it crosses each one. */
  const k = t * t * (3 - 2 * t);

  mixHex(_s.top, a.top, b.top, k);
  mixHex(_s.mid, a.mid, b.mid, k);
  mixHex(_s.haze, a.haze, b.haze, k);
  mixHex(_s.key, a.key, b.key, k);
  mixHex(_s.hemiSky, a.hemiSky, b.hemiSky, k);
  mixHex(_s.hemiGround, a.hemiGround, b.hemiGround, k);
  mixHex(_s.cloud, a.cloud, b.cloud, k);
  _s.keyLevel = a.keyLevel + (b.keyLevel - a.keyLevel) * k;
  _s.hemiLevel = a.hemiLevel + (b.hemiLevel - a.hemiLevel) * k;
  _s.cloudOp = a.cloudOp + (b.cloudOp - a.cloudOp) * k;
  _s.grade.lift = a.grade.lift + (b.grade.lift - a.grade.lift) * k;
  _s.grade.gain = a.grade.gain + (b.grade.gain - a.grade.gain) * k;
  _s.grade.sat = a.grade.sat + (b.grade.sat - a.grade.sat) * k;
  return _s;
}

function mixHex(out, a, b, t) {
  _a.setHex(a); _b.setHex(b);
  out.copy(_a).lerp(_b, t);
}

function lumOf(c, out) {
  const l = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  return out.setRGB(l, l, l);
}

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
