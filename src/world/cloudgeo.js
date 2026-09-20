import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CLOUD_UNIFORMS, CLOUD_PARS } from './cloudfield.js';
import { PAL } from '../core/palette.js';
import { hashFloat } from '../core/rng.js';

/* ------------------------------------------------------------------ *
 * The cloud layer, drawn.
 *
 * `clouds.js` marches the field volumetrically and is the better *physics*
 * by a distance.  It is also photographic -- soft gradients, continuous
 * shading, no edge anywhere -- and everything under the horizon is the
 * opposite: three flat bands of light, a cool hue shift in shadow, and a
 * line around every silhouette.  The sky read as a photograph pasted
 * behind a drawing.  `prompt_2.md` asks for the other thing: simple
 * geometric shapes, cel shaded, with the same ink.
 *
 * So this is not a repair of the march and it does not pretend to be one.
 * It is a different picture, and the march is still there behind
 * `?clouds=march` for as long as that is worth having.
 *
 * **What it keeps.**  `cloudfield.js` is the contract -- one field, four
 * consumers, and a cloud you can see is the cloud whose shadow you drive
 * through and the cloud the rain falls out of.  Every cluster below is
 * placed by the *same test the march makes*, on the same texture, at the
 * same drift: `cloudShape(f) > cut`.  Nothing in that file changes, the
 * ground shadow is untouched, and `w.cloud` still means that fraction of
 * the sky.
 *
 * **Where it draws.**  Into this layer's own target, like the march, and
 * composited by the same quad at depth exactly 1.0 -- which paints every
 * pixel the world has not drawn into and skips the rest, for free.  That
 * matters more here than it did there: `camera.far` is about 2 km and the
 * deck is at 1150 m *above* the camera, so a cloud thirty degrees up is
 * already past the far plane and one at the horizon is twelve kilometres
 * out.  Cloud geometry in the main scene would have to be squeezed into
 * the last few hundred metres of a depth buffer it shares with a 1.9 km
 * ridge, which is exactly where cloud bottoms meet the skyline.  A
 * separate target means a separate camera -- near 200, far 45000 -- and
 * the clouds can simply be where they are.
 *
 * It also means the world's ink never sees them: `uFadeEnd` is 900 m and
 * `uSkyDepth` cuts at 1900, so this layer is outside the post pass's reach
 * by construction.  The lines below are its own, from the same second
 * difference of depth, with their own weight and their own fade.
 *
 * **No backticks below this line** -- the shaders are template literals
 * and one in a GLSL comment ends it.  `clouds.js` and `cloudfield.js`
 * carry the same warning and it has been earned twice.
 * ------------------------------------------------------------------ */

/** Height of the deck's nominal base above the camera, metres. */
const BASE = 1150;
/** ... and the nominal top.  Individual clouds vary either side of both. */
const TOP = 1800;

/**
 * How far out clouds are placed, and where they have finished turning into
 * haze.
 *
 * These two are one number in two places and have to stay that way.  The
 * field ends somewhere, and wherever it ends there is a boundary -- so the
 * boundary is put where a cloud is already indistinguishable from the sky
 * behind it, and then it cannot be seen.  A cloud at twenty kilometres is
 * most of an atmosphere away; the march reaches further only because
 * marching further costs it nothing but iterations.
 */
const RANGE = 17000;
const FADE_FROM = 5000;
const FADE_TO = RANGE;

/**
 * The scan, as rings of cells.
 *
 * A cloud is decided per cell: one deterministic jitter for its centre,
 * one look at the field, in or out.  Uniform cells would be the honest
 * thing and are unaffordable at this range -- 22 km of 600 m cells is
 * four thousand of them and most of the accepted ones would be a handful
 * of pixels each.  So the cell grows with distance, which is the same
 * argument `chunks.js` makes for the ground and for the same reason: what
 * a cell is standing in for is an angular size, not a size.
 *
 * The cloud built in a coarse cell is correspondingly bigger, so the sky
 * fraction is preserved on average even though the individual clouds near
 * the horizon are fewer and larger than they should be.  That is the one
 * place this model knowingly departs from the field, and it departs from
 * it where everything is half haze anyway.
 */
const RINGS = [
  { to: 5000, cell: 470, lobes: 6, share: 0.42 },
  { to: 10000, cell: 900, lobes: 4, share: 0.34 },
  { to: RANGE, cell: 1500, lobes: 2, share: 0.24 },
];

/** The most lobes any ring asks for, which is what the buffers are sized to. */
const LOBES = 6;

