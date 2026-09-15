import * as THREE from 'three';
import { LAT } from './clock.js';
import { assetUrl } from '../core/assets.js';

/* ------------------------------------------------------------------ *
 * The night sky: five thousand real stars and a moon with a real phase.
 *
 * **The stars are a catalogue, not a noise function.**  `public/stars.bin`
 * is the Yale Bright Star Catalogue cut at V <= 6.0 -- 5080 stars, six
 * bytes each -- so Orion, Scorpius and Crux are where they are because
 * that is where they are.  See `tools/stars/build.mjs`.
 *
 * They are drawn as one `Points` in **equatorial** coordinates, and the
 * whole celestial sphere is turned by two rotations on the object's own
 * matrix: a spin about the pole for the time of night, and a fixed tilt
 * that puts the pole at the latitude.  So the per-frame cost of the star
 * field is two quaternion multiplies, whatever the star count -- there is
 * no per-star work anywhere, ever.
 *
 * The two rotations, derived rather than fiddled into place:
 *
 *   spin   about the local +Y (the celestial pole) by `-lst - PI/2`
 *   tilt   about the world +X by `LAT - PI/2`
 *
 * which together satisfy `sin(alt) = sin(lat)sin(dec) + cos(lat)cos(dec)
 * cos(H)` for every star, with `H = lst - ra`, to within 1e-6 degrees.
 * `tools/probe/sky.mjs` checks that against `Clock`'s own spherical
 * astronomy, star by star.
 *
 * At latitude -30 that puts the *south* celestial pole 30 degrees above
 * the southern horizon, with Crux and Carina circumpolar around it and
 * Orion standing on its head -- which is correct, and is the more
 * interesting sky.
 *
 * The moon is a country whose fragment shader reconstructs a sphere
 * from the quad and lights it with the true sun direction.  That is the
 * whole trick and it is why the crescent tilts correctly at every hour,
 * including lying on its back near the horizon -- the thing that looks
 * unmistakably wrong when a game fakes a phase with a sliding mask.
 * ------------------------------------------------------------------ */

/** Where the stars and the moon sit.  Inside the sky dome (radius ~1568)
 *  so the dome never draws over them, and inside the camera's far plane. */
const R = 1450;

/**
 * The moon, drawn at **2.5x** its true angular size.
 *
 * A real moon is 0.52 degrees across, which at a 68 degree field of view
 * is about ten pixels at 1080p -- too few to show a phase at all, and the
 * phase is the thing the brief actually asks for.  This is the only cheat
 * in the celestial model and it is deliberate; do not "fix" it.
 */
const MOON_SIZE = 2.5 * 0.26 * Math.PI / 180;   // angular radius, radians

const STAR_VERT = /* glsl */ `
  attribute float aMag;
  attribute float aBv;
  uniform float uPixel;
  uniform float uOpacity;
  uniform float uTime;
  varying vec3 vColour;
  varying float vAlpha;

  /* B-V colour index to something like the star's colour.  Rigel comes
   * out blue-white at -0.03 and Betelgeuse orange at 1.85, which is most
   * of what makes a real star field read as real rather than as a
   * scattering of white dots. */
  vec3 bvColour( float bv ) {
    float t = clamp( ( bv + 0.35 ) / 2.2, 0.0, 1.0 );
    vec3 hot  = vec3( 0.70, 0.80, 1.00 );
    vec3 mid  = vec3( 1.00, 0.98, 0.94 );
    vec3 cool = vec3( 1.00, 0.78, 0.58 );
    return t < 0.5 ? mix( hot, mid, t * 2.0 ) : mix( mid, cool, ( t - 0.5 ) * 2.0 );
  }

  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;

    /* Brightness from magnitude on the real 2.512 ratio, then flattened:
     * a linear flux scale puts Sirius twelve times brighter than a mag 3
     * star and the sky becomes six dots and a void. */
    float flux = pow( 2.512, -aMag );
    float b = pow( clamp( flux * 3.2, 0.0, 1.0 ), 0.42 );

    gl_PointSize = uPixel * ( 0.85 + 2.4 * b );

    /* Scintillation.  Keyed on the star's own position so each one
     * twinkles independently, and much stronger near the horizon, where
     * the real thing looks through a lot more air. */
    vec3 dir = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz );
    float horizon = 1.0 - clamp( dir.y * 3.2, 0.0, 1.0 );
    float tw = sin( uTime * 2.7 + position.x * 0.021 )
             * sin( uTime * 3.9 + position.z * 0.017 );
    float twinkle = 1.0 + tw * ( 0.06 + 0.34 * horizon );

    /* Atmospheric extinction: nothing is visible in the last couple of
     * degrees, which also hides the fact that the ground ends. */
    float extinct = smoothstep( -0.02, 0.14, dir.y );

    vColour = bvColour( aBv );
    vAlpha = b * twinkle * extinct * uOpacity;
  }
`;

