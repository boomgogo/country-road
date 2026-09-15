import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CLOUD_UNIFORMS, CLOUD_PARS } from './cloudfield.js';

/* ------------------------------------------------------------------ *
 * The cloud layer, raymarched.
 *
 * This replaces the three textured sphere caps that have been the sky's
 * clouds since iteration 0, and it replaces them for four reasons, three
 * of which are in `prompt_4.md` item 4 and one of which is a bug:
 *
 *  1. **Depth from the ground.**  You can see *under* the base, so an
 *     overcast sky has a ceiling and a fair-weather sky has bottoms lit
 *     from below at sunset.  A cap cannot do that at any opacity.
 *  2. **A shadow on the ground** -- but that is `cloudfield.js`, not here.
 *     What matters is that it comes out of the *same field*, so the cloud
 *     you can see is the one whose shadow you drive through.
 *  3. **Rain that belongs to a cloud**, ditto: the shafts below the base
 *     hang under the thick part of the field, and that is where the rain
 *     falls.
 *  4. **The seam.**  `tools/probe/seam.mjs`, run on the previous build,
 *     put a number on the discontinuity `next_3.md` §6 could not explain:
 *     the second difference of the row means peaks at **8.11/255 at
 *     y=478** -- five pixels off the horizon -- in cloudy and heavy-rain
 *     skies, at every daylight hour.  Hiding the three caps takes it to
 *     **0.66**; turning off ink and grade leaves it at **8.92**.  So it
 *     was the caps' rims all along, it was never the post pipeline, and
 *     "isolating the three cloud sheets one at a time did not reproduce
 *     it" was true because it takes hiding *all three* to see it go.
 *
 * **Half resolution, and a depth test.**
 *
 * A 24-step march with a light tap per step is about fifty texture reads
 * per fragment, and clouds are the lowest-frequency thing in the frame, so
 * marching at half the render target's resolution and letting the upsample
 * do the rest costs nothing anyone can see.
 *
 * It was a quarter to begin with, on the arithmetic alone.  Measured, the
 * whole layer costs under the noise floor of the frame time either way --
 * 2.8 ms at half, 2.8 ms at full, 2.8 ms with `?clouds=off` -- so the
 * resolution was chosen on how the *edges* look instead, and a quarter
 * puts visible stair-steps on a cloud top.  (That measurement times
 * `step()` on the CPU while the GPU works asynchronously behind it, so it
 * is a floor, not a budget; what it does establish is that nothing here
 * shows up against everything else the frame does.)
 *
 * **And a temporal resolve, which is what makes half resolution honest.**
 *
 * Half res and a jittered march both buy their speed by being wrong in a
 * way that is *supposed* to average out, and until this iteration nothing
 * averaged it: one sample per pixel per frame, a dither pinned to
 * `gl_FragCoord`, and a bilinear magnify.  What that draws is a fixed 8x8
 * crosshatch on every cloud edge that the sky slides through as you drive
 * -- reported as "a strange pattern on the edge of clouds, and it flickers
 * as you drive", which is an exact description of screen-space
 * fixed-pattern noise in motion.
 *
 * So the march now moves its dither *and* its rays every frame, and
 * `RESOLVE_FRAG` keeps the running mean, reprojected against the previous
 * frame's view-projection so the mean belongs to a piece of sky rather
 * than to a pixel.  The pattern averages away because it is now a sample
 * sequence; the crawl goes with it because the result is anchored in the
 * world; and the smear goes too, because the history is kept at full
 * resolution and the jittered half-res samples land all over it.
 *
 * The composite is a fullscreen quad whose vertex shader writes depth
 * **exactly 1.0** -- the far plane -- with `depthTest` on and
 * `depthWrite` off.  The buffer is cleared to 1.0, so `LEqual` passes on
 * every pixel nothing has drawn into and fails on every pixel the terrain
 * has: the layer paints the sky and skips the world, for free, with no
 * mask and no second depth fetch.  It also means the stars and the moon,
 * which draw earlier and write no depth, end up *behind* the clouds --
 * so the moon goes behind a cloud per pixel rather than the whole star
 * field fading out by a global cover number, which is what iteration 3
 * had to do.
 * **No backticks below this line.**  The shader is a template literal, so
 * a backtick in a GLSL *comment* ends it -- and what follows then parses
 * as JavaScript, which fails a hundred lines later with a message about a
 * missing semicolon in the middle of a sentence.  Twice in one afternoon.
 * ------------------------------------------------------------------ */

/**
 * The deck, in metres above the camera.
 *
 * It was 1150 to 2350 -- **1200 m thick, for clouds about 730 m wide.**
 * A cumulus that is taller than it is broad is a towering cumulus, and a
 * field of them seen at a grazing angle is a wall: at nine degrees of
 * elevation a ray crosses fifteen kilometres of that slab, so it passes
 * through every cell in its way and the sky above the horizon marches out
 * solid whatever the coverage says.  Fair-weather cumulus are wide and
 * shallow -- a few hundred metres deep on a kilometre base -- and 900 is
 * the compromise: thin enough that the far sky is not a wall, thick
 * enough that the light march still has something to march through.  At
 * 600 the march was too short to shade anything and the whole sky came
 * back as one flat cream ceiling, which is measurably worse (chroma 0.95
 * against 2.52) as well as obviously worse.
 */
const BASE = 1150;
/**
 * The top of the deck: **650 m, not 900.**
 *
 * The number that decides how much of the sky is cloud at a *moderate*
 * elevation is not the coverage -- it is the ratio of the deck's thickness
 * to a cloud's width, because that is what sets the path length of a ray
 * through the field.  At 30 degrees a ray crosses a 900 m deck over 1.8 km
 * of ground, so it meets four or five clouds in a row and comes out solid
 * however patchy the sky is from directly below.  `ref/cloud/day_cloud_3`
 * is blue at 30 degrees, and ours was white.
 *
 * 650 against a 444 m cloud width is about the aspect a fair-weather
 * cumulus really has -- they are wider than they are tall, and the field
 * this had been building was a field of towers.  With the per-cloud height
 * variation on top, the tops now run 250 to 650 m above a base that itself
 * moves by 190, which is a cumulus field rather than a slab.
 *
 * `next_5.md` records that thinning the deck to 600 made things *worse*
 * last time, and it did: with a light march that needed thickness to shade
 * anything and a vertical profile that was a window rather than a
 * silhouette, a thin deck was one flat ceiling.  Neither of those is true
 * any more -- what shades a cloud now is its own narrowing outline.
 */
const TOP = 1800;
/** World metres per repeat of the Perlin-Worley shape volume. */
const NOISE_SCALE = 2600;
/** ... and of the Worley detail volume, which is the fringe. */
const DETAIL_SCALE = 700;
/** Where the cirrus sheet hangs, and how thin it is. */
const CIRRUS_ALT = 7000;
/**
 * Stop marching here, and start fading a long way before it.
 *
 * At a grazing angle a ray enters the base kilometres away, and a degree
 * of elevation moves that entry point by kilometres more -- so the whole
 * of a cloud field compresses into a few pixels above the horizon, and
 * the boundary between a cell and a gap becomes a hard horizontal edge.
 * Measured on a dawn frame: alpha 0.99 at 13.5 degrees of elevation and
 * 0.15 at 9.7, over twenty pixels, which reads as a pale slab with a
 * ruled edge and was reported as one.
 *
 * There is no fixing that inside a slab model; what there is, is aerial
 * perspective, which is true anyway.  A cloud eight kilometres away is
 * already half haze and one at twenty-five is all of it.
 */
const MAX_DIST = 34000;
/**
 * And the fade starts at five kilometres, not eight.
 *
 * A slab seen at a grazing angle is a very long path: at nine degrees of
 * elevation a ray enters the base seven kilometres away and does not leave
 * the top for fifteen, so it passes through nearly every cell in its way
 * and the sky above the horizon marches out solid.  Real cumulus do bunch
 * up toward the horizon -- `day_cloud_3.jpg` shows exactly that -- but
 * they also go pale, because twenty kilometres of air is most of what you
 * are looking at by then.  Bringing the fade in is both the honest fix and
 * the only one: it is aerial perspective, not a cheat, and it is what lets
 * the blue show through between the far clouds instead of a grey deck.
 */
const FADE_FROM = 5000;

