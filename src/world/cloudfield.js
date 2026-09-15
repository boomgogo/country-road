import * as THREE from 'three';
import { fbmField, perlinWorleyVolume, worleyDetailVolume } from '../core/textures.js';
import { hashFloat } from '../core/rng.js';

/* ------------------------------------------------------------------ *
 * One cloud field, four consumers.
 *
 * `atmosphere.js` is one function with six consumers and it is the reason
 * the sky holds together -- the fog colour and the sky's horizon colour
 * cannot drift apart because there is one place that writes both.  This is
 * the same idea for the *shape* of the weather rather than its colour:
 *
 *   the sky        `clouds.js` marches through it to draw the layer
 *   the ground     every lit material multiplies its direct light by it,
 *                  so a cloud's shadow crosses the landscape
 *   the rain       `Weather.localAt` reads it, so rain falls out of the
 *                  thick part of the cloud you can see ahead of you
 *   the probes     `coverAt` on the CPU, which is how any of the above
 *                  can be tested at all
 *
 * A cloud you can see overhead is the cloud whose shadow you drive through
 * and the cloud the rain is falling out of.  Not because three systems
 * were tuned to agree, but because there is one field.
 *
 * **The field is a texture, and the texture is the single source of
 * truth.**  The CPU samples the same bytes the GPU samples, bilinearly,
 * with the same wrap and the same scale.  The alternative -- two
 * implementations of the same *noise* -- agrees right up until somebody
 * changes one of them, and then disagrees silently, which for a rain field
 * means rain falling out of a clear sky in a place nobody is looking.
 *
 * Two decisions worth keeping:
 *
 * **The cell size is 2-6 km**, which at the 22.35 m/s top speed is a 90 to
 * 270 second crossing.  That is the pace `prompt_4.md` is describing when
 * it asks for "driving into or out of a raining area": smaller cells
 * flicker past the windscreen, larger ones never change.
 *
 * **Coverage is a quantile, not a threshold.**  `w.cloud = 0.45` has to
 * mean *45 % of the sky*, and thresholding an fBm at 0.55 does not mean
 * anything in particular -- the field's distribution is a bell, not a
 * ramp.  So the field's own histogram is built once and inverted, and the
 * cut is read out of it.  `tools/probe/clouds.mjs` measures the sky
 * fraction directly against `w.cloud` because of this.
 * ------------------------------------------------------------------ */

/** World metres per repeat of the texture. */
const TILE = 16000;
/** Texture resolution.  256 is 4 km per texel pair at the scale above. */
const SIZE = 256;
/** The second, much larger sample that breaks the tile's repeat. */
const BREAK_SCALE = 0.37;
const BREAK_MIX = 0.28;
/**
 * The **shape** channel: cumulus-sized, and separate from the coverage.
 *
 * The coverage field's cell is 2-6 km, and that number is load-bearing --
 * it is the rain patch, the shadow patch, and the 90-270 second crossing
 * `prompt_4.md` asked for.  It is also four times too big to be a cloud.
 * At a 1150 m base a 4 km cell subtends **74 degrees**, which is why one
 * cloud filled 60 % of the frame while `ref/cloud/day_cloud_3.jpg` has
 * forty in it and the largest is about 25.
 *
 * So there are two scales in one texture. `.r` decides *where the weather
 * is* and nothing about it changes -- the quantile table, the rain cut,
 * the ground shadow and both probe rows all still read it. `.b` decides
 * *what the cloud looks like* inside that, at about 1.1 km, and only the
 * march reads it. One weather cell becomes three or four cumulus.
 */
const SHAPE_BASE = 36;          // 16 km / 36 = 444 m features
/**
 * How much of the cloud's outline the shape channel decides.
 *
 * The march's silhouette is `coverage + (shape - 0.5) * SHAPE_MIX`, and
 * **the quantile table is built on that same sum** -- which is the whole
 * point.  Any other arrangement makes `w.cloud` stop meaning "this
 * fraction of the sky", because a break-up applied after the cut removes
 * area the cut had already counted.  Two attempts at that are recorded in
 * `clouds.js`: one turned an overcast into puffs (0.85 asked, 0.283
 * marched) and the next turned a fair-weather sky into a ceiling.
 *
 * With the sum quantised instead, the amplitude is free: it decides how
 * *broken* the sky is and not how much of it is covered.  0.55 is about
 * four times the coverage field's own standard deviation, so the fine
 * structure decides the outline of each cloud while the coarse field still
 * decides where the weather is -- which is exactly the separation
 * `prompt_5.md` item 5 needs.
 */