const STAR_FRAG = /* glsl */ `
  varying vec3 vColour;
  varying float vAlpha;
  void main() {
    /* A soft round point.  gl_PointCoord is the only geometry a point
     * sprite has, and a hard square is instantly readable as one. */
    vec2 d = gl_PointCoord - 0.5;
    float r = length( d ) * 2.0;
    float a = ( 1.0 - smoothstep( 0.25, 1.0, r ) ) * vAlpha;
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( vColour, a );
  }
`;

const MOON_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const MOON_FRAG = /* glsl */ `
  uniform vec3 uSunLocal;
  uniform vec3 uTint;
  uniform float uOpacity;
  uniform float uEarthshine;
  varying vec2 vUv;

  /* Cheap crater mottle.  Without it a lit moon is a flat white disc,
   * which reads as a hole in the sky rather than as a body. */
  float mottle( vec2 p ) {
    return fract( sin( dot( p, vec2( 41.7, 23.3 ) ) ) * 7841.13 );
  }

  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r2 = dot( q, q );
    if ( r2 > 1.0 ) discard;

    /* The quad is a *sphere*: reconstruct the normal from the disc, with
     * +Z out of the quad and therefore toward the viewer.  Lighting that
     * normal with the true sun direction -- transformed into this quad's
     * own frame on the CPU -- gives the real terminator, at the real
     * tilt, for free at every hour of the night. */
    vec3 n = vec3( q, sqrt( max( 0.0, 1.0 - r2 ) ) );
    float lam = dot( n, normalize( uSunLocal ) );

    /* A soft terminator: the moon's limb darkening is nothing like
     * Lambert, and a hard edge looks like a shape cut out of paper. */
    float lit = smoothstep( -0.09, 0.16, lam );

    float grain = 0.86 + 0.14 * mottle( floor( q * 13.0 ) );
    /* Earthshine -- the dark side is never entirely dark, and putting a
     * little light there is what makes a thin crescent read as a sphere
     * rather than as a fingernail. */
    vec3 col = uTint * grain * ( lit + uEarthshine * ( 1.0 - lit ) );

    /* Feather the limb by one pixel's worth of the disc, or it aliases
     * horribly against a dark sky. */
    float edge = 1.0 - smoothstep( 0.90, 1.0, sqrt( r2 ) );
    gl_FragColor = vec4( col, uOpacity * edge * max( lit, uEarthshine * 0.9 ) );
  }
`;

const _v = new THREE.Vector3();
const _qi = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);

export class Celestial {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.frustumCulled = false;
    scene.add(this.group);

    /* ------------------------------ stars ------------------------------ */
    this.starUniforms = {
      uPixel: { value: 2.0 },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
    };
    const starMat = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    /* Transparent, so it renders after the opaque pass -- and therefore
     * depth-tests against terrain that has already been drawn, which is
     * what makes a hill hide the stars behind it. */
    this.stars = new THREE.Points(new THREE.BufferGeometry(), starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -900;
    this.stars.visible = false;
    this.group.add(this.stars);
    this.count = 0;

    /* ------------------------------ moon ------------------------------- */
    this.moonUniforms = {
      uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
      uTint: { value: new THREE.Color(0xf4f1e6) },
      uOpacity: { value: 0 },
      uEarthshine: { value: 0.055 },
    };
    const size = 2 * R * Math.tan(MOON_SIZE);
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.ShaderMaterial({
        uniforms: this.moonUniforms,
        vertexShader: MOON_VERT,
        fragmentShader: MOON_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      }));
    this.moon.frustumCulled = false;
    this.moon.renderOrder = -890;
    this.moon.visible = false;
    this.group.add(this.moon);