/* --- the march's step schedule ------------------------------------- *
 *
 * **Twenty-eight even steps between the entry and the exit is the wrong
 * shape for this problem**, and it is the shape the layer had.  A ray
 * that leaves overhead crosses 900 m of deck and got 32 m steps it did
 * not need; a ray at nine degrees crosses fifteen kilometres and got 535 m
 * steps, which is most of a cloud, so the far sky was integrated at a
 * resolution coarser than the thing it was integrating.  That is a large
 * part of why the horizon marched out as a wall.
 *
 * `~/Repos/others/three-geospatial` marches the same slab (a shell, in
 * its case) with a step that starts small, **grows geometrically**, and
 * **jumps ahead through empty space** -- `marchClouds` in
 * `packages/clouds/src/shaders/clouds.frag`, with `minStepSize`,
 * `maxStepSize` and `perspectiveStepScale`.  The empty-space skip is what
 * pays for the rest: the coverage test is two texture reads and rejects
 * most samples in a fair-weather sky before any 3D tap happens, so the
 * budget goes where the cloud is.
 *
 * `PERSP_K` is the part that is about perspective rather than about
 * cloud: a step subtends less angle the further away it is taken, so the
 * step that costs one pixel of error grows linearly with distance.  1 % of
 * the distance is about a pixel at this field of view.
 */
const MIN_STEP = 55;
/**
 * The longest stride, and **150 rather than 450**.
 *
 * This is the number that draws the horizontal layering on far cloud --
 * reported, after plan_8 took the dither off it, as *the cloud appears to
 * have horizontal layers sometimes*.
 *
 * The mechanism is one line further down: `cap` is only lowered to
 * IN_CLOUD_STEP *after* a sample has come back non-empty, so the stride
 * that found the cloud is also the stride the first slab of it is
 * integrated with.  A ray that has just skipped 450 m of nothing puts a
 * 450 m slab into a 650 m deck, and where that slab starts is quantised by
 * the skip.
 *
 * And the quantisation comes out **level**, which is why it reads as
 * layers rather than as noise.  `t0` is anchored to a fixed height, and
 * for a low ray the vertical rise per step, `dir.y * st`, is very nearly
 * `uPerspK * (uBase - 240 - camY)` -- a constant, independent of the ray's
 * elevation.  So neighbouring pixels quantise their arrival at the same
 * distances, those distances are the same *heights*, and the heights are
 * flat.  It is a bias and not variance, which is why plan_8's temporal
 * resolve could not average it away.
 *
 * Swept by `tools/probe/rings.mjs`, one page load per value -- a
 * horizontal blur to cancel everything that is not axis-aligned, then the
 * vertical second difference of what survives, x1000 at blur radius 80:
 *
 *     MAX_STEP        450    320    240    190    150    110
 *     sunny 10:00   1.514  1.314  1.341  1.239  1.258  1.269
 *     sunny 17:30   1.850  2.060  1.653  2.067  1.664  1.544
 *     cloudy 10:00  0.742  0.664  0.635  0.617  0.605  0.745
 *     cloudy 17:30  0.662  0.646  0.605  0.584  0.587  0.736
 *
 * Most of the win is in the first step down from 450, and 150 and 190 are
 * a tie -- either would do, and the choice between them is not supported
 * by this table.  **110 is past the knee, and the cover row says why**:
 * sky cover falls with it (0.593 to 0.591 cloudy, 0.290 to 0.287 sunny
 * 17:30) because a stride that short runs the ray out of MAX_ITER before
 * it has crossed the deck.  Shortening the step stops helping exactly when
 * it starts starving the march.
 *
 * **And it costs nothing measurable.**  GPU-synced on this machine, 3.87
 * ms/frame at 450 against 3.77 at 150, both inside the noise of 3.79 with
 * the layer's composite hidden altogether.
 *
 * It also recovers cloud that was never being drawn.  The coarse march
 * *under*-integrated: sky cover goes 0.251 to 0.258 at midday and 0.283 to
 * 0.290 at 17:30, where the rays graze longest and the strides were
 * therefore worst.  That is a more correct integral rather than a drift,
 * so `uDensity` is left where `score.mjs` put it.
 *
 * The whole-sky ratio, x0.82 to x0.90, understates what this does to a
 * frame, and honestly so: most of a sky is near cloud with no artefact in
 * it, and the average is diluted by it.  `capture/p9` is the same drive
 * rendered at 450 and at 150 with everything below the horizon identical
 * to the pixel, and the banded clouds in it are the reason the number is
 * worth having rather than the other way round.
 */
const MAX_STEP = 150;
/**
 * ... and it is overridable, by `?maxstep=N`.
 *
 * `tools/probe/rings.mjs` sweeps it, one page load per value, and the
 * sweep is the only reason the number above is 150 rather than a guess.
 * A constant that cannot be measured against its alternatives is an
 * assertion, and this file does not keep those.
 */
/**
 * ... and the cap once the ray is inside a cloud.
 *
 * A 250 m cumulus nine kilometres away subtends about a degree and a half,
 * which is thirty pixels -- so a 700 m stride through the layer at that
 * distance steps clean over half the clouds near the horizon and draws the
 * rest as a perforated band.  450 in clear air and 190 in cloud.
 */
const IN_CLOUD_STEP = 190;
/* **And since plan_9 it does not bind.**
 *
 * st is clamped to MAX_STEP at both places it grows, and MAX_STEP is now
 * 150, so `st = min( st, cap )` with cap at 190 is a no-op and the march
 * has one stride rather than two.  Left at 190 rather than tidied away
 * because the machinery is still what would happen if MAX_STEP went back
 * up, and because making it bind buys nothing that can be measured: at
 * IN_CLOUD_STEP 90, layering at blur 80 goes 1.258 -> 1.213, 1.664 ->
 * 1.584, 0.605 -> 0.629, 0.587 -> 0.565 across the four probe rows -- three
 * better by a twentieth, one worse by the same, and sky cover a shade
 * down from the extra iterations.  That is noise, and a constant should
 * not be changed on noise. */
const PERSP = 1.03;
const PERSP_K = 0.010;
/** How far a *skip* through empty space may reach, as a fraction of the
 *  distance already travelled.  See the march. */
const SKIP_FAR = 14000;
const MAX_ITER = 72;
/** Steps toward the sun, per lit sample.  See `lightMarch`. */
const LIGHT_STEPS = 5;
/**
 * Octaves of the multiple-scattering approximation.
 *
 * Three was not enough and the reason is in the reference photographs: the
 * inside of a cumulus is *bright*, because light that has scattered four
 * or five times has spread through the mass and is coming out everywhere.
 * A single-scattering model has no way for that to happen and comes out
 * charcoal; each octave here is one more bounce, with its attenuation, its
 * contribution and its phase eccentricity all halved.  three-geospatial
 * ships eight; the sixth here is worth about a percent and the seventh is
 * not measurable, so six.
 */
const MS_OCTAVES = 6;
/** See `update`: the deck's optical depth against the old profile window. */
const DENSITY_SCALE = 0.62;

/**
 * Where the rays go, frame by frame: Halton(2,3), in march texels.
 *
 * Eight rather than sixteen, because a sequence longer than the window it
 * is averaged over never completes: the tail of it is always still
 * arriving while the early terms have already faded out.  Eight inside the
 * sixteen-frame window uAlpha sets means every offset is visited twice
 * before the oldest has decayed, which is the coverage a longer sequence
 * would only promise.
 *
 * The span is a whole march texel, not a whole output pixel.  Half a texel
 * either side of centre is the footprint the half-resolution sample stands
 * for, and covering it is the difference between an accumulation that
 * merely denoises the upsample and one that resolves through it.
 */
const SUBPIXEL = [
  [0.000, -0.167], [-0.250, 0.167], [0.250, -0.389], [-0.375, -0.056],
  [0.125, 0.278], [-0.125, -0.278], [0.375, 0.056], [-0.438, 0.389],
];

