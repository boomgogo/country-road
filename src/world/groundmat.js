import * as THREE from 'three';
import { TEX, roadTexture, ROAD_TILE_LENGTH } from '../core/textures.js';
import { CEL, gradientMap, shadowTint } from '../core/toon.js';
import { CARRIAGEWAY, SHOULDER } from './terrain.js';
import { SEASON_UNIFORMS, SEASON_PARS } from './season.js';
import { patchClouds } from './cloudfield.js';

/* ------------------------------------------------------------------ *
 * The ground material.
 *
 * A `MeshStandardMaterial` with its map stage replaced -- the lighting,
 * shadows and fog that three.js already does well are left alone, and
 * only the question of *what colour is this square metre* is taken over.
 *
 * Four inputs decide it, and the fourth is the interesting one:
 *
 *   height        sand at the water, grass in the middle, heather high up
 *   steepness     rock breaks through wherever the ground stands up
 *   road prox     gravel on the shoulder; and no rock near the road,
 *                 because a cutting is engineered, not weathered
 *   curvature     a discrete Laplacian of the landform -- positive in a
 *                 hollow, negative on a ridge.  Sediment gathers in one
 *                 and rock is exposed on the other, which is a far better
 *                 rule than height or slope alone and costs four samples
 *                 that were already being taken.
 *
 * On top of those, the same blend noise is read at three world scales --
 * 8 m, 220 m and 1400 m -- so the transitions between surfaces are
 * ragged at every distance you look at them from.  A crossfade governed
 * by height alone puts a contour line around every hill.
 * ------------------------------------------------------------------ */

const DETILE = /* glsl */ `
  /* Explicit gradients, because every call is inside a branch -- see
   * "only the layers that show" in FRAG_BODY -- and an implicit derivative
   * inside non-uniform control flow is undefined.  g is the gradient pair
   * for a; b is the same world position at BREAK_RATIO of the scale, so its
   * gradients are g times that and need not be taken twice. */
  #define BREAK_RATIO 0.3688
  vec3 detile( sampler2D t, vec2 a, vec2 b, float k, vec4 g ) {
    return mix( textureGrad( t, a, g.xy, g.zw ).rgb,
                textureGrad( t, b, g.xy * BREAK_RATIO, g.zw * BREAK_RATIO ).rgb,
                0.30 + 0.30 * k );
  }
`;

const PARS = /* glsl */ `
  uniform sampler2D tGrass, tGrassDry, tHeather, tRock, tGravel, tSand, tFade, tRoad;
  uniform float uWater, uCarriageway, uRoadTile, uShoulder;
  varying vec3 vWorld;
  varying float vSteep, vCurv, vRoadU, vRoadA, vRoadS;
` + SEASON_PARS;

const VERT_PARS = /* glsl */ `
  attribute float roadU;
  attribute float roadA;
  attribute float roadS;
  attribute float curv;
  varying vec3 vWorld;
  varying float vSteep, vCurv, vRoadU, vRoadA, vRoadS;
`;

const VERT_BODY = /* glsl */ `
  vec4 wp = modelMatrix * vec4( transformed, 1.0 );
  vWorld = wp.xyz;
  vSteep = clamp( ( 1.0 - dot( normalize( objectNormal ), vec3( 0.0, 1.0, 0.0 ) ) ) * 2.6, 0.0, 1.0 );
  vRoadU = roadU;
  vRoadA = roadA;
  vRoadS = roadS;
  vCurv = curv;
`;