/**
 * A cloud's half-width, **as a fraction of its cell**, at no strength and
 * at full.
 *
 * Tied to the cell, and it has to be.  The test is the field's own
 * quantile cut, so the fraction of cells that accept is `w.cloud` -- which
 * means the sky fraction comes out right only if an accepted cell's cloud
 * covers about one cell's worth of sky.  `pi * r^2 = cell^2` puts the mean
 * radius at 0.56 of the cell, which is what these two average to.
 *
 * **In proportion, and that is the correction.**  The radius grew as the
 * 0.55 power of the cell to begin with, which is a coverage that falls
 * away as the square root of the ring: the far ring's clouds covered 43 %
 * of the sky they were standing in for, and an overcast came out as a
 * ceiling directly above the car with pale empty sky from about fifteen
 * degrees down to the horizon.  Which is most of the sky, and the half an
 * overcast is most obviously an overcast in.
 */
const RAD_MIN = 0.42;
const RAD_SPAN = 0.28;

/**
 * The silhouette test's own margin.
 *
 * `coverage()` in the march smoothsteps across `uCloudSoft` either side of
 * the cut; a cell either has a cloud in it or does not, so the smoothstep
 * becomes a threshold and the softness becomes *size*: a cell that clears
 * the cut by nothing gets the smallest cloud the model draws, and one that
 * clears it by this much gets the largest.
 */
const FULL_AT = 0.16;

/* ------------------------------------------------------------------ *
 * The cluster.
 *
 * Six lobes on a flattened ellipsoidal envelope, the lower half squashed
 * so the base is nearly flat -- which is the one thing every cumulus in
 * `ref/cloud/` has in common, and the thing a ball of spheres does not
 * have unless it is told to.  The lobes are instances of one icosahedron,
 * so the whole layer is a single draw call and the variety is in the
 * per-instance matrices rather than in the geometry.
 * ------------------------------------------------------------------ */

/** Where lobe `i` of cloud `seed` sits, in units of the cloud's radius. */
function lobe(seed, i, out) {
  const a = hashFloat(seed, i, 11) * Math.PI * 2;
  const r = 0.30 + 0.52 * hashFloat(seed, i, 12);
  /* The first lobe is the body and sits at the middle; the rest ring it.
   * Without the body a cloud is a wreath, which is what the first build of
   * this was -- six lobes on a circle and a hole in the middle of every
   * one of them. */
  const rr = i === 0 ? 0 : r;
  out.x = Math.cos(a) * rr;
  out.z = Math.sin(a) * rr * 0.8;
  /* Higher toward the middle: the tops pile up over the body and the
   * outliers stay down on the base, which is the cauliflower profile the
   * march gets out of its height-dependent cut. */
  out.y = 0.30 + (1 - rr) * 0.34 * hashFloat(seed, i, 13);
  out.s = (i === 0 ? 0.62 : 0.30 + 0.26 * hashFloat(seed, i, 14));
  return out;
}

const LOBE_VERT = /* glsl */ `
  attribute vec3 aCentre;      // the cloud's own centre, world metres
  attribute float aFade;       // 0 at the range boundary, 1 up close
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vDist;
  varying float vFade;
  varying float vUp;

  void main() {
    vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
    /* The lobes are squashed -- wider than tall -- so the instance matrix
     * has a non-uniform scale in it and its upper 3x3 is not a rotation.
     * Dividing by the squared column lengths is the inverse transpose
     * without building one: for T * R * S with S diagonal, that is all it
     * is.  Without it every base shades as though it were a sphere and
     * the flattening does not read at all. */
    vec3 sc = vec3( length( instanceMatrix[ 0 ].xyz ),
                    length( instanceMatrix[ 1 ].xyz ),
                    length( instanceMatrix[ 2 ].xyz ) );
    vNormal = normalize( mat3( modelMatrix ) * mat3( instanceMatrix )
                         * ( normal / ( sc * sc ) ) );
    vec4 mv = viewMatrix * wp;
    vView = normalize( -mv.xyz );
    vDist = length( wp.xyz - cameraPosition );
    vFade = aFade;
    /* How far up its own cloud this fragment is, for the base shading.
     * Off the instance rather than off the lobe, so a low lobe is dark all
     * over rather than dark only at its own bottom. */
    vUp = clamp( ( wp.y - aCentre.y ) * 0.004 + 0.5, 0.0, 1.0 );
    gl_Position = projectionMatrix * mv;
  }
`;

