import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Rain and snow: one object, no spawning, no pooling.
 *
 * A fixed number of particles live in a box that follows the camera and
 * wrap modulo that box, so nothing is ever created or destroyed and the
 * CPU cost per frame is one uniform write.  All the motion is in the
 * vertex shader: position is `start + velocity * time`, taken modulo the
 * box height, which means a particle that falls out of the bottom is
 * already back at the top with no bookkeeping at all.
 *
 * The velocity has three terms and the third is the one that matters:
 *
 *   fall      gravity, fast for rain and slow for snow
 *   wind      the weather's own drift
 *   **car**   a fraction of the car's velocity, subtracted
 *
 * That last one slants the streaks backwards as you accelerate, and it is
 * the single strongest cue that you are moving *through* weather rather
 * than sitting under it.  Rain that falls straight down past a car at
 * 80 km/h looks like a screen effect, because it is one.
 *
 * Rain draws as `LineSegments` -- a streak is a line, and a line is two
 * vertices where a textured quad is four plus a texture -- and snow reuses
 * the same buffer with a short segment and a wide, soft point-ish look.
 * ------------------------------------------------------------------ */

/** Half-extent of the box, in metres, and how tall it is. */
const BOX = 36;
const HEIGHT = 34;
const COUNT = 3000;          // 3000 segments = 6000 vertices, one draw

const VERT = /* glsl */ `
  attribute vec3 aStart;      // where in the box this drop lives
  attribute float aSeed;
  attribute float aEnd;       // 0 at the head of the streak, 1 at the tail

  uniform vec3 uCentre;
  uniform vec3 uVel;          // fall + wind + the car's own motion
  uniform float uTime;
  uniform float uBox;
  uniform float uHeight;
  uniform float uLength;      // streak length, metres
  uniform float uAmount;
  uniform float uSnow;

  varying float vFade;

  void main() {
    vec3 p = aStart;

    /* Fall.  A mod on the vertical does the wrapping; the horizontal
     * drift is wrapped the same way so a long sideways wind cannot walk
     * the whole field out of the box. */
    vec3 travel = uVel * ( uTime + aSeed * 37.0 );
    p += travel;
    p.y = mod( p.y - uCentre.y + uHeight * 0.5, uHeight ) - uHeight * 0.5 + uCentre.y;
    p.x = mod( p.x - uCentre.x + uBox, uBox * 2.0 ) - uBox + uCentre.x;
    p.z = mod( p.z - uCentre.z + uBox, uBox * 2.0 ) - uBox + uCentre.z;

    /* The tail of the streak lies back along the velocity, so a streak
     * always points the way it is going -- including the backward slant
     * from the car's own motion, which is the whole point. */
    vec3 dir = normalize( uVel + vec3( 0.0, -0.0001, 0.0 ) );
    p -= dir * ( aEnd * uLength );

    /* Snow wanders.  Two sines at incommensurate rates, keyed on the
     * flake's own seed, is enough -- a flake that falls dead straight
     * reads as rain that has been slowed down. */
    if ( uSnow > 0.5 ) {
      float t = uTime * 0.7 + aSeed * 19.0;
      p.x += sin( t ) * 0.75 + sin( t * 2.31 ) * 0.3;
      p.z += cos( t * 0.83 ) * 0.75;
    }

    vec4 mv = modelViewMatrix * vec4( p, 1.0 );
    gl_Position = projectionMatrix * mv;

    /* Fade out at the edge of the box, so the field has no wall, and
     * close to the eye, where a drop is a bar across the whole frame. */
    float d = length( p - uCentre );
    float near = smoothstep( 1.2, 4.5, d );
    float far = 1.0 - smoothstep( uBox * 0.55, uBox * 0.98, d );
    vFade = near * far * uAmount * ( 1.0 - aEnd * 0.55 );
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uTint;
  varying float vFade;
  void main() {
    if ( vFade < 0.004 ) discard;
    gl_FragColor = vec4( uTint, vFade );
  }
`;

const _v = new THREE.Vector3();

export class Precipitation {
  constructor(scene) {
    const pos = new Float32Array(COUNT * 2 * 3);
    const start = new Float32Array(COUNT * 2 * 3);
    const seed = new Float32Array(COUNT * 2);
    const end = new Float32Array(COUNT * 2);
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() * 2 - 1) * BOX;
      const y = (Math.random() * 2 - 1) * HEIGHT * 0.5;
      const z = (Math.random() * 2 - 1) * BOX;
      const s = Math.random();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 3;
        start[o] = x; start[o + 1] = y; start[o + 2] = z;
        seed[i * 2 + k] = s;
        end[i * 2 + k] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aStart', new THREE.BufferAttribute(start, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uCentre: { value: new THREE.Vector3() },
      uVel: { value: new THREE.Vector3(0, -9, 0) },
      uTime: { value: 0 },
      uBox: { value: BOX },
      uHeight: { value: HEIGHT },
      uLength: { value: 1.1 },
      uAmount: { value: 0 },
      uSnow: { value: 0 },
      uTint: { value: new THREE.Color(0xc8d6e4) },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.LineSegments(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.time = 0;
  }

  /**
   * @param w      the weather's blended parameters
   * @param camera where the box sits
   * @param car    for the slant; may be null before the car exists
   * @param light  0..1 daylight, so rain is not lit like noon at midnight
   */
  update(dt, w, camera, car, light = 1) {
    this.time += dt;
    const rain = w ? w.rain : 0;
    const snow = w ? w.snow : 0;
    const amount = Math.max(rain, snow);
    this.mesh.visible = amount > 0.01;
    if (!this.mesh.visible) return;

    const isSnow = snow > rain;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uCentre.value.copy(camera.position);
    u.uAmount.value = Math.min(1, amount * (isSnow ? 1.35 : 1.15));
    u.uSnow.value = isSnow ? 1 : 0;
    /* A flake is a short segment rather than a point sprite, and 12 cm
     * of it is sub-pixel at any distance worth drawing -- the first snow
     * shot had no visible snow in it at all.  35 cm reads as a flake
     * without reading as sleet. */
    u.uLength.value = isSnow ? 0.35 : 0.6 + 1.7 * rain;

    /* Fall speed, wind, and the car.  The car term is deliberately less
     * than one -- at 0.35 the streaks lean convincingly without turning
     * the whole field horizontal the moment the car moves. */
    const fall = isSnow ? -1.6 : -(11 + 8 * rain);
    const wind = (w ? w.wind : 0.3) * (isSnow ? 2.2 : 4.5);
    _v.set(wind, fall, wind * 0.4);
    if (car) {
      _v.x -= Math.cos(car.yaw) * car.speed * 0.35;
      _v.z -= Math.sin(car.yaw) * car.speed * 0.35;
    }
    u.uVel.value.copy(_v);

    /* Rain is not white.  It is whatever the sky is, slightly brighter --
     * which is why rain against a dark hillside reads and rain against a
     * bright sky nearly vanishes. */
    const l = 0.25 + 0.75 * light;
    u.uTint.value.setRGB(
      (isSnow ? 0.95 : 0.72) * l,
      (isSnow ? 0.97 : 0.80) * l,
      (isSnow ? 1.00 : 0.90) * l);
  }
}