const SHAPE_MIX = 0.55;
/** How soft a cloud edge is, in units of the raw field. */
const SOFT = 0.035;
/** Blur radius for the shadow copy, in texels: a shadow cast from 1200 m
 *  has no crisp edge, and one tap of a blurred channel is the cheapest
 *  possible way to say so. */
const BLUR = 3;

/** Below this fraction of sky, the cut is lifted until nothing passes it
 *  at all.  See `update`. */
const CLEAR_COVER = 0.02;
/** A cut no sample can reach: the field is stored in a byte, so 0..1. */
const CUT_EMPTY = 2;

const SALT_WIND = 0xc10d5;

export const CLOUD_UNIFORMS = {
  uCloudTex: { value: null },
  /** Wind drift, in world metres.  Added before the scale. */
  uCloudOfs: { value: new THREE.Vector2() },
  uCloudScale: { value: 1 / TILE },
  /** The raw value above which there is cloud.  From the quantile table. */
  uCloudCut: { value: 1 },
  uCloudSoft: { value: SOFT },
  /** ... and above which it is raining.  Always above `uCloudCut`. */
  uRainCut: { value: 1 },
  /** The march's own cut, on the coverage-plus-shape sum.  See SHAPE_MIX. */
  uShapeCut: { value: 1 },
  /**
   * ... and the same cut at the *top and bottom* of the deck.
   *
   * This is the one number that turns a slab into clouds.  Until now the
   * silhouette was cut at one threshold and then multiplied by a vertical
   * profile, which is an **extrusion**: the outline of a cloud at its base
   * is its outline at its top, so every cloud is a cylinder with a rounded
   * lid and a deck seen from below is one continuous ceiling.  It was, and
   * `docs/cloud/day_cloud_3-sheet.png` from before this change is a grey
   * lid over the whole frame beside a photograph of forty separate
   * cumulus.
   *
   * `~/Repos/others/three-geospatial` does not have that problem because
   * it modulates the *coverage threshold* by height --
   * `shapeAlteringFunction` in `packages/clouds/src/shaders/clouds.glsl`,
   * a semicircle over a biased height fraction -- so the horizontal
   * outline shrinks toward both ends of the layer and the sky shows
   * through between the clouds.
   *
   * Two cuts out of the same quantile table, lerped by that height term.
   * At the widest slice the threshold is exactly `uShapeCut`, so **the
   * marched fraction of sky is still `w.cloud`**: the cut is a threshold
   * on one scalar field, so the slices are nested, and the union of a
   * nested family is its widest member.  The invariant `cloudfield.js` is
   * built around survives a change that makes every other slice narrower.
   */
  uShapeCutTop: { value: 1 },
  uShapeMix: { value: SHAPE_MIX },
  /** Height of the cloud base, in metres above the car. */
  uCloudBase: { value: 1150 },
  /** Strength of the shadow on the ground.  Zero at night. */
  uCloudAmt: { value: 0 },
  /** `sunDir.xz / sunDir.y`: the parallax from the ground to the base. */
  uCloudSunXZ: { value: new THREE.Vector2() },
};

/**
 * The field, as GLSL.  Injected into every lit material and into the sky.
 *
 * `cloudRaw` is the field; `cloudCover` is where the cloud is; `cloudRain`
 * is where it is raining, which is the *thick* part of the same cloud and
 * not a second field; `cloudShadow` is the ground term.
 */
