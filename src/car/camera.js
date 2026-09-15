import * as THREE from 'three';
import { METRICS } from './vehicle.js';

/* ------------------------------------------------------------------ *
 * The camera operator.
 *
 * A camera bolted to the car is not a chase camera -- it is a camera
 * bolted to the car, and it reads as one.  The difference is lag.  The
 * question this file got wrong for two iterations is *what* lags.
 *
 * It used to be the position: the eye sprang toward a point behind the
 * car, in world space, with a time constant of about 0.17 s.  A
 * first-order lag on position against a car accelerating at `a` settles at
 * a standing error of `a * tau` -- and 7 m/s^2 of acceleration is 1.2 m of
 * it, on a rig whose whole length is four.  Measured: the horizontal gap
 * between car and camera went 1.84 m parked, 4.43 m under full throttle,
 * 1.76 m under braking.  The camera did not so much follow the car as get
 * left behind by it and then run into the back of it.
 *
 * The answer is to not spring position at all.  The eye sits on a boom of
 * fixed length from an anchor on the car, and everything that lags, lags
 * in **orientation**: a yaw spring, and a slower pitch spring.  The
 * distance from the car to the eye is exactly `range`, in every
 * manoeuvre, and the swing that reads as a chase camera on the way into a
 * corner is the yaw spring alone.
 *
 * Two things ride along on the same structure:
 *
 *   - the anchor's height is a low-passed `car.pos.y`, which is where the
 *     suspension's residual bounce stops reaching the frame -- for the
 *     modes that watch the car from outside it.  A *mounted* mode
 *     (`MODES.bonnet`) is bolted to the body instead, bounce and all,
 *     because that is what a camera on a car does;
 *   - `orbit` is the player's own yaw and pitch offset from dragging the
 *     mouse, and `zoom` scales the range under the scroll wheel.  Both are
 *     targets for the same springs, so looking around swings rather than
 *     snaps, and neither can change the distance the rig holds.
 * ------------------------------------------------------------------ */

/**
 * How far the player may swing the view, per mode.
 *
 * `yaw: null` is unbounded -- `prompt_16.md` item 3 asks to be able to
 * rotate past the front of the car and keep going, which the old shared
 * limit of PI stopped dead exactly where the interesting view began.
 * `up` and `down` are the pitch offsets, in the rig's sign: positive
 * pitch looks down.
 */
const LOOK_FREE = { yaw: null, up: -0.55, down: 0.85 };

export const MODES = {
  chase: {
    name: 'chase',
    /* Further back than the old 3.35-4.05, and this is the one number the
     * rebuild could not simply carry over.
     *
     * The eye does not sit `range` behind the *car*: it sits `range` from
     * an anchor `ahead` metres in front of it, so the gap the player sees
     * is `range * cos(pitch) - ahead`, which for the old numbers was
     * 1.84 m -- less than half a car length, i.e. inside the boot.  It
     * never looked like that because the position spring was also dragging
     * the eye 1 to 2 m further back whenever the car was doing anything,
     * and *that* was the framing everyone tuned against.  Take the lag
     * away and the length has to be written down: 4.0 m of clear air at
     * rest, opening to 4.5 at speed. */
    range: [5.6, 7.0], pitch: [0.27, 0.19], lift: [0.86, 1.08],
    ahead: [0.8, 1.7], smooth: 1.4, fov: [66, 73],
    look: LOOK_FREE,
  },
  chaseFar: {
    name: 'chase far',
    range: [9.0, 12.0], pitch: [0.25, 0.15], lift: [1.00, 2.00],
    ahead: [1.4, 3.2], smooth: 1.25, fov: [66, 72],
    look: LOOK_FREE,
  },
  bonnet: {
    /**
     * The driver's eye, and it is **mounted** rather than orbited.
     *
     * It used to be placed the way the chase modes are -- `range` metres
     * from the anchor along the rig's own view direction, negative so the
     * eye went in *front* of it.  That is fine while the view points where
     * the car does and wrong the moment the player drags the mouse, because
     * the rig's direction carries the drag: a pan did not turn a head, it
     * swung the eye around a 1.4 m circle centred on the car.  At 90
     * degrees the eye was out through the driver's door, and at 180 it was
     * 1.4 m *behind* the body origin -- inside the cabin, looking forward
     * through the seats.  That is `prompt_16.md` item 2's "I can see the
     * inside of the car", and no clamp on the drag would have fixed it,
     * only made the frame it ends in a different wrong one.
     *
     * `mount` says: bolt the eye to the body at a fixed local offset, and
     * let the springs do nothing but aim.  A pan is then a head turn -- the
     * eye does not move at all -- and where the camera sits is a pair of
     * numbers rather than an emergent property of where you were looking.
     *
     * The numbers are `[forward, up]` in the car's own frame: 2.0 m forward
     * of the body origin puts the eye over the front wheels, a little short
     * of the nose at 2.27 m, so the leading edge of the bonnet sits low in
     * frame instead of filling it; 0.95 m up clears the wing line.  Chosen
     * off stills at the drag's extremes (`tools/probe/camera.mjs --stills`),
     * not from arithmetic.
     */
    name: 'bonnet',
    mount: [2.0, 0.95],
    range: [0, 0], pitch: [0.05, 0.05], lift: [0, 0],
    ahead: [0, 0], smooth: 9, fov: [70, 78],
    /* A head, not a turret.  75 degrees each way reaches a side window and
     * does not reach the back seats; the pitch band keeps the roof lining
     * above the frame and the tarmac a few metres ahead at the bottom of
     * it.  See `core/pointer.js`, which reads these. */
    look: { yaw: 1.3, up: -0.30, down: 0.28 },
  },
};
export const MODE_ORDER = ['chase', 'chaseFar', 'bonnet'];

