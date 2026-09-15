/* ------------------------------------------------------------------ *
 * The season, as one uniform block patched into four materials.
 *
 * The whole of the seasonal landscape is three uniforms shared by the
 * ground, the grass, the trees and the roadside furniture:
 *
 *   uSeason   vec4   weights for spring, summer, autumn, winter; sums to 1
 *   uSnow     float  how much snow is lying, 0..1
 *   uWet      float  how wet everything is, 0..1
 *
 * A weight *vector* rather than an index and a blend, because that lets a
 * shader mix four colours in one expression and makes the change gradual
 * by construction -- there is no frame at which the season "switches".  A
 * season lasts three game-days, which is 72 minutes of driving, so the
 * change is visible between sittings and invisible within a corner.
 *
 * The reason this is affordable at all is a piece of luck in the existing
 * design: `ChunkField` builds `groundMaterial()` **once** and hands the
 * same instance to every chunk mesh, so writing a uniform re-dresses
 * ground that was baked ten minutes ago at no rebuild cost whatsoever.
 * Seasons never touch the chunk pipeline.
 *
 * `patch()` goes through `onBeforeCompile` on both branches of `cel()` --
 * toon *and* standard -- because `?flat` has to keep working on the
 * dev server, and anything patched only into the toon path breaks it
 * silently.
 * ------------------------------------------------------------------ */

export const SEASON_UNIFORMS = {
  uSeason: { value: [0, 1, 0, 0] },
  uSnow: { value: 0 },
  uWet: { value: 0 },
};

/** GLSL declarations, for any shader that wants the block. */
export const SEASON_PARS = /* glsl */ `
  uniform vec4 uSeason;
  uniform float uSnow;
  uniform float uWet;

  /* Mix four seasonal colours by the weight vector.  Written out rather
   * than looped so it compiles to four madds. */
  vec3 seasonMix( vec3 sp, vec3 su, vec3 au, vec3 wi ) {
    return sp * uSeason.x + su * uSeason.y + au * uSeason.z + wi * uSeason.w;
  }
`;

/**
 * Give a material the season block.
 *
 * Chains whatever `onBeforeCompile` is already there -- `cel()` installs
 * the shadow-tint patch through the same hook, and clobbering it turns
 * every cel shadow back into plain black.
 */
export function patchSeason(mat, { pars = '', vertex = '', fragment = '', key = '' } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, SEASON_UNIFORMS);
    if (vertex) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + SEASON_PARS + pars)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vertex);
    }
    if (fragment) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + SEASON_PARS + pars)
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + fragment);
    }
  };
  /* Cache key, chained the same careful way `shadowTint` does it: every
   * Material inherits a default `customProgramCacheKey` from the
   * prototype, so a plain truthiness test finds one on every material
   * there has ever been and calls it unbound. */
  const own = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')
    ? mat.customProgramCacheKey.bind(mat)
    : null;
  /**
   * `key` is not optional when the injected GLSL differs between
   * materials, and forgetting it is silent.
   *
   * The three tree species are patched with three different shaders --
   * they differ by a compile-time `EVERGREEN` constant -- and all three
   * originally returned the same cache key, so three.js compiled the
   * first one and handed the same program to the other two.  The result
   * was conifers turning rust-orange in autumn, which looks like a
   * mistake in the colour ramp and is in fact a mistake in a cache.
   */
  mat.customProgramCacheKey = () => 'season' + (key ? '_' + key : '') + (own ? '_' + own() : '');
  return mat;
}

/** Write the clock's and the weather's state into the shared block. */
export function setSeason(weights, snow, wet) {
  const v = SEASON_UNIFORMS.uSeason.value;
  v[0] = weights[0]; v[1] = weights[1]; v[2] = weights[2]; v[3] = weights[3];
  SEASON_UNIFORMS.uSnow.value = snow;
  SEASON_UNIFORMS.uWet.value = wet;
}
