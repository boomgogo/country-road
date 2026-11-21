import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Light from the places, on everything near them -- without a single
 * new `THREE.Light`.
 *
 * `car/lights.js` says why in its header and it is the rule here too:
 * three.js recompiles every material in the scene when the light count
 * changes, so a street light that is a `PointLight` is a stall at every
 * dusk and every time a town streams in.  So a lamp is a *uniform*: a
 * fixed array of the nearest few lamps that are on, written once a frame,
 * and a patch on the materials that should catch them -- the ground (which
 * is the road as well), the furniture, and the buildings themselves.
 *
 * The pool is quantised into bands, the way the sun is quantised by the
 * cel ramp, so a street light makes a drawn circle of light on the road
 * rather than a photographic falloff.
 *
 * It is patched in at boot, before anything compiles, and costs nothing
 * by day: the count is zero and the loop is never entered.  `places.js`
 * is what writes the array; this file is small on purpose, because it is
 * on the first load and `places.js` is not.
 * ------------------------------------------------------------------ */

/** The most lamps any material reads.  The tier decides how many of these
 *  are actually used -- see `quality.js`, `lamps`. */
export const LAMP_MAX = 8;

export const LAMP_UNIFORMS = {
  /** xyz: where, world.  w: reach, metres. */
  uLamp: { value: Array.from({ length: LAMP_MAX }, () => new THREE.Vector4()) },
  uLampN: { value: 0 },
  uLampCol: { value: new THREE.Color(1.0, 0.78, 0.48) },
  /** How much the lamps count for: the night, more or less. */
  uLampAmt: { value: 0 },
};

const PARS = /* glsl */ `
  uniform vec4 uLamp[ ${LAMP_MAX} ];
  uniform int uLampN;
  uniform vec3 uLampCol;
  uniform float uLampAmt;
`;

/* After `lights_fragment_end`, so the cloud shadow -- which scales the
 * direct term just after `lights_fragment_begin` -- does not dim a street
 * light, which is not under the cloud. */
const LIGHT = /* glsl */ `
  if ( uLampN > 0 ) {
    vec3 wPosLamp = cameraPosition + transpose( mat3( viewMatrix ) ) * ( -vViewPosition );
    float lampI = 0.0;
    for ( int i = 0; i < ${LAMP_MAX}; i++ ) {
      if ( i >= uLampN ) break;
      vec3 toL = uLamp[ i ].xyz - wPosLamp;
      float d2 = dot( toL, toL );
      float r2 = uLamp[ i ].w * uLamp[ i ].w;
      if ( d2 >= r2 ) continue;
      /* Lambert against the lamp, in view space, where 'normal' is. */
      vec3 dirV = mat3( viewMatrix ) * ( toL * inversesqrt( max( d2, 1e-4 ) ) );
      float ndl = max( dot( normal, dirV ), 0.0 );
      float k = 1.0 - d2 / r2;
      lampI += k * k * ndl;
    }
    /* Three bands and nothing, like the sun: a drawn pool. */
    float band = lampI > 0.55 ? 1.0 : ( lampI > 0.24 ? 0.58 : ( lampI > 0.09 ? 0.22 : 0.0 ) );
    reflectedLight.directDiffuse += diffuseColor.rgb * uLampCol * band * uLampAmt;
  }
`;

/**
 * Give a material the lamps.  Chains `onBeforeCompile` and the program
 * cache key exactly as `patchClouds` and `patchSeason` do, for the reason
 * both of them give.
 */
export function patchLamps(mat, key = '') {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    if (!shader.fragmentShader.includes('lights_fragment_end')) return;
    Object.assign(shader.uniforms, LAMP_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + LIGHT);
  };
  const own = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')
    ? mat.customProgramCacheKey.bind(mat)
    : null;
  mat.customProgramCacheKey = () => 'lamp' + (key ? '_' + key : '') + (own ? '_' + own() : '');
  return mat;
}

const _byDist = [];

/**
 * Pick the lamps that count this frame and write them.
 *
 * @param lamps  `{ x, y, z, reach, on }` records; `on` already decided
 * @param eye    the camera, which is where the pools are looked at from
 * @param max    the tier's count, at most `LAMP_MAX`
 * @param amt    the night, 0..1
 */
export function setLamps(lamps, eye, max, amt) {
  const U = LAMP_UNIFORMS;
  U.uLampAmt.value = amt;
  if (amt < 0.01 || !lamps.length) { U.uLampN.value = 0; return; }
  _byDist.length = 0;
  for (const l of lamps) {
    if (!l.on) continue;
    const d = (l.x - eye.x) ** 2 + (l.z - eye.z) ** 2;
    /* Past 350 m a pool is a few pixels and the glow above it is carrying
     * the light on its own. */
    if (d > 350 * 350) continue;
    _byDist.push({ l, d });
  }
  _byDist.sort((a, b) => a.d - b.d);
  const n = Math.min(max, LAMP_MAX, _byDist.length);
  for (let i = 0; i < n; i++) {
    const l = _byDist[i].l;
    U.uLamp.value[i].set(l.x, l.y, l.z, l.reach);
  }
  U.uLampN.value = n;
}