export const CLOUD_PARS = /* glsl */ `
  uniform sampler2D uCloudTex;
  uniform vec2 uCloudOfs, uCloudSunXZ;
  uniform float uCloudScale, uCloudCut, uCloudSoft, uRainCut;
  uniform float uCloudBase, uCloudAmt;
  uniform float uShapeCut, uShapeCutTop, uShapeMix;

  /* The silhouette the sky is marched against: where the weather is, plus
   * what a cloud looks like inside it.  Quantised as one number -- see
   * SHAPE_MIX in cloudfield.js. */
  float cloudShape( vec3 f ) { return f.x + ( f.z - 0.5 ) * uShapeMix; }

  /* Two samples of one texture at incommensurate scales.  One would repeat
   * every 16 km, which is inside the distance a cloud at 1150 m can be
   * seen from; multiplied by a sample 2.7 times larger the pattern does
   * not close until 43 km, by which point it is haze. */
  vec3 cloudRaw3( vec2 p ) {
    vec2 q = ( p + uCloudOfs ) * uCloudScale;
    vec3 a = texture2D( uCloudTex, q ).rgb;
    vec3 b = texture2D( uCloudTex, q * ${BREAK_SCALE} + 0.137 ).rgb;
    return mix( a, b, ${BREAK_MIX} );
  }

  /* The two channels everything outside the march reads: coverage and its
   * blurred copy.  Unchanged, and deliberately so -- the quantile table,
   * the rain cut and the ground shadow are all calibrated on the first
   * one, and a backtick in here ends the template literal. */
  vec2 cloudRaw2( vec2 p ) { return cloudRaw3( p ).xy; }

  float cloudCover( vec2 p ) {
    return smoothstep( uCloudCut - uCloudSoft, uCloudCut + uCloudSoft,
                       cloudRaw2( p ).x );
  }

  float cloudRain( vec2 p ) {
    return smoothstep( uRainCut - uCloudSoft, uRainCut + uCloudSoft * 2.0,
                       cloudRaw2( p ).x );
  }

  /**
   * How much of the key light survives to this point on the ground.
   *
   * The parallax is the whole of it: the cloud that shadows a point is not
   * the one above it, it is the one *toward the sun* from it, by the
   * cloud's height over the ground.  Which is also why a low sun throws
   * cloud shadows kilometres away and a cloud overhead at sunset casts
   * nothing you can see -- correct, and it looks like a bug.  The clamp on
   * sunDir.y is what stops that going to infinity at the horizon.
   */
  float cloudShadow( vec3 world ) {
    vec2 sp = world.xz + uCloudSunXZ * max( 0.0, uCloudBase - world.y );
    float c = smoothstep( uCloudCut - uCloudSoft * 2.0,
                          uCloudCut + uCloudSoft * 2.0, cloudRaw2( sp ).y );
    return 1.0 - uCloudAmt * c;
  }
`;

/**
 * How much of the sky's cover also rains, at full `patchiness`.
 *
 * 0.45 was the first guess and it is too dry to be the feature: measured
 * over eight 13 km drives through a pinned sunshower, the car was in rain
 * **8 %** of the time and **0.6** drives in one crossed a cell at all --
 * so "driving into or out of a raining area" mostly did not happen.  0.7
 * puts about a third of a patchy sky's map under rain, which is one or two
 * crossings on a ten-minute drive.
 */
const RAIN_FRACTION = 0.7;

/** Cloud drift, m/s.  See `update`: fixed, so the sky is a function of t. */
const NOMINAL_WIND = 9;

/**
 * How much of the coverage survives at the very top and bottom of the deck.
 *
 * `uShapeCutTop` is the quantile of `w.cloud * TAPER_FRACTION`, so this is
 * literally "a cloud's lid covers a sixth of the sky its waist does".
 * Zero would be the physical answer and is the wrong one: the top slice
 * would be a point, the march would step straight over it, and cloud tops
 * would come out flat and aliased.  A sixth leaves a small cap.
 */
const TAPER_FRACTION = 0.16;

/** Side of the 3D shape volume.  256 kB at one byte a texel. */
const N3 = 64;
/** ... and of the detail volume, which is sampled eight times finer. */
const N3_DETAIL = 32;