const MARCH_FRAG = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  varying vec2 vUv;

  uniform vec3 uCamPos;
  uniform mat4 uInvVP;
  uniform vec3 uSunDir, uSunCol, uAmbient, uHaze;
  uniform float uBase, uTop, uDensity, uRainVisible, uNight, uCirrus;
  uniform float uShapeBias, uShapeAmt, uDetailAmt, uScatter;
  uniform sampler3D uNoise3, uDetail3;
  /** Sub-pixel offset of this frame's rays, in NDC.  See SUBPIXEL. */
  uniform float uMaxStep;
  uniform vec2 uJitter;
  /** Frame index, for the temporal turn of the dither below. */
  uniform float uFrame;

  ${CLOUD_PARS}

  /* An ordered dither, **turned over time**.
   *
   * The march has to start at a jittered offset or its steps show as
   * concentric bands across the sky.  A per-pixel hash does that -- and at
   * half resolution it also puts white noise on every cloud edge, which
   * the upsample then smears into a speckled fringe.  A 4x4 Bayer pattern
   * breaks the banding just as well and is *structured*, so what the
   * upsample sees is a texture rather than noise.
   *
   * **That last sentence was true of a still frame and false of a moving
   * one, and it is the bug this pass exists to fix.**  Indexed by
   * gl_FragCoord alone the pattern is pinned to the screen and identical
   * every frame, so as the sky slides across it each pixel holds a fixed
   * threshold while the geometry sweeps through it.  The eye locks onto
   * regular structure in motion where it would average away speckle, so
   * *structured* is the worse of the two choices the moment the camera
   * moves -- an 8x8 screen-pixel crosshatch crawling along every cloud
   * edge, worst near the horizon where the step is 190 m through a 250 m
   * cumulus and the dither is modulating nearly the whole alpha.
   *
   * The additive golden-ratio term is what makes it a *sample sequence*
   * rather than a pattern: 0.618 is the most irrational rotation of the
   * unit interval, so sixteen Bayer values turned by it land as far apart
   * as consecutive frames can be made to land, and the sixteen-frame
   * window the resolve integrates over sees a near-uniform spread of start
   * offsets.  The pattern is still there in any single frame.  It is no
   * longer there in what anybody looks at. */
  float bayer2( vec2 a ) { a = floor( a ); return fract( a.x / 2.0 + a.y * a.y * 0.75 ); }
  float bayer4( vec2 a ) { return bayer2( 0.5 * a ) * 0.25 + bayer2( a ); }

  /** Rescale v from [lo,hi] into [0,1], clamped.  The whole cloud model is
   *  written in these: an erosion is a remap of the density into what is
   *  left after the noise has bitten, which keeps the *core* at full value
   *  and eats only the edge.  A subtraction, which is what this used to
   *  do, thins the middle by exactly as much as the edge and reads as
   *  fog. */
  float remap01( float v, float lo, float hi ) {
    return clamp( ( v - lo ) / max( 1e-5, hi - lo ), 0.0, 1.0 );
  }

  /** The two volumes, in world metres.  Hardware trilinear, hardware wrap. */
  float shapeVol( vec3 p ) { return texture( uNoise3, p / ${NOISE_SCALE.toFixed(1)} ).r; }
  float detailVol( vec3 p ) { return texture( uDetail3, p / ${DETAIL_SCALE.toFixed(1)} ).r; }

  /**
   * How wide a cloud is at this fraction of its height, 0..1.
   *
   * three-geospatial's shapeAlteringFunction, and it is the single line
   * that stops the layer being a slab.  A biased height fraction through a
   * semicircle: zero at the base, zero at the top, one at the widest
   * slice -- and the bias moves that slice *down*, because a cumulus is
   * widest just above its base and everything above that is narrowing.
   * At 0.35 the waist sits at 14 % of the deck's height, so the bottom
   * eighth flares fast and the remaining seven eighths taper, which is the
   * cauliflower profile and it comes out of the *shape* rather than out of
   * the noise.
   */
  float heightScale( float hf ) {
    float b = pow( hf, uShapeBias );
    float x = clamp( b * 2.0 - 1.0, -1.0, 1.0 );
    /* **Broadened, not flattened.**  The bare semicircle is at full width
     * at exactly one height, so a cloud is at its nominal coverage on a
     * surface of measure zero and is narrower everywhere else -- which
     * cost the layer a quarter of its cover (sky cover ran 0.66 to 0.76 of
     * w.cloud across the four weathers at a correlation of exactly 1.000,
     * so it was a scale error and not a shape one).
     *
     * Clamping a scaled semicircle fixes the cover and introduces a worse
     * problem: a flat top on the width profile is a *shelf*, a slab of
     * cloud at one height with narrower cloud above and below it, and a
     * sky of those reads as pancakes.  A fractional power broadens the
     * peak without ever making it flat, so the widest slice is still a
     * single height and the cloud still has a waist. */
    return pow( 1.0 - x * x, 0.6 );
  }

  /**
   * Is there cloud here, and how far up it are we -- from two texture
   * reads and no volume at all.
   *
   * Splitting this out of the density is what makes the empty-space skip
   * possible, and the skip is what pays for a march long enough to resolve
   * the far sky.  In a fair-weather sky most samples end here.
   */
  float coverage( vec3 p, out float hf ) {
    vec3 f = cloudRaw3( p.xz );
    /* The base, and why it is not a plane.
     *
     * A cloud base at a constant altitude is a *plane*, and a plane seen
     * at a grazing angle projects to a ruled horizontal line -- so every
     * cloud underside near the horizon came to a straight edge.  Two
     * fields hang it now: the blurred coverage channel, which correlates
     * the heavier masses with a lower base, and the shape channel, which
     * gives each individual cloud its own bottom a hundred metres either
     * side of the deck.  Reference photographs have exactly that: a common
     * base level that no two clouds sit on precisely. */
    /* Half of what it was: the undulation used to move the base by 360 m
     * either way, against a deck that is now 550 thick, so the layer as a
     * whole was twice as deep as any cloud in it -- which is the same
     * grazing-angle wall by another route. */
    float base = uBase - ( f.y - 0.5 ) * 220.0 - ( f.z - 0.5 ) * 160.0;
    /* **And no two clouds are the same height**, which matters far more
     * than it sounds.
     *
     * A deck of constant thickness seen at a grazing angle is a wall: at
     * six degrees of elevation a ray travels twelve kilometres inside the
     * layer, and if every cloud in the field spans the whole of it then
     * the ray passes through the waist of every cloud it meets and the sky
     * above the horizon marches out solid.  It did, and next_5.md called
     * this the largest remaining gap.
     *
     * Real cumulus fields are not like that: the tops are at every height
     * between a few hundred metres and the inversion, so a shallow ray
     * goes *over* most of them and through the tall ones.  One tap of the
     * shape channel, which is already here, gives each cloud its own top
     * between two fifths and all of the deck -- and because the base is
     * hung off the same fields, a cloud with a low base is not
     * automatically a tall one. */
    float thick = ( uTop - uBase ) * mix( 0.38, 1.0, smoothstep( 0.28, 0.68, f.z ) );
    hf = ( p.y - base ) / thick;
    if ( hf <= 0.0 || hf >= 1.0 ) return 0.0;

    /* **The cut moves with height.**  See uShapeCutTop in cloudfield.js:
     * one threshold on one scalar field gives a family of nested
     * silhouettes whose widest member is the one w.cloud is calibrated
     * against, so the sky fraction is preserved and everything above and
     * below the waist gets narrower -- which is a cloud, rather than an
     * extruded outline with a lid on it. */
    float cut = mix( uShapeCutTop, uShapeCut, heightScale( hf ) );
    return smoothstep( cut - uCloudSoft, cut + uCloudSoft, cloudShape( f ) );
  }

  /**
   * Density at a point, given its coverage and height fraction.
   *
   * **Where the weather is** is .x of the shared field, at 2-6 km, and
   * nothing about that has changed: it is the same number the ground
   * shadow, the rain and the quantile table read, so a cloud you can see
   * is still the cloud whose shadow you drive through.
   *
   * **What the cloud looks like** is .z, at about 730 m, cut inside the
   * coverage so one weather cell becomes three or four cumulus.
   *
   * **What it is made of** is the two Worley volumes.  The shape volume
   * erodes the silhouette into billows; the detail volume takes the fringe
   * off, and only above the waist -- a cumulus is ragged where it is
   * growing and flat where it is condensing, so the bottom fifth is left
   * alone and gets the flat base every photograph in ref/cloud has.
   *
   * det is how much fringe to take off, and it is a number rather than a
   * flag because it has to **fade out with distance**.  The detail volume
   * repeats every 700 m and its finest crease is about ninety metres
   * across, while the march's step is 55 m at the camera and 700 at the
   * far end -- so beyond a few kilometres it is being sampled far under
   * its Nyquist rate and what it adds is not fringe but noise.  It showed
   * as a dark speckle along every lit edge.  The light march passes zero:
   * it calls this five times per lit sample and cannot see the difference.
   */
  float density( vec3 p, float c, float hf, float det ) {
    /* Erosion as a remap: the core keeps its value and the edge is eaten.
     * See remap01. */
    float d = remap01( c, ( 1.0 - shapeVol( p ) ) * uShapeAmt, 1.0 );
    if ( d <= 0.0 ) return 0.0;

    if ( det > 0.01 ) {
      float g = detailVol( p );
      /* Wisps above, a solid base below: g^6 is nearly zero nearly
       * everywhere, so the bottom of the cloud is barely touched, while
       * 1 - g is all crease and takes the top apart. */
      float m = mix( g * g * g * g * g * g, 1.0 - g, remap01( hf, 0.2, 0.42 ) );
      d = remap01( d * 2.0, m * det * 0.5, 1.0 );
      if ( d <= 0.0 ) return 0.0;
    }

    /* And the vertical density profile: thin where it is condensing, thick
     * where it has risen.  three-geospatial's default layer profile, which
     * is linear. */
    return d * ( 0.25 + 0.75 * hf );
  }

  /**
   * How much cloud lies between here and the sun.
   *
   * Five steps at a geometrically growing stride -- 60 m at the first and
   * 630 at the last, reaching 1.6 km, which is more than the layer is
   * thick.  It replaces a single tap of the *coverage* field, which could
   * only ever say "is there a cloud over there", not "how much of one is
   * in the way", so every cloud came out one flat cream value with no
   * top-to-bottom gradient at all.  Measured on the old build, the ratio
   * between the brightest tenth and the darkest tenth of one cloud's own
   * pixels was **1.08**; ref/cloud/day_cloud_1.jpg is 2.4.
   */
  float lightMarch( vec3 p ) {
    float t = 0.0, sum = 0.0, st = 60.0;
    for ( int i = 0; i < ${LIGHT_STEPS}; i++ ) {
      t += st;
      vec3 q = p + uSunDir * t;
      float hf;
      float c = coverage( q, hf );
      if ( c > 0.003 ) sum += density( q, c, hf, 0.0 ) * st;
      st *= 1.9;
    }
    return sum;
  }

  /** Henyey-Greenstein, normalised so an isotropic lobe is 1. */
  float hg( float mu, float g ) {
    float g2 = g * g;
    return ( 1.0 - g2 ) / pow( 1.0 + g2 - 2.0 * g * mu, 1.5 );
  }

  /**
   * The light that reaches a sample, with two things a one-tap version
   * could not have.
   *
   * **Two phase lobes.**  A strong forward lobe and a weak backward one is
   * what puts the bright rim on the sun side of a cloud at golden hour and
   * the halo around the sun through a thin one -- both plainly there in
   * ref/cloud/golden_hour_cloud_2.jpg and both entirely absent before.
   * The pair is three-geospatial's: 0.7 forward against -0.2 back, mixed
   * evenly, which is a little less peaked than the 0.82 this used and
   * survives six octaves of attenuation without going flat.
   *
   * **Six octaves of multiple scattering.**  Attenuation, contribution and
   * eccentricity each halve per octave.  Without it a real light march
   * makes thick cloud far too dark -- the classic failure of a first
   * implementation -- because a single-scattering model has no way for
   * light to get *into* a mass and bounce.
   */
  vec3 lightEnergy( float toSun, float mu, float powder ) {
    float att = 1.0, contrib = 1.0, ecc = 1.0;
    float e = 0.0;
    for ( int i = 0; i < ${MS_OCTAVES}; i++ ) {
      float beer = exp( -toSun * uDensity * att );
      float ph = mix( hg( mu, -0.2 * ecc ), hg( mu, 0.7 * ecc ), 0.5 );
      e += contrib * beer * ph;
      att *= 0.5; contrib *= 0.5; ecc *= 0.5;
    }
    /* **Normalised by the octaves' own weights**, and it is not optional.
     *
     * Going from three octaves to six adds about 12 % of contribution and
     * changes the phase pair to a less peaked one, which at side-lit
     * angles is another 60 % -- so the first build of this came out with
     * a sky of blown-out white where the reference photographs have cloud
     * tops at about 240.  Dividing by the sum of the contributions makes the octave
     * count a statement about how far light spreads inside a cloud rather
     * than about how bright the sky is, which is what it should have been
     * all along; uScatter is then one honest exposure knob. */
    return uSunCol * e * uScatter * ( 0.32 + 0.68 * powder );
  }

  void main() {
    /* The ray, from the inverse view-projection.  Two unprojections rather
     * than one plus the camera position, because the near plane is 0.4 m
     * and the difference of two nearly equal large numbers is not a
     * direction. */
    /* ... and offset by a sub-pixel amount that moves every frame, which
     * is the other half of what the resolve is for.  A half-resolution
     * buffer whose texel centres never move samples the same 25 % of the
     * screen for ever and the other 75 % is interpolation; moved by a
     * different fraction of an output pixel each frame, the same buffer
     * covers all of it, and the history the resolve keeps is at the *full*
     * resolution those samples land in.  So the half-res march stops
     * costing sharpness as well as stopping the crawl -- the smear was the
     * second of the two things reported, and this is the line that
     * removes it. */
    vec2 ndc = vUv * 2.0 - 1.0 + uJitter;
    vec4 a = uInvVP * vec4( ndc, -1.0, 1.0 );
    vec4 b = uInvVP * vec4( ndc, 1.0, 1.0 );
    vec3 dir = normalize( b.xyz / b.w - a.xyz / a.w );
    float mu = dot( dir, uSunDir );

    vec3 col = vec3( 0.0 );
    float T = 1.0;
    float jitter = fract( bayer4( gl_FragCoord.xy ) + uFrame * 0.6180339887 );

    /* --- rain shafts, under the base ------------------------------- *
     * Sampled once, at the height where a curtain reads, rather than
     * marched: a shaft is a smooth vertical gradient and marching it buys
     * nothing.  This goes *behind* the cloud, which is where it is. */
    if ( uRainVisible > 0.001 && dir.y > 0.004 ) {
      float tS = ( uBase * 0.45 ) / dir.y;
      if ( tS < MAX_DIST_F ) {
        vec2 sp = uCamPos.xz + dir.xz * tS;
        float veil = cloudRain( sp ) * uRainVisible
          * smoothstep( 0.004, 0.05, dir.y ) * ( 1.0 - smoothstep( 0.16, 0.42, dir.y ) );
        vec3 vc = mix( uHaze, uAmbient, 0.35 );
        col += vc * veil * 0.55;
        T *= 1.0 - veil * 0.55;
      }
    }

    /* --- cirrus, above everything ----------------------------------- *
     * A third of why a fair-weather sky reads as deep is the thin high
     * stuff above the cumulus -- ref/cloud/day_cloud_3.jpg is full of
     * it.  One stretched tap of the shape channel at 7 km, composited
     * before the cumulus so it can never put a rim on anything, and no
     * extra sheet: the seam that cost iteration 4 a week came from sheets,
     * and this is a sample inside the same march. */
    if ( uCirrus > 0.001 && dir.y > 0.17 ) {
      /* **Only well above the horizon**, and that is not a taste call.
       * A sheet at a constant altitude is a plane, and the distance to a
       * plane goes as 1/sin(elevation): at two degrees a 7 km deck is
       * two hundred kilometres away, so the sample positions fan out
       * radially from the zenith and the veil draws as a sunburst of
       * streaks converging on a point.  It did, on the first build of
       * this.  Above ten degrees the fan is mild and the cap never
       * binds. */
      float tC = min( ${CIRRUS_ALT.toFixed(1)} / dir.y, 26000.0 );
      vec2 cp = uCamPos.xz + dir.xz * tC;
      /* Stretched about 3:1 and turned thirty degrees off the world axes,
       * because wind shear does not run along X.  It was 5:1, which at
       * this altitude drew as scratches rather than as fibres. */
      vec2 q = vec2( cp.x * 0.866 - cp.y * 0.5, cp.x * 0.5 + cp.y * 0.866 );
      /* Two fibres at different combings rather than one, mixed rather
       * than thresholded.  The single 5:1 stretch through a hard
       * smoothstep drew as *scratches*: a threshold on a stretched field
       * gives long thin components with hard ends, and hard ends on a
       * 60 m-wide streak across a blue sky is exactly what a scratch on a
       * lens looks like.  Cirrus has no edges -- it is ice falling out of
       * a shear layer and it fades out along its own length. */
      float f1 = cloudRaw3( vec2( q.x * 0.30, q.y * 1.05 ) ).z;
      float f2 = cloudRaw3( vec2( q.x * 1.10, q.y * 0.34 ) + 91.0 ).z;
      float fib = f1 * 0.68 + f2 * 0.32;
      /* Broken by the coarse channel as well, so a cirrus sky has patches
       * of clear in it rather than being one combed sheet. */
      float veil = smoothstep( 0.44, 0.86, fib ) * smoothstep( 0.36, 0.62, cloudRaw3( cp * 0.5 ).x )
        * uCirrus * smoothstep( 0.17, 0.50, dir.y );
      /* **And cirrus is brighter than the sky it is drawn on, not
       * greyer.**  It was mixed 55 % of the way from haze toward a dim sum
       * of sun and ambient, which at the zenith on a clear day is *darker*
       * than the blue behind it -- so the veil read as smoke.  Ice cloud
       * at 7 km is lit by the unattenuated sun and is the brightest thing
       * in a daytime sky after the sun itself. */
      vec3 cc = uSunCol * 0.82 + uAmbient * 0.35;
      col += cc * veil * 0.34;
      T *= 1.0 - veil * 0.34;
    }

    if ( dir.y > 0.010 ) {
      /* Enter below the *lowest* base the undulation can produce, and
       * leave at the top -- both measured from the camera's own altitude,
       * because uBase and uTop are heights above the ground and the ground
       * is not always at zero. */
      float t0 = max( 0.0, ( uBase - 240.0 - uCamPos.y ) / dir.y );
      float t1 = min( ( uTop - uCamPos.y ) / dir.y, MAX_DIST_F );
      if ( t1 > t0 ) {
        /* The step schedule.  See MIN_STEP above. */
        float st = ${MIN_STEP.toFixed(1)} + ${PERSP_K.toFixed(4)} * t0;
        /* The cap on the step, which is MAX_STEP in clear air and much
         * shorter once the ray is inside something.  Without it a ray that
         * has skipped MAX_STEP of nothing carries that stride into the
         * cloud it just found and integrates it in three or four slices,
         * which draws as **horizontal layers**: the step boundaries are
         * surfaces in space, they are level surfaces (see MAX_STEP), so
         * neighbouring pixels quantise at the same heights and what should
         * be a rounded top comes out as a stack of plates.
         *
         * **It is lowered one sample too late, and that is the whole
         * artefact.**  Nothing knows there is cloud here until a sample
         * says so, and by then the stride that found it has already been
         * committed to.  Two ways to close that gap were built and both
         * lost to simply shortening the stride: bisecting back to the
         * cloud's boundary, and rewinding to the last empty distance and
         * walking in at IN_CLOUD_STEP.  The rewind is the instructive
         * failure -- it is *correct*, in that the alpha comes out right
         * and it recovers the cloud the coarse march was missing, and it
         * made the layering worse at every stride tried, because entering
         * at tPrev + k*IN_CLOUD_STEP off a coarsely quantised tPrev is a
         * *cleaner* lattice than the ragged arrival it replaced.
         * Sharpening a lattice is not dissolving it.
         *
         * That comparison is directional only: it was run before the
         * same-page sweep was found to be measuring a different sky every
         * row (plan_9.md 3.1), so the ordering held across all six strides
         * but the numbers under it are not quotable.  Shortening the
         * stride won by enough that re-running it was not worth the
         * rewind's hundred lines.  plan_9.md 2 has both. */
        float cap = uMaxStep;
        float t = t0 + st * jitter;
        for ( int i = 0; i < ${MAX_ITER}; i++ ) {
          if ( t > t1 || T < 0.02 ) break;
          st = min( st, cap );
          /* **Sampled at a jittered midpoint of the interval it stands
           * for**, rather than at its near edge.  Offsetting the sample by
           * (jitter - 0.5) of a step is unbiased -- the interval it
           * integrates is unchanged -- and it turns the one remaining
           * source of rings, the quantised entry into a distant cloud,
           * into a dither that the half-resolution upsample resolves into
           * a soft edge. */
          vec3 p = uCamPos + dir * ( t + st * ( jitter - 0.5 ) );
          float hf;
          float c = coverage( p, hf );
          if ( c <= 0.003 ) {
            cap = uMaxStep;
            /* Empty: jump.  Near the camera a cloud is large on screen and
             * a doubled step is invisible; far away the whole deck is a
             * few pixels tall and MAX_STEP is still under a pixel of
             * error.  This is the line that buys the long march. */
            st = min( st * ${PERSP.toFixed(3)}, uMaxStep );
            t += mix( st * 2.0, uMaxStep,
                      clamp( t / ${SKIP_FAR.toFixed(1)}, 0.0, 1.0 ) );
            continue;
          }
          cap = ${IN_CLOUD_STEP.toFixed(1)};
          /* The fringe, faded out before it starts aliasing.  See density. */
          float d = density( p, c, hf,
                             uDetailAmt * ( 1.0 - smoothstep( 2500.0, 9000.0, t ) ) );
          if ( d > 0.002 ) {
            /* Powder: the dark edge a cloud has where it is thin and lit
             * from behind.  One line, and it is most of what separates a
             * raymarch from a fog volume. */
            float powder = 1.0 - exp( -d * 7.0 );
            vec3 lit = lightEnergy( lightMarch( p ), mu, powder );
            /* And the ambient falls off *downwards*, which is what gives
             * the layer a ceiling.
             *
             * Sky light reaches the top of a deck and not the bottom of
             * it; scaling the ambient by depth is the cheapest way to say
             * so, and it is the difference between a ceiling and a wash.
             * 0.42, not 0.26: a cumulus base is grey-blue, not charcoal --
             * it is lit by the whole lower hemisphere, sky all round it
             * and ground under it, and only the sun is blocked. */
            float up = ( uTop - p.y ) / ( uTop - uBase );
            lit += uAmbient * mix( 1.0, 0.42, clamp( up, 0.0, 1.0 ) );
            float alpha = 1.0 - exp( -d * st * uDensity );
            /* Aerial perspective, and it is not decoration -- it is what
             * stops the march's own distance limit from being visible.
             *
             * A ray that leaves the slab beyond MAX_DIST is simply cut
             * off, and a cut-off column of cloud projects to a straight
             * line.  Fading cloud into the haze over the last two thirds
             * of the march means there is nothing left to cut off -- and
             * it is also simply true, since a cloud thirty kilometres away
             * *is* haze. */
            float far = 1.0 - smoothstep( FADE_FROM_F, MAX_DIST_F, t );
            lit = mix( uHaze, lit, far );
            alpha *= far;
            col += lit * alpha * T;
            T *= 1.0 - alpha;
          }
          st = min( st * ${PERSP.toFixed(3)}, uMaxStep );
          t += st;
        }
      }
    }

    /* Into the haze at the horizon, which is what makes the layer *meet*
     * the sky instead of ending at it -- and is the other half of not
     * having a seam.
     *
     * **The alpha has to reach zero at the same angle the march stops
     * at**, and the first version did not: it faded to 0.45 while the
     * march below 0.012 contributed nothing, so there was a hard step from
     * 0.45 to 0 straight across the sky at that elevation.  With the far
     * field nearly constant along a grazing ray, what that produced was
     * pale rectangles either side of the horizon with hard horizontal
     * edges -- which looked uncannily like the sheets this replaced, and
     * were reported as exactly that. */
    float low = 1.0 - smoothstep( 0.010, 0.19, dir.y );
    float a2 = ( 1.0 - T );
    col = mix( col, uHaze * a2, low * 0.85 );
    gl_FragColor = vec4( col, a2 * ( 1.0 - low ) );
  }
