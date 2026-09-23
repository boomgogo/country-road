import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PAL } from './palette.js';

/* ------------------------------------------------------------------ *
 * The 3D-to-2D pipeline.
 *
 *   scene  ->  rtScene (colour + depth texture)
 *          ->  look pass   : screen-space line work from the depth buffer,
 *                            then colour grade + linear->sRGB
 *          ->  fxaa pass   : clean up the line work, straight to screen
 *
 * or, when the scene is drawn smaller than the screen (see `setSize`):
 *
 *   scene  ->  rtScene
 *          ->  look pass   : the ink's *strength* only, into alpha
 *          ->  up pass     : upscale to device pixels, ink redrawn sharp
 *                            at that resolution, grade + linear->sRGB
 *
 * Ported from `ref/dp-sakura-crossing` (MIT, same author), retuned for a
 * landscape at 30 m/s rather than a townscape at walking pace.
 *
 * Lines come from a *second difference* of linearised depth.  A first
 * difference smears ink across the road wherever the surface grazes the
 * camera; the second difference is flat across any planar surface however
 * oblique, so it fires only on real silhouettes and real creases.
 *
 * Two things had to change for open country, and both were predicted in
 * `plan_0.md`:
 *
 *  - **Distances.**  The town's 40-98 m ink fade and 420 m sky cutoff are
 *    nothing here; a road runs to the horizon and the fade has to run
 *    with it.
 *
 *  - **The grazing horizon.**  A big field of ground seen almost edge-on
 *    is this pass's worst case: the second difference is small but the
 *    *distance normalisation* divides by a large depth, so noise in the
 *    depth buffer comes back as sparkle across the whole lower frame.  A
 *    slope term, taken from the depth gradient the pass already has,
 *    desensitises exactly where the surface is oblique and leaves the
 *    silhouettes alone.
 * ------------------------------------------------------------------ */

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/* The last of the picture, shared by the look pass and the up pass: the
 * ink's colour, the grade, and the encode.  Everything here is per pixel
 * and none of it reads a texture, which is what lets the up pass run it at
 * the screen's resolution on a scene drawn at a smaller one. */
const FINISH = /* glsl */ `
    vec3 inkMix( vec3 col, float edge ) {
      // ink keeps a whisper of the underlying hue so it never looks pasted on
      vec3 line = mix( uInk, col * 0.42, 0.22 );
      return mix( col, line, edge );
    }

    /* ---- the grade ---- */
    vec3 grade( vec3 c ) {
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

      // split-tone: cool in the darks, warm paper white in the lights
      float k = smoothstep( 0.02, 0.55, l );
      c *= mix( uShadowTint, uLightTint, k );
      c += vec3( uWarmth, uWarmth * 0.45, 0.0 ) * l * 0.35;
      c = c + uLift * ( 1.0 - k );
      c = mix( vec3( l ), c, uSaturation );

      float r = length( vUv - 0.5 ) * 1.42;
      c *= 1.0 - uVignette * pow( clamp( r, 0.0, 1.0 ), 2.6 );
      return c;
    }

    vec3 linearToSRGB( vec3 c ) {
      return mix( c * 12.92,
                  1.055 * pow( max( c, vec3( 0.0031308 ) ), vec3( 1.0 / 2.4 ) ) - 0.055,
                  step( 0.0031308, c ) );
    }

    vec3 finish( vec3 c ) {
      #ifdef GRADE
        c = grade( c );
      #endif
      return linearToSRGB( max( c, vec3( 0.0 ) ) );
    }
`;

/* The ink and the grade, in one full-screen pass.
 *
 * They were two, with a half-float render target between them, and the
 * only thing the grade ever did with the ink's output was read it back one
 * texel at a time -- so the target was a whole frame of memory and a whole
 * frame of fill spent on passing a colour from one function to the next.
 * On integrated graphics a full-screen pass is about a millisecond at
 * 1080p.  The maths is unchanged; `INK` and `GRADE` are defines, so the
 * `O` and `G` keys still take each one out on its own. */