export class CloudField {
  constructor(seed) {
    this.seed = seed;
    /* Five octaves from a base of 4: the largest features are a quarter of
     * the tile, which is the 4 km cell the whole thing is sized around. */
    const sharp = fbmField(SIZE, { octaves: 5, base: 4, seed: (seed ^ 0x51ee) >>> 0 });
    const soft = blur(sharp, SIZE, BLUR);
    /* The cumulus-sized channel.  Four octaves from 14, so the largest
     * feature is 1.14 km and the smallest is 143 m -- the range a cloud
     * has structure over. */
    /* Three octaves from 36, so the largest feature is 444 m and the
     * smallest is 111 -- above the 62.5 m texel, which four octaves was
     * not.  It was four from 22: a 730 m cloud at a 1150 m base subtends
     * thirty-five degrees, and `ref/cloud/day_cloud_3.jpg` has forty
     * clouds in it of which the largest is about twenty-five.  Everything
     * finer than this is now the business of the two Worley volumes, which
     * is where detail belongs -- in three dimensions rather than extruded
     * out of two. */
    const shape = fbmField(SIZE, {
      octaves: 3, base: SHAPE_BASE, seed: (seed ^ 0x3c10) >>> 0,
    });

    const data = new Uint8Array(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i++) {
      data[i * 4] = clamp255(sharp[i] * 255);
      data[i * 4 + 1] = clamp255(soft[i] * 255);
      data[i * 4 + 2] = clamp255(shape[i] * 255);
      data[i * 4 + 3] = 255;
    }
    this.data = data;
    const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    CLOUD_UNIFORMS.uCloudTex.value = tex;

    /* And the volumes, which are what a cloud is made of.
     *
     * A cloud silhouette that is a 2D field extruded upward reads as
     * extruded, and these are what erode it into billows.  There are two,
     * and they are the pair `~/Repos/others/three-geospatial` builds in
     * `cloudShape.frag` and `cloudShapeDetail.frag`:
     *
     *   `noise3`   64^3 Perlin-Worley, the shape.  Round lumps that are
     *              themselves lumpy.
     *   `detail3`  32^3 Worley fBm, the fringe.  All creases, no shape.
     *
     * **Worley, not value noise**, and that is the whole point of the
     * change.  A sum of smoothed lattices has blobby level sets in the
     * middle and blobby level sets at the edge, so subtracting it from a
     * silhouette thins a cloud evenly and reads as fog; inverted Worley is
     * a field of round bumps meeting at creases, so eroding with it carves
     * cauliflower.  See the header in `core/textures.js`.
     *
     * They live here rather than in `clouds.js` for the same reason
     * everything else does: one field, and the probes can read it.  They
     * are deliberately **not** in `CLOUD_UNIFORMS` -- that block is
     * injected into every lit material in the scene, and the ground has no
     * use for a cloud's interior.  `Clouds` takes them as its own
     * uniforms.
     */
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    this.noise3 = vol3(perlinWorleyVolume(N3, { cells: 4, seed: (seed ^ 0x9d17) >>> 0 }), N3);
    this.detail3 = vol3(worleyDetailVolume(N3_DETAIL, { cells: 2, seed: (seed ^ 0x4a81) >>> 0 }), N3_DETAIL);
    this.volumeMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;

    /* One wind direction per world, fixed: a cloud field whose drift
     * changed direction with the weather would slide sideways under the
     * player every time a front came through. */
    const a = hashFloat(seed, SALT_WIND, 0) * Math.PI * 2;
    this.wind = new THREE.Vector2(Math.cos(a), Math.sin(a));
    this.ofs = CLOUD_UNIFORMS.uCloudOfs.value;
    this.ofs.set(0, 0);

    /* The quantile table, from the *combined* two-scale field rather than
     * from the octaves -- mixing two samples narrows the distribution, and
     * a table built from one of them would put `w.cloud = 0.5` at about
     * 0.62 of the sky.  After `ofs` exists, because it samples through
     * `rawAt`, which reads it. */
    this.quantiles = quantiles(this, 160, (fld, x, z) => fld.rawAt(x, z, 0));
    /* And the same table for the silhouette the march actually cuts, so
     * `w.cloud` means a fraction of *sky* rather than a fraction of the
     * coverage field.  See SHAPE_MIX. */
    this.shapeQuantiles = quantiles(this, 160, (fld, x, z) =>
      fld.rawAt(x, z, 0) + (fld.rawAt(x, z, 2) - 0.5) * SHAPE_MIX);
  }