/**
 * The speed at which the camera reaches its "at speed" framing.
 *
 * Every camera number is `lerp(near, far, speed / FAR_SPEED)`, and this
 * was 45 -- the car's old top speed.  Against a 22.35 m/s car the lerp
 * saturates at **0.50**: chase range would top out at 6.3 m of a designed
 * 7.0 and fov at 71 of 74, so the framing iteration 2 designed for speed
 * would never once be reached.  It has to be the
 * top speed, whatever the top speed is.
 */
const FAR_SPEED = METRICS.topSpeed;

/** Orientation spring time constants at `smooth: 1.5`, in seconds.  A mode
 *  with a lower `smooth` lags proportionally more. */
const TAU_YAW = 0.35;
const TAU_PITCH = 0.7;
/** And the anchor height, which is the anti-bounce filter. */
const TAU_HEIGHT = 0.25;

/** How close the pull-in may bring the eye to its anchor.  The car is
 *  4.53 m long, so anything under about 2.5 m is inside it. */
const MIN_EYE = 2.6;

/** How much of the car's own pitch the camera takes on. */
const PITCH_FOLLOW = 0.55;
/** Clamped, because a nose-down car on a 12 % descent should not point the
 *  camera at the tarmac. */
const PITCH_MIN = -0.16;
const PITCH_MAX = 1.15;

const _anchor = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _off = new THREE.Vector3();