const LOOK = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNear: { value: 0.4 },
    uFar: { value: 2000 },
    uInk: { value: new THREE.Color(PAL.ink) },
    uThickness: { value: 1.3 },
    uSens: { value: 0.0026 },
    uConcave: { value: 0.020 },
    uConcaveAmount: { value: 0.38 },
    uFadeStart: { value: 260.0 },
    uFadeEnd: { value: 900.0 },
    uStrength: { value: 1.0 },
    uSkyDepth: { value: 1900.0 },
    uSlope: { value: 1.4 },

    uShadowTint: { value: new THREE.Color(0xb3bdd6) },
    uLightTint: { value: new THREE.Color(0xfff8ea) },
    uSaturation: { value: 1.10 },
    uLift: { value: 0.026 },
    uVignette: { value: 0.13 },
    uWarmth: { value: 0.04 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uNear, uFar;
    uniform vec3 uInk;
    uniform float uThickness, uSens, uConcave, uConcaveAmount;
    uniform float uFadeStart, uFadeEnd, uStrength, uSkyDepth, uSlope;
    uniform vec3 uShadowTint, uLightTint;
    uniform float uSaturation, uLift, uVignette, uWarmth;
    varying vec2 vUv;

    float linearDepth( vec2 uv ) {
      float d = texture2D( tDepth, uv ).x;
      return -perspectiveDepthToViewZ( d, uNear, uFar );
    }

    /* ---- the ink: screen-space line work from the depth buffer ----
     * How much ink this texel gets, 0..1.  Split from the mix below so the
     * up pass can carry it to device pixels on its own; see UP. */
    float inkEdge() {
      /* **Whole texels, and the rounding belongs here rather than in
       * setSize.**  (No backticks in this comment: it is inside a template
       * literal, and one would end it.  See cloudfield.js, same trap.)
       *
       * tDepth is NEAREST on both axes, so a fractional tap does not draw a
       * finer line -- it draws the same line with the fetch snapped.  At
       * *half* a texel it does something worse: a fragment centre is at
       * ( i + 0.5 ) / rw, so a tap of 1.5 texels lands at ( i + 2.0 ) / rw,
       * exactly on the boundary between two texels, and which side the
       * float sum falls on flips with the column.  The second difference
       * below is then taken one texel wide here and two texels wide there,
       * and on ground seen edge-on -- where the depth gradient is steep
       * enough for one texel to matter -- that crosses uSens and inks it.
       * The frame comes out under a grid of dark bars and rungs, vertical
       * from the x tap and horizontal from the y.  See ai/plan_1.md: a
       * sweep of this uniform is flat everywhere except a spike at 1.5 and
       * a smaller one at 2.5, which is the shape of a tie and not of a
       * threshold being grazed.
       *
       * setSize writes 1.0 + 0.5 * scale, which is exactly 1.5 at a render
       * scale of exactly 1 -- where the medium tier starts, where the high
       * tier's governor bottoms out, and where scaleFor's pixel budget puts
       * any tier on a window past about four megapixels.  Rounding here
       * covers all three, and covers setNight and anything else that ever
       * writes the uniform directly.
       *
       * The cost is that the line weight steps between one texel and two
       * instead of sliding.  That is not a regression, it is what a NEAREST
       * fetch was always doing; it just used to do it per column.
       *
       * floor( x + 0.5 ) and not round(): these shaders compile as GLSL ES
       * 1.00, which has no round(). */
      vec2 t = uTexel * max( 1.0, floor( uThickness + 0.5 ) );
      float dc = linearDepth( vUv );

      if ( dc > uSkyDepth ) return 0.0;

      float dl = linearDepth( vUv - vec2( t.x, 0.0 ) );
      float dr = linearDepth( vUv + vec2( t.x, 0.0 ) );
      float du = linearDepth( vUv + vec2( 0.0, t.y ) );
      float dd = linearDepth( vUv - vec2( 0.0, t.y ) );

      // second difference of linear depth, normalised by distance
      float sx = ( dl + dr - 2.0 * dc ) / dc;
      float sy = ( du + dd - 2.0 * dc ) / dc;

      /* How oblique the surface is, from the first difference.  Ground
       * running away toward the horizon has a huge gradient and no real
       * edges in it; raising the threshold there is what stops the whole
       * lower half of the frame sparkling. */
      float grad = ( abs( dr - dl ) + abs( du - dd ) ) / dc;
      float sens = uSens * ( 1.0 + uSlope * grad * 40.0 );

      float convex  = max( 0.0,  sx ) + max( 0.0,  sy );
      float concave = max( 0.0, -sx ) + max( 0.0, -sy );

      float edge = smoothstep( sens * 0.32, sens, convex );
      edge = max( edge, smoothstep( uConcave, uConcave * 3.4, concave ) * uConcaveAmount );

      // let the background dissolve into the haze instead of getting busy
      edge *= 1.0 - smoothstep( uFadeStart, uFadeEnd, dc );
      edge *= uStrength;
      return clamp( edge, 0.0, 1.0 );
    }

    ${FINISH}

    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      #ifdef SPLIT
        /* The up pass finishes the picture.  Linear colour and the ink's
         * strength, into a half-float target: the grade is not linear, so
         * the ink has to be mixed in before it, and that happens there. */
        float e = 0.0;
        #ifdef INK
          e = inkEdge();
        #endif
        gl_FragColor = vec4( c, e );
      #else
        #ifdef INK
          c = inkMix( c, inkEdge() );
        #endif
        gl_FragColor = vec4( finish( c ), 1.0 );
      #endif
    }
  `,
};

/* The upscale, for a scene drawn smaller than the screen.
 *
 * `prompt_4.md`: "on my phone and on my old Surface Go, the rendering can
 * get quite blurry".  It was, by construction.  The canvas was sized in
 * CSS pixels on every device, so a DPR-3 phone had its picture stretched
 * three times by the compositor -- bilinear, and after FXAA had already
 * softened it once -- and with the governor at its floor the scene was a
 * fifth of the panel.  The canvas is now the size of the panel (see
 * `outFor`), and this pass is what fills it from a scene that is not.
 *
 * Two different upscales, because the picture is two different things:
 *
 *  - **The colour** is bilinear with its weights pulled toward the
 *    nearest texel by `uCrisp`.  Fully that way, each scene texel is a
 *    flat square with a one-pixel ramp at its edge (the "sharp bilinear"
 *    of pixel-art scalers); fully the other, plain bilinear.  A cel
 *    picture is mostly flat fills, so it stands a good deal of this
 *    before it starts to look like a mosaic.
 *
 *  - **The ink** is redrawn.  The look pass leaves how much ink each
 *    scene texel gets in alpha.  Reconstructed with a cubic B-spline,
 *    that is a smooth field whose half-height contour is where the line's
 *    edge belongs, and a smoothstep one *device* pixel wide across that
 *    contour puts a hard edge exactly there.  So a line keeps its width
 *    and its curve and loses the ramp -- which on a phone was two and a
 *    half device pixels of grey either side of every line in the frame.
 *    The contour is taken of the field divided by its local peak, so a
 *    line that is faint because it is far away, or at night, or concave,
 *    is still faint, and only its edge is sharpened.
 *
 *    B-spline and not bilinear, and this was seen before it was reasoned
 *    about: the edge field is close to binary per texel, so a diagonal
 *    line in it is a staircase, and the contour of a *bilinear* staircase
 *    is a staircase with sharp corners -- at the Surface Go's governor
 *    floor, steps two and a half device pixels tall along every ridge.
 *    The spline rounds them off.  Its weights are chosen so the
 *    half-height contour of a two-texel line falls exactly on the line's
 *    two edges, and a one-texel line comes out about nine tenths as wide.
 *
 * Four point taps for the colour and four filtered taps for the spline
 * (the GPU Gems 2 construction: sixteen texels, four bilinear reads).  No
 * FXAA in this route: its job was the ink's stair-steps, and the ink is
 * now drawn at a resolution that has none. */
const UP = {
  uniforms: {
    tDiffuse: { value: null },
    uSrcSize: { value: new THREE.Vector2(1, 1) },
    uRatio: { value: 1 },
    uCrisp: { value: 0.55 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSrcSize;
    uniform float uRatio, uCrisp;
    uniform vec3 uInk;
    uniform vec3 uShadowTint, uLightTint;
    uniform float uSaturation, uLift, uVignette, uWarmth;
    varying vec2 vUv;

    ${FINISH}

    void main() {
      vec2 p = vUv * uSrcSize - 0.5;
      vec2 b = floor( p );
      vec2 f = p - b;
      vec2 d = 1.0 / uSrcSize;
      vec2 t0 = ( b + 0.5 ) * d;
      vec4 s00 = texture2D( tDiffuse, t0 );
      vec4 s10 = texture2D( tDiffuse, t0 + vec2( d.x, 0.0 ) );
      vec4 s01 = texture2D( tDiffuse, t0 + vec2( 0.0, d.y ) );
      vec4 s11 = texture2D( tDiffuse, t0 + d );

      vec2 fc = mix( f, clamp( ( f - 0.5 ) * uRatio + 0.5, 0.0, 1.0 ), uCrisp );
      vec3 c = mix( mix( s00.rgb, s10.rgb, fc.x ), mix( s01.rgb, s11.rgb, fc.x ), fc.y );

      #ifdef INK
        vec2 f2 = f * f, f3 = f2 * f;
        vec2 w0 = ( 1.0 - 3.0 * f + 3.0 * f2 - f3 ) / 6.0;
        vec2 w1 = ( 4.0 - 6.0 * f2 + 3.0 * f3 ) / 6.0;
        vec2 w2 = ( 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3 ) / 6.0;
        vec2 w3 = f3 / 6.0;
        vec2 g0 = w0 + w1, g1 = w2 + w3;
        vec2 c0 = ( b - 0.5 + w1 / g0 ) * d;
        vec2 c1 = ( b + 1.5 + w3 / g1 ) * d;
        float e = g0.y * ( g0.x * texture2D( tDiffuse, c0 ).a
                         + g1.x * texture2D( tDiffuse, vec2( c1.x, c0.y ) ).a )
                + g1.y * ( g0.x * texture2D( tDiffuse, vec2( c0.x, c1.y ) ).a
                         + g1.x * texture2D( tDiffuse, c1 ).a );
        float peak = max( max( s00.a, s10.a ), max( s01.a, s11.a ) );
        /* A device pixel wide, and a little more as the ratio grows: past
         * about 2x a shallow line's steps are long enough to see as jogs,
         * and a softer edge is the cheapest thing that hides them. */
        float w = min( 0.5, 0.5 / uRatio + 0.06 * max( 0.0, uRatio - 1.5 ) / uRatio );
        float edge = peak > 1e-4 ? peak * smoothstep( 0.5 - w, 0.5 + w, e / peak ) : 0.0;
        c = inkMix( c, edge );
      #endif
      gl_FragColor = vec4( finish( c ), 1.0 );
    }
  `,
};