  /**
   * One frame.  `dt` is game seconds -- during a rest this is called with
   * the lapse's own delta, so the sky is in the right place afterwards.
   */
  update(dt, w, clock) {
    /* **The drift is a function of the clock, not an integral of it.**
     *
     * Accumulating `speed * dt` would make the sky's position depend on
     * how long the page had been open, which breaks the property the rest
     * of this world has and the save depends on: everything is a pure
     * function of (seed, t).  A reload would put the clouds somewhere
     * else, and a scrub backwards with `[` would drift them *forwards*,
     * because an integral of a speed has no sign to run back.
     *
     * The price is that the drift rate is fixed rather than scaling with
     * the weather's wind.  9 m/s is a fresh breeze; it puts a 4 km cell
     * over the car for about seven minutes when parked, which is the right
     * order for something you are supposed to notice but not watch.
     */
    const t = clock ? clock.t : 0;
    this.ofs.x = this.wind.x * NOMINAL_WIND * t;
    this.ofs.y = this.wind.y * NOMINAL_WIND * t;
    this.drift = NOMINAL_WIND * t;

    const cover = w ? w.cloud : 0;
    /* **Zero coverage has to mean an empty sky**, and the quantile table on
     * its own does not quite give that.  `cutFor(0)` returns the largest
     * value in a 160x160 sample of the field, and the shader's edge is a
     * `smoothstep(cut - soft, cut + soft, raw)` -- so the brightest texels
     * still come through at about half density, and any texel above the
     * sampled maximum comes through whole.  What you saw was a handful of
     * wisps in the weather that is supposed to have nothing in it at all.
     *
     * So the cut is lifted clear of the field's range as the coverage
     * approaches nothing.  `CLEAR_COVER` is 2 % of sky, which is a wisp
     * either way, and the lift is a lerp rather than a branch so a drift
     * out of an overcast still empties the sky continuously instead of
     * blinking the last cloud out. */
    const k = Math.min(1, cover / CLEAR_COVER);
    CLOUD_UNIFORMS.uCloudCut.value = this.cutLifted(cover, k);
    CLOUD_UNIFORMS.uRainCut.value = this.cutLifted(cover * RAIN_FRACTION, k);
    CLOUD_UNIFORMS.uShapeCut.value =
      this.cutLifted(cover, k, this.shapeQuantiles);
    /* The same table, at a sixth of the fraction: what a cloud's lid
     * covers.  See `uShapeCutTop`. */
    CLOUD_UNIFORMS.uShapeCutTop.value =
      this.cutLifted(cover * TAPER_FRACTION, k, this.shapeQuantiles);

    /* How strong the shadow is, and the `sunBlock` term is not optional.
     *
     * `atmosphere.js` already dims the key light by `1 - 0.88 * sunBlock`
     * for the weather as a whole.  Under a solid overcast there is no
     * *shadow* -- there is just less light, and that is already handled.
     * Without this term the two stack: measured on a pinned `cloudy` at
     * 10:00, the ground came back at 0.386 of its light, once for being
     * overcast and again for standing under the cloud that makes it
     * overcast.
     *
     * So the spatial term fades out exactly as the global one comes in.
     * Sunny (`sunBlock` 0) gets the full 0.8; `patchy` 0.64, which is the
     * weather this is really for; `heavyRain` 0.04, which is right --
     * under that deck nothing casts anything.
     *
     * `daylight` rather than a time test, so it is right at both solstices
     * and agrees with the headlights and the stars, which read the same
     * scalar. */
    const day = clock ? clock.daylight : 1;
    const block = w ? w.sunBlock : 0;
    CLOUD_UNIFORMS.uCloudAmt.value = 0.8 * day * (1 - block);

    if (clock) {
      const d = clock.sun.dir;
      const y = Math.max(0.18, d.y);
      CLOUD_UNIFORMS.uCloudSunXZ.value.set(d.x / y, d.z / y);
    }
  }

  /**
   * Everything `update` writes, and putting it back.
   *
   * `Weather.projectDry` runs the world forward twenty game-hours to find
   * out when the rain will actually have stopped, and it does that by
   * calling the *real* `update` rather than by reimplementing it -- which
   * is the only way a forecast can be guaranteed not to disagree with the
   * weather.  The price is that it moves this object's state and the
   * shared uniform block, and both have to come back exactly.
   */
  snapshot() {
    const U = CLOUD_UNIFORMS;
    return {
      ox: this.ofs.x, oy: this.ofs.y, drift: this.drift,
      cut: U.uCloudCut.value, rainCut: U.uRainCut.value, amt: U.uCloudAmt.value,
      sunX: U.uCloudSunXZ.value.x, sunZ: U.uCloudSunXZ.value.y,
      /* The march's two cuts as well.  They were missing, and the miss was
       * invisible only because `update` runs again before the next frame
       * is drawn -- which is luck, not a guarantee: `projectDry` calls
       * `update` a thousand times and anything that reads a uniform
       * between the last of those and the next frame would have read the
       * forecast's sky rather than this one's. */
      shapeCut: U.uShapeCut.value, shapeCutTop: U.uShapeCutTop.value,
    };
  }