`.replace(/MAX_DIST_F/g, MAX_DIST.toFixed(1))
 .replace(/FADE_FROM_F/g, FADE_FROM.toFixed(1));

const MARCH_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/* ------------------------------------------------------------------ *
 * The resolve: reproject, clamp, blend.
 *
 * The march above now produces a *different* estimate every frame -- a
 * different dither offset, a different sub-pixel ray -- and on its own
 * that is worse than what it replaced: it trades a crawling pattern for
 * per-pixel flicker.  The two go together or not at all.  This pass is the
 * other half: it holds the last sixteen frames' worth of estimates and blends
 * the new one into them, so what reaches the screen is the *mean* of a
 * well-spread sample sequence rather than any one member of it.
 *
 * **Reprojection without a depth buffer.**  A cloud has no surface, so
 * there is no depth to reproject against, and the usual answer -- write
 * the transmittance-weighted mean distance to a second attachment -- costs
 * an MRT and a float target for a number this scene does not need to know
 * accurately.  What it needs is the *parallax*, and the parallax is
 * dominated by the geometry we already have: the ray's own intersection
 * with the middle of the deck.  A pixel looking at the zenith is looking
 * at cloud 1475 m away and gets 1475; a pixel near the horizon is looking
 * at cloud a long way off and gets the clamp, which is right, because at
 * that angle the layer really is effectively at infinity.
 *
 * The error that leaves is the difference between the true distance and
 * the deck's mid-height along that ray, and at 25 m/s and 60 fps that is
 * worth well under a tenth of a pixel per frame even overhead, where the
 * parallax is largest.  Reprojecting at infinity instead -- rotation only,
 * which is what a sky box would do -- costs about a third of a pixel a
 * frame overhead, which the clamp below would absorb too.  This is two
 * lines more and removes the question.
 *
 * **Variance clipping, not a min/max box.**  The neighbourhood is the only
 * thing standing between a slow accumulation and smeared ghosts trailing
 * every cloud, and a hard min/max of the 3x3 is both too tight (it does
 * not span the 4x4 dither's period, so it clamps the converged value back
 * toward the noise it just removed) and too loose where one bright sample
 * widens it. The first and second moments give a box that follows the
 * local *dither amplitude*, which is exactly the quantity the history is
 * allowed to differ by: wide on a fringe where the estimate is genuinely
 * uncertain, narrow in a core where it is not.
 * ------------------------------------------------------------------ */
const RESOLVE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D tCurr;    /* this frame's march, half resolution */
  uniform sampler2D tHist;    /* the accumulation, full resolution */
  uniform mat4 uInvVP;        /* this frame's, un-jittered */
  uniform mat4 uPrevVP;       /* the frame the history was resolved at */
  uniform vec3 uCamPos;
  uniform vec2 uMarchTexel;   /* 1 / the march buffer's size */
  uniform vec2 uJitterUv;     /* this frame's sub-pixel offset, in uv */
  uniform float uMidY;        /* world height of the middle of the deck */
  uniform float uAlpha;       /* how much of the new estimate to take */
  uniform float uGamma;       /* half-width of the clip box, in sigmas */
  uniform float uValid;       /* 0 on the first frame and after a resize */

  void main() {
    /* The march texel this output pixel's ray was actually traced at.  The
     * jitter moved the ray, so it has to move the fetch back, or the
     * sub-pixel offset would read as the whole image shivering. */
    vec2 cuv = vUv - uJitterUv;
    vec4 curr = texture2D( tCurr, cuv );

    /* The 3x3 around it, for the clip box and for nothing else. */
    vec4 m1 = vec4( 0.0 ), m2 = vec4( 0.0 );
    for ( int y = -1; y <= 1; y++ ) {
      for ( int x = -1; x <= 1; x++ ) {
        vec4 s = texture2D( tCurr, cuv + vec2( float( x ), float( y ) ) * uMarchTexel );
        m1 += s; m2 += s * s;
      }
    }
    vec4 mu = m1 / 9.0;
    vec4 sigma = sqrt( max( vec4( 0.0 ), m2 / 9.0 - mu * mu ) );

    /* Where this pixel was looking, last frame.  See the header. */
    vec2 ndc = vUv * 2.0 - 1.0;
    vec4 pa = uInvVP * vec4( ndc, -1.0, 1.0 );
    vec4 pb = uInvVP * vec4( ndc, 1.0, 1.0 );
    vec3 dir = normalize( pb.xyz / pb.w - pa.xyz / pa.w );
    float t = clamp( ( uMidY - uCamPos.y ) / max( dir.y, 1e-3 ),
                     0.0, ${MAX_DIST.toFixed(1)} );
    vec4 pp = uPrevVP * vec4( uCamPos + dir * t, 1.0 );
    vec2 prevUv = ( pp.xy / pp.w ) * 0.5 + 0.5;

    /* Off the edge of last frame is not history, it is the first sight of
     * a piece of sky, and the only honest thing to show is this frame's
     * estimate at full weight.  A branch and not a weight of 1.0, because
     * mix() at 1.0 still multiplies the history by zero and zero times an
     * uninitialised NaN is a NaN -- the first frame after a resize reads a
     * buffer nothing has written yet. */
    bool onScreen = pp.w > 0.0
      && all( greaterThanEqual( prevUv, vec2( 0.0 ) ) )
      && all( lessThanEqual( prevUv, vec2( 1.0 ) ) );
    if ( !onScreen || uValid < 0.5 ) { gl_FragColor = curr; return; }

    vec4 hist = clamp( texture2D( tHist, prevUv ),
                       mu - uGamma * sigma, mu + uGamma * sigma );
    gl_FragColor = mix( hist, curr, uAlpha );
  }
`;