    /** Resolves when the catalogue is in, so the load screen can wait. */
    this.ready = this.load();
  }

  /** Fetch and unpack the catalogue.  Resolves either way -- a night with
   *  no stars is a great deal better than a game that does not start. */
  async load(url = assetUrl('stars.bin')) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('stars.bin ' + res.status);
      const raw = new DataView(await res.arrayBuffer());
      const n = Math.floor(raw.byteLength / 6);
      const pos = new Float32Array(n * 3);
      const mag = new Float32Array(n);
      const bv = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * 6;
        const ra = (raw.getInt16(o, true) / 32768) * Math.PI * 2;
        const dec = (raw.getInt16(o + 2, true) / 32768) * Math.PI * 2;
        mag[i] = raw.getUint8(o + 4) / 20 - 2;
        bv[i] = raw.getUint8(o + 5) / 100 - 0.5;
        /* Equatorial frame: +Y is the celestial pole, and RA runs from +X
         * toward **−Z**.  That minus sign is not cosmetic and it cost an
         * hour: with RA running the other way the map from equatorial to
         * horizon coordinates has determinant −1 -- it is a *reflection*,
         * not a rotation -- so no pair of object rotations can express it.
         * The symptom was a sky whose altitudes were all exactly right and
         * whose azimuths were all mirrored east for west, which looks
         * completely plausible until you notice Orion rising in the west.
         * See `tools/probe/sky.mjs`, which checks this star by star. */
        const c = Math.cos(dec);
        pos[i * 3] = R * c * Math.cos(ra);
        pos[i * 3 + 1] = R * Math.sin(dec);
        pos[i * 3 + 2] = -R * c * Math.sin(ra);
      }
      const geo = this.stars.geometry;
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
      geo.setAttribute('aBv', new THREE.BufferAttribute(bv, 1));
      geo.computeBoundingSphere();
      this.count = n;
      return n;
    } catch (err) {
      console.warn('[stars]', err.message);
      return 0;
    }
  }

  /**
   * One frame.
   *
   * @param clock   the time model
   * @param camera  the sky follows the eye, like the dome
   * @param cloud   0..1; stars and moon are only visible through a gap
   * @param pixelRatio for a point size that means the same thing on any
   *                display -- a 2 px point on a retina panel is a speck
   */
  update(clock, camera, cloud = 0, pixelRatio = 1) {
    this.group.position.copy(camera.position);

    const night = clock.night;
    /* How much sky there is to see through.
     *
     * A linear `1 - cloud` leaves an overcast night with a tenth of its
     * stars still showing through the deck, which is a tenth more than
     * overcast means.  A smoothstep closes it properly by the time the
     * cover is a solid sheet, and still leaves a good scatter visible
     * through the gaps of a half-covered sky. */
    const clear = 1 - smoothstep(0.15, 0.80, cloud);

    /* --- stars --------------------------------------------------------- */
    const starOp = night * clear;
    this.stars.visible = starOp > 0.004 && this.count > 0;
    if (this.stars.visible) {
      this.starUniforms.uOpacity.value = starOp;
      this.starUniforms.uTime.value = clock.t;
      this.starUniforms.uPixel.value = 1.7 * pixelRatio;
      /* Spin about the pole for the hour, then tilt the pole to the
       * latitude.  `multiply` applies the spin first. */
      _qi.setFromAxisAngle(_Y, -clock.lst - Math.PI / 2);
      this.stars.quaternion.setFromAxisAngle(_X, LAT - Math.PI / 2);
      this.stars.quaternion.multiply(_qi);
    }

    /* --- moon ---------------------------------------------------------- *
     * Invisible by day, as the brief asks -- a real daytime moon is not,
     * but the fade rides `clock.night`, which is exactly the gradual
     * sunrise/sunset fade it asks for.  Below the horizon it is simply
     * gone, which the dome would otherwise not hide. */
    const moonOp = night * (0.25 + 0.75 * clear)
      * smoothstep(-0.035, 0.02, clock.moon.dir.y);
    this.moon.visible = moonOp > 0.004;
    if (this.moon.visible) {
      this.moon.position.copy(clock.moon.dir).multiplyScalar(R)
        .add(camera.position).sub(this.group.position);
      /* Face the eye.  `lookAt` in the group's frame, and the group sits
       * on the camera, so the moon's own +Z always points at it. */
      this.moon.lookAt(camera.position.x - this.group.position.x,
                       camera.position.y - this.group.position.y,
                       camera.position.z - this.group.position.z);
      /* The sun's direction in the quad's own frame -- the one number the
       * phase shader needs, and the reason the terminator is right rather
       * than approximated. */
      _v.copy(clock.sun.dir);
      _qi.copy(this.moon.quaternion).invert();
      _v.applyQuaternion(_qi);
      this.moonUniforms.uSunLocal.value.copy(_v);
      this.moonUniforms.uOpacity.value = moonOp;
      /* Earthshine is strongest on a thin crescent, which is when it is
       * actually visible on the real thing. */
      this.moonUniforms.uEarthshine.value = 0.03 + 0.05 * (1 - clock.moon.illum);
    }
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