  restore(s) {
    const U = CLOUD_UNIFORMS;
    this.ofs.x = s.ox; this.ofs.y = s.oy; this.drift = s.drift;
    U.uCloudCut.value = s.cut;
    U.uRainCut.value = s.rainCut;
    U.uCloudAmt.value = s.amt;
    U.uShapeCut.value = s.shapeCut;
    U.uShapeCutTop.value = s.shapeCutTop;
    U.uCloudSunXZ.value.set(s.sunX, s.sunZ);
  }

  /** The raw field at a world position, exactly as the shader reads it. */
  rawAt(x, z, channel = 0) {
    const ox = x + this.ofs.x, oz = z + this.ofs.y;
    const a = this._tap(ox / TILE, oz / TILE, channel);
    const b = this._tap(ox / TILE * BREAK_SCALE + 0.137,
                        oz / TILE * BREAK_SCALE + 0.137, channel);
    return a + (b - a) * BREAK_MIX;
  }

  /** Where the cloud is, 0..1.  The same smoothstep as the shader. */
  coverAt(x, z) {
    const c = CLOUD_UNIFORMS.uCloudCut.value, s = CLOUD_UNIFORMS.uCloudSoft.value;
    return smoothstep(c - s, c + s, this.rawAt(x, z, 0));
  }

  /** Where it is raining, 0..1. */
  rainAt(x, z) {
    const c = CLOUD_UNIFORMS.uRainCut.value, s = CLOUD_UNIFORMS.uCloudSoft.value;
    return smoothstep(c - s, c + s * 2, this.rawAt(x, z, 0));
  }

  /** What the ground gets, 0..1, at a world point.  For the probes. */
  shadowAt(x, y, z) {
    const p = CLOUD_UNIFORMS.uCloudSunXZ.value;
    const h = Math.max(0, CLOUD_UNIFORMS.uCloudBase.value - y);
    const c = CLOUD_UNIFORMS.uCloudCut.value, s = CLOUD_UNIFORMS.uCloudSoft.value;
    const raw = this.rawAt(x + p.x * h, z + p.y * h, 1);
    return 1 - CLOUD_UNIFORMS.uCloudAmt.value * smoothstep(c - s * 2, c + s * 2, raw);
  }

  /**
   * The raw value at which `frac` of the sky is cloud.
   *
   * The inverse of the field's own histogram, so `w.cloud` is a *fraction
   * of sky* rather than a number that happens to look right at noon.
   */
  cutFor(frac, table = null) {
    const q = table || this.quantiles;
    const f = Math.max(0, Math.min(1, 1 - frac)) * (q.length - 1);
    const i = Math.floor(f);
    const t = f - i;
    return q[i] + ((q[Math.min(q.length - 1, i + 1)] - q[i]) * t);
  }

  /** `cutFor`, lifted clear of the field as the sky empties: `k` is 0 at no
   *  cloud at all and 1 from `CLEAR_COVER` up.  See `update`. */
  cutLifted(frac, k, table = null) {
    return this.cutFor(frac, table) * k + CUT_EMPTY * (1 - k);
  }

  /** Bilinear, wrapping, on the stored bytes -- the GPU's own filter. */
  _tap(u, v, channel) {
    const fx = (u - Math.floor(u)) * SIZE - 0.5;
    const fy = (v - Math.floor(v)) * SIZE - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const at = (x, y) => {
      const i = (((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE);
      return this.data[i * 4 + channel] / 255;
    };
    const a = at(x0, y0), b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
}

/* ------------------------------------------------------------------ */

/** A separable box blur on a wrapping field. */
/**
 * A Float32Array of `n^3` values in [0,1], as a wrapping single-channel
 * 3D texture.
 *
 * Hardware trilinear and hardware wrap, because every shader in this
 * project is compiled as GLSL ES 3.00 and `sampler3D` is simply
 * available.  `RedFormat` at one byte a texel: 256 kB for the shape, 32 kB
 * for the detail.
 */
function vol3(arr, n) {
  const bytes = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) bytes[i] = clamp255(arr[i] * 255);
  const t = new THREE.Data3DTexture(bytes, n, n, n);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function blur(src, size, r) {
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  const n = r * 2 + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * size + (((x + k) % size) + size) % size];
      tmp[y * size + x] = s / n;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[((((y + k) % size) + size) % size) * size + x];
      out[y * size + x] = s / n;
    }
  }
  return out;
}

