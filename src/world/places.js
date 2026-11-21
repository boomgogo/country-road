import * as THREE from 'three';
import { cel } from '../core/toon.js';
import { hashFloat, mulberry32 } from '../core/rng.js';
import { WATER_LEVEL, CARRIAGEWAY } from './terrain.js';
import { patchClouds } from './cloudfield.js';
import { SEASON_UNIFORMS, SEASON_PARS } from './season.js';
import { patchLamps, setLamps } from './lamps.js';
import { archetypes, HOUSES, ROOFS, WALLS, COL, unitBox, unitCyl } from './placekit.js';

/* ------------------------------------------------------------------ *
 * Places: towns, farms, a woolshed, a pair of silos, a windmill, a
 * lookout -- and the signposts that say how far.  `prompt_5.md`, after
 * `suggest_4.md` §1.
 *
 * `placeplan.js` says *where along the road* each one is; this file finds
 * ground for it there, builds it, lights it at night, and lets it go.
 *
 * **Only on road that will stay.**  The tracer can take back road ahead of
 * the car (`Midline` reverts), so a place is built only once its road is
 * traced past it, and only inside a window around the car -- 400 m behind
 * and 1600 ahead, wider than the furniture's because a town should be
 * visible across a valley.  Any road the tracer abandons or newly lays
 * through a place's ground comes here as a box, in the same pass of the
 * frame that hands it to the chunks, and the place is dropped and sited
 * again.
 *
 * **No terrain edits.**  `heightAt` is load-bearing and was just made 3.5
 * times cheaper; a building pad would be a new term in it.  So buildings
 * stand on what the land gives them, the way they do on the east coast: a
 * house on stumps, a shed or a pub on a plinth, a silo on a ring footing.
 * A lot whose ground is too steep for its building is left empty, and a
 * town on a hillside is a smaller town.
 *
 * **Loaded after the first frame.**  The first place is kilometres away,
 * so this file and the kit come in through a dynamic import once the
 * drive is running, and the first load does not change.  `?places=off`
 * keeps them out entirely, for A/B frame times.
 * ------------------------------------------------------------------ */

/** Metres of clearance from the carriageway's edge to any footprint. */
const CLEAR = 8.5;
/** ...and from a different stretch of road that happens to pass nearby. */
const CLEAR_OTHER = 22;
/** How far a place's ground may fall across its footprint, by footing. */
const SPREAD = { stumps: 3.8, plinth: 2.4, ring: 1.6, none: 3.0 };
/** Metres of road either side of a town's centre its lots spread over. */
const TOWN_SPAN = 400;
/** Behind and ahead of the car, in metres of road, that places are built. */
const BEHIND = 400, AHEAD = 1600;
/** ...and kept, beyond which they are let go. */
const KEEP = 2400;
/** The clearing grid's cell, metres.  See `blocked`. */
const CELL = 6;
/** Milliseconds a frame spent siting.  See `_siting`. */
const BUDGET = 1.5;
/** The text atlas, in pixels. */
const ATLAS_W = 2048, ATLAS_H = 1024;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _sm = {};
const _nq = {};

/* ------------------------------------------------------------------ *
 * When a light is on.
 *
 * One rule, written twice -- here for the lamps' pools, and in GLSL for
 * the windows and the glows -- so a porch light and the pool it throws on
 * the yard can never disagree.  `a` and `b` are the light's own two
 * random numbers; `kind` is what it is (see `Kit.win`).  `late` is hours
 * since noon, so one o'clock in the morning is 25.
 *
 * Windows come on through the dusk, one by one, as `night` passes each
 * one's own threshold -- so a town lights up over the half hour after
 * sunset rather than at a stroke -- and most go off between ten and one.
 * A porch light, a shop and a street light stay on until dawn.
 * ------------------------------------------------------------------ */
const LIT_GLSL = /* glsl */ `
  float litRule( float a, float b, float kind, float night, float late ) {
    float onAt, offAt;
    if ( kind < 0.5 ) { onAt = 0.15 + 0.7 * a; offAt = 21.5 + 4.0 * b; }
    else if ( kind < 1.5 ) { onAt = 0.08 + 0.3 * a; offAt = 99.0; }
    else if ( kind < 2.5 ) { onAt = 0.10 + 0.3 * a; offAt = 23.2 + 1.3 * b; }
    else { onAt = 0.20 + 0.3 * a; offAt = 20.6 + 1.6 * b; }
    return step( onAt, night ) * step( late, offAt );
  }
`;

function litRule(a, b, kind, night, late) {
  let onAt, offAt;
  if (kind < 0.5) { onAt = 0.15 + 0.7 * a; offAt = 21.5 + 4.0 * b; }
  else if (kind < 1.5) { onAt = 0.08 + 0.3 * a; offAt = 99; }
  else if (kind < 2.5) { onAt = 0.10 + 0.3 * a; offAt = 23.2 + 1.3 * b; }
  else { onAt = 0.20 + 0.3 * a; offAt = 20.6 + 1.6 * b; }
  return night >= onAt && late <= offAt ? 1 : 0;
}

/** A light's own two numbers, from its archetype's and its building's. */
function mixAB(a, b, seed) {
  const x = a + seed * 0.6180339, y = b + seed * 0.7548776;
  return [x - Math.floor(x), y - Math.floor(y)];
}

/* ------------------------------------------------------------------ *
 * Materials.
 * ------------------------------------------------------------------ */

/** The buildings: vertex colours, each building's own roof and wall
 *  colours already baked in (see `Merger`), and snow on the vertices
 *  `aMask` says are roof. */