/** Shortest signed angle from `a` to `b`. */
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.pos = new THREE.Vector3();
    /** What the rig is aimed at: the anchor, in world space. */
    this.look = new THREE.Vector3();
    this.started = false;
    this.shake = 0;

    /** The two orientation springs, in world terms. */
    this.yaw = 0;
    this.pitch = 0;
    /** The low-passed ground height the anchor rides on. */
    this.height = 0;

    /**
     * The player's own view offset, written by `core/pointer.js`.  Added
     * to the spring *targets*, so a drag is smoothed by the same rig that
     * smooths everything else and cannot move the eye off its radius.
     */
    this.orbit = { yaw: 0, pitch: 0 };
    /** Scroll-wheel distance multiplier.
     *
     *  **One number for every mode.**  It was one per mode, and a 5x span
     *  against a 1.6x gap between chase and chase far meant the wheel
     *  could put the two framings the wrong way round -- which is what
     *  `prompt_5.md` item 1 reports.  See `core/pointer.js`. */
    this.zoom = 1;
  }

  cycle() {
    const i = MODE_ORDER.indexOf(this.mode);
    this.mode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
    this.started = false;                 // snap rather than sweep across
    return MODES[this.mode].name;
  }

  /** Is this a mode the scroll wheel should move the eye in? */
  get zoomable() { return MODES[this.mode].range[0] > 0; }

  /** How far the drag may swing this mode's view.  See `core/pointer.js`. */
  get lookLimits() { return MODES[this.mode].look; }

  update(dt, car) {
    const M = MODES[this.mode];
    const f = Math.min(1, Math.abs(car.speed) / FAR_SPEED);
    const lerp = (a, b) => a + (b - a) * f;

    const range = lerp(M.range[0], M.range[1]) * this.zoom;
    const lift = lerp(M.lift[0], M.lift[1]);
    const ahead = lerp(M.ahead[0], M.ahead[1]);

    /* The anchor, in the car's *yaw* frame rather than its full rotation.
     *
     * Using the whole quaternion would put the car's pitch and roll into
     * the rig as well; taking yaw only and adding a fraction of the pitch
     * below keeps the framing without the horizon tipping over when the car is on its roof in a ditch -- which, since
     * the physics went in, it can be. */
    const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
    if (!this.started) this.height = car.pos.y;
    else this.height += (car.pos.y - this.height) * (1 - Math.exp(-dt / TAU_HEIGHT));
    _anchor.set(car.pos.x + fx * ahead, this.height + lift, car.pos.z + fz * ahead);

    /* Targets.  The orbit offsets are the player's, from the mouse. */
    const wantYaw = car.yaw + this.orbit.yaw;
    const wantPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX,
      lerp(M.pitch[0], M.pitch[1]) + car.pitch * PITCH_FOLLOW + this.orbit.pitch));

    if (!this.started) {
      this.yaw = wantYaw;
      this.pitch = wantPitch;
      this.started = true;
    } else {
      const s = 1.5 / M.smooth;
      this.yaw += angleDelta(this.yaw, wantYaw) * (1 - Math.exp(-dt / (TAU_YAW * s)));
      this.pitch += (wantPitch - this.pitch) * (1 - Math.exp(-dt / (TAU_PITCH * s)));
    }

    /* Place and aim from the same two angles.  This is the whole point:
     * the eye is exactly `range` from the anchor, always.
     *
     * Unless the mode is *mounted*, in which case the eye is bolted to the
     * car and only the aim springs -- see `MODES.bonnet`. */
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    _dir.set(Math.cos(this.yaw) * cp, -sp, Math.sin(this.yaw) * cp);
    if (M.mount) {
      /* Bolted to the *body*, through its whole rotation and to its actual
       * position -- not to the yaw frame, and not to the low-passed height.
       *
       * Both of those were tried and both fail on a gradient, in the same
       * direction and for the same reason: the car pitches and the eye did
       * not.  A first-order lag on height has a standing error of `rate *
       * tau`, which at 20 m/s on a 12 % climb is 19 cm of eye sunk into the
       * car; and an offset taken in the yaw frame leaves the bonnet to rise
       * `2 * sin(pitch)` -- a quarter of a metre -- into a frame the eye
       * held level.  Measured on `alder`, that was 805 frames in 3455 with
       * the eye inside the car's own hull.
       *
       * A real bonnet camera is bolted on, so this one is too: one offset,
       * in the car's local frame, through the body's own quaternion.  The
       * suspension comes with it, which is right -- a camera on a car moves
       * like a camera on a car, and `TAU_HEIGHT` above exists to keep that
       * out of a shot that is *watching* the car from behind. */
      _off.set(0, M.mount[1], M.mount[0]).applyQuaternion(car.quat);
      this.pos.copy(car.pos).add(_off);
    } else {
      this.pos.copy(_anchor).addScaledVector(_dir, -range);
    }
    this.look.copy(_anchor);
    this.range = range;

    this.camera.position.copy(this.pos);
    this._aim(car);

    const fov = lerp(M.fov[0], M.fov[1]);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Point the camera, from the rig's angles rather than at a point.
   *
   * `lookAt(anchor)` would give the same answer everywhere except bonnet
   * view, where the eye is in front of its own anchor and aiming at it
   * turns the driver round to face the boot.
   */
  _aim(car) {
    /* Our world yaw is the heading of `(cos yaw, sin yaw)` in XZ; a
     * three.js camera looks down its own -Z, so the Euler that takes one
     * to the other is a turn of `-(yaw + PI/2)` about up. */
    this.camera.rotation.set(-this.pitch, -(this.yaw + Math.PI / 2), 0, 'YXZ');
    // a whisper of roll into the corner, from the car's own body roll
    this.camera.rotateZ(-car.roll * 0.35);
  }

  /**
   * Keep the ground out of the shot.
   *
   * Raising the eye above whatever is under it is not enough: on the inside
   * of a cutting the hill between the camera and the car is *higher* than
   * both, and a frame where the terrain had closed over the car entirely
   * turned up in the second round of captured stills.  So the line from the car back to the
   * eye is marched, and the first place the ground is above it pulls the
   * camera in to there.  A chase camera that shortens on a bank is what
   * every driving game does; one that lets the hill in is a bug.
   *
   * Pulling in along the rig's own ray keeps the aim exactly where it was,
   * so this reads as the camera dollying in rather than as a lurch.
   *
   * **Two jobs, and only the first of them is about the chase rig.**  The
   * march along the ray needs a ray, so it stays where it was; the *floor*
   * -- never put the eye below the ground it is standing over -- applies to
   * every mode, and used to apply to none of the ones that need it most.
   * This function opened with `if (!this.zoomable) return`, which is
   * exactly the modes with no ray, which is exactly bonnet view, whose
   * whole margin over the tarmac is about a metre.  So the one guard that
   * keeps the ground out of the shot was switched off in the only view with
   * no room for error, and `prompt_16.md` item 2 reports the result.
   */
  collide(terrain, car, margin = 0.75) {
    if (!this.zoomable) { this._floor(terrain, car, margin); return; }
    const cam = this.camera.position;
    const ax = this.look.x, az = this.look.z, ay = this.look.y;
    let dx = cam.x - ax, dy = cam.y - ay, dz = cam.z - az;
    const len = Math.hypot(dx, dz);
    if (len < 0.2) return;

    const STEPS = 7;
    let hit = 1;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const x = ax + dx * t, z = az + dz * t, y = ay + dy * t;
      const g = terrain.heightAt(x, z) + margin;
      if (y < g) { hit = (i - 1) / STEPS; break; }
    }
    if (hit < 1) {
      /* Never inside the car.
       *
       * The floor here was a flat 0.22 of the rig's range, which on a 5.6 m
       * chase rig is 1.2 m from the anchor -- inside the bodywork.  It is
       * rare (five frames in three and a half thousand, on a bank tight
       * enough to need the full pull-in) and it is unmistakable when it
       * happens, because what fills the frame is the inside of the roof.
       * A moment of hillside is the better failure of the two.
       *
       * And the floor is a distance from the **car**, not a fraction of
       * the rig and not a distance from the anchor: the anchor sits up to
       * 1.7 m ahead of the car, so "2.6 m back from the anchor" is 0.9 m
       * from the body when the drag has swung the view round the front. */
      hit = Math.max(this._clearOfCar(car, ax, ay, az, dx, dy, dz), hit);
      cam.set(ax + dx * hit, ay + dy * hit, az + dz * hit);
      this._floor(terrain, car, margin);
      this.pos.copy(cam);
      this._aim(car);
    }
  }

  /**
   * The nearest point along `anchor + t * d` that is `MIN_EYE` clear of the
   * car, as a `t` in [0, 1].
   *
   * The larger root of `|P + t d| = MIN_EYE` with `P = anchor - car`: the
   * ray starts inside the sphere and leaves it once.  No intersection means
   * the whole segment is already clear, which is the common case and costs
   * a discriminant.
   */
  _clearOfCar(car, ax, ay, az, dx, dy, dz) {
    const px = ax - car.pos.x, py = ay - car.pos.y, pz = az - car.pos.z;
    const a = dx * dx + dy * dy + dz * dz;
    if (a < 1e-6) return 0;
    const b = px * dx + py * dy + pz * dz;
    const c = px * px + py * py + pz * pz - MIN_EYE * MIN_EYE;
    const disc = b * b - a * c;
    if (disc <= 0) return 0;
    const t = (-b + Math.sqrt(disc)) / a;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  /**
   * Never below the ground under the eye.  One height query, every mode.
   *
   * A smaller margin for a mounted eye: half a metre is most of the
   * clearance a driver's head has over the road in the first place, and
   * pushing it up by three quarters of one would have the bonnet view
   * float whenever it ran over anything.  It is a backstop against being
   * *inside* the tarmac, not a ride height.
   */
  _floor(terrain, car, margin) {
    const M = MODES[this.mode];
    const m = M.mount ? 0.25 : margin;
    const cam = this.camera.position;
    const g = terrain.heightAt(cam.x, cam.z) + m;
    if (cam.y >= g) return;
    cam.y = g;
    this.pos.copy(cam);
    this._aim(car);
  }
}