const FRAG_BODY = /* glsl */ `
  vec2 uvNear = vWorld.xz * 0.125;          // 8 m tile
  /* Second sample of the same texture at an incommensurate scale and
   * offset, mixed by the slow noise.  An 8 m tile seen at 250 m across a
   * hillside moires into corduroy stripes that follow the contours, and
   * no amount of anisotropy fixes it because the repeat is real.  Two
   * scales beating against each other has no period. */
  vec2 uvBreak = vWorld.xz * 0.0461 + vec2( 0.37, 0.71 );
  vec2 uvMid  = vWorld.xz * 0.0045;         // 220 m
  vec2 uvFar  = vWorld.xz * 0.0007;         // 1400 m

  float f0 = texture2D( tFade, uvNear ).r;
  float f1 = texture2D( tFade, uvMid ).r;
  float f2 = texture2D( tFade, uvFar ).r;

  /* uvNear's gradients, taken once and out here in uniform control flow.
   * uvBreak is uvNear * BREAK_RATIO plus a constant: 0.0461 / 0.125. */
  vec4 gNear = vec4( dFdx( uvNear ), dFdy( uvNear ) );

  float h = vWorld.y;
  float alt = clamp( ( h - uWater ) / 150.0, 0.0, 1.0 );

  /* Every layer's *weight* first, and only then any of its texels.
   *
   * This used to read the texture of all six surfaces at every fragment,
   * twice each for the detile -- fifteen anisotropic taps -- and then mix
   * most of them away at a weight of exactly zero: rock and sand and
   * gravel under an open field, all of the grass under the tarmac.  On an
   * Intel HD 630 at 1080p that blend was 23 of the ground's 35 ms (the
   * same triangles in a flat colour cost 9), and the ground was most of
   * the frame: hiding it took the game from 23 frames a second to 80.
   * Sampling only what shows took the whole frame from 44 ms to 27, for
   * an identical picture.
   *
   * The weights below are the same expressions as before, in the same
   * order, so the picture does not change: a layer is skipped only when
   * its weight is exactly zero, or when a layer mixed on top of it has a
   * weight of exactly one -- mix( x, y, 1.0 ) is y whatever x was. */

  // --- the green, which is two greens ---
  float dry = smoothstep( 0.35, 0.85, alt * 0.7 + f1 * 0.5 );

  // --- heather on the tops, ragged at the 220 m scale ---
  float heath = smoothstep( 0.46, 0.62, min( 1.0, h / 165.0 ) * f1 * ( f2 * 0.5 + 0.6 ) );

  /* How far off the road this fragment is, 0 far away, 1 at the tarmac edge.
   *
   * vRoadA and not abs( vRoadU ): the signed offset is interpolated across
   * the triangle, and the off-road sentinel is positive, so an edge running
   * from the *left* of the road out past the query radius crosses zero
   * somewhere in a field -- and everything below would then paint a
   * carriageway there.  vRoadA is the distance to the curve, which cannot.
   * See terrain.js at ROAD_QUERY and chunks.js where it is written.  The
   * signed value is still exactly right for the marking coordinate at the
   * bottom of this function, because that is only read where the mask is
   * open, and there the two agree. */
  float au = vRoadA;
  float prox = 1.0 - clamp( ( au - uCarriageway ) / 7.0, 0.0, 1.0 );

  // --- sediment in the hollows, rock on the ridges ---
  float curvature = clamp( vCurv * 4.0, -1.0, 1.0 );
  float outcrop = clamp( ( -curvature - f2 * 0.55 ) * max( 0.4, f1 ), 0.0, 1.0 );

  // --- rock where it is steep, and where the ground is convex ---
  /* Rock wants to be the exception, not the ground cover.  At a 0.30
   * threshold it climbed the whole hillside above every cutting; bare rock
   * belongs on the cut face and the crags, with grass over everything
   * else. */
  float rocky = max( smoothstep( 0.44, 0.86, vSteep + f0 * 0.14 - 0.07 ), outcrop * 0.34 );
  /* Keep rock off the *flat* ground beside the road -- a verge is soil --
   * but a cut face is the one place rock is most exposed, not least, and
   * suppressing it there took the rock out of every cutting.  So the
   * suppression is gated on the ground being flat as well as near. */
  rocky *= 1.0 - prox * 0.85 * ( 1.0 - smoothstep( 0.18, 0.45, vSteep ) );

  // --- the shore ---
  float shore = smoothstep( uWater + 3.4, uWater - 0.4, h );

  /* --- the shoulder ---
   * A proper band of aggregate outside the tarmac, hard on the inside edge
   * and ragged where it gives out into the grass. */
  float gravel = 1.0 - smoothstep( uShoulder * 0.55, uShoulder * 1.5,
                                   au - uCarriageway + f0 * uShoulder * 0.7 );
  gravel *= step( uCarriageway - 0.4, au );
  gravel = clamp( gravel, 0.0, 1.0 );

  /* The tarmac's weight, from further down, because it covers everything
   * here: the edge is hard, so across nearly all of the carriageway it is
   * exactly one and none of the layers under it are read at all. */
  float edge = au < uCarriageway + 0.35
    ? 1.0 - smoothstep( uCarriageway - 0.15, uCarriageway + 0.30, au ) : 0.0;

  // --- only the layers that show, bottom up ---
  bool hideGravel = edge >= 1.0;
  bool hideSand = hideGravel || gravel >= 1.0;
  bool hideRock = hideSand || shore >= 1.0;
  bool hideHeath = hideRock || rocky >= 1.0;
  bool hideGreen = hideHeath || heath >= 1.0;

  vec3 col = vec3( 0.0 );
  if ( !hideGreen ) {
    vec3 lush = dry < 1.0 ? detile( tGrass, uvNear, uvBreak, f1, gNear ) : vec3( 0.0 );
    vec3 parched = dry > 0.0 ? detile( tGrassDry, uvNear, uvBreak, f1, gNear ) : vec3( 0.0 );
    col = mix( lush, parched, dry );
  }
  if ( !hideHeath && heath > 0.0 ) col = mix( col, detile( tHeather, uvNear, uvBreak, f1, gNear ), heath );
  if ( !hideRock && rocky > 0.0 ) col = mix( col, detile( tRock, uvNear, uvBreak, f1, gNear ), rocky );
  if ( !hideSand && shore > 0.0 ) col = mix( col, detile( tSand, uvNear, uvBreak, f1, gNear ), shore );
  if ( !hideGravel && gravel > 0.0 ) col = mix( col, detile( tGravel, uvNear, uvBreak, f1, gNear ), gravel );

  // a broad, very slow tint so two hillsides are never the same green
  col *= 0.93 + 0.14 * f2;

  /* --- the season -------------------------------------------------- *
   * A tint on the vegetation rather than four sets of textures.  The
   * grass and heather have already been blended above, and what changes
   * with the season is their *colour*, not their pattern -- a hillside
   * in autumn is the same hillside.  Rock, gravel and sand are left
   * alone deliberately: stone does not have a season.
   *
   * The mask is what keeps that true.  It is built from how green the
   * fragment already is, so the tint lands on vegetation and slides off
   * the rock in the same cutting.
   */
  float green = clamp( ( col.g - max( col.r, col.b ) ) * 5.0 + 0.35, 0.0, 1.0 );
  float veg = green * ( 1.0 - rocky * 0.85 ) * ( 1.0 - shore * 0.7 );
  vec3 tint = seasonMix(
    vec3( 1.00, 1.18, 0.92 ),      // spring: light green, not ochre
    vec3( 1.00, 1.00, 1.00 ),      // summer: the palette as it stands
    vec3( 1.34, 1.02, 0.52 ),      // autumn: ochre and rust
    vec3( 0.92, 0.90, 0.86 ) );    // winter: bleached, before any snow
  col *= mix( vec3( 1.0 ), tint, veg );

  /* Spring wildflowers, in the ground as well as in the grass: a sparse
   * speckle of warm white at the 8 m scale, so a spring verge reads as
   * flowering from a distance the individual tufts cannot be seen at. */
  float bloom = uSeason.x * smoothstep( 0.78, 0.94, f0 ) * veg;
  col = mix( col, vec3( 0.95, 0.93, 0.80 ), bloom * 0.75 );

  /* --- snow ---
   *
   * Not a texture swap -- a layer, laid over everything the weather can
   * reach.  Two rules do all the work: snow does not stick to a cliff,
   * and it is ragged at the 220 m scale rather than uniform, because a
   * uniform white hillside is a white hillside and not a snowy one. */
  float lie = smoothstep( 0.62, 0.16, vSteep );
  float snow = uSnow * lie * ( 0.62 + 0.38 * f1 ) * ( 1.0 - shore * 0.85 );
  /* Hollows hold snow and ridges lose it, which is the same curvature
   * term the rock blend is built on, used the other way up. */
  snow *= clamp( 0.75 + curvature * 0.5, 0.0, 1.2 );
  snow = clamp( snow, 0.0, 1.0 );
  vec3 snowCol = vec3( 0.93, 0.95, 0.99 ) * ( 0.94 + 0.06 * f0 );
  col = mix( col, snowCol, snow );

  /* --- wet ---
   * Wet ground is darker and less saturated.  The tarmac gets a good deal
   * more of it than the verge does, below. */
  col *= 1.0 - uWet * 0.18 * ( 1.0 - snow );

  /* --- and the carriageway itself, on top of everything ---
   *
   * Sampled in road coordinates rather than world ones, so the markings
   * follow the curve and keep their pitch through a corner.  The edge is
   * hard on purpose: tarmac ends where it ends, and feathering it into the
   * verge is the one place a soft transition looks wrong. */
  vec2 ruv = vec2( ( vRoadU + uCarriageway ) / ( 2.0 * uCarriageway ),
                   vRoadS / uRoadTile );
  vec2 rdx = dFdx( ruv ), rdy = dFdy( ruv );
  if ( edge > 0.0 ) {
    vec3 tar = textureGrad( tRoad, ruv, rdx, rdy ).rgb;

    /* A road that is driven is a road that is cleared.  The carriageway
     * takes a *fraction* of the snow the ground beside it does, and what
     * it does take gathers toward the edges rather than lying evenly --
     * so tarmac shows through with white verges, which is both what
     * winter looks like from a car and what keeps the road legible. */
    float across = clamp( au / uCarriageway, 0.0, 1.0 );
    float ploughed = uSnow * ( 0.10 + 0.62 * pow( across, 2.2 ) ) * ( 0.7 + 0.3 * f0 );
    tar = mix( tar, snowCol, clamp( ploughed, 0.0, 0.85 ) );

    /* Wet tarmac is much darker than wet grass, and it is the difference
     * that reads as rain -- a road that does not change colour in a
     * downpour is a road with weather happening near it. */
    tar *= 1.0 - uWet * 0.34;

    col = mix( col, tar, edge );
  }

  diffuseColor.rgb *= col;
`;