const LOBE_FRAG = /* glsl */ `
  uniform vec3 uSunDir, uSunCol, uAmbient, uHaze, uTint, uShadowTint;
  uniform float uNight, uExposure, uHeavy;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vDist;
  varying float vFade;
  varying float vUp;

  void main() {
    vec3 n = normalize( vNormal );
    float ndl = dot( n, uSunDir );

    /* The ramp, and it is the *high-key* one -- 168 / 212 / 255 out of
     * toon.js, the ramp that file keeps for pale masses that have to stay
     * light on their shadow side.  A cloud shaded on the ground's own
     * three bands goes grey at the first step and a grey cumulus in
     * daylight is a rain cloud. */
    float band = ndl > 0.42 ? 1.0 : ( ndl > -0.08 ? 0.78 : 0.56 );

    /* Undersides are darker than shadow sides: a cumulus base is lit by
     * the ground and by whatever gets through the cloud above it, and
     * flattening that into the sun term alone is what makes a cel cloud
     * read as a paper cut-out.  It is also most of what stops a
     * fair-weather sky reading as a ceiling of popcorn, because from
     * underneath a cumulus field is mostly bases.
     *
     * **And how dark the base is, is the weather.**  This is the one thing
     * a cel model cannot get from geometry: an overcast is not more cloud,
     * it is cloud you cannot see through, and what you are looking at from
     * below is the part of it no light has reached.  Without the term the
     * layer drew a rainstorm as a field of bright fair-weather cumulus --
     * the same sky as the fair preset, which carries the same cloud
     * fraction and differs only in what is falling out of it. */
    float baseLit = mix( 0.66, 0.34, uHeavy );
    band *= baseLit + ( 1.0 - baseLit ) * vUp;

    /* The cool shift in the dark band, exactly as shadowTint does it for
     * every lit material in the world: the shadow is a different hue and
     * not a darker copy, which is most of what separates cel from
     * low-poly. */
    /* **And it is halved on the way in.**  The target is eight bits and
     * the pipeline is linear, so the ambient plus the key on a white tint
     * is about 1.65 -- and every band above the darkest clips to the same
     * white, which is a cloud shaded correctly and then thrown away by
     * the buffer.  It was: three bands went in and one came out.  Half
     * puts a lit top at about 0.95 and a shaded base at 0.46, which is
     * the two-to-one a cumulus actually has.  (The march never met this
     * because it integrates transmittance and arrives from below.) */
    vec3 lit = uSunCol * band * mix( uShadowTint, vec3( 1.0 ), band );
    vec3 col = uTint * ( uAmbient + lit * uExposure );

    /* A silver lining, and it is the one piece of the march worth keeping
     * by hand: light that has come *through* the edge of a cloud, so it
     * lands where the sun is behind the cloud and the surface is turning
     * away from the eye.  Without it a backlit cumulus is a flat grey
     * shape, which is the one sky everybody recognises as fake. */
    float rim = pow( max( 0.0, dot( vView, -uSunDir ) ), 3.0 )
      * pow( 1.0 - abs( dot( n, vView ) ), 1.6 );
    col += uSunCol * rim * 0.55 * uExposure;

    /* Aerial perspective, by true distance.  The layer's camera is not the
     * world's, so three's fog is no use here and is switched off -- this
     * is the same fade the march does, and it is what lets the blue show
     * through between the far clouds instead of a grey deck. */
    float haze = smoothstep( ${FADE_FROM.toFixed(1)}, ${FADE_TO.toFixed(1)}, vDist );
    col = mix( col, uHaze, haze * 0.94 );

    gl_FragColor = vec4( col, vFade );
  }
`;

/* ------------------------------------------------------------------ *
 * The ink, the cirrus and the rain, in one pass over the layer's target.
 *
 * The ink is the world's own: a second difference of linearised depth,
 * the formula out of `core/post.js`, so the sky and the ground cannot
 * drift apart the way two hand-tuned edge detectors would.  It draws the
 * silhouette against the sky -- a depth step is a second difference, which
 * is what `plan_1.md` had to learn the hard way -- and it draws the
 * creases where two lobes of a cluster meet, which is the line a drawing
 * of a cloud actually has.
 *
 * The cirrus and the rain shafts ride along because they are already
 * single taps rather than marched, and because this is exactly where they
 * were composited in the march: behind the cumulus, so neither can put a
 * rim on anything.
 * ------------------------------------------------------------------ */