/* The composite.  Depth exactly 1.0 -- see the header. */
const COMP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 1.0, 1.0 );
  }
`;

const COMP_FRAG = /* glsl */ `
  uniform sampler2D tCloud;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D( tCloud, vUv );
    if ( gl_FragColor.a < 0.002 ) discard;
  }
`;

/** Scratch: the white a cloud top is lit by.  See `update`. */
const _white = new THREE.Color(1, 1, 1);

export class Clouds {
  /**
   * @param {THREE.Scene} scene
   * @param {number} scale  fraction of the render target to march at
   * @param {boolean} temporal  accumulate over frames.  Off is the
   *   pre-`plan_8` layer, kept because it is what the crawl looks like and
   *   because a probe that wants one frame's honest estimate should not be
   *   handed sixteen frames' mean of it.
   * @param {number} maxStep  the march's longest stride.  `?maxstep=450`
   *   is the pre-`plan_9` layer, i.e. what the horizontal layering looks
   *   like.  Swept by `rings.mjs`.
   * @param {number} history  fraction of the render target the history is
   *   kept at.  1 is the resolve as designed; `core/quality.js` takes it to
   *   a half on integrated graphics, where the resolve's nine-tap clip box
   *   over every pixel of a supersampled frame is a cost in its own right.
   */
  constructor(scene, { scale = 0.5, field = null, temporal = true,
                       maxStep = MAX_STEP, history = 1 } = {}) {
    this.maxStep = maxStep;
    this.scale = scale;
    this.history = history;
    this.temporal = temporal;
    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });

    /* The history, ping-ponged, at the *output* resolution rather than the
     * march's -- see `RESOLVE_FRAG`.  Half float and not bytes, because an
     * eight-bit accumulator cannot move at all until the gap it is closing
     * exceeds 0.5/(255*uAlpha), which at 0.06 is a little over 8/255 --
     * so it converges to within three percent of the answer and stops: the
     * classic stalled-TAA fringe, a converged image everywhere except the
     * few pixels that needed the last one percent.  `post.js` already
     * renders the whole scene into half float, so this asks nothing new of
     * the machine. */
    this.hist = this.temporal ? [0, 1].map(() => new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
    })) : null;
    this.cur = 0;
    /** Nothing to reproject against yet.  Set by `reset`. */
    this._valid = false;
    this._frame = 0;
    this._drawn = -1;

    this.mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uCamPos: { value: new THREE.Vector3() },
        uInvVP: { value: new THREE.Matrix4() },
        uMaxStep: { value: maxStep },
        uJitter: { value: new THREE.Vector2() },
        uFrame: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uAmbient: { value: new THREE.Color(0.5, 0.55, 0.6) },
        uHaze: { value: new THREE.Color(0.8, 0.85, 0.9) },
        uBase: { value: BASE },
        uTop: { value: TOP },
        uDensity: { value: 0.011 },
        uRainVisible: { value: 0 },
        uNight: { value: 0 },
        uCirrus: { value: 0 },
        /* The two erosion volumes, taken from the field rather than
         * declared in `CLOUD_UNIFORMS`: that block is injected into every
         * lit material in the scene, and the ground has no use for a
         * `sampler3D`. */
        uNoise3: { value: field ? field.noise3 : null },
        uDetail3: { value: field ? field.detail3 : null },
        /** Where the widest slice of a cloud sits.  See `heightScale`. */
        uShapeBias: { value: 0.35 },
        /** How deep the shape volume bites.  1.0 is "a gap in the Worley
         *  field removes the cloud entirely", which is what makes the
         *  billows read as separate lumps rather than as dents. */
        uShapeAmt: { value: 1.0 },
        /** ... and the fringe.  Less, because it is eight times finer and
         *  a fringe that eats as deep as the shape leaves lace. */
        uDetailAmt: { value: 0.72 },
        /**
         * The exposure of the scattering sum.  See `lightEnergy`.
         *
         * 1 / (sum of the six contributions) is 0.508 and would be the
         * neutral value; measured against `ref/cloud/day_cloud_3.jpg` the
         * value EMD is flattest a little under that, because the reference
         * photograph has a sky in it as well as clouds and its bright
         * quartile is not saturated.
         */
        uScatter: { value: 0.46 },
      }, CLOUD_UNIFORMS),
      vertexShader: MARCH_VERT,
      fragmentShader: MARCH_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);

    this.resolveMat = this.temporal ? new THREE.ShaderMaterial({
      uniforms: {
        tCurr: { value: this.rt.texture },
        tHist: { value: null },
        uInvVP: { value: new THREE.Matrix4() },
        uPrevVP: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uMarchTexel: { value: new THREE.Vector2() },
        uJitterUv: { value: new THREE.Vector2() },
        uMidY: { value: (BASE + TOP) * 0.5 },
        /**
         * A sixteen-frame window, and it is worth more than it looks.
         *
         * Sixteen rather than the eight the dither's period would suggest,
         * because the pattern is not the only thing the average is
         * fighting.  The march's step schedule leaves **contour rings** on
         * a far cloud -- the artefact `MAX_STEP` and `IN_CLOUD_STEP` exist
         * to fight and do not win outright -- and until this iteration the
         * dither was *hiding* them: a crosshatch over a banded cloud reads
         * as one texture, and taking the crosshatch away puts the bands in
         * focus.  Anyone who fixes the crawl and stops here has traded a
         * pattern for a different pattern, which is not a fix.
         *
         * A longer average takes some of that back.  Measured as the
         * vertical second difference of alpha over the sky band, on the
         * flanks where a ring lives (0.05 < alpha < 0.95), sunny at 10:00,
         * x1000:
         *
         *     alpha   0.12    0.06    0.03
         *     rings   7.93    5.54    4.16
         *
         * ... and what a longer window normally costs -- the history
         * lagging behind the picture -- it does not cost here.  Matching
         * each frame's history against the last seven marches, the best
         * match is the *current* one at every setting tried, and the next
         * frame back is already 29 % worse: the reprojection anchors the
         * average to the sky rather than to the screen, so a longer
         * average is a better estimate of the same instant and not a
         * blurrier estimate of an older one.
         *
         * **But it does not finish the job**, and it cannot: the bands
         * survive at 0.12, at 0.06, and with the clip box opened all the
         * way, which between them rule out both the window length and the
         * clamp.  What is left is not variance, and no amount of averaging
         * removes it -- the mean of a biased estimator is the bias.  That
         * one belongs to the march's stride and `plan_9` fixed it there;
         * see MAX_STEP.
         *
         * Two things that comment corrects, since this one asserted them:
         * the cause is *not* the empty-space skip being discontinuous in
         * where a ray finds density, it is the stride that found the cloud
         * also being the stride its first slab is integrated with; and the
         * fix does *not* cost frame time.  It costs nothing measurable.
         */
        uAlpha: { value: 0.06 },
        /**
         * The clip box, in standard deviations of the local 3x3.
         *
         * 1.75 rather than the 1.0 the variance-clipping papers use for
         * opaque geometry, because the 3x3 is smaller than the 4x4
         * dither's period and therefore under-estimates the spread of
         * values the march can legitimately produce at a pixel.
         *
         * It is nearly idle either way -- see `uAlpha` for the measurement
         * -- and that is the point of keeping it rather than an argument
         * for dropping it: what it is there for is the case the drive does
         * not exercise, a cloud edge sweeping across a pixel fast enough
         * that the reprojection cannot follow it.  A clamp that never
         * fires during normal driving and catches the one frame that needs
         * it is a clamp that is set correctly.
         */
        uGamma: { value: 1.75 },
        uValid: { value: 0 },
      },
      vertexShader: MARCH_VERT,
      fragmentShader: RESOLVE_FRAG,
      depthTest: false, depthWrite: false,
    }) : null;
    this.resolveQuad = this.resolveMat ? new FullScreenQuad(this.resolveMat) : null;

    this.composite = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { tCloud: { value: this.rt.texture } },
        vertexShader: COMP_VERT,
        fragmentShader: COMP_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        fog: false,
      }));
    this.composite.frustumCulled = false;
    /* After the moon (-890) and the stars (-900), before everything that
     * is really in the world. */
    this.composite.renderOrder = -880;
    scene.add(this.composite);

    this._vp = new THREE.Matrix4();
    this._prevVP = new THREE.Matrix4();
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(2, Math.round(w * this.scale)),
                    Math.max(2, Math.round(h * this.scale)));
    if (this.hist) {
      const hw = Math.max(2, Math.round(w * this.history));
      const hh = Math.max(2, Math.round(h * this.history));
      for (const rt of this.hist) rt.setSize(hw, hh);
      /* Resizing a render target reallocates it, so the history is now
       * two frames of undefined memory reprojected against a projection
       * matrix that has also just changed.  Both are gone next frame
       * anyway; saying so explicitly is one line and saves a flash. */
      this.reset();
    }
  }

  /**
   * Forget the history.
   *
   * The next frame is then shown at full weight and the accumulation
   * starts again from it.  There is no cut in this project that needs it
   * -- the scrub runs the sun as a lapse rather than teleporting it, which
   * is exactly the property that lets the clamp follow a sunset -- but a
   * resize is a cut, and so is the first frame.
   */
  reset() { this._valid = false; }

  /** Colours and geometry for this frame.  Called from `tick`. */
  update(camera, atmos, w, clock) {
    const u = this.mat.uniforms;
    u.uCamPos.value.copy(camera.position);
    /* Last frame's, before it is overwritten: the resolve needs to know
     * where this pixel's piece of sky was on the screen it is about to
     * read.  The *un-jittered* matrix, both times -- the sub-pixel offset
     * lives in the shader's NDC and never enters the projection, so the
     * history stays anchored to the pixel grid it is stored in. */
    this._prevVP.copy(this._vp);
    this._vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uInvVP.value.copy(this._vp).invert();
    this._frame++;
    u.uFrame.value = this._frame;
    if (this.temporal) {
      const [jx, jy] = SUBPIXEL[this._frame % SUBPIXEL.length];
      const mw = this.rt.width, mh = this.rt.height;
      u.uJitter.value.set(2 * jx / mw, 2 * jy / mh);
      const r = this.resolveMat.uniforms;
      r.uJitterUv.value.set(jx / mw, jy / mh);
      r.uMarchTexel.value.set(1 / mw, 1 / mh);
      r.uInvVP.value.copy(u.uInvVP.value);
      r.uPrevVP.value.copy(this._prevVP);
      r.uCamPos.value.copy(camera.position);
    }
    u.uSunDir.value.copy(clock.sun.dir);
    /* Lit out of the same palette as everything else, which is why a cloud
     * is orange at sunset without anything here knowing what a sunset is
     * -- **but whiter in the middle of the day than the ground is**.
     *
     * `PAL.sun` is #fff4dc, a warm key chosen for a hillside, and a cloud
     * lit by it comes out cream.  Every fair-weather reference photograph
     * has near-white cloud tops against blue, and measured against
     * `day_cloud_3.jpg` the cream cost us both of the numbers that
     * separate a cloud from its sky: the chroma of the bright quartile and
     * the contrast at the edge.  Sunlight is white; the warmth in the key
     * is what the *atmosphere* does to it on its way to the ground, and a
     * cloud at 1500 m has had less of that done to it than a verge has.
     * So the tint is pulled out in daylight and left in at the horizon,
     * which is exactly when it is real. */
    u.uSunCol.value.copy(atmos.key.colour)
      .lerp(_white, 0.55 * clock.daylight)
      .multiplyScalar(0.55 + 0.85 * Math.max(0, Math.min(1.6, atmos.key.level)));
    /* And the ambient is **sky**, not white.
     *
     * The underside of a cumulus is lit by the dome above it and the
     * ground below it, and the dome is blue.  Feeding it a near-white
     * `PAL.cloud` gave a shaded side that was merely a darker cream, which
     * is the other half of why the chroma ratio came out low -- in a real
     * sky the *dark* pixels are the coloured ones.  0.18 rather than 0.35
     * of the way toward the cloud tint, for the same reason and measured
     * the same way: at 0.35 the bases were pale grey and the chroma of the
     * dark quartile against the bright one was 2.08 where
     * `day_cloud_3.jpg` is 9.16. */
    u.uAmbient.value.copy(atmos.mid).lerp(atmos.cloud.tint, 0.18)
      .multiplyScalar(0.62);
    u.uHaze.value.copy(atmos.haze);
    u.uNight.value = clock.night;
    /* A shaft you can see needs rain falling and light to see it in. */
    u.uRainVisible.value = Math.min(1, (w ? w.rain : 0) * 1.4)
      * (0.25 + 0.75 * clock.daylight);
    /* Thicker deck in worse weather: an overcast is not more cloud, it is
     * cloud you cannot see through. */
    /* Optical density, and the 1.6 is measured rather than chosen.
     *
     * A real cumulus is optically thick and ours were not: swept against
     * `ref/cloud/day_cloud_3.jpg` through `tools/cloud/score.mjs`, the
     * 90th-percentile edge gradient goes 1.23 / 1.49 / 1.68 / 1.86 at 1x,
     * 2x, 3x and 4x against the photograph's 3.45, while the power
     * spectrum's slope error goes 0.02 / 0.09 / 0.17 / 0.23.  So density
     * buys crispness and spends structure, and it stops being a good
     * trade somewhere below 2x.
     *
     * The rest of that gap is not density and should not be chased with
     * it: a photograph has a lens and a sharpening pass, and this has a
     * three-band toon ramp and an ink filter.  See `next_5.md`. */
    /* ... and then scaled, because the cloud is now the whole deck.
     *
     * The old vertical profile was a window: full density between 13 % and
     * 36 % of the layer's height and nothing outside it, so a core was
     * about 210 m of optical path.  The height-dependent cut replaces that
     * window with a *silhouette* that narrows, so a core is the whole 650
     * m of the deck.  0.62 puts the optical depth of a core back where it
     * was; everything else about how thick a cloud looks is now geometry
     * rather than coefficient. */
    u.uDensity.value = (0.007 + 0.012 * (w ? w.cloud : 0)) * 1.6 * DENSITY_SCALE;
    /* Cirrus belongs to a *fair* sky.  Under a deck there is nothing to
     * see it against, and drawing it there would put a second ceiling
     * above the first.
     *
     * **It comes from the state now, not from `1 - cloud`.**  Derived from
     * the coverage it was largest exactly where there was least cumulus,
     * which put a high sheet over the one sky that is supposed to be
     * empty: `sunny` is `cloud: 0` and the brief asks for it to have not a
     * shred in it.  `weather.js` blends `cirrus` with everything else, so
     * a drift from clear into fair still brings the sheet in gradually. */
    u.uCirrus.value = (w ? w.cirrus ?? Math.max(0, 0.55 - w.cloud * 0.6) : 0)
      * (0.25 + 0.75 * clock.daylight);
  }

  /** The march, then the resolve.  Both before the main render. */
  render(renderer) {
    /* One accumulation step per *simulated* frame, not per draw.
     *
     * `draw` and `tick` are one to one today, but the recorder drives
     * `step` itself and the pause gate stops both, and if this ever ran
     * twice on one `update` the second pass would blend the identical
     * estimate into the history a second time -- which converges the
     * accumulator onto a single jittered frame and puts the whole
     * crosshatch back, on a still image, where it is most visible.  The
     * guard is cheaper than the bug is subtle. */
    if (this._frame === this._drawn) return;
    this._drawn = this._frame;

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, false, false);
    this.quad.render(renderer);

    if (this.temporal) {
      const src = this.hist[this.cur], dst = this.hist[this.cur ^ 1];
      const r = this.resolveMat.uniforms;
      r.tHist.value = src.texture;
      r.uValid.value = this._valid ? 1 : 0;
      renderer.setRenderTarget(dst);
      this.resolveQuad.render(renderer);
      this.cur ^= 1;
      this._valid = true;
      this.composite.material.uniforms.tCloud.value = dst.texture;
    }
    renderer.setRenderTarget(prev);
  }

  /**
   * Read `cloudCover` off the GPU along a straight line in world XZ.
   *
   * The only way to check that the sky and the ground and the rain are
   * really reading *one* field: `tools/probe/clouds.mjs` walks the same
   * line through `CloudField.coverAt` on the CPU and compares. Without
   * this the claim at the top of `cloudfield.js` is an assertion about two
   * pieces of code that happen to have been written on the same afternoon.
   *
   * @returns {Uint8Array} `n` cover values, 0-255
   */
  debugLine(renderer, x0, z0, x1, z1, n = 256, raw = false) {
    if (!this._dbg) {
      this._dbg = new THREE.WebGLRenderTarget(n, 1, {
        depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      });
      this._dbgMat = new THREE.ShaderMaterial({
        uniforms: Object.assign({
          uA: { value: new THREE.Vector2() },
          uB: { value: new THREE.Vector2() },
          uRaw: { value: 0 },
        }, CLOUD_UNIFORMS),
        vertexShader: MARCH_VERT,
        fragmentShader: `
          varying vec2 vUv;
          uniform vec2 uA, uB;
          ${CLOUD_PARS}
          uniform float uRaw;
          void main() {
            vec2 p = mix( uA, uB, vUv.x );
            /* Both, because they fail differently: the raw field is a
             * texture read and agrees to a quantum, while cover puts it
             * through a smoothstep whose slope is 1/(2*uCloudSoft) = 14,
             * so one quantum of raw becomes 0.056 of cover on an edge. */
            gl_FragColor = vec4( vec3( mix( cloudCover( p ), cloudRaw2( p ).x, uRaw ) ), 1.0 );
          }`,
        depthTest: false, depthWrite: false,
      });
      this._dbgQuad = new FullScreenQuad(this._dbgMat);
    }
    if (this._dbg.width !== n) this._dbg.setSize(n, 1);
    this._dbgMat.uniforms.uRaw.value = raw ? 1 : 0;
    this._dbgMat.uniforms.uA.value.set(x0, z0);
    this._dbgMat.uniforms.uB.value.set(x1, z1);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this._dbg);
    this._dbgQuad.render(renderer);
    const buf = new Uint8Array(n * 4);
    renderer.readRenderTargetPixels(this._dbg, 0, 0, n, 1, buf);
    renderer.setRenderTarget(prev);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = buf[i * 4];
    return out;
  }

  /**
   * The layer's alpha at one point on the screen, in NDC.
   *
   * For the one question a mean cannot answer: is the *moon* behind a
   * cloud?  The layer draws after the moon and over it, so this is what
   * per-pixel occlusion looks like from outside.
   *
   * The *march* buffer, deliberately, and the same goes for
   * `coverFraction` below: this asks what the field says here, and the
   * field is what the march samples.  The accumulation is a statement
   * about the last sixteen frames and would answer a slightly different
   * question, one frame late.  The cost is that both now read a single
   * jittered estimate rather than a fixed one, so `alphaAt` on a fringe
   * moves by a few percent frame to frame where it used to be steady --
   * `coverFraction` averages a whole half-frame of pixels and does not
   * move at all.
   */
  alphaAt(renderer, ndcX, ndcY) {
    const w = this.rt.width, h = this.rt.height;
    const x = Math.max(0, Math.min(w - 1, Math.round((ndcX * 0.5 + 0.5) * w)));
    const y = Math.max(0, Math.min(h - 1, Math.round((ndcY * 0.5 + 0.5) * h)));
    const buf = new Uint8Array(4);
    const prev = renderer.getRenderTarget();
    renderer.readRenderTargetPixels(this.rt, x, y, 1, 1, buf);
    renderer.setRenderTarget(prev);
    return buf[3] / 255;
  }

  /** Mean alpha of the marched layer, i.e. how much sky is cloud. */
  coverFraction(renderer, above = 0.5) {
    const w = this.rt.width, h = this.rt.height;
    const buf = new Uint8Array(w * h * 4);
    const prev = renderer.getRenderTarget();
    renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(prev);
    /* Only the upper part of the frame: the lower half is ground, and a
     * cloud that is behind a hill is not sky that is covered. */
    let n = 0, cov = 0;
    const y1 = Math.floor(h * above);
    for (let y = y1; y < h; y++) {
      for (let x = 0; x < w; x++) { cov += buf[(y * w + x) * 4 + 3] / 255; n++; }
    }
    return n ? cov / n : 0;
  }

  dispose() {
    this.rt.dispose();
    this.quad.dispose();
    this.mat.dispose();
    if (this.hist) for (const rt of this.hist) rt.dispose();
    if (this.resolveQuad) this.resolveQuad.dispose();
    if (this.resolveMat) this.resolveMat.dispose();
  }
}