export function groundMaterial() {
  /* The ground goes through the same switch as everything else: a toon
   * material under the cel pass, a standard one under `?flat`.  Only the
   * *lighting* changes -- the whole blend above, which is the interesting
   * half, is identical either way, because it decides what colour a square
   * metre is and not how it is lit. */
  const mat = CEL
    ? new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradientMap(3) })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uniforms = {
    tGrass: { value: TEX.grass() },
    tGrassDry: { value: TEX.grassDry() },
    tHeather: { value: TEX.heather() },
    tRock: { value: TEX.rock() },
    tGravel: { value: TEX.gravel() },
    tSand: { value: TEX.sand() },
    tFade: { value: TEX.fade() },
    tRoad: { value: roadTexture(2 * CARRIAGEWAY) },
    uWater: { value: 2 },
    uCarriageway: { value: CARRIAGEWAY },
    uShoulder: { value: SHOULDER },
    uRoadTile: { value: ROAD_TILE_LENGTH },
    /* The season block, shared by reference with the grass, the trees and
     * the furniture -- one write in `main.js` re-dresses all four. */
    ...SEASON_UNIFORMS,
  };
  mat.userData.uniforms = uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', VERT_BODY + '\n#include <project_vertex>');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS + DETILE)
      .replace('#include <map_fragment>', FRAG_BODY);
  };
  mat.customProgramCacheKey = () => 'ground' + (CEL ? '_cel' : '');
  if (CEL) shadowTint(mat, 0x585d75);
  /* And the cloud shadow, which is the one moving light gradient in a
   * world whose direct term is quantised into three flat bands.  One
   * material instance serves every chunk, so this costs one patch. */
  patchClouds(mat, 'ground');
  return mat;
}