const SKY_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D tCloud, tDepth;
  uniform vec2 uTexel;
  uniform float uNear, uFar;
  uniform vec3 uInk;
  uniform float uThickness, uSens, uInkFade, uInkGone;
  uniform vec3 uCamPos, uHaze, uAmbient;
  uniform mat4 uInvVP;
  uniform float uRainVisible, uCirrus, uNight;
  varying vec2 vUv;

  ${CLOUD_PARS}

  float linearDepth( vec2 uv ) {
    float d = texture2D( tDepth, uv ).x;
    return -perspectiveDepthToViewZ( d, uNear, uFar );
  }

  void main() {
    vec4 src = texture2D( tCloud, vUv );

    /* --- what is behind the cumulus ---------------------------------- *
     * Only where no cloud has drawn.  Both terms are lifted from the
     * march, constants and all: the cirrus cap above ten degrees of
     * elevation (a sheet at constant altitude is a plane, and a plane at a
     * grazing angle draws as a sunburst of streaks converging on the
     * zenith -- it did), and the shaft sampled once at the height where a
     * curtain reads rather than integrated. */
    vec3 back = vec3( 0.0 );
    float backA = 0.0;
    if ( src.a < 0.999 ) {
      vec4 a = uInvVP * vec4( vUv * 2.0 - 1.0, -1.0, 1.0 );
      vec4 b = uInvVP * vec4( vUv * 2.0 - 1.0, 1.0, 1.0 );
      vec3 dir = normalize( b.xyz / b.w - a.xyz / a.w );

      /* Cirrus first: it is at seven kilometres and thirty-five away at
       * the elevations where the two overlap, so the shaft goes in front
       * of it and the cumulus in front of both. */
      if ( uCirrus > 0.001 && dir.y > 0.17 ) {
        float tC = min( 7000.0 / dir.y, 26000.0 );
        vec2 cp = uCamPos.xz + dir.xz * tC;
        vec2 q = vec2( cp.x * 0.866 - cp.y * 0.5, cp.x * 0.5 + cp.y * 0.866 );
        float f1 = cloudRaw3( vec2( q.x * 0.30, q.y * 1.05 ) ).z;
        float f2 = cloudRaw3( vec2( q.x * 1.10, q.y * 0.34 ) + 91.0 ).z;
        float fib = f1 * 0.68 + f2 * 0.32;
        backA = smoothstep( 0.46, 0.78, fib ) * uCirrus
          * smoothstep( 0.17, 0.42, dir.y ) * ( 1.0 - uNight * 0.7 );
        back = mix( uHaze, vec3( 1.0 ), 0.35 );
      }

      if ( uRainVisible > 0.001 && dir.y > 0.004 ) {
        vec2 sp = uCamPos.xz + dir.xz * ( ( uCloudBase * 0.45 ) / dir.y );
        float veil = cloudRain( sp ) * uRainVisible
          * smoothstep( 0.004, 0.05, dir.y )
          * ( 1.0 - smoothstep( 0.16, 0.42, dir.y ) ) * 0.55;
        back = mix( back, mix( uHaze, uAmbient, 0.35 ), veil );
        backA = veil + backA * ( 1.0 - veil );
      }
    }

    /* --- the ink ------------------------------------------------------ *
     * Whole texels: tDepth is NEAREST, so a fractional tap does not draw a
     * finer line, it draws the same line with the fetch snapped -- and at
     * half a texel it draws a different line in every other column.  See
     * ink() in core/post.js, which is where that was paid for. */
    vec2 t = uTexel * max( 1.0, floor( uThickness + 0.5 ) );
    float dc = linearDepth( vUv );
    float edge = 0.0;
    if ( dc < uFar * 0.999 || src.a > 0.001 ) {
      float dl = linearDepth( vUv - vec2( t.x, 0.0 ) );
      float dr = linearDepth( vUv + vec2( t.x, 0.0 ) );
      float du = linearDepth( vUv + vec2( 0.0, t.y ) );
      float dd = linearDepth( vUv - vec2( 0.0, t.y ) );
      float sx = ( dl + dr - 2.0 * dc ) / dc;
      float sy = ( du + dd - 2.0 * dc ) / dc;
      float convex = max( 0.0, sx ) + max( 0.0, sy );
      float concave = max( 0.0, -sx ) + max( 0.0, -sy );
      edge = smoothstep( uSens * 0.3, uSens, convex );
      edge = max( edge, smoothstep( uSens * 1.6, uSens * 5.0, concave ) * 0.55 );
      /* Into the haze with everything else.  A line on a cloud that is
       * itself nine tenths sky is a line drawn on nothing, and the world
       * below does exactly this from 260 m. */
      edge *= 1.0 - smoothstep( uInkFade, uInkGone, dc );
    }

    /* Cloud over cirrus over sky, then ink over all three.  The alpha is
     * what the composite blends with, so the line has to carry its own --
     * that is what lets it sit half outside the silhouette, the way the
     * world's ink sits half outside a tree. */
    vec3 col = mix( back, src.rgb, src.a );
    float a = src.a + backA * ( 1.0 - src.a );
    vec3 ink = mix( uInk, col * 0.42, 0.22 );
    float outA = max( a, edge );
    col = ( col * a * ( 1.0 - edge ) + ink * edge ) / max( 1e-4, outA );

    if ( outA < 0.002 ) discard;
    gl_FragColor = vec4( col, outA );
  }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/* The composite.  Depth exactly 1.0, `depthTest` on and `depthWrite` off:
 * the buffer is cleared to 1.0, so LEqual passes on every pixel nothing
 * has drawn into and fails on every pixel the terrain has.  The layer
 * paints the sky and skips the world, with no mask and no depth fetch --
 * and the stars and the moon, which draw earlier and write no depth, end
 * up behind it per pixel.  Straight out of `clouds.js`. */
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

