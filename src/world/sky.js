import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * The sky.
 *
 * A gradient dome, and since iteration 4 that is *all* it is: the three
 * cloud sheets that used to hang inside it are gone, replaced by the
 * raymarched layer in `clouds.js`.  The dome is the important half
 * anyway -- a flat background colour is the single cheapest tell in a
 * landscape renderer, because the real thing is always lighter and warmer
 * at the horizon than overhead, and the eye reads the absence of that
 * before it reads anything else in the frame.
 *
 * The dome shader gained two things when the clock landed, and both are
 * functions of the view direction it already had in hand rather than new
 * passes:
 *
 *  - **the sun**, as a disc at its real angular size with a wide glow.
 *    The disc is about ten pixels; the *glow* is what actually reads, and
 *    it is what makes a sunset look like one.
 *
 *  - **the rainbow**, which is a pure function of the angle from the
 *    antisolar point and therefore belongs here and nowhere else.  Two
 *    constraints fall straight out of the physics and both are worth
 *    keeping: the bow only exists with the sun below 42 degrees, and its
 *    centre is always below the horizon while the sun is up -- so what
 *    you see is the *top of an arc*, which is what a rainbow looks like
 *    and what a faked one usually does not.
 *
 * The one honest limitation: the dome is behind everything, so a hill
 * occludes the bow rather than the bow standing in the rain in front of
 * the hill.  For a distant ridge that reads correctly.  For a near
 * cutting it will not, and fixing it properly means moving the bow into
 * the grade pass with a depth test.
 * ------------------------------------------------------------------ */

const DOME = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const DOME_FRAG = /* glsl */ `
  uniform vec3 uTop, uMid, uHaze;
  uniform float uHorizon;
  uniform vec3 uSunDir, uSunTint;
  uniform float uSunUp;        // 0 when the sun is well down: kills the glow
  uniform float uRainbow;
  varying vec3 vDir;

  /* Ordered dither.  A sky is the one surface in a scene that is *only*
   * gradient, so eight bits per channel across sixty degrees of arc puts a
   * visible step every few pixels -- "a vertical blue gradient with visible
   * banding" was one of the two most obvious faults in the early stills.
   * A third of a level
   * of noise, keyed to screen position, removes it completely. */
  float dither( vec2 p ) {
    return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  }

  /* One band of the bow.  w is where in the band we are, 0 at the inner
   * (violet) edge and 1 at the outer (red) one. */
  vec3 spectrum( float w ) {
    vec3 c = vec3( 0.0 );
    c += vec3( 0.42, 0.16, 0.72 ) * exp( -pow( ( w - 0.06 ) * 5.6, 2.0 ) );
    c += vec3( 0.16, 0.34, 0.92 ) * exp( -pow( ( w - 0.26 ) * 5.6, 2.0 ) );
    c += vec3( 0.22, 0.80, 0.34 ) * exp( -pow( ( w - 0.50 ) * 5.6, 2.0 ) );
    c += vec3( 0.98, 0.86, 0.22 ) * exp( -pow( ( w - 0.72 ) * 6.0, 2.0 ) );
    c += vec3( 0.96, 0.34, 0.18 ) * exp( -pow( ( w - 0.92 ) * 6.0, 2.0 ) );
    return c;
  }

  void main() {
    vec3 dir = normalize( vDir );
    float h = dir.y;
    vec3 c;
    if ( h > uHorizon ) {
      float t = clamp( ( h - uHorizon ) / ( 1.0 - uHorizon ), 0.0, 1.0 );
      // three stops: one linear ramp from horizon to zenith reads as a ramp
      float s = t * t * ( 3.0 - 2.0 * t );
      c = mix( uMid, uTop, s );
      // and a wide, soft haze lifting out of the horizon
      c = mix( c, uHaze, pow( 1.0 - t, 3.2 ) * 0.85 );
    } else {
      c = uHaze;
    }

    /* --- the sun ---------------------------------------------------- *
     * The disc is at its true angular radius, 0.267 degrees, which is a
     * handful of pixels; everything that makes a sunrise read is in the
     * two glow terms around it.  All of it is gated on uSunUp so a sun
     * an inch under the horizon does not leave a hard bright spot in the
     * ground haze. */
    float d = dot( dir, uSunDir );
    if ( uSunUp > 0.001 ) {
      float disc = smoothstep( 0.99996, 0.999989, d );
      float tight = pow( max( 0.0, d ), 320.0 );
      float wide  = pow( max( 0.0, d ), 7.0 );
      c += uSunTint * uSunUp * ( disc * 1.35 + tight * 0.55 + wide * 0.22 );
    }

    /* --- the rainbow ------------------------------------------------ *
     * Distance from the *antisolar* point, so the bow is centred exactly
     * opposite the sun and its centre goes below the horizon as the sun
     * rises -- which is what leaves the familiar arc. */
    if ( uRainbow > 0.001 ) {
      float a = degrees( acos( clamp( dot( dir, -uSunDir ), -1.0, 1.0 ) ) );
      // primary: violet inside at 40.7, red outside at 42.3
      float p = ( a - 40.7 ) / 1.6;
      // secondary: reversed, wider, fainter
      float s2 = 1.0 - ( a - 50.5 ) / 3.5;
      vec3 bow = vec3( 0.0 );
      if ( p > 0.0 && p < 1.0 ) bow += spectrum( p ) * 1.0;
      if ( s2 > 0.0 && s2 < 1.0 ) bow += spectrum( s2 ) * 0.30;
      /* A supernumerary just inside the primary -- faint, and the detail
       * that makes it look observed rather than drawn. */
      float sn = ( a - 39.3 ) / 1.3;
      if ( sn > 0.0 && sn < 1.0 ) bow += spectrum( sn ) * 0.13;
      /* Alexander's dark band: the sky between the two bows really is
       * darker, and leaving it out is why most faked bows look pasted on. */
      float alex = smoothstep( 42.4, 44.0, a ) * ( 1.0 - smoothstep( 48.5, 50.4, a ) );
      c *= 1.0 - alex * 0.10 * uRainbow;
      /* Fade out into the ground, where there is no rain curtain to see. */
      float above = smoothstep( -0.02, 0.10, dir.y );
      c += bow * uRainbow * above * 0.85;
    }

    c += ( dither( gl_FragCoord.xy ) - 0.5 ) / 255.0 * 1.5;
    gl_FragColor = vec4( c, 1.0 );
  }
`;