/**
 * The sorted distribution of the combined field, as `n` quantiles.
 *
 * Sampled through `rawAt` at a stride that is not a divisor of the tile,
 * so the samples are not all on the same lattice corners as the noise.
 */
function quantiles(field, n, read) {
  const N = 128;
  const vals = new Float64Array(N * N);
  const step = TILE / N * 1.013;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) vals[j * N + i] = read(field, i * step, j * step);
  }
  vals.sort();
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = vals[Math.min(vals.length - 1, Math.round(i / (n - 1) * (vals.length - 1)))];
  }
  return out;
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/* ------------------------------------------------------------------ *
 * The ground shadow, patched into every lit material.
 *
 * **Into the light, not into the albedo**, and the difference is the
 * whole reason this is worth doing.
 *
 * Multiplying `diffuseColor` -- where the season tint goes, twenty lines
 * away in `season.js` -- would darken the ambient and the hemisphere as
 * well, so a cloud shadow at midnight would put a black patch on ground
 * lit only by the sky.  Scaling the *direct* contribution attenuates only
 * the key, which is what a cloud actually does.
 *
 * And there is a second reason, which is `prompt_4.md` item 3.  Every
 * material in this project is a `MeshToonMaterial` with a two-to-four stop
 * gradient map at `NearestFilter`, so the direct term is **quantised**: a
 * hillside sits in one band for a long time and then steps to the next.
 * That is the look, and it is why the sun moving 0.25 degrees a second
 * changes nothing you can see on the ground for minutes at a time.  But
 * the band is quantised and *what it is multiplied by* is not --
 * `toon.js` computes `celBand * mix(uShadowTint, 1, celBand) *
 * directLight.color` -- so a term that scales the accumulated direct light
 * is the one soft, continuously-moving light gradient a cel-shaded world
 * can have.  A cloud shadow crossing a hillside is the answer to "I can't
 * see the sun move", and it arrives with the clouds rather than as a
 * change to the art direction.
 *
 * The patch goes *after* `#include <lights_fragment_begin>`, which is
 * where the light loop has finished accumulating into `reflectedLight` and
 * before `lights_fragment_end` folds in the indirect terms.  It works
 * identically on the toon and the standard programs, which is what keeps
 * `?style=flat` alive.
 */
const LIGHT_PATCH = /* glsl */ `
  {
    /* World position, reconstructed rather than passed down as a varying:
     * vViewPosition is already there in every lit material (toon gets it
     * from lights_toon_pars_fragment), and the view matrix's upper 3x3
     * is orthonormal, so its transpose is its inverse.  One line here
     * against a new varying in six different vertex shaders, three of
     * which are instanced. */
    vec3 wPosCloud = cameraPosition + transpose( mat3( viewMatrix ) ) * ( -vViewPosition );
    float cloudShade = cloudShadow( wPosCloud );
    reflectedLight.directDiffuse *= cloudShade;
    reflectedLight.directSpecular *= cloudShade;
  }
`;

/**
 * Give a material the cloud shadow.
 *
 * Chains whatever `onBeforeCompile` is already there, exactly as
 * `patchSeason` and `shadowTint` do -- and takes a `key` for exactly the
 * same reason: every `Material` inherits `customProgramCacheKey` from the
 * prototype, so a plain truthiness test finds one on every material there
 * has ever been, and two materials that inject different GLSL under one
 * key get one compiled program between them.  That cost `next_3.md` an
 * afternoon and three rust-orange conifers.
 */
export function patchClouds(mat, key = '') {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, CLOUD_UNIFORMS);
    if (!shader.fragmentShader.includes('lights_fragment_begin')) return;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + CLOUD_PARS)
      .replace('#include <lights_fragment_begin>',
               '#include <lights_fragment_begin>\n' + LIGHT_PATCH);
  };
  const own = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')
    ? mat.customProgramCacheKey.bind(mat)
    : null;
  mat.customProgramCacheKey = () => 'cloud' + (key ? '_' + key : '') + (own ? '_' + own() : '');
  return mat;
}