function buildingMaterial() {
  const mat = cel({ color: 0xffffff, vertexColors: true, cache: false });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, SEASON_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aMask;
        varying float vMask;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vMask = aMask;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SEASON_PARS + '\nvarying float vMask;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float isRoof = step( 0.5, vMask ) * step( vMask, 1.5 );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.92, 0.94, 0.98 ), uSnow * 0.85 * isRoof );
          diffuseColor.rgb *= 1.0 - uWet * 0.16;
        }`);
  };
  const own = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')
    ? mat.customProgramCacheKey.bind(mat) : null;
  mat.customProgramCacheKey = () => 'building' + (own ? '_' + own() : '');
  patchClouds(mat, 'building');
  patchLamps(mat, 'building');
  return mat;
}

/** Everything else that is vertex-coloured: stumps, plinths, posts. */
function plainMaterial() {
  const mat = cel({ color: 0xffffff, vertexColors: true, cache: false });
  patchClouds(mat, 'placeplain');
  patchLamps(mat, 'placeplain');
  return mat;
}

/**
 * The windows, unlit.  Dark glass by day, with a little of the sky in it;
 * warm light at night when `litRule` says so.  They take only half the
 * fog, so a farmhouse window still reads across a valley -- which is the
 * picture `suggest_4.md` §3 asked for.
 */
function windowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uNight: { value: 0 },
      uLate: { value: 12 },
      uGlass: { value: new THREE.Color(0.1, 0.12, 0.15) },
      uLevel: { value: 2.2 },
    }]),
    vertexShader: /* glsl */ `
      attribute vec3 aWin;
      attribute float aSeed;
      uniform float uNight, uLate;
      varying vec3 vCol;
      varying float vLit;
      varying float vFogDepth;
      ${LIT_GLSL}
      void main() {
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        gl_Position = projectionMatrix * mv;
        vFogDepth = -mv.z;
        float a = fract( aWin.x + aSeed * 0.6180339 );
        float b = fract( aWin.y + aSeed * 0.7548776 );
        float on = litRule( a, b, aWin.z, uNight, uLate );
        vLit = on * smoothstep( 0.0, 0.25, uNight ) * ( 0.75 + 0.5 * b );
        vCol = aWin.z < 0.5 ? vec3( 1.0, 0.70, 0.36 )
          : ( aWin.z < 1.5 ? vec3( 1.0, 0.86, 0.62 )
          : ( aWin.z < 2.5 ? vec3( 1.0, 0.66, 0.30 ) : vec3( 1.0, 0.80, 0.52 ) ) );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGlass;
      uniform float uLevel;
      uniform vec3 fogColor;
      uniform float fogNear, fogFar;
      varying vec3 vCol;
      varying float vLit;
      varying float vFogDepth;
      void main() {
        vec3 c = mix( uGlass, vCol * uLevel, min( vLit, 1.0 ) );
        float f = smoothstep( fogNear, fogFar, vFogDepth ) * ( 1.0 - 0.5 * min( vLit, 1.0 ) );
        gl_FragColor = vec4( mix( c, fogColor, f ), 1.0 );
      }`,
    fog: true,
  });
}

/**
 * The glows: one camera-facing additive quad per light, so a town at
 * night is visible from a ridge as points of light rather than as nothing.
 * Each has a floor on its size on screen, so a light far away is a point
 * and not a sub-pixel that flickers out.  Depth-tested and not depth-
 * written, so the ink never sees them.  Ones past the camera's far plane
 * -- a town's glow on the horizon -- are drawn at the far plane at the
 * same angular size.
 */
function glowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uNight: { value: 0 },
      uLate: { value: 12 },
      uPxK: { value: 0.002 },
      uFar: { value: 1800 },
    }]),
    vertexShader: /* glsl */ `
      attribute vec4 aGlow;     // a, b, kind, size
      uniform float uNight, uLate, uPxK, uFar;
      uniform float fogNear, fogFar;
      varying vec2 vUv;
      varying vec3 vCol;
      ${LIT_GLSL}
      void main() {
        vec3 c = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        vec3 rel = c - cameraPosition;
        float d = length( rel );
        float k = d > uFar ? uFar / d : 1.0;
        float kind = aGlow.z;
        float on = kind > 3.5 ? 1.0 : litRule( aGlow.x, aGlow.y, kind, uNight, uLate );
        float lvl = on * smoothstep( 0.05, 0.4, uNight );
        /* A floor of about three pixels, and the town glow has none: it is
         * a wide, low smudge on the horizon, not a disc, and it is only
         * there from a distance -- inside the town it would be a brown fog
         * overhead. */
        float town = step( 3.5, kind );
        float size = town > 0.5 ? aGlow.w : max( aGlow.w, 3.0 * uPxK * d );
        lvl *= mix( 1.0, smoothstep( 600.0, 1800.0, d ), town );
        vec2 shape = mix( vec2( 1.0 ), vec2( 1.7, 0.55 ), town );
        vec4 mv = viewMatrix * vec4( cameraPosition + rel * k, 1.0 );
        mv.xy += position.xy * shape * size * k * step( 0.001, lvl );
        gl_Position = projectionMatrix * mv;
        vUv = position.xy * 2.0;
        /* Through the fog, but at half its rate and further out: a light
         * is what you can still see when the hill it is on has gone. */
        float fog = smoothstep( fogNear, fogFar * 3.0, d ) * 0.85;
        vec3 col = kind < 0.5 ? vec3( 1.0, 0.68, 0.34 )
          : ( kind < 1.5 ? vec3( 1.0, 0.82, 0.56 )
          : ( kind < 2.5 ? vec3( 1.0, 0.62, 0.30 )
          : ( kind < 3.5 ? vec3( 1.0, 0.78, 0.5 ) : vec3( 1.0, 0.72, 0.45 ) ) ) );
        float strength = kind > 3.5 ? 0.11 : ( kind < 0.5 ? 0.55 : 1.0 );
        vCol = col * lvl * strength * ( 1.0 - fog );
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        float r2 = dot( vUv, vUv );
        if ( r2 > 1.0 ) discard;
        float a = 1.0 - r2;
        a = a * a * ( 0.35 + 0.65 * a );
        gl_FragColor = vec4( vCol * a * 1.6, 1.0 );
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
}

/**
 * The sign faces: the atlas through a per-instance rectangle, and at
 * night a retroreflective flare when the car's lamps are on them -- the
 * way a real sign jumps out of the dark at you.
 */
function signMaterial(texture) {
  const mat = cel({ color: 0xffffff, map: texture, cache: false });
  const U = {
    uCarPos: { value: new THREE.Vector3() },
    uCarFwd: { value: new THREE.Vector3(1, 0, 0) },
    uRetro: { value: 0 },
    /** The pub's and the servo's own signs are lit from within at night. */
    uSignLit: { value: 0 },
  };
  mat.userData.retro = U;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aRect;
        uniform vec3 uCarPos, uCarFwd;
        varying float vRetro;
        varying float vLitSign;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = uv * abs( aRect.zw ) + aRect.xy;
        #endif
        vLitSign = aRect.z < 0.0 ? 1.0 : 0.0;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          mat4 wm = modelMatrix * instanceMatrix;
          vec3 wp = ( wm * vec4( transformed, 1.0 ) ).xyz;
          vec3 wn = normalize( mat3( wm ) * vec3( 0.0, 0.0, -1.0 ) );
          vec3 toCar = uCarPos - wp;
          float dc = length( toCar );
          toCar /= max( dc, 1e-3 );
          vRetro = max( dot( wn, toCar ), 0.0 ) * max( dot( uCarFwd, -toCar ), 0.0 )
            * ( 1.0 - smoothstep( 40.0, 170.0, dc ) );
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRetro, uSignLit;\nvarying float vRetro;\nvarying float vLitSign;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * ( uRetro * vRetro * 1.8 + uSignLit * vLitSign );`);
  };
  const own = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey')
    ? mat.customProgramCacheKey.bind(mat) : null;
  mat.customProgramCacheKey = () => 'sign' + (own ? '_' + own() : '');
  patchClouds(mat, 'sign');
  patchLamps(mat, 'sign');
  return mat;
}

/* ------------------------------------------------------------------ *
 * The sign atlas.
 *
 * One canvas, drawn into as signs are needed and uploaded as one texture,
 * so every sign in the world is one draw call.  Shelf-packed; when it is
 * full it is cleared and redrawn with only what is live, which over a long
 * drive is the only housekeeping it needs.
 * ------------------------------------------------------------------ */

const STYLE = {
  green: { bg: '#1f6b45', fg: '#f4f6f2', border: '#f4f6f2' },
  town: { bg: '#1f5a8c', fg: '#f4f6f2', border: '#f4f6f2' },
  sixty: { bg: '#f7f7f2', fg: '#15161a', ring: '#c8242c' },
  pub: { bg: '#5a1f22', fg: '#f0e2b8', border: '#f0e2b8' },
  servo: { bg: '#b8322c', fg: '#ffffff', border: null },
  hall: { bg: '#efe6cf', fg: '#33382e', border: '#33382e' },
  brown: { bg: '#6b4428', fg: '#f4efe4', border: '#f4efe4' },
};

class SignAtlas {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.entries = new Map();
    this._clear();
  }

  _clear() {
    this.ctx.fillStyle = '#808080';
    this.ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
    this.entries.clear();
    this.x = 0; this.y = 0; this.row = 0;
    this.generation = (this.generation || 0) + 1;
  }

  /**
   * The rectangle for a sign, drawing it if it is new.  `lines` is one or
   * more rows of `[left, right]`; the panel's shape comes back as `aspect`
   * so the caller can size the board to its text.
   */
  get(key, style, lines) {
    const have = this.entries.get(key);
    if (have) return have;
    const ctx = this.ctx;
    const S = STYLE[style] || STYLE.green;
    const rowH = 72, pad = 26;
    let w, h;
    ctx.font = '600 56px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    if (style === 'sixty') { w = 150; h = 190; }
    else {
      let widest = 0;
      for (const [l, r] of lines) widest = Math.max(widest, ctx.measureText(l).width + (r ? ctx.measureText(r).width + 70 : 0));
      w = Math.ceil(widest + pad * 2);
      h = rowH * lines.length + pad * 1.4;
    }
    if (this.x + w > ATLAS_W) { this.x = 0; this.y += this.row + 4; this.row = 0; }
    if (this.y + h > ATLAS_H) { this._clear(); return this.get(key, style, lines); }
    const x = this.x, y = this.y;
    this.x += w + 4;
    this.row = Math.max(this.row, h);

    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = S.bg;
    ctx.fillRect(0, 0, w, h);
    if (style === 'sixty') {
      ctx.strokeStyle = S.ring;
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = S.fg;
      ctx.font = '700 64px Arial, Helvetica, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(lines[0][0], w / 2, h / 2 + 3);
    } else {
      if (S.border) {
        ctx.strokeStyle = S.border;
        ctx.lineWidth = 5;
        ctx.strokeRect(9, 9, w - 18, h - 18);
      }
      ctx.fillStyle = S.fg;
      ctx.textBaseline = 'middle';
      for (let i = 0; i < lines.length; i++) {
        const [l, r] = lines[i];
        const cy = pad * 0.7 + rowH * (i + 0.5);
        if (r) {
          ctx.textAlign = 'left';
          ctx.fillText(l, pad, cy);
          ctx.textAlign = 'right';
          ctx.fillText(r, w - pad, cy);
        } else {
          ctx.textAlign = 'center';
          ctx.fillText(l, w / 2, cy);
        }
      }
    }
    ctx.restore();
    this.texture.needsUpdate = true;
    /* UV: the canvas's y runs down, the texture's (flipY) runs up. */
    const e = {
      rect: [x / ATLAS_W, 1 - (y + h) / ATLAS_H, w / ATLAS_W, h / ATLAS_H],
      aspect: w / h, generation: this.generation,
    };
    this.entries.set(key, e);
    return e;
  }
}

/* ------------------------------------------------------------------ *
 * Places.
 * ------------------------------------------------------------------ */

export class Places {
  /**
   * @param o.plan     the `PlacePlan` -- the same one the load screen reads
   * @param o.lamps    how many lamps' pools the tier affords
   */
  constructor(scene, terrain, road, scatter, { plan, lamps = 8, seed = 1 } = {}) {
    this.scene = scene;
    this.T = terrain;
    this.road = road;
    this.scatter = scatter;
    this.plan = plan;
    this.lampMax = lamps;
    this.seed = seed;

    this.arch = archetypes();
    this.mat = buildingMaterial();
    this.plain = plainMaterial();
    this.winMat = windowMaterial();
    this.glowMat = glowMaterial();
    this.atlas = new SignAtlas();
    this.signMat = signMaterial(this.atlas.texture);
    this.stumpGeo = unitBox(COL.concrete);
    this.ringGeo = unitCyl(COL.concrete);
    this.poleGeo = unitBox(0x9aa0a4);
    this.faceGeo = new THREE.PlaneGeometry(1, 1);
    this.faceGeo.rotateY(Math.PI);

    /** Built places, by schedule key. */
    this.live = new Map();
    /** Entries whose ground was refused, by key, so they are not retried
     *  every frame.  Cleared when the road under them changes. */
    this.refused = new Map();
    /** Ground no tree may grow on: `cellKey -> count of places`. */
    this.cells = new Map();
    /** Every lamp of every live place, for the pools. */
    this.lamps = [];
    /** Towns seen, by key, with where they are -- kept after the town
     *  itself is let go, so its glow stays on the horizon behind you. */
    this.townGlow = new Map();

    const glowGeo = new THREE.PlaneGeometry(1, 1);
    this.glowCap = 1200;
    this.glow = new THREE.InstancedMesh(glowGeo, this.glowMat, this.glowCap);
    this.aGlow = new THREE.InstancedBufferAttribute(new Float32Array(this.glowCap * 4), 4);
    glowGeo.setAttribute('aGlow', this.aGlow);
    this.glow.count = 0;
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 5;
    scene.add(this.glow);
    this._glowDirty = false;

    /** The town the car is in, for the toast. */
    this.inTown = null;
    this.stats = { built: 0, dropped: 0, refused: 0, buildMs: 0, addMs: 0 };
    /** The place being sited, a few lots a frame.  See `_siting`. */
    this.job = null;
    /** Why lots were turned down, counted -- for `perf-bench/places.mjs`. */
    this.why = { road: 0, other: 0, taken: 0, water: 0, slope: 0 };
    this._t = 0;

    scatter.blocked = (x, z) => this.blocked(x, z);
  }

  /* ---------------------------- the schedule ---------------------------- */

  _key(e) { return `${e.line}:${e.d}:${e.kind}`; }

  /** How much road either side of an entry it might occupy. */
  _reach(e) { return e.kind === 'town' ? TOWN_SPAN * 2 + 300 : (e.kind === 'sign' ? 20 : 260); }

  /** Is the road traced, and protected from a revert, past this entry? */
  _traced(e) {
    const len = e.line ? this.road.lengthBack : this.road.length;
    return e.d + this._reach(e) + 300 <= len;
  }

  /**
   * Once a frame.  Builds at most one place, so a town arriving costs one
   * frame's worth of siting and not a stall.
   *
   * @param s    the car's signed arc position
   * @param dir  +1 or -1, which way along the road it is pointing
   */
  update(s, dir, car) {
    const lo = dir >= 0 ? s - BEHIND : s - AHEAD;
    const hi = dir >= 0 ? s + AHEAD : s + BEHIND;
    /* One place at a time, sited over as many frames as it takes at
     * `BUDGET` milliseconds a frame. */
    if (!this.job) {
      for (const e of this.plan.between(lo - 900, hi + 900)) {
        const k = this._key(e);
        if (this.live.has(k) || this.refused.has(k)) continue;
        const r = e.kind === 'town' ? TOWN_SPAN + 300 : 0;
        if (e.s + r < lo || e.s - r > hi) continue;
        if (!this._traced(e)) continue;
        this.road.sampleAt(e.s, _sm);
        const m = this._reach(e) + 80;
        this.job = { k, e, it: this._siting(e), ms: 0, boxes: [],
                     box: { minX: _sm.x - m, minZ: _sm.z - m, maxX: _sm.x + m, maxZ: _sm.z + m } };
        break;
      }
    }
    if (this.job) {
      const job = this.job;
      const t0 = performance.now();
      let r;
      do { r = job.it.next(); } while (!r.done && performance.now() - t0 < BUDGET);
      job.ms += performance.now() - t0;
      if (r.done) {
        this.job = null;
        this.stats.buildMs = job.ms;
        const t1 = performance.now();
        const hit = (b, o) => !(b.maxX < o.minX || b.minX > o.maxX || b.maxZ < o.minZ || b.minZ > o.maxZ);
        if (r.value) {
          /* Road changed near it while it was being sited: asked the same
           * question `invalidate` asks, and let go only on a no. */
          const rec = this._add(job.k, r.value);
          if (job.boxes.some((b) => hit(rec.box, b)) && !this._stillGood(rec)) this._drop(job.k);
        } else if (!job.boxes.some((b) => b.dirty && hit(job.box, b))) {
          /* Remembered with the ground it was refused on.  Only road taken
           * *away* there asks again: new road can only add to what a lot
           * has to keep clear of, so it never turns a no into a yes. */
          this.refused.set(job.k, job.box);
          this.stats.refused++;
        }
        this.stats.addMs = performance.now() - t1;
      }
    }
    for (const [k, p] of this.live) {
      if (Math.abs(p.e.s - s) > KEEP + this._reach(p.e)) this._drop(k);
    }
    if (this._glowDirty) this._writeGlow();

    /* Which town the car is in, by road, for the toast. */
    let inside = null;
    for (const p of this.live.values()) {
      if (p.e.kind === 'town' && s >= p.sRange[0] && s <= p.sRange[1]) inside = p;
    }
    let entered = null;
    if (inside && inside !== this.inTown) entered = inside.name;
    this.inTown = inside;
    return entered;
  }

  /**
   * Road the tracer has abandoned (`dirty`) or newly laid, as a box.  A
   * place it touches is let go and sited again if the road no longer
   * allows it, and a lot refused under abandoned road is worth asking
   * about again.
   */
  invalidate(minX, minZ, maxX, maxZ, dirty = false) {
    const hit = (b) => !(b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ);
    /* A box is a bounding box, and the road's growing tip is in one every
     * frame; dropping every place a box touched would make a town near a
     * winding road blink.  So a place in the box is *asked*: is its own
     * road still where it was, and does every footprint still clear every
     * road?  Only a no lets it go. */
    for (const [k, p] of this.live) if (hit(p.box) && !this._stillGood(p)) this._drop(k);
    if (dirty) for (const [k, b] of this.refused) if (hit(b)) this.refused.delete(k);
    /* A siting in progress carries on, and is checked against these when
     * it finishes -- see `update`.  Cancelling it here instead would never
     * let a town near a winding road's growing tip finish at all. */
    if (this.job) this.job.boxes.push({ minX, minZ, maxX, maxZ, dirty });
  }

  /** Does a built place still stand where the road now allows?  See
   *  `invalidate`. */
  _stillGood(p) {
    this.road.sampleAt(p.e.s, _sm);
    if (Math.hypot(_sm.x - p.anchor.x, _sm.z - p.anchor.z) > 0.5) return false;
    for (const it of p.layout) {
      if (it.light) continue;
      const [x0, z0, x1, z1] = it.a.foot;
      for (const [lx, lz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [(x0 + x1) / 2, (z0 + z1) / 2]]) {
        const [wx, wz] = Places.world(it.f, lx, lz);
        const q = this.road.nearest(wx, wz, _nq);
        if (!q) continue;
        if (q.d < CARRIAGEWAY + CLEAR - 0.5) return false;
        if (Math.abs(q.s - it.s) > 250 && q.d < CARRIAGEWAY + CLEAR_OTHER) return false;
      }
    }
    return true;
  }

  /** Is this ground somebody's yard?  A grid lookup, for the scatter. */
  blocked(x, z) {
    return this.cells.has(cellOf(x, z));
  }

  /* ------------------------------- siting ------------------------------- */

  /**
   * The frame of a building at arc `s`, `side` of the road, its front
   * `setback` metres past the carriageway's edge.  Local x runs along the
   * road (`side` times its tangent) and local z away from it.
   */
  _frame(s, side, setback, a, along = 0) {
    this.road.sampleAt(s, _sm);
    const tx = _sm.tx * side, tz = _sm.tz * side;
    const zx = _sm.rx * side, zz = _sm.rz * side;
    const off = CARRIAGEWAY + setback - a.foot[1];
    return {
      x: _sm.x + zx * off + tx * along, z: _sm.z + zz * off + tz * along,
      /* Rotation about y taking local +z to (zx, zz). */
      yaw: Math.atan2(zx, zz),
      tx, tz, zx, zz,
    };
  }

  /** Local (x, z) in a frame to world. */
  static world(f, lx, lz) {
    return [f.x + f.tx * lx + f.zx * lz, f.z + f.tz * lx + f.zz * lz];
  }

  /**
   * Can this archetype stand here?  Returns the floor height and the
   * ground under its corners, or null.
   *
   * Corners and the middles of its sides: none too near the carriageway,
   * none near a *different* stretch of road (one that loops back), none in
   * the water, none over another building of this place, and the ground
   * across them not falling more than the footing can take up.
   */
  _test(a, f, s, taken) {
    const [x0, z0, x1, z1] = a.foot;
    const pts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1],
                 [(x0 + x1) / 2, z0], [(x0 + x1) / 2, z1], [x0, (z0 + z1) / 2], [x1, (z0 + z1) / 2],
                 [(x0 + x1) / 2, (z0 + z1) / 2]];
    let lo = Infinity, hi = -Infinity;
    for (const [lx, lz] of pts) {
      const [wx, wz] = Places.world(f, lx, lz);
      const q = this.road.nearest(wx, wz, _nq);
      if (q) {
        if (q.d < CARRIAGEWAY + CLEAR) { this.why.road++; return null; }
        if (Math.abs(q.s - s) > 250 && q.d < CARRIAGEWAY + CLEAR_OTHER) { this.why.other++; return null; }
      }
      for (const t of taken) {
        if ((wx - t.x) ** 2 + (wz - t.z) ** 2 < t.r * t.r) { this.why.taken++; return null; }
      }
      const y = this.T.heightAt(wx, wz);
      if (y < WATER_LEVEL + 1.5) { this.why.water++; return null; }
      lo = Math.min(lo, y); hi = Math.max(hi, y);
    }
    const footing = a.footing;
    if (hi - lo > (a.spread ?? SPREAD[footing])) { this.why.slope++; return null; }
    let floor;
    if (footing === 'stumps') floor = hi + 0.35 + (a.floorLift || 0);
    else if (footing === 'plinth') floor = hi + 0.18;
    else if (footing === 'ring') floor = hi + 0.12;
    else floor = (lo + hi) / 2;
    return { floor, lo, hi };
  }

  /** Try a building at `s`, `side`; on success it is added to `out`. */
  _put(out, name, s, side, setback, opt = {}) {
    const a = this.arch[name];
    const f = this._frame(s, side, setback, a, opt.along || 0);
    if (opt.turn) {
      /* Turned a quarter or a half on its lot, for the outbuildings. */
      const c = Math.cos(opt.turn), sn = Math.sin(opt.turn);
      const tx = f.tx * c - f.zx * sn, tz = f.tz * c - f.zz * sn;
      const zx = f.tx * sn + f.zx * c, zz = f.tz * sn + f.zz * c;
      Object.assign(f, { tx, tz, zx, zz, yaw: Math.atan2(zx, zz) });
    }
    const t = this._test(a, f, s, out.taken);
    if (!t) return null;
    const r = Math.hypot(a.foot[2] - a.foot[0], a.foot[3] - a.foot[1]) * 0.42;
    const [cx, cz] = Places.world(f, (a.foot[0] + a.foot[2]) / 2, (a.foot[1] + a.foot[3]) / 2);
    out.taken.push({ x: cx, z: cz, r });
    const seed = hashFloat(out.seed, out.items.length, 9);
    const item = {
      a, f, floor: t.floor, lo: t.lo, hi: t.hi, seed,
      roof: opt.roof ?? ROOFS[Math.floor(hashFloat(out.seed, out.items.length, 10) * ROOFS.length)],
      wall: opt.wall ?? WALLS[Math.floor(hashFloat(out.seed, out.items.length, 11) * WALLS.length)],
      s,
    };
    out.items.push(item);
    return item;
  }

  /**
   * Find ground for an entry, as a generator that yields after every lot
   * it tries -- so `update` can spread a town over as many frames as its
   * ground takes.  Siting a town is a few hundred height samples, which is
   * 3 to 10 ms here and several times that on a phone: as one frame's work
   * it was a hitch at every town.  Returns the layout, or null.
   */
  * _siting(e) {
    const out = { e, seed: e.seed, items: [], taken: [], extra: [], trees: [], signs: [], lights: [] };
    const rand = mulberry32(e.seed);
    if (e.kind === 'town') yield* this._siteTown(e, out, rand);
    else if (e.kind === 'sign') this._siteDistanceSign(e, out);
    else yield* this._siteLandmark(e, out, rand);
    if (!out.items.length && !out.signs.length) return null;
    return out;
  }

  /** The same, all at once.  For the probes. */
  _site(e) {
    const it = this._siting(e);
    let r;
    do { r = it.next(); } while (!r.done);
    return r.value;
  }

  /**
   * A town.  The main street is the road; the memorial is at the middle,
   * the pub across from it, the hall up the street, the servo at one end,
   * and houses fill the lots outward from the middle on both sides.
   */
  * _siteTown(e, out, rand) {
    const c = e.s, dir = e.line ? -1 : 1;
    const side = e.side;
    const want = 10 + Math.floor(rand() * 7);
    out.name = e.name;
    /* The civic buildings first, each tried at its spot and then nudged
     * along and back and across the road: most roadside ground is a slope
     * somewhere, and a town that loses its pub to one is a worse town than
     * one whose pub is fifty metres up the street. */
    const civic = [
      ['memorial', 0, side, 12],
      ['pub', 35 * dir, -side, 9],
      [rand() < 0.5 ? 'hall' : 'church', 140 * dir, side, 10],
      ['servo', -200 * dir, -side, 9],
    ];
    for (const [name, ds, sd, sb] of civic) {
      let done = false;
      for (const nudge of [0, 22, -22, 45, -45, 70, -70, 100, -100]) {
        for (const side2 of [sd, -sd]) {
          for (const sb2 of [sb, sb + 6, sb + 13]) {
            const ok = this._put(out, name, c + ds + nudge, side2, sb2, name === 'memorial' ? { roof: 0xcbb68d } : {});
            yield;
            if (ok) { done = true; break; }
          }
          if (done) break;
        }
        if (done) break;
      }
    }
    /* Houses, on lots outward from the middle on both sides, until there
     * are enough or the town has run out of road.  Each lot tries three
     * setbacks, and the cottage if the house it drew will not fit -- so a
     * town keeps together on broken ground rather than strung out along
     * a kilometre of it.  Past 400 m the lots go on to 800, which is the
     * span the signs allow for. */
    let houses = 0;
    for (let k = 0; houses < want; k++) {
      const ds = (14 + 27 * Math.floor(k / 2)) * (k % 2 ? -1 : 1);
      if (Math.abs(ds) > TOWN_SPAN * 2) break;
      for (const sd of [side, -side]) {
        if (houses >= want) break;
        const first = HOUSES[Math.floor(rand() * HOUSES.length)];
        let put = null;
        for (const name of first === 'cottage' ? ['cottage'] : [first, 'cottage']) {
          for (const sb of [9 + rand() * 3, 14, 20]) {
            put = this._put(out, name, c + ds + (rand() - 0.5) * 6, sd, sb);
            yield;
            if (put) break;
          }
          if (put) break;
        }
        if (put) { houses++; this._yardTree(out, put, rand); }
      }
    }
    if (!out.items.length) return;

    /* How far along the road the town runs, from what got built. */
    let s0 = Infinity, s1 = -Infinity;
    for (const it of out.items) { s0 = Math.min(s0, it.s); s1 = Math.max(s1, it.s); }
    s0 -= 30; s1 += 30;
    out.sRange = [s0, s1];

    /* Street lights down the middle of town, alternating sides. */
    let alt = 1;
    for (let ss = Math.max(s0, c - 280); ss <= Math.min(s1, c + 280); ss += 46) {
      this._streetLight(out, ss, alt);
      alt = -alt;
    }

    /* The signs at each end: the name, and 60.  On the left of whoever is
     * arriving, facing them -- this is a left-hand-drive country. */
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1);
    const outbound = dir;   // which way travel away from the origin goes in s
    const entryA = outbound > 0 ? lo - 150 : hi + 150;
    const entryB = outbound > 0 ? hi + 150 : lo - 150;
    this._sign(out, entryA, outbound, `town:${e.name}`, 'town', [[e.name]], 3.0);
    this._sign(out, entryA + 40 * outbound, outbound, 'sixty', 'sixty', [['60']], 1.25);
    this._sign(out, entryB, -outbound, `town:${e.name}`, 'town', [[e.name]], 3.0);
    this._sign(out, entryB - 40 * outbound, -outbound, 'sixty', 'sixty', [['60']], 1.25);
  }

  /** A street light at the road's edge, arm out over the road. */
  _streetLight(out, s, side) {
    const a = this.arch.streetLight;
    /* The pole 1.7 m past the carriageway's edge -- a metre behind where a
     * guardrail would be -- with local -z, its arm, out over the road. */
    this.road.sampleAt(s, _sm);
    const u = CARRIAGEWAY + 1.7;
    const zx = _sm.rx * side, zz = _sm.rz * side;
    const f = { x: _sm.x + zx * u, z: _sm.z + zz * u, yaw: Math.atan2(zx, zz),
                tx: _sm.tx * side, tz: _sm.tz * side, zx, zz };
    const y = this.T.heightAt(f.x, f.z);
    out.items.push({ a, f, floor: y, lo: y, hi: y, seed: hashFloat(out.seed, out.items.length, 12), s, light: true });
  }

  /**
   * A sign at arc `s` for traffic going `travel` (+1 toward +s), on its
   * left, facing it.  `lines` are rows of `[left, right]`; `height` is the
   * board's height in metres.
   */
  _sign(out, s, travel, key, style, lines, height) {
    this.road.sampleAt(s, _sm);
    const u = -travel * (CARRIAGEWAY + 2.4);
    const x = _sm.x + _sm.rx * u, z = _sm.z + _sm.rz * u;
    const q = this.road.nearest(x, z, _nq);
    if (q && q.d < CARRIAGEWAY + 1.5) return;
    /* The face is local -z, toward whoever is coming; so local +z points
     * the way they are going. */
    const zx = _sm.tx * travel, zz = _sm.tz * travel;
    out.signs.push({ x, z, y: this.T.heightAt(x, z), yaw: Math.atan2(zx, zz), key, style, lines, height, s });
  }

  /** A distance sign: the next two towns out, and how far. */
  _siteDistanceSign(e, out) {
    const towns = this.plan.signTowns(e);
    if (!towns.length) return;
    const lines = towns.map((t) => [t.name, String(Math.max(1, Math.round(Math.abs(t.s - e.s) / 1000)))]);
    this._sign(out, e.s, e.line ? -1 : 1, `dist:${lines.map((l) => l.join(' ')).join('|')}`, 'green', lines, 2.2);
    out.sRange = [e.s - 5, e.s + 5];
  }

  /** One shade tree beside a house, out of the scatter's own species. */
  _yardTree(out, it, rand) {
    if (rand() < 0.35) return;
    const a = it.a;
    const lx = rand() < 0.5 ? a.foot[0] - 3 - rand() * 3 : a.foot[2] + 3 + rand() * 3;
    const lz = a.foot[3] - 1 - rand() * 5;
    const [x, z] = Places.world(it.f, lx, lz);
    const q = this.road.nearest(x, z, _nq);
    if (q && q.d < CARRIAGEWAY + CLEAR) return;
    out.trees.push({ sp: rand() < 0.75 ? 0 : 1, x, z, h: 6 + rand() * 3, rot: rand() * 6.28, jx: 0.9 + rand() * 0.2, jz: 0.9 + rand() * 0.2 });
  }

  /** A landmark: tried along a stretch of road until the ground takes it. */
  * _siteLandmark(e, out, rand) {
    const kind = e.kind;
    let side = e.side;
    if (kind === 'lookout') {
      /* On the side the land falls away, which is where the view is. */
      this.road.sampleAt(e.s, _sm);
      const yl = this.T.heightAt(_sm.x - _sm.rx * 40, _sm.z - _sm.rz * 40);
      const yr = this.T.heightAt(_sm.x + _sm.rx * 40, _sm.z + _sm.rz * 40);
      side = yr < yl ? 1 : -1;
    }
    const tries = [0, 60, -60, 120, -120, 180, -180];
    for (const ds of tries) {
      for (const sd of [side, -side]) {
        out.items.length = 0; out.taken.length = 0; out.trees.length = 0; out.extra.length = 0;
        const ok = this._landmarkAt(kind, e.s + ds, sd, out, rand);
        yield;
        if (ok) {
          out.sRange = [e.s + ds - 40, e.s + ds + 40];
          return;
        }
      }
    }
    out.items.length = 0;
  }

  _landmarkAt(kind, s, side, out, rand) {
    if (kind === 'farmhouse') {
      const setback = 28 + rand() * 20;
      const h = this._put(out, 'farmhouse', s, side, setback);
      if (!h) return false;
      /* The machinery shed, off to one side and turned, and a windbreak of
       * conifers along the back of the house yard. */
      this._put(out, 'shed', s + (rand() < 0.5 ? -1 : 1) * 24, side, setback + 6, { turn: Math.PI / 2, roof: 0xb4b9bb });
      const a = h.a;
      const n = 8 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const lx = a.foot[0] - 6 + (a.foot[2] - a.foot[0] + 12) * (i / (n - 1));
        const [x, z] = Places.world(h.f, lx, a.foot[3] + 9 + (rand() - 0.5) * 1.5);
        out.trees.push({ sp: 1, x, z, h: 9 + rand() * 3, rot: rand() * 6.28, jx: 0.9 + rand() * 0.2, jz: 0.9 + rand() * 0.2 });
      }
      this._yardTree(out, h, rand);
      return true;
    }
    if (kind === 'woolshed') return !!this._put(out, 'woolshed', s, side, 22 + rand() * 20, { roof: 0x8d5f43 });
    if (kind === 'silos') return !!this._put(out, 'silos', s, side, 14 + rand() * 12);
    if (kind === 'windmill') return !!this._put(out, 'windmill', s, side, 18 + rand() * 25);
    if (kind === 'lookout') {
      /* A pull-off, so as close to the road as the clearance allows. */
      for (const sb of [9, 12, 16]) if (this._put(out, 'lookout', s, side, sb)) return true;
      return false;
    }
    return false;
  }

  /* ------------------------------ building ------------------------------ */

  _add(key, p) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
    const grow = (x, z, r = 0) => {
      box.minX = Math.min(box.minX, x - r); box.maxX = Math.max(box.maxX, x + r);
      box.minZ = Math.min(box.minZ, z - r); box.maxZ = Math.max(box.maxZ, z + r);
    };
    const colliders = [];
    const lamps = [];
    const glows = [];
    const cells = [];
    const blades = [];

    /* **One mesh for all of a place's buildings**, one for its windows and
     * one for what they stand on -- merged here, with each building's roof
     * and wall colours baked into its vertices.  It was an instanced mesh
     * per archetype, which is the obvious way and the wrong one at this
     * scale: a town is eighteen buildings of eight kinds, so instancing
     * bought eight draw calls of two or three instances each, twice over
     * with the shadow pass, and on a phone's CPU at 4x that was a tenth of
     * the frame.  Merged, a town is about six calls, and the vertices --
     * some fifteen thousand -- are a few hundred kilobytes, once. */
    const body = new Merger(true), wins = new Merger(false), feet = new Merger(false);
    const stumps = [], rings = [];
    for (const it of p.items) {
      _p.set(it.f.x, it.floor, it.f.z);
      _q.setFromAxisAngle(_up, it.f.yaw);
      _m.compose(_p, _q, _s.set(1, 1, 1));
      body.add(it.a.geo, _m, it.roof, it.wall);
      if (it.a.win) wins.addWindows(it.a.win, _m, it.seed);
      this._extras(it, { grow, colliders, lamps, glows, cells, stumps, rings, blades, group });
    }
    const addMesh = (merger, mat, shadow) => {
      if (!merger.count) return;
      const m = new THREE.Mesh(merger.build(), mat);
      m.castShadow = shadow;
      m.receiveShadow = false;
      m.matrixAutoUpdate = false;
      m.userData.own = true;
      group.add(m);
    };
    addMesh(body, this.mat, true);
    addMesh(wins, this.winMat, false);

    /* What they stand on: stumps, plinths and ring footings, scaled unit
     * shapes, into the same kind of merged mesh. */
    for (const b of stumps) feet.add(this.stumpGeo, scaled(b));
    for (const b of rings) feet.add(this.ringGeo, scaled(b));

    /* Trees the place planted: the scatter's own geometry and material. */
    const bySp = [[], [], []];
    for (const t of p.trees) {
      const y = this.T.heightAt(t.x, t.z);
      const { matrix, trunk } = this.scatter.plant(t.sp, t.x, y, t.z, t.h, t.rot, t.jx, t.jz);
      bySp[t.sp].push(matrix);
      if (trunk) colliders.push({ type: 'cyl', x: trunk.x, y: trunk.y + trunk.h / 2, z: trunk.z, r: trunk.r, hh: trunk.h / 2 });
      grow(t.x, t.z, 4);
    }
    for (let sp = 0; sp < 3; sp++) {
      if (!bySp[sp].length) continue;
      const m = new THREE.InstancedMesh(this.scatter.geo[sp], this.scatter.materials[sp], bySp[sp].length);
      bySp[sp].forEach((mx, i) => m.setMatrixAt(i, mx));
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.computeBoundingSphere();
      group.add(m);
    }

    /* Signs: posts and a board from the plain kit, the face from the atlas.
     * The atlas's generation is read *before*, so that if drawing these
     * signs filled it and it was cleared half way through, the rectangles
     * taken before the clear are noticed as stale and re-read. */
    const gen0 = this.atlas.generation;
    this._signs(p, group, colliders, grow, feet);
    addMesh(feet, this.plain, true);

    this.scene.add(group);
    const rec = {
      key, e: p.e, name: p.name || null, group, box, colliders, lamps, glows, cells, blades,
      sRange: p.sRange || [p.e.s - 50, p.e.s + 50],
      atlasGen: gen0, signRecs: p.signs,
      /** What stands where, for the probes. */
      items: p.items.map((it) => ({ name: it.a.name, x: it.f.x, z: it.f.z, floor: it.floor, lo: it.lo, s: it.s })),
      /** ...and the layout itself, and where its road was, for `_stillGood`. */
      layout: p.items,
      anchor: (this.road.sampleAt(p.e.s, _sm), { x: _sm.x, z: _sm.z }),
    };
    this.live.set(key, rec);
    for (const c of cells) this.cells.set(c, (this.cells.get(c) || 0) + 1);
    this.lamps.push(...lamps);
    this._glowDirty = true;
    if (p.e.kind === 'town') {
      let x = 0, z = 0, n = 0;
      for (const it of p.items) { x += it.f.x; z += it.f.z; n++; }
      this.townGlow.set(key, { x: x / n, z: z / n, y: p.items[0].floor + 40 });
    }
    /* The wood grows again without the yards in it. */
    if (cells.length) this.scatter.invalidate(box.minX, box.minZ, box.maxX, box.maxZ);
    this.stats.built++;
    return rec;
  }

  /** Stumps, plinth, colliders, lamps, glows and clearing for one item. */
  _extras(it, o) {
    const a = it.a, f = it.f;
    const [x0, z0, x1, z1] = a.foot;
    for (const [lx, lz] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
      const [wx, wz] = Places.world(f, lx, lz);
      o.grow(wx, wz, 2);
    }
    /* The clearing: the footprint and a yard round it. */
    if (!it.light) {
      const m = 7;
      for (let lx = x0 - m; lx <= x1 + m; lx += CELL * 0.7) {
        for (let lz = z0 - m; lz <= z1 + m; lz += CELL * 0.7) {
          const [wx, wz] = Places.world(f, lx, lz);
          o.cells.push(cellOf(wx, wz));
        }
      }
    }
    /* Footings. */
    if (a.footing === 'stumps' && a.stumps) {
      for (const [lx, lz] of a.stumps) {
        const [wx, wz] = Places.world(f, lx, lz);
        const g = this.T.heightAt(wx, wz) - 0.3;
        const top = it.floor - 0.12;
        if (top - g < 0.05) continue;
        o.stumps.push({ x: wx, y: g, z: wz, sx: 0.24, sy: top - g, sz: 0.24, yaw: f.yaw });
      }
    } else if (a.footing === 'plinth') {
      const [cx, cz] = Places.world(f, (x0 + x1) / 2, (z0 + z1) / 2);
      const g = it.lo - 0.6;
      o.stumps.push({ x: cx, y: g, z: cz, sx: x1 - x0 - 1.0, sy: it.floor - g - 0.02, sz: z1 - z0 - 1.0, yaw: f.yaw });
    } else if (a.footing === 'ring' && a.rings) {
      for (const [lx, lz, r] of a.rings) {
        const [wx, wz] = Places.world(f, lx, lz);
        const g = it.lo - 0.6;
        o.rings.push({ x: wx, y: g, z: wz, sx: r, sy: it.floor - g, sz: r, yaw: 0 });
      }
    }
    /* Colliders, in the world. */
    for (const c of a.colliders) {
      if (c.type === 'box') {
        const [wx, wz] = Places.world(f, (c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2);
        o.colliders.push({ type: 'box', x: wx, z: wz, y: it.floor + (c.y0 + c.y1) / 2,
          hx: (c.x1 - c.x0) / 2, hy: (c.y1 - c.y0) / 2, hz: (c.z1 - c.z0) / 2, yaw: f.yaw });
      } else {
        const [wx, wz] = Places.world(f, c.x, c.z);
        o.colliders.push({ type: 'cyl', x: wx, z: wz, y: it.floor + (c.y0 + c.y1) / 2, r: c.r, hh: (c.y1 - c.y0) / 2 });
      }
    }
    /* Lamps and their glows. */
    a.lamps.forEach((l, i) => {
      const [wx, wz] = Places.world(f, l.x, l.z);
      const [la, lb] = mixAB(hashFloat(i, 3, 1), hashFloat(i, 3, 2), it.seed);
      const lamp = { x: wx, y: it.floor + l.y, z: wz, reach: l.reach, kind: l.kind, a: la, b: lb, on: false };
      o.lamps.push(lamp);
      o.glows.push({ x: wx, y: lamp.y, z: wz, a: la, b: lb, kind: l.kind,
        size: l.reach > 15 ? 2.4 : (l.kind === 1 ? 1.1 : 1.5) });
    });
    /* And one glow for the house's rooms, keyed to its first room window,
     * so a house far away at night is a warm point when that window is. */
    if (a.win) {
      const w = a.win.attributes.aWin.array;
      for (let i = 0; i < w.length; i += 18) {
        if (w[i + 2] > 0.5) continue;
        const [ga, gb] = mixAB(w[i], w[i + 1], it.seed);
        const [wx, wz] = Places.world(f, (x0 + x1) / 2, z0 + 0.5);
        o.glows.push({ x: wx, y: it.floor + 1.7, z: wz, a: ga, b: gb, kind: 0, size: 2.2 });
        break;
      }
    }
    /* The windmill's sails, which turn. */
    if (a.blades) {
      const m = new THREE.Mesh(a.blades, this.plain);
      const [wx, wz] = Places.world(f, a.hub[0], a.hub[2]);
      m.position.set(wx, it.floor + a.hub[1], wz);
      m.rotation.order = 'YXZ';
      m.rotation.y = f.yaw;
      m.castShadow = true;
      m.userData.spin = 0.8 + it.seed * 0.6;
      o.group.add(m);
      o.blades.push(m);
    }
  }

  _signs(p, group, colliders, grow, feet) {
    const posts = [], faces = [], rects = [];
    const signs = [];
    for (const sg of p.signs) {
      const e = this.atlas.get(sg.key, sg.style, sg.lines);
      const h = sg.height, w = h * e.aspect;
      const two = w > 2.2;
      const bottom = sg.style === 'sixty' ? 1.6 : (two ? 1.4 : 1.8);
      const c = Math.cos(sg.yaw), s = Math.sin(sg.yaw);
      /* Local x of the board is (cos yaw, -sin yaw). */
      const lx = (x) => [sg.x + c * x, sg.z - s * x];
      for (const px of two ? [-w * 0.3, w * 0.3] : [0]) {
        const [x, z] = lx(px);
        posts.push({ x, y: sg.y - 0.5, z, sx: 0.1, sy: bottom + h + 0.5, sz: 0.1, yaw: sg.yaw });
        colliders.push({ type: 'box', x, z, y: sg.y + (bottom + h) / 2, hx: 0.06, hy: (bottom + h) / 2 + 0.3, hz: 0.06, yaw: sg.yaw });
      }
      /* The board's back, just behind the face. */
      posts.push({ x: sg.x + s * 0.06, y: sg.y + bottom - 0.04, z: sg.z + c * 0.06, sx: w + 0.08, sy: h + 0.08, sz: 0.05, yaw: sg.yaw });
      faces.push({ x: sg.x, y: sg.y + bottom + h / 2, z: sg.z, w, h, yaw: sg.yaw, key: sg.key, style: sg.style, lines: sg.lines });
      rects.push(e.rect);
      grow(sg.x, sg.z, w);
      signs.push(sg);
    }
    /* And the archetypes' own panels -- "HOTEL", "FUEL" -- which are part
     * of their buildings. */
    for (const it of p.items) {
      for (const sg of it.a.signs) {
        const e = this.atlas.get(`arch:${sg.text}`, sg.style, [[sg.text]]);
        const [x, z] = Places.world(it.f, sg.x, sg.z);
        const lit = sg.style === 'pub' || sg.style === 'servo';
        faces.push({ x, y: it.floor + sg.y, z, w: sg.w, h: sg.h, yaw: it.f.yaw + sg.yaw,
                     key: `arch:${sg.text}`, style: sg.style, lines: [[sg.text]], lit });
        rects.push(litRect(e.rect, lit));
      }
    }
    for (const b of posts) feet.add(this.poleGeo, scaled(b));
    if (faces.length) {
      const m = new THREE.InstancedMesh(this.faceGeo.clone(), this.signMat, faces.length);
      const aRect = new THREE.InstancedBufferAttribute(new Float32Array(faces.length * 4), 4);
      m.geometry.setAttribute('aRect', aRect);
      m.userData.own = true;
      faces.forEach((f, i) => {
        _p.set(f.x, f.y, f.z);
        _q.setFromAxisAngle(_up, f.yaw);
        _m.compose(_p, _q, _s.set(f.w, f.h, 1));
        m.setMatrixAt(i, _m);
        aRect.setXYZW(i, ...rects[i]);
      });
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      m.computeBoundingSphere();
      m.userData.faces = faces;
      m.userData.aRect = aRect;
      group.add(m);
    }
  }

  /** Re-read every live sign's rectangle, after the atlas was cleared. */
  _refreshSigns() {
    for (const p of this.live.values()) {
      if (p.atlasGen === this.atlas.generation) continue;
      p.atlasGen = this.atlas.generation;
      p.group.traverse((o) => {
        if (!o.userData.faces) return;
        o.userData.faces.forEach((f, i) => {
          const e = this.atlas.get(f.key, f.style, f.lines);
          o.userData.aRect.setXYZW(i, ...litRect(e.rect, f.lit));
        });
        o.userData.aRect.needsUpdate = true;
      });
    }
  }

  _drop(key) {
    const p = this.live.get(key);
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((o) => {
      if (!o.isMesh) return;
      /* The copies made for this place go; the shared kit -- the stumps,
       * the poles, the scatter's trees, the windmill's sails -- stays. */
      if (o.userData.own) o.geometry.dispose();
      if (o.isInstancedMesh) o.dispose();
    });
    this.live.delete(key);
    for (const c of p.cells) {
      const n = (this.cells.get(c) || 1) - 1;
      if (n <= 0) this.cells.delete(c); else this.cells.set(c, n);
    }
    if (p.lamps.length) this.lamps = this.lamps.filter((l) => !p.lamps.includes(l));
    this._glowDirty = true;
    if (p.cells.length) this.scatter.invalidate(p.box.minX, p.box.minZ, p.box.maxX, p.box.maxZ);
    this.stats.dropped++;
  }

  /** Every glow of every live place, and the towns' horizon glows. */
  _writeGlow() {
    this._glowDirty = false;
    const arr = this.aGlow.array;
    let n = 0;
    const put = (g) => {
      if (n >= this.glowCap) return;
      _m.makeTranslation(g.x, g.y, g.z);
      this.glow.setMatrixAt(n, _m);
      arr[n * 4] = g.a; arr[n * 4 + 1] = g.b; arr[n * 4 + 2] = g.kind; arr[n * 4 + 3] = g.size;
      n++;
    };
    for (const p of this.live.values()) for (const g of p.glows) put(g);
    for (const t of this.townGlow.values()) put({ x: t.x, y: t.y, z: t.z, a: 0, b: 0, kind: 4, size: 320 });
    this.glow.count = n;
    this.glow.instanceMatrix.needsUpdate = true;
    this.aGlow.needsUpdate = true;
  }

  /* ------------------------------- the frame ----------------------------- */

  /**
   * Night, once a frame: which lights are on, the nearest few into the
   * lamp pools, the windows' and glows' clocks, the signs' flare, and the
   * windmills.
   */
  paint(dt, camera, clock, car, headlights, atmos, height) {
    const night = clock.night;
    const h = clock.hour;
    const late = h < 12 ? h + 24 : h;
    for (const l of this.lamps) l.on = litRule(l.a, l.b, l.kind, night, late) === 1;
    setLamps(this.lamps, camera.position, this.lampMax, smoothstep01((night - 0.05) / 0.35));

    const w = this.winMat.uniforms;
    w.uNight.value = night;
    w.uLate.value = late;
    /* By day the glass is the sky, darkened: a window reflects what is
     * above it, which is what makes it read as glass and not as paint. */
    w.uGlass.value.copy(atmos.mid).multiplyScalar(0.22 + 0.1 * clock.daylight).addScalar(0.015);
    const g = this.glowMat.uniforms;
    g.uNight.value = night;
    g.uLate.value = late;
    g.uPxK.value = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) / Math.max(1, height);
    g.uFar.value = camera.far * 0.9;

    const r = this.signMat.userData.retro;
    r.uCarPos.value.set(car.pos.x, car.pos.y + 0.6, car.pos.z);
    r.uCarFwd.value.set(Math.cos(car.yaw), 0, Math.sin(car.yaw));
    r.uRetro.value = headlights ? headlights.glow : 0;
    r.uSignLit.value = 0.9 * smoothstep01((night - 0.1) / 0.4);

    this._t += dt;
    for (const p of this.live.values()) {
      for (const b of p.blades) b.rotation.z = this._t * b.userData.spin * 2.2;
    }
    /* Towns' horizon glows past eight kilometres are let go. */
    for (const [k, t] of this.townGlow) {
      if (Math.hypot(t.x - camera.position.x, t.z - camera.position.z) > 8000) {
        this.townGlow.delete(k);
        this._glowDirty = true;
      }
    }
    if (this._glowDirty) this._writeGlow();
    for (const p of this.live.values()) if (p.atlasGen !== this.atlas.generation) { this._refreshSigns(); break; }
  }

  /** Counts for the probes. */
  get counts() {
    let buildings = 0, signs = 0, colliders = 0;
    for (const p of this.live.values()) {
      colliders += p.colliders.length;
      signs += p.signRecs.length;
      buildings += p.layout.filter((it) => !it.light).length;
    }
    return { live: this.live.size, buildings, signs, colliders, lamps: this.lamps.length, glows: this.glow.count };
  }
}

const _c = new THREE.Color();

/**
 * Geometry appended into one buffer, each piece through its own matrix.
 * With `paint`, a piece's roof and wall vertices (`aMask` 1 and 2) are
 * multiplied by the colours given -- which is how one archetype makes a
 * street of different houses without an instance attribute.
 */
class Merger {
  constructor(masked) {
    this.masked = masked;
    this.p = []; this.n = []; this.c = []; this.m = []; this.w = []; this.s = [];
    this.count = 0;
  }

  add(geo, matrix, roof = null, wall = null) {
    const P = geo.attributes.position.array, N = geo.attributes.normal.array;
    const C = geo.attributes.color.array, M = geo.attributes.aMask ? geo.attributes.aMask.array : null;
    const e = matrix.elements;
    const r = roof === null ? null : _c.setHex(roof).toArray([]);
    const w = wall === null ? null : _c.setHex(wall).toArray([]);
    /* The normal turns with the upper 3x3 and is renormalised: the scaled
     * unit boxes are scaled along their own axes, which leaves a box's
     * face normals pointing the same way. */
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      this.p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13],
                  e[2] * x + e[6] * y + e[10] * z + e[14]);
      const nx = N[i], ny = N[i + 1], nz = N[i + 2];
      let ax = e[0] * nx + e[4] * ny + e[8] * nz, ay = e[1] * nx + e[5] * ny + e[9] * nz;
      let az = e[2] * nx + e[6] * ny + e[10] * nz;
      const l = Math.hypot(ax, ay, az) || 1;
      this.n.push(ax / l, ay / l, az / l);
      const k = i / 3, mask = M ? M[k] : 0;
      const tint = mask > 1.5 ? w : (mask > 0.5 ? r : null);
      if (tint) this.c.push(C[i] * tint[0], C[i + 1] * tint[1], C[i + 2] * tint[2]);
      else this.c.push(C[i], C[i + 1], C[i + 2]);
      if (this.masked) this.m.push(mask);
    }
    this.count += P.length / 3;
  }

  /** A window kit, with its building's seed on every vertex. */
  addWindows(geo, matrix, seed) {
    const P = geo.attributes.position.array, W = geo.attributes.aWin.array;
    const e = matrix.elements;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      this.p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13],
                  e[2] * x + e[6] * y + e[10] * z + e[14]);
      this.w.push(W[i], W[i + 1], W[i + 2]);
      this.s.push(seed);
    }
    this.count += P.length / 3;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    if (this.w.length) {
      g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.w, 3));
      g.setAttribute('aSeed', new THREE.Float32BufferAttribute(this.s, 1));
    } else {
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      if (this.masked) g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.m, 1));
    }
    g.computeBoundingSphere();
    return g;
  }
}

/** The matrix for a scaled unit shape: `{ x, y, z, sx, sy, sz, yaw }`. */
function scaled(b) {
  _p.set(b.x, b.y, b.z);
  _q.setFromAxisAngle(_up, b.yaw);
  return _m.compose(_p, _q, _s.set(b.sx, b.sy, b.sz));
}

/** A sign's atlas rectangle, with its width negated if it is lit from
 *  within -- one bit carried in a sign the shader takes `abs` of anyway. */
function litRect(r, lit) {
  return lit ? [r[0], r[1], -r[2], r[3]] : r;
}

function cellOf(x, z) {
  return (Math.floor(x / CELL) + 0x100000) * 0x200000 + (Math.floor(z / CELL) + 0x100000);
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