export class Sky {
  constructor(scene, radius = 3000) {
    this.uniforms = {
      uTop: { value: new THREE.Color(0x8fb6dd) },
      uMid: { value: new THREE.Color(0xcfe0ee) },
      uHaze: { value: new THREE.Color(0xdcebf2) },
      uHorizon: { value: 0.02 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunTint: { value: new THREE.Color(0xfff0d0) },
      uSunUp: { value: 1 },
      uRainbow: { value: 0 },
    };
    const geo = new THREE.SphereGeometry(radius, 32, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DOME,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    /* There used to be three textured sphere caps here, at three radii
     * and three drift rates, and they were the sky's clouds from the first
     * commit until this iteration.  They are gone: `clouds.js` marches a
     * real layer through the shared field instead.
     *
     * They are also, measured, where the seam was.  `tools/probe/seam.mjs`
     * on the previous build: the second difference of the row means peaks
     * at **8.11/255 at y=478**, five pixels off the horizon, in every
     * cloudy and rainy daylight hour.  Hide all three caps and it is
     * **0.66**; turn ink and grade off instead and it is **8.92**.
     * `next_3.md` §6 said "isolating the three cloud sheets one at a time
     * did not reproduce it" -- and that is true, because each cap has a
     * rim and hiding one leaves two. */
    /** Kept, and empty: `tools/probe/seam.mjs` hides the sheets to isolate
     *  them, and a probe that can still run against a build with no sheets
     *  in it is a probe that can measure the fix. */
    this.layers = [];
  }

  /**
   * One frame, and it is one line now.
   *
   * The dome follows the camera so its horizon is always at eye level;
   * everything else this used to do -- three tinted, drifting sheets --
   * moved to `clouds.js`.
   */
  update(dt, camera) {
    this.dome.position.copy(camera.position);
  }

  /** Palette.  The atmosphere model is the only caller. */
  set(top, mid, haze) {
    this.uniforms.uTop.value.set(top);
    this.uniforms.uMid.value.set(mid);
    this.uniforms.uHaze.value.set(haze);
  }

  /** Where the sun is, and how much bow to draw. */
  setSun(dir, tint, up) {
    this.uniforms.uSunDir.value.copy(dir);
    this.uniforms.uSunTint.value.copy(tint);
    this.uniforms.uSunUp.value = up;
  }

  setRainbow(strength) { this.uniforms.uRainbow.value = strength; }
}
