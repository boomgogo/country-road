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

    /* ---- the ink: screen-space line work from the depth buffer ---- */
    vec3 ink( vec3 col ) {
      vec2 t = uTexel * uThickness;
      float dc = linearDepth( vUv );

      if ( dc > uSkyDepth ) return col;

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

      // ink keeps a whisper of the underlying hue so it never looks pasted on
      vec3 line = mix( uInk, col * 0.42, 0.22 );
      return mix( col, line, clamp( edge, 0.0, 1.0 ) );
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

    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;
      #ifdef INK
        c = ink( c );
      #endif
      #ifdef GRADE
        c = grade( c );
      #endif
      gl_FragColor = vec4( linearToSRGB( max( c, vec3( 0.0 ) ) ), 1.0 );
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

function makeQuad(def) {
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(def.uniforms),
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

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.rtScene.setSize(rw, rh);
    this.rtB.setSize(rw, rh);

    const texel = new THREE.Vector2(1 / rw, 1 / rh);
    const look = this.look.mat.uniforms;
    look.uTexel.value.copy(texel);
    this.fxaa.mat.uniforms.uTexel.value.copy(texel);
    look.uNear.value = this.camera.near;
    look.uFar.value = this.camera.far;
    // scale ink weight with resolution so lines stay ~2 device px
    look.uThickness.value = 1.0 + 0.5 * scale;
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(this.scene, this.camera);

    /* The two switches are compile-time, so a toggle is a recompile --
     * once, on a key press, and never in the frame. */
    const m = this.look.mat;
    if (('INK' in m.defines) !== this.enabled.ink || ('GRADE' in m.defines) !== this.enabled.grade) {
      m.defines = {};
      if (this.enabled.ink) m.defines.INK = '';
      if (this.enabled.grade) m.defines.GRADE = '';
      m.needsUpdate = true;
    }
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
    [this.rtScene, this.rtB].forEach((rt) => rt.dispose());
    [this.look, this.fxaa].forEach((p) => { p.quad.dispose(); p.mat.dispose(); });
  }
}