const FXAA = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    float luma( vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
    void main() {
      vec3 cM = texture2D( tDiffuse, vUv ).rgb;
      vec3 cNW = texture2D( tDiffuse, vUv + vec2( -uTexel.x, -uTexel.y ) ).rgb;
      vec3 cNE = texture2D( tDiffuse, vUv + vec2(  uTexel.x, -uTexel.y ) ).rgb;
      vec3 cSW = texture2D( tDiffuse, vUv + vec2( -uTexel.x,  uTexel.y ) ).rgb;
      vec3 cSE = texture2D( tDiffuse, vUv + vec2(  uTexel.x,  uTexel.y ) ).rgb;
      float lM = luma( cM ), lNW = luma( cNW ), lNE = luma( cNE ),
            lSW = luma( cSW ), lSE = luma( cSE );
      float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
      float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
      vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ),
                        ( ( lNW + lSW ) - ( lNE + lSE ) ) );
      float reduce = max( ( lNW + lNE + lSW + lSE ) * 0.25 * 0.18, 1.0 / 128.0 );
      float rcp = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + reduce );
      dir = clamp( dir * rcp, vec2( -8.0 ), vec2( 8.0 ) ) * uTexel;
      vec3 rgbA = 0.5 * ( texture2D( tDiffuse, vUv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb +
                          texture2D( tDiffuse, vUv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
      vec3 rgbB = rgbA * 0.5 + 0.25 * ( texture2D( tDiffuse, vUv - dir * 0.5 ).rgb +
                                        texture2D( tDiffuse, vUv + dir * 0.5 ).rgb );
      float lB = luma( rgbB );
      gl_FragColor = vec4( ( lB < lMin || lB > lMax ) ? rgbA : rgbB, 1.0 );
    }
  `,
};

function makeQuad(def, uniforms = THREE.UniformsUtils.clone(def.uniforms)) {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: def.vertexShader,
    fragmentShader: def.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  return { quad: new FullScreenQuad(mat), mat };
}

export class Pipeline {
  constructor(renderer, scene, camera, { pixelBudget = 4.2e6, maxScale = 1.75 } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.pixelBudget = pixelBudget;
    this.maxScale = maxScale;
    this.size = new THREE.Vector2(1, 1);
    /** The canvas's own size, in device pixels.  See `outFor`. */
    this.out = new THREE.Vector2(1, 1);
    /** `'fxaa'`, the route the picture always took, or `'up'` when the
     *  scene is drawn smaller than the canvas.  See `setSize`. */
    this.mode = 'fxaa';

    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.rtScene = new THREE.WebGLRenderTarget(2, 2, opts);
    this.rtScene.depthTexture = new THREE.DepthTexture(2, 2);
    this.rtScene.depthTexture.format = THREE.DepthFormat;
    this.rtScene.depthTexture.type = THREE.UnsignedIntType;
    this.rtScene.depthTexture.minFilter = THREE.NearestFilter;
    this.rtScene.depthTexture.magFilter = THREE.NearestFilter;

    this.rtB = new THREE.WebGLRenderTarget(2, 2, {
      ...opts, type: THREE.UnsignedByteType, depthBuffer: false,
    });

    this.look = makeQuad(LOOK);
    this.fxaa = makeQuad(FXAA);
    this.look.mat.uniforms.tDepth.value = this.rtScene.depthTexture;
    this.look.mat.defines = { INK: '', GRADE: '' };
    /* The up route's two passes.  `lookSplit` is the look pass compiled
     * the other way, and it shares the look pass's uniforms *object*, so
     * `setNight`, the ink probes and anything else that writes a look
     * uniform write both at once.  Two materials rather than one with a
     * define flipped, because the governor can cross between the routes
     * mid-drive and a recompile there is a hitch. */
    this.lookSplit = makeQuad(LOOK, this.look.mat.uniforms);
    this.lookSplit.mat.defines = { SPLIT: '', INK: '', GRADE: '' };
    const lu = this.look.mat.uniforms;
    const upU = THREE.UniformsUtils.clone(UP.uniforms);
    for (const k of ['uInk', 'uShadowTint', 'uLightTint', 'uSaturation', 'uLift', 'uVignette', 'uWarmth']) {
      upU[k] = lu[k];
    }
    this.up = makeQuad(UP, upU);
    this.up.mat.defines = { INK: '', GRADE: '' };
    /* Linear colour plus the ink's strength, so half float: an 8-bit
     * target would band the grade, which now runs after it.  Made on
     * first use -- a desktop at its own resolution never needs it. */
    this.rtUp = null;
    this.enabled = { ink: true, grade: true, fxaa: true };
    /* The daytime settings, kept so `setNight` can interpolate back to
     * them rather than accumulating drift across a game-year. */
    this.day = {
      sat: LOOK.uniforms.uSaturation.value,
      lift: LOOK.uniforms.uLift.value,
      warmth: LOOK.uniforms.uWarmth.value,
      shadow: this.look.mat.uniforms.uShadowTint.value.clone(),
      ink: this.look.mat.uniforms.uStrength.value,
      inkFade: this.look.mat.uniforms.uFadeStart.value,
      inkColour: this.look.mat.uniforms.uInk.value.clone(),
    };
    this._nightShadow = new THREE.Color(0x5a6c96);
    /* Near-black, for the ink at night.  See `setNight`. */
    this._nightInk = new THREE.Color(0x090b11);
  }

  /**
   * Take the grade, and the ink, into the night.
   *
   * The ink half is the one that needed finding.  Lines come from a second
   * difference of *depth*, so they are exactly as strong at midnight as at
   * noon -- but the scene underneath them has a fraction of the contrast,
   * so the same line weight that reads as drawing by day reads as a
   * scribble over a dark hillside by night.  Backing off the strength and
   * pulling the fade in is most of the fix.
   *
   * @param night  0..1 from the clock
   * @param grade  the atmosphere's own lift/gain/saturation
   */
  setNight(night, grade = null) {
    const g = this.look.mat.uniforms;
    const d = this.day;
    if (grade) {
      g.uSaturation.value = d.sat * grade.sat;
      g.uLift.value = d.lift + grade.lift;
    }
    /* Everything is *more* blue at night and less warm, which is a
     * perceptual fact rather than a stylistic one -- scotopic vision
     * shifts toward blue, and rendering a night scene warm is why so many
     * of them look like a day scene behind sunglasses. */
    g.uShadowTint.value.copy(d.shadow).lerp(this._nightShadow, night * 0.8);
    g.uWarmth.value = d.warmth * (1 - 0.85 * night);

    /* The ink, and this is the half that had to be *seen* to be found.
     *
     * `uInk` is a fixed slate blue -- 0x2f3341 -- which is darker than a
     * daylit hillside and a good deal *lighter* than a moonlit one.  So
     * after dark every silhouette in the frame came back as a pale outline
     * on black: the car, the trees, and every single blade of grass, drawn
     * in glowing pencil.  Cel shading inverted.
     *
     * Backing the strength off is not enough on its own, because faint
     * light lines on black are still light lines.  The ink has to go
     * *darker than the scene*, which at night means near-black -- at which
     * point the lines correctly stop being visible, because at night you
     * cannot see the outline of a hillside either. */
    const i = this.look.mat.uniforms;
    i.uStrength.value = d.ink * (1 - 0.55 * night);
    i.uFadeStart.value = d.inkFade * (1 - 0.45 * night);
    i.uInk.value.copy(d.inkColour).lerp(this._nightInk, night);
  }

  /**
   * The scale a `maxScale` of `limit` really draws at, for a w x h window.
   *
   * Capped by the screen's density and by the pixel budget, so two limits
   * can come out the same -- which `ResolutionGovernor` needs to know, or
   * it takes a step that changes nothing and concludes that stepping does
   * not help.  Below 1 is allowed now: that is the governor on a GPU that
   * cannot hold the frame rate at the window's own resolution.
   */
  /**
   * The canvas's resolution, as a multiple of CSS pixels.
   *
   * This was 1 everywhere: `setSize` set a pixel ratio of 1 and sized the
   * canvas to the window, whatever the screen.  On a desktop at DPR 1 that
   * is the panel.  On a Surface Go at 1.5 the compositor stretched the
   * finished frame half again, and on a phone at 2.75 nearly three times
   * -- over a scene that was already the smaller of the two.  So now it is
   * the screen's own density, to 2 (past which nobody can tell and every
   * pass costs the square of it), and to the same pixel budget as the
   * scene.  Never below 1, which is where it was.
   */
  outFor(w, h) {
    const dpr = window.devicePixelRatio || 1;
    let out = Math.min(dpr, 2);
    if (w * h * out * out > this.pixelBudget) out = Math.sqrt(this.pixelBudget / (w * h));
    return Math.max(1, out);
  }

  scaleFor(w, h, limit = this.maxScale) {
    const dpr = window.devicePixelRatio || 1;
    let scale = Math.min(limit, dpr < 1.5 ? 1.5 : Math.min(dpr, 2));
    if (w * h * scale * scale > this.pixelBudget) {
      scale = Math.max(Math.min(1, limit), Math.sqrt(this.pixelBudget / (w * h)));
    }
    return scale;
  }

  setSize(w, h) {
    const scale = this.scaleFor(w, h);
    this.scale = scale;
    const rw = Math.max(2, Math.floor(w * scale));
    const rh = Math.max(2, Math.floor(h * scale));
    this.size.set(rw, rh);
    const out = this.outFor(w, h);
    const ow = Math.max(2, Math.floor(w * out));
    const oh = Math.max(2, Math.floor(h * out));
    this.out.set(ow, oh);
    /* The route.  A scene within a few per cent of the canvas goes the
     * way it always went -- FXAA, which downsamples a supersampled scene
     * well enough and which every ink probe was tuned against.  A scene
     * visibly smaller than the canvas goes through the up pass. */
    this.mode = rw < ow * 0.95 ? 'up' : 'fxaa';

    this.renderer.setPixelRatio(1);
    /* `false`: the canvas's CSS size is the stylesheet's, 100 % of the
     * window.  This sets only its drawing buffer. */
    this.renderer.setSize(ow, oh, false);
    this.rtScene.setSize(rw, rh);
    this.rtB.setSize(rw, rh);
    if (this.mode === 'up') {
      if (!this.rtUp) {
        this.rtUp = new THREE.WebGLRenderTarget(rw, rh, {
          type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          depthBuffer: false, stencilBuffer: false, colorSpace: THREE.NoColorSpace,
        });
      }
      this.rtUp.setSize(rw, rh);
      const u = this.up.mat.uniforms;
      u.uSrcSize.value.set(rw, rh);
      u.uRatio.value = ow / rw;
      /* Crisp colour costs stair-steps on every hard colour edge -- the
       * road's paint, a fence against the sky -- and those grow with the
       * ratio.  Full crispness to 2x, easing to a quarter by 4x. */
      u.uCrisp.value = Math.min(0.55, Math.max(0.25, 0.55 - (ow / rw - 2) * 0.15));
    }

    const texel = new THREE.Vector2(1 / rw, 1 / rh);
    const look = this.look.mat.uniforms;
    look.uTexel.value.copy(texel);
    this.fxaa.mat.uniforms.uTexel.value.copy(texel);
    look.uNear.value = this.camera.near;
    look.uFar.value = this.camera.far;
    /* Scale the ink weight with resolution so lines stay ~2 device px.
     * The shader rounds this to whole texels before it taps -- it has to,
     * `tDepth` cannot be filtered -- so what this really chooses is one
     * texel below a render scale of 1 and two at or above it.  See `ink()`
     * for what a half-texel tap did before the rounding was there. */
    look.uThickness.value = 1.0 + 0.5 * scale;
  }

  /** The two switches are compile-time, so a toggle is a recompile --
   *  once, on a key press, and never in the frame. */
  _defines(m, extra) {
    if (('INK' in m.defines) === this.enabled.ink && ('GRADE' in m.defines) === this.enabled.grade) return;
    m.defines = { ...extra };
    if (this.enabled.ink) m.defines.INK = '';
    if (this.enabled.grade) m.defines.GRADE = '';
    m.needsUpdate = true;
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(this.scene, this.camera);

    if (this.mode === 'up') {
      const m = this.lookSplit.mat;
      this._defines(m, { SPLIT: '' });
      /* INK decides whether the look pass writes an edge at all; the up
       * pass's own INK only saves it the four alpha reads. */
      this._defines(this.up.mat, {});
      m.uniforms.tDiffuse.value = this.rtScene.texture;
      r.setRenderTarget(this.rtUp);
      this.lookSplit.quad.render(r);
      this.up.mat.uniforms.tDiffuse.value = this.rtUp.texture;
      r.setRenderTarget(null);
      this.up.quad.render(r);
      return;
    }

    const m = this.look.mat;
    this._defines(m, {});
    const last = this.enabled.fxaa ? this.rtB : null;
    m.uniforms.tDiffuse.value = this.rtScene.texture;
    r.setRenderTarget(last);
    this.look.quad.render(r);
    if (this.enabled.fxaa) {
      this.fxaa.mat.uniforms.tDiffuse.value = this.rtB.texture;
      r.setRenderTarget(null);
      this.fxaa.quad.render(r);
    }
    r.setRenderTarget(null);
  }

  dispose() {
    [this.rtScene, this.rtB, this.rtUp].forEach((rt) => rt && rt.dispose());
    [this.look, this.lookSplit, this.fxaa, this.up].forEach((p) => { p.quad.dispose(); p.mat.dispose(); });
  }
}
