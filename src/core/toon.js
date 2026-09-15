import * as THREE from 'three';
import { PAL } from './palette.js';

/* ------------------------------------------------------------------ *
 * The material seam, and now the cel shading behind it.
 *
 * Ported from `ref/dp-sakura-crossing` (MIT, same author), which is the
 * brief's instruction: everything uses `MeshToonMaterial` with a
 * hand-authored gradient ramp, so direct sun is quantised into two to
 * four flat bands instead of a smooth falloff, and the toon BRDF is
 * patched so the darker bands are *hue-shifted* toward a cool violet
 * rather than being a darker version of the base colour.  That hue shift
 * in shadow is most of what separates "cel" from "low-poly 3D".
 *
 * Every material in the project has come through `cel()` and `flat()`
 * since the first commit, when both were two-line stubs returning
 * standard materials, precisely so that this file could be replaced
 * rather than forty call sites edited.  It was worth it: nothing outside
 * this file changed.
 *
 * `?flat` puts the standard materials back, on the dev server only: it is
 * a debugging view of the lighting without the cel ramp in the way, and
 * the production build always draws cel.
 * ------------------------------------------------------------------ */

export const CEL = !(import.meta.env?.DEV && new URLSearchParams(
  typeof location === 'undefined' ? '' : location.search
).has('flat'));

const RAMPS = {
  2: [98, 255],
  3: [92, 176, 255],
  4: [82, 140, 200, 255],
  // high-key: for pale masses that must stay light on their shadow side
  soft: [176, 255],
  soft3: [168, 212, 255],
};

const rampCache = new Map();

export function gradientMap(bands = 3) {
  if (rampCache.has(bands)) return rampCache.get(bands);
  const stops = RAMPS[bands] || RAMPS[3];
  const data = new Uint8Array(stops.length * 4);
  for (let i = 0; i < stops.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = stops[i];
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, stops.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  rampCache.set(bands, tex);
  return tex;
}

/* ---------------------- the shadow-tint patch ---------------------- */

const CHUNK = 'lights_toon_pars_fragment';
const LINE =
  'vec3 irradiance = getGradientIrradiance( geometryNormal, directLight.direction ) * directLight.color;';
const PATCH = `
	vec3 celBand = getGradientIrradiance( geometryNormal, directLight.direction );
	vec3 irradiance = celBand * mix( uShadowTint, vec3( 1.0 ), celBand ) * directLight.color;`;

let patchAvailable = false;
let patchedChunk = '';
{
  const src = THREE.ShaderChunk[CHUNK];
  if (src && src.includes(LINE)) {
    patchedChunk = 'uniform vec3 uShadowTint;\n' + src.replace(LINE, PATCH);
    patchAvailable = true;
  }
}

/** Tint the shadow side of a toon material toward a cool hue. */
export function shadowTint(mat, tint) {
  if (!patchAvailable) return mat;
  const uni = { value: new THREE.Color(tint) };
  mat.userData.shadowTint = uni;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uShadowTint = uni;
    shader.fragmentShader = shader.fragmentShader.replace(
      `#include <${CHUNK}>`, patchedChunk
    );
  };
  /* Chain the cache key only if the material *owns* one.  Every Material
   * inherits a default `customProgramCacheKey` from the prototype, so a
   * plain truthiness test finds one on every material there has ever been
   * and then calls it unbound -- which reads `this.onBeforeCompile` off
   * undefined and takes the whole renderer down on the first frame. */
  const hex = new THREE.Color(tint).getHexString();
  const own = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')
    ? mat.customProgramCacheKey.bind(mat)
    : null;
  mat.customProgramCacheKey = () => 'cel_' + hex + (own ? '_' + own() : '');
  return mat;
}

/* ------------------------------ factories ------------------------------ */

const cache = new Map();

/** Lit surface: cel-shaded, or standard under `?flat`. */
export function cel(opts = {}) {
  const {
    color = 0xffffff, roughness = 0.95, metalness = 0,
    map = null, vertexColors = false, side = THREE.FrontSide,
    transparent = false, opacity = 1, alphaTest = 0, flat: flatShade = false,
    fog = true, depthWrite = null, cache: doCache = true,
    bands = 3, tint = PAL.ink,
  } = opts;

  const key = doCache && !map
    ? ['c', CEL, color, roughness, metalness, vertexColors, side, transparent,
       opacity, alphaTest, flatShade, fog, depthWrite, bands, tint].join('|')
    : null;
  if (key && cache.has(key)) return cache.get(key);

  let m;
  if (CEL) {
    /* No `flatShading`: MeshToonMaterial has no such property and three
     * warns once per material about it.  Faceting is the geometry's job
     * here anyway -- the ramp is already quantising the light. */
    m = new THREE.MeshToonMaterial({
      color, gradientMap: gradientMap(bands), map, vertexColors, side,
      transparent, opacity, alphaTest, fog,
    });
    shadowTint(m, tint);
  } else {
    m = new THREE.MeshStandardMaterial({
      color, roughness, metalness, map, vertexColors, side,
      transparent, opacity, alphaTest, flatShading: flatShade, fog,
    });
  }
  if (depthWrite !== null) m.depthWrite = depthWrite;
  if (key) cache.set(key, m);
  return m;
}

/** Unlit flat colour -- sky, water, glass, lamps, anything not to be shaded. */
export function flat(opts = {}) {
  const {
    color = 0xffffff, map = null, side = THREE.FrontSide,
    transparent = false, opacity = 1, fog = true, depthWrite = null,
    vertexColors = false, cache: doCache = true,
  } = opts;
  const key = doCache && !map
    ? ['f', color, side, transparent, opacity, fog, depthWrite, vertexColors].join('|')
    : null;
  if (key && cache.has(key)) return cache.get(key);
  const m = new THREE.MeshBasicMaterial({
    color, map, side, transparent, opacity, fog, vertexColors,
  });
  if (depthWrite !== null) m.depthWrite = depthWrite;
  if (key) cache.set(key, m);
  return m;
}

/** The base class the ground material must extend to match the rest. */
export function GroundBase() {
  return CEL ? THREE.MeshToonMaterial : THREE.MeshStandardMaterial;
}