const _white = new THREE.Color(1, 1, 1);
const _lobe = { x: 0, y: 0, z: 0, s: 1 };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export class CloudGeo {
  /**
   * @param {THREE.Scene} scene  the world's scene, for the composite quad
   * @param {object} o
   * @param {CloudField} o.field
   * @param {number} o.clouds  the budget, in six-lobe clusters -- so the
   *   layer will draw *more* clusters than this, because the far rings
   *   spend four lobes and two rather than six.  The quality knob, and
   *   the only one that matters: the layer draws at the target's own
   *   resolution because the lines want it and because geometry this
   *   cheap can pay for it.
   * @param {number} o.detail  icosahedron subdivision per lobe: 1 is a
   *   rounded lump at 80 triangles, 0 is a faceted one at 20.
   */
  constructor(scene, { field = null, clouds = 320, detail = 1 } = {}) {
    this.field = field;
    this.max = clouds;

    this.rt = new THREE.WebGLRenderTarget(2, 2, {
      depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
    });
    this.rt.depthTexture = new THREE.DepthTexture(2, 2);
    this.rt.depthTexture.format = THREE.DepthFormat;
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.rt.depthTexture.minFilter = THREE.NearestFilter;
    this.rt.depthTexture.magFilter = THREE.NearestFilter;

    /* The layer's own scene and its own camera.  Near 200 because nothing
     * here is ever closer than the deck's base, far 45000 because the
     * range is 22 km and a cloud at the horizon is further than it looks;
     * a ratio of 225 leaves the depth buffer plenty for clouds to occlude
     * each other, which is the only thing it is asked to do. */
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(66, 1, 200, 45000);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uAmbient: { value: new THREE.Color(0.5, 0.55, 0.6) },
        uHaze: { value: new THREE.Color(0.8, 0.85, 0.9) },
        uTint: { value: new THREE.Color(PAL.cloud) },
        uShadowTint: { value: new THREE.Color(0x8e9ec4) },
        uNight: { value: 0 },
        uExposure: { value: 0.5 },
        uHeavy: { value: 0 },
      },
      vertexShader: LOBE_VERT,
      fragmentShader: LOBE_FRAG,
      transparent: true,
      fog: false,
    });

    const geo = new THREE.IcosahedronGeometry(1, detail);
    this.mesh = new THREE.InstancedMesh(geo, this.mat, this.max * LOBES);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const n = this.max * LOBES;
    this.aCentre = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.aFade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aCentre', this.aCentre);
    geo.setAttribute('aFade', this.aFade);
    this.scene.add(this.mesh);

    this.sky = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        tCloud: { value: this.rt.texture },
        tDepth: { value: this.rt.depthTexture },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: this.cam.near },
        uFar: { value: this.cam.far },
        uInk: { value: new THREE.Color(PAL.ink) },
        uThickness: { value: 1 },
        /* Thirty times the ground's 0.0026, and swept rather than
         * guessed.  What the threshold chooses here is not whether there
         * are lines but *which* lines: the silhouette against the sky is a
         * depth step of tens of kilometres and fires at any setting, while
         * the creases where two lobes of one cluster meet are a few metres
         * of depth over a texel and fire only down at the bottom of the
         * range.  At 0.02 every lobe was outlined and a cloud overhead
         * read as a bunch of grapes; at 0.25 only the outer silhouette
         * survives and the cluster goes flat.  0.08 keeps the billow
         * that separates one lobe from the next and drops the rest, which
         * is what a drawing of a cumulus has in it. */
        uSens: { value: 0.08 },
        /* And the lines go into the haze well before the clouds do.
         *
         * A cluster at fifteen kilometres is a few pixels of thin sliver,
         * and an outline around it is not a line, it is a scribble: the
         * far sky over the horizon came out covered in little pen marks
         * that moved with the drive.  The world below does the same thing
         * for the same reason -- ink from 260 m, gone by 900, against a
         * 1400 m view -- so the layer fades its lines over the middle
         * third of its own range and lets the far cloud be a shape in the
         * haze, which is what it is. */
        uInkFade: { value: 3000 },
        uInkGone: { value: 9000 },
        uCamPos: { value: new THREE.Vector3() },
        uInvVP: { value: new THREE.Matrix4() },
        uRainVisible: { value: 0 },
        uCirrus: { value: 0 },
        uNight: { value: 0 },
      }, CLOUD_UNIFORMS, {
        /* `uHaze` and `uAmbient` are this layer's, not the field's -- the
         * field block has no such names, but assigning it wholesale would
         * hide them if it ever grew any. */
        uHaze: { value: new THREE.Color(0.8, 0.85, 0.9) },
        uAmbient: { value: new THREE.Color(0.5, 0.55, 0.6) },
      }),
      vertexShader: QUAD_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.skyQuad = new FullScreenQuad(this.sky);

    this.composite = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { tCloud: { value: null } },
        vertexShader: COMP_VERT,
        fragmentShader: COMP_FRAG,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        fog: false,
      }));
    this.composite.frustumCulled = false;
    /* After the moon (-890) and the stars (-900), before the world. */
    this.composite.renderOrder = -880;
    scene.add(this.composite);

    /* The inked target, which is what the composite reads. */
    this.out = new THREE.WebGLRenderTarget(2, 2, {
      depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.NoColorSpace,
    });
    this.composite.material.uniforms.tCloud.value = this.out.texture;

    /** Where the field was when the instances were last built. */
    this._at = new THREE.Vector3(NaN, NaN, NaN);
    this._ofs = new THREE.Vector2(NaN, NaN);
    this._cut = NaN;
    this.count = 0;
    this._dayInk = new THREE.Color(PAL.ink);
    this._prevClear = new THREE.Color();
    /** Candidate clouds, reused: a rebuild sorts them and keeps the
     *  nearest `max`.  Without the sort the cap truncates in scan order,
     *  which takes the clouds off one side of the sky. */
    this._cand = [];
  }

  setSize(w, h) {
    const rw = Math.max(2, Math.round(w));
    const rh = Math.max(2, Math.round(h));
    this.rt.setSize(rw, rh);
    this.out.setSize(rw, rh);
    this.sky.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    /* One device pixel of line at the scene's own scale, rounded to whole
     * texels in the shader for the reason given there. */
    this.sky.uniforms.uThickness.value = 1 + 0.5 * Math.min(2, rw / 1280);
  }

  /** Nothing is accumulated, so there is nothing to forget.  Kept so the
   *  governor and the recorder can call the same method on either layer. */
  reset() { this._at.set(NaN, NaN, NaN); }

  /**
   * Colours for this frame, and the cloud set if it has moved on.
   *
   * The colour half is the march's, line for line, because it was right
   * and because a cloud lit out of a different palette from the ground is
   * the fault this whole layer exists to fix.
   */
  update(camera, atmos, w, clock) {
    const u = this.mat.uniforms;
    u.uSunDir.value.copy(clock.sun.dir);
    /* Sunlight is white; the warmth in `PAL.sun` is what the atmosphere
     * does to it on the way to the ground, and a cloud at 1500 m has had
     * less of that done to it than a verge has.  So the tint comes out in
     * daylight and stays in at the horizon, which is when it is real. */
    u.uSunCol.value.copy(atmos.key.colour)
      .lerp(_white, 0.55 * clock.daylight)
      .multiplyScalar(0.55 + 0.85 * Math.max(0, Math.min(1.6, atmos.key.level)));
    /* And the ambient is *sky*: the underside of a cumulus is lit by the
     * dome above it and the ground below it, and the dome is blue.  In a
     * real sky the dark pixels are the coloured ones. */
    u.uAmbient.value.copy(atmos.mid).lerp(atmos.cloud.tint, 0.18)
      .multiplyScalar(0.62);
    u.uHaze.value.copy(atmos.haze);
    u.uNight.value = clock.night;
    /* How thick the deck is.  `w.cloud` is a fraction of *sky* and says
     * nothing about depth, so a rainstorm and a fair afternoon can carry
     * the same number -- `rain` and `fair` both sit at 0.52 -- and the
     * rain has to come in on its own.  The march gets this for free out
     * of `uDensity` and an integral; here it is two knobs, the tint and
     * how dark the bases go. */
    const heavy = Math.max(smooth01(((w ? w.cloud : 0) - 0.45) / 0.45),
                           Math.min(1, (w ? w.rain : 0) * 1.4));
    u.uHeavy.value = heavy;
    u.uTint.value.copy(_cloudTint).multiplyScalar(1 - 0.42 * heavy);

    const s = this.sky.uniforms;
    s.uHaze.value.copy(atmos.haze);
    s.uAmbient.value.copy(u.uAmbient.value);
    s.uCamPos.value.copy(camera.position);
    s.uNight.value = clock.night;
    s.uRainVisible.value = Math.min(1, (w ? w.rain : 0) * 1.4)
      * (0.25 + 0.75 * clock.daylight);
    s.uCirrus.value = (w ? w.cirrus ?? Math.max(0, 0.55 - w.cloud * 0.6) : 0)
      * (0.25 + 0.75 * clock.daylight);
    /* The ink goes near-black at night for the same reason `post.setNight`
     * takes the world's there: `PAL.ink` is lighter than a moonlit cloud,
     * so a slate line on a dark sky is a *pale* line, and cel shading
     * comes out inverted. */
    s.uInk.value.copy(this._dayInk).lerp(_black, clock.night);

    /* The layer's camera: the world's, with a frustum that can hold a
     * cloud.  Copied rather than shared, because changing `near` and
     * `far` on the world's camera would change what the ink and the depth
     * buffer mean everywhere else. */
    const c = this.cam;
    c.position.copy(camera.position);
    c.quaternion.copy(camera.quaternion);
    c.fov = camera.fov;
    c.aspect = camera.aspect;
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    s.uInvVP.value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).invert();

    this._place(camera.position);
  }

  /**
   * Rebuild the instance set, when it is worth rebuilding.
   *
   * Placement is a pure function of (the field, the drift, where the
   * camera is), so a rebuild produces the same clouds in the same places
   * and nothing pops except at the range boundary -- which is why the
   * boundary is out where a cloud is already the colour of the sky.
   *
   * The threshold is in metres of camera movement rather than in frames
   * because that is what actually changes the answer: at 30 m/s a 240 m
   * step is eight seconds, and the near ring's cells are 470 m across.
   * The cut gets a tolerance of its own -- it moves continuously while
   * the weather blends, and without one every frame of a change would be
   * a full rescan.
   */
  _place(eye) {
    const f = this.field;
    if (!f) return;
    const ofs = f.ofs;
    const cut = CLOUD_UNIFORMS.uShapeCut.value;
    if (Math.abs(eye.x - this._at.x) < 240 && Math.abs(eye.z - this._at.z) < 240
        && Math.abs(ofs.x - this._ofs.x) < 240 && Math.abs(ofs.y - this._ofs.y) < 240
        && Math.abs(cut - this._cut) < 0.004) return;
    this._at.copy(eye);
    this._ofs.copy(ofs);
    this._cut = cut;

    const mix = CLOUD_UNIFORMS.uShapeMix.value;
    const base = CLOUD_UNIFORMS.uCloudBase.value;
    const mat = this.mesh.instanceMatrix.array;
    const ctr = this.aCentre.array;
    const fade = this.aFade.array;
    const cand = this._cand;
    cand.length = 0;

    /* A cut this high is `CUT_EMPTY`: the sky is clear and no sample can
     * reach it, so skip the scan rather than walk fourteen hundred cells
     * to be told so. */
    /* The budget is in *lobes*, not in clouds, and it is spent ring by
     * ring.
     *
     * Nearest-first over the whole sky is the wrong cap here and it is
     * worth saying why, because it is the obvious one: the far ring holds
     * most of the cells and each of its clouds stands for a much larger
     * piece of sky, so a global cap spends everything on the near ring and
     * empties the horizon -- which is precisely the half of the sky an
     * overcast is read from.  Each ring gets a share, unspent share falls
     * through to the next, and inside a ring it is nearest first. */
    let budget = this.max * LOBES;
    let off = 0;
    let clouds = 0;
    let from = 0;
    if (cut < 1.5) {
      for (let r = 0; r < RINGS.length; r++) {
        const ring = RINGS[r];
        const cell = ring.cell;
        const span = Math.ceil(ring.to / cell);
        const cx = Math.floor(eye.x / cell), cz = Math.floor(eye.z / cell);
        cand.length = 0;
        for (let j = -span; j <= span; j++) {
          for (let i = -span; i <= span; i++) {
            const ix = cx + i, iz = cz + j;
            /* The cell's own point, jittered inside it so the field is not
             * sampled on a lattice -- a grid of clouds reads as a grid
             * however good each cloud is. */
            const x = (ix + 0.18 + 0.64 * hashFloat(ix, iz, 3)) * cell;
            const z = (iz + 0.18 + 0.64 * hashFloat(ix, iz, 4)) * cell;
            const d = Math.hypot(x - eye.x, z - eye.z);
            if (d < from || d >= ring.to) continue;

            /* The march's own test, on the march's own field. */
            const f0 = f.rawAt(x, z, 0);
            const f2 = f.rawAt(x, z, 2);
            const v = f0 + (f2 - 0.5) * mix;
            if (v <= cut) continue;

            cand.push({
              x, z, d,
              rad: cell * (RAD_MIN + RAD_SPAN * Math.min(1, (v - cut) / FULL_AT)),
              f1: f.rawAt(x, z, 1),
              f2,
              seed: ((ix * 73856093) ^ (iz * 19349663)) >>> 0,
              rot: hashFloat(ix, iz, 5) * Math.PI * 2,
            });
          }
        }
        from = ring.to;

        cand.sort((a, b) => a.d - b.d);
        /* This ring's share of what is left, except on the last one, which
         * takes the remainder: shares that do not add to one would
         * otherwise leave lobes unspent for no reason. */
        const lobes = ring.lobes;
        const share = r === RINGS.length - 1
          ? budget
          : Math.min(budget, Math.floor(this.max * LOBES * ring.share));
        const take = Math.min(cand.length, Math.floor(share / lobes));

        for (let c = 0; c < take; c++) {
          const q = cand[c];
          /* Base and thickness out of the same two channels the march
           * hangs them on, so no two clouds sit on one base and no two are
           * the same height. */
          const y = eye.y + base - (q.f1 - 0.5) * 220 - (q.f2 - 0.5) * 160;
          const thick = (TOP - BASE) * (0.38 + 0.62 * smooth01((q.f2 - 0.28) / 0.40));
          const fv = 1 - smooth01((q.d - FADE_TO * 0.86) / (FADE_TO * 0.14));

          for (let k = 0; k < lobes; k++) {
            /* Always out of the same six, so a cloud does not change shape
             * when it crosses a ring boundary -- it loses its outliers and
             * keeps its body, which at that distance is a pixel or two. */
            lobe(q.seed, k, _lobe);
            _p.set(_lobe.x * q.rad, _lobe.y * thick, _lobe.z * q.rad);
            _p.applyAxisAngle(_up, q.rot);
            _p.set(q.x + _p.x, y + _p.y, q.z + _p.z);
            /* Fewer lobes have to cover the same cloud, or a far cluster is
             * a body with nothing around it and the ring shows as a step
             * in cloud size. */
            const fat = 1 + (LOBES - lobes) * 0.055;
            _s.set(_lobe.s * q.rad * fat, _lobe.s * thick * 1.15, _lobe.s * q.rad * fat);
            _e.set(hashFloat(q.seed, k, 6) * 3, hashFloat(q.seed, k, 7) * 3, 0);
            _q.setFromEuler(_e);
            _m.compose(_p, _q, _s);
            _m.toArray(mat, off * 16);
            ctr[off * 3] = q.x; ctr[off * 3 + 1] = y; ctr[off * 3 + 2] = q.z;
            fade[off] = fv;
            off++;
          }
          budget -= lobes;
          clouds++;
        }
      }
    }

    this.count = clouds;
    this.mesh.count = off;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aCentre.needsUpdate = true;
    this.aFade.needsUpdate = true;
  }

  /** The layer, then the ink.  Both before the main render. */
  render(renderer) {
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(this._prevClear);
    const prevAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.cam);

    renderer.setRenderTarget(this.out);
    renderer.clear(true, false, false);
    this.skyQuad.render(renderer);

    renderer.setClearColor(this._prevClear, prevAlpha);
    renderer.setRenderTarget(prev);
  }

  /**
   * What fraction of the sky is cloud, off the GPU.
   *
   * The same measurement `Clouds.coverFraction` makes, on the same half of
   * the frame and with the same definition, so the two layers can be put
   * in one table against `w.cloud`.  Read off `rt` rather than `out`: the
   * ink has its own alpha and would count a line as cover.
   *
   * This is the probe that says the placement still honours
   * `cloudfield.js`'s one invariant -- that `w.cloud` is a fraction of
   * sky and not a number that happens to look right.
   */
  coverFraction(renderer, above = 0.5) {
    const w = this.rt.width, h = this.rt.height;
    const buf = new Uint8Array(w * h * 4);
    const prev = renderer.getRenderTarget();
    renderer.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
    renderer.setRenderTarget(prev);
    let n = 0, cov = 0;
    for (let y = Math.floor(h * above); y < h; y++) {
      for (let x = 0; x < w; x++) { cov += buf[(y * w + x) * 4 + 3] / 255; n++; }
    }
    return n ? cov / n : 0;
  }

  dispose() {
    this.rt.dispose();
    this.out.dispose();
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.sky.dispose();
    this.skyQuad.dispose();
  }
}

const _up = new THREE.Vector3(0, 1, 0);

const _black = new THREE.Color(0x090b11);
const _cloudTint = new THREE.Color(PAL.cloud);

function smooth01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
