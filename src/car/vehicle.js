import * as THREE from 'three';
import { RAPIER } from './physics.js';

/* ------------------------------------------------------------------ *
 * The car -- a rigid body on four raycast wheels.
 *
 * This was an arcade kinematic model: a bicycle model for the horizontal
 * and four samples of `terrain.heightAt` for the vertical, with the body
 * eased toward the mean.  It drove well and it had one fatal property --
 * it stood on the *analytic height field* while the player looked at a
 * mesh that had sampled that field at up to 16 m and interpolated between
 * the samples.  Where the two disagreed, and they disagreed by as much as
 * 17.9 m, the car floated or sank, and no amount of suspension tuning was
 * ever going to touch it.
 *
 * So the fix is not "better suspension", it is **one surface**: the wheels
 * raycast against colliders built from the very numbers the ground mesh
 * was built from.  See `physics.js`.  Rapier's vehicle controller then
 * gives what the brief asks for -- a car held up by its wheels, just
 * touching, with suspension travel, airtime and a real answer to what
 * happens when you drive off the road.
 *
 * The public surface is unchanged: `pos`, `yaw`, `pitch`, `roll`, `speed`,
 * `steer`, `wheelSpin`, `surface`, `grip`, `airborne`, `update`, `applyTo`,
 * `placeOn`.  The chase camera, the HUD, the autodrive and the recorder do
 * not know any of this happened.
 *
 * Local frame: **+Z is forward**, which is the car model's own forward, so
 * `applyTo` can hand the body's quaternion straight to the mesh instead of
 * rebuilding it out of three Euler angles.
 *
 * The numbers below are a *target* for the physics rather than a
 * description of it -- a mid-weight road car that pulls a little over
 * 0.65 g from rest and brakes harder than it accelerates.  The body,
 * wheels and suspension are what actually produce the motion; these are
 * the figures they are held to.
 * ------------------------------------------------------------------ */

export const METRICS = {
  mass: 1400,
  accel: 6.6,        // m/s^2 at full throttle, before drag
  brake: 8.6,
  reverse: 4.5,
  drag: 0.0011,      // v^2 coefficient
  /** Rolling resistance as a fraction of the car's weight: about a real
   *  road tyre's.  See `_drive`. */
  rollResistance: 0.015,
  /* 22.35 m/s is 50.0 mph and 80.5 km/h.  The brief asks for 80 km/h,
   * which is 22.22 -- and reads as 49.7 on a HUD that is in mph, which
   * anyone who asked for fifty will file as a bug.  Take the mile as the
   * round number, since the mile is what is on screen. */
  topSpeed: 22.35,
  /**
   * The speed the *handling* is scaled against, which is no longer the
   * top speed.
   *
   * `_rack` closes the steering lock with `(v / topSpeed)^2` and stretches
   * the rack's interval by the same fraction.  Both were written against a
   * 45 m/s car, and re-pointing them at a 22.35 m/s one is not a re-scale,
   * it is a different car: at cruise the lock would fall from 0.82 of
   * maxSteer to **0.28**, i.e. a third of the steering the car has today,
   * arriving as "the car won't turn" -- a report with nothing to do with
   * steering and everything to do with a constant that meant two things.
   *
   * So the two meanings are separated.  The steering feel measured in
   * `next_2.md` -- full lock in 1.13 s at rest, 1.43 s at 24 m/s, a 5 %
   * input moving the rack at 25 % of the full-lock rate -- carries over
   * unchanged, which is the point.
   *
   * The *drivetrain* keeps using `topSpeed`, and should: torque tailing
   * off as `1 - 0.85 (v/topSpeed)^2` is what makes the approach to the cap
   * asymptotic rather than a wall, and it puts 0-50 mph at about 6.5 s.
   */
  handlingRef: 42,
  maxSteer: 0.64,    // radians at the road wheel
  wheelbase: 2.45,
  track: 1.66,
  axleHeight: 0.34,
  bodyLength: 4.53,
  bodyWidth: 1.90,
  latGrip: 9.2,      // m/s^2 before the tyres let go
};

/**
 * Suspension: stiff, and damped on Bullet's own rule.
 *
 * It was `stiffness 30, compression 0.82, relaxation 0.88, travel 0.22`,
 * and those damping numbers look exactly like the 0-to-1 fractions damping
 * usually is.  They are not.  Rapier's raycast vehicle is a port of
 * Bullet's, and Bullet documents its damping coefficient as
 * `2 * sqrt(stiffness) * ratio` with the ratio between 0.1 and 0.3 -- for
 * stiffness 30 that is 1.1 to 3.3, so 0.82 was a damping ratio of 0.075.
 *
 * Measured, by dropping the car 0.8 m onto flat ground: 3 Hz, damping
 * ratio 0.15, three visible oscillations, 1.5 s to settle -- and it was
 * being re-excited continuously by a 1 m collider lattice at 27 m/s.  That
 * is the whole of "the suspension is too bumpy".
 *
 * Now: stiffer, damped at the top of Bullet's range, and with a third less
 * travel, so there is less body movement to damp in the first place.
 * Measured on the same drop: bounces 4 -> 2, settling 1.58 s -> 0.8 s, and
 * at cruise on tarmac the body's pitch settles from 0.38 deg RMS to 0.16.
 *
 * **Do not push the damping past Bullet's range.**  The first attempt at
 * this went to ratios of 0.38 and 0.55 on the reasoning that the brief
 * asks for a car which ignores the road rather than one which follows it.
 * The car then would not move at all: measured suspension load at rest
 * fell to *zero* on all four wheels, and a wheel carrying no load can put
 * down no force, so full throttle produced nothing.  It looked like a
 * drivetrain bug and it was a damping coefficient two lines away.  The
 * safe band is `2 * sqrt(stiffness) * 0.1..0.3`; the numbers below sit at
 * 0.22 and 0.32 of critical, and 0.22 is where the load starts to sag.
 */
const SUSPENSION = {
  rest: 0.24,
  stiffness: 52,
  compression: 2 * Math.sqrt(52) * 0.22,   // 3.17
  relaxation: 2 * Math.sqrt(52) * 0.32,    // 4.61
  maxForce: 26000,
  travel: 0.14,
};

/**
 * Which way a positive engine force pushes.
 *
 * Determined by experiment, not by reading: with the forward axis on +Z,
 * the up axis on +Y and the axle on +X, a *positive* engine force drives
 * the car backwards.  Rapier's vehicle controller is a port of Bullet's
 * `btRaycastVehicle` and its forward impulse comes out of a cross product
 * whose handedness depends on all three of those choices at once, so the
 * only trustworthy way to pin it down is to push the car and watch.  Fixed
 * 4000 N on the rear axle: `+` gave 1.3 m/s (that is the hill), `-` gave
 * 16.7.  Hence the sign, here, once, rather than a minus buried in five
 * call sites.
 */
const DRIVE_SIGN = -1;

/**
 * Friction slip: how many times the wheel's own suspension load it can put
 * down before it spins.  Bullet's default is 10.5, which is a slot car.
 * 3.2 leaves a rear wheel able to break traction on gravel and not on
 * tarmac, which is the distinction the surfaces exist to make.
 */
const SLIP = 3.2;

/**
 * And which way a positive steer angle turns the car.
 *
 * Same story as `DRIVE_SIGN`, and it cost more: with the sign wrong the
 * autopilot's every correction pushed it *away* from the line it was
 * correcting toward, so it left the road inside a hundred metres, every
 * time, and looked exactly like a car that had lost grip.  Measured: a
 * held steer of +1 turned the car -2.49 rad, where the rest of the game --
 * `Autodrive`, and the old kinematic model it was written against -- takes
 * positive steer to mean yaw increasing.
 */
const STEER_SIGN = -1;

/**
 * How the drive is split, front to rear.
 *
 * Rear-drive only was the first version and it was miserable off the road
 * for a reason worth writing down: on anything uneven the *rear* is the
 * axle that unloads -- measured suspension force falling from 1960 N to
 * 9 N over ordinary bumps -- and an axle carrying 9 N can put down no
 * force at all, so the car simply stopped accelerating halfway up every
 * verge.  Driving all four with a rearward bias keeps at least one loaded
 * axle on the ground almost always.
 */
const DRIVE_SPLIT = [0.15, 0.15, 0.35, 0.35];

/**
 * How long a full-lock swing takes at rest, in seconds.
 *
 * An *interval*, not a rate: the time a swing takes is fixed and the rate
 * falls out of it.  Three consequences, each chosen for feel:
 *
 *   - a full-lock swing takes about a second, not the 0.43 s the old flat
 *     rate limit gave;
 *   - `SPEED_STRETCH` lengthens that interval with the square of speed,
 *     on top of the lock itself closing;
 *   - `RECENTRE` -- the wheel comes back to centre faster than it leaves
 *     it, which is most of what makes a car feel like it wants to go
 *     straight rather than like it wants to be caught.
 */
const STEER_INTERVAL = 1.15;
const RATE_FLOOR = 0.25;
const RECENTRE = 1.8;
/** How much longer a swing takes at `handlingRef`: `1 + SPEED_STRETCH`. */
const SPEED_STRETCH = 0.8;

/**
 * How fast the pedal itself can move, up and down, per second.
 *
 * This is the cheapest possible fix for a keyboard: a key is a step function, and a
 * step from no torque to 9800 N is a lurch however good the tyre model
 * underneath it is.  Down is quicker than up, because lifting off should
 * feel immediate even when picking the throttle up does not.
 */
const JERK_UP = 3.0;
const JERK_DOWN = 5.0;

/**
 * What coasting costs, in m/s^2, before aero drag.
 *
 * `METRICS.rollResistance` times `G`: about 0.15 m/s^2, so a car left to
 * itself rolls a long way, and aero drag -- which grows with the square
 * of speed -- is what actually slows it from anything quick.
 */
const G = 9.81;

/**
 * Below this, with neither pedal touched, the car is parked and is held.
 * Half a metre a second is under two km/h -- slower than anything anyone
 * would call driving, and fast enough that the hold cannot catch a car
 * still rolling to a stop under its own momentum.
 */
const PARK_SPEED = 0.5;

/**
 * How far the car sinks onto its springs standing still, in metres.
 *
 * Rapier's raycast vehicle is Bullet's, and Bullet's suspension force is
 * `stiffness * compression * chassisMass` -- so four wheels holding up
 * `mass * g` compress by `g / (4 * stiffness)` and the mass cancels: 4.7 cm
 * here, and measured at 4.7 cm.  It is exported because the *model* needs
 * it: the body is drawn standing on the ground, the vehicle's origin is
 * the hub line, and the gap between the two is exactly this.  See
 * `model.js:seat`.
 */
export const RIDE_SAG = G / (4 * SUSPENSION.stiffness);

/** How much grip each surface gives, as a friction-slip multiplier. */
const GRIP = { road: 1, gravel: 0.66, verge: 0.58, grass: 0.55, shore: 0.42, rock: 0.5, water: 0.25 };

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

export class Vehicle {
  constructor(terrain, physics, opts = {}) {
    this.T = terrain;
    this.P = physics;
    this.m = { ...METRICS, ...opts.metrics };

    this.pos = new THREE.Vector3(0, 0, 0);
    this.quat = new THREE.Quaternion();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 0;         // along the car's own nose, m/s
    this.slide = 0;         // across it
    this.steer = 0;         // current road-wheel angle
    this.wheelSpin = 0;
    this.airborne = false;
    /** Each hub's height above the body origin -- the suspension, for the
     *  wheel meshes to be hung on.  Written in `_read`. */
    this.wheelY = [0, 0, 0, 0];
    this.surface = 'road';
    this.grip = 1;
    /**
     * What the weather is doing to the tyres, 0..1.
     *
     * Written from outside, once a frame, and folded into `grip` below --
     * so a wet road is less grip everywhere rather than a special case in
     * the surface table, and snow lying on tarmac is still tarmac with
     * less grip rather than a different surface.  Deliberately mild: the
     * brief for this iteration is a relaxing drive.
     */
    this.weatherGrip = 1;
    /** Metres travelled with no wheel on anything -- drives the recover hint. */
    this.stranded = 0;
    /** How long the brake has been held at a standstill.  See `_drive`. */
    this.reverseHold = 0;
    /** The pedal, as opposed to the key: rate-limited.  See `JERK_UP`. */
    this.throttle = 0;

    const m = this.m;
    const body = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 0, 0)
      .setCcdEnabled(true)
      /**
       * **This body never sleeps**, and that is a bug fix, not a tuning
       * knob.
       *
       * Rapier parks a rigid body that has been nearly still for a moment:
       * its velocities are zeroed and it stops being integrated.  That is
       * the right thing to do to a crate on a floor and the wrong thing to
       * do to a body held up by a raycast vehicle, because
       * `DynamicRayCastVehicleController` is *outside* the solver -- it
       * raycasts and applies suspension forces from `updateVehicle` on
       * every substep whether the body is asleep or not.  So the springs
       * keep pushing at a body that has stopped listening, until the push
       * wakes it and arrives all at once.
       *
       * Measured on a car parked on the flat, which is `prompt_16.md` item
       * 4 as reported -- "the 4 wheels are stationary on the road while the
       * body of the car pops up and down":
       *
       *     body, peak to peak      18.9 mm      at 1.13 Hz, not decaying
       *     wheel hub, peak to peak  0.5 mm      the struts absorb it all
       *     suspension force, one corner   0 to 3567 N
       *
       * and the trace is a sawtooth with the mechanism written on it: the
       * height sits at one *bit-identical* value for eleven frames -- the
       * sleep -- then jumps 3.8 mm on the frame it wakes and 18 mm over the
       * next four, then damps out and sleeps again, repeating every 53
       * frames without losing amplitude.
       *
       * The A/B is `tools/probe/park.mjs --bob`: 19.3 mm asleep-able,
       * 0.55 mm kept awake, 19.3 mm again with sleeping restored.  The cost
       * is integrating one body -- the only dynamic body in the world --
       * for as long as the tab is open.
       */
      .setCanSleep(false)
      /* Damping, not to model anything, but because a rigid body on four
       * springs will happily oscillate for ever otherwise.
       *
       * It was 0.05, which Rapier applies as a fraction of velocity per
       * second -- 0.95 m/s^2 of it at 19 m/s, three times the aero drag
       * and the largest single term in how quickly the car slows when you
       * lift off.  The suspension does the job this was here for now that
       * it is damped properly, so this can go back to being what it says
       * it is. */
      .setLinearDamping(0.02)
      .setAngularDamping(0.6);
    this.body = physics.world.createRigidBody(body);

    /* The shell.  Raised half a metre above the body origin, which puts the
     * centre of mass at roughly the height of a real one and is most of
     * what stops the car rolling over every time it leaves the tarmac. */
    const hull = RAPIER.ColliderDesc
      .cuboid(m.bodyWidth / 2, 0.46, m.bodyLength / 2)
      .setTranslation(0, 0.42, 0)
      .setMass(m.mass)
      .setFriction(0.4)
      .setRestitution(0.05);
    this.hull = physics.world.createCollider(hull, this.body);
    physics.carBody = this.body;

    this.vc = physics.world.createVehicleController(this.body);
    this.vc.indexUpAxis = 1;
    this.vc.setIndexForwardAxis = 2;

    const hw = m.track / 2, hl = m.wheelbase / 2;
    /* Front axle first and, within an axle, -x before +x -- which with
     * forward on +Z and the game's right-handed frame is front-right,
     * front-left, rear-right, rear-left.  `wheelY` comes back in this
     * order and `model.js` sorts the wheel meshes into it by position, so
     * neither has to take the labels on trust. */
    for (const [fz, rx] of [[hl, -hw], [hl, hw], [-hl, -hw], [-hl, hw]]) {
      this.vc.addWheel(
        { x: rx, y: SUSPENSION.rest, z: fz },   // where the strut is bolted on
        { x: 0, y: -1, z: 0 },                  // it hangs downward
        /* The axle.  +X rather than -X: with forward on +Z and up on +Y,
         * the other sign drives the car backwards under a positive engine
         * force, which is a very quiet way to be wrong -- the autopilot
         * simply reversed away from its aim point at a steady 6 m/s. */
        { x: 1, y: 0, z: 0 },
        SUSPENSION.rest,
        m.axleHeight);
    }
    for (let i = 0; i < 4; i++) {
      this.vc.setWheelSuspensionStiffness(i, SUSPENSION.stiffness);
      this.vc.setWheelSuspensionCompression(i, SUSPENSION.compression);
      this.vc.setWheelSuspensionRelaxation(i, SUSPENSION.relaxation);
      this.vc.setWheelMaxSuspensionForce(i, SUSPENSION.maxForce);
      this.vc.setWheelMaxSuspensionTravel(i, SUSPENSION.travel);
      this.vc.setWheelFrictionSlip(i, SLIP);
    }
  }

  /** Drop the car onto the road at arc position `s`, facing along it. */
  /**
   * Stop, where it stands.
   *
   * For the rest: "as if the player takes a rest on the side of the road".
   * Without it a rest is twelve game-hours of frozen physics with the car
   * still carrying 20 m/s of momentum into the far side of them, which is
   * a lurch on the frame the lapse ends.
   */
  halt() {
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.speed = 0;
  }

  placeOn(road, s) {
    const sm = road.sampleAt(s, {});
    this.teleport(sm.x, sm.y + this.m.axleHeight + 0.05, sm.z, Math.atan2(sm.tz, sm.tx));
  }

  /**
   * Put the body somewhere, at rest.
   *
   * `yaw` is the old convention -- the heading of `(cos yaw, sin yaw)` in
   * world XZ -- and the body's forward is +Z, so the rotation that takes
   * one to the other is a turn of `PI/2 - yaw` about the up axis.  Exactly
   * the mapping `applyTo` used to do to the mesh by hand.
   */
  teleport(x, y, z, yaw) {
    const a = Math.PI / 2 - yaw;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.speed = 0;
    this.slide = 0;
    this.steer = 0;
    this.stranded = 0;
    this.throttle = 0;
    this.reverseHold = 0;
    this._read();
  }

  get forward() { return _v.set(Math.cos(this.yaw), 0, Math.sin(this.yaw)); }

  /**
   * One frame.  The physics runs at a fixed 120 Hz underneath, and the
   * controls are re-applied before every substep -- the wheels' raycasts
   * have to be against the world the solver is about to advance, not the
   * one it advanced last frame.
   */
  update(dt, axes) {
    this._rack(dt, axes);
    this.P.step(dt, () => this._drive(axes));
    this._read();
  }

  /* ------------------------------ controls ----------------------------- */

  /**
   * The driver's hands and the steering rack.
   *
   * This was a flat rate limit -- full lock in 0.43 s whatever you were
   * doing and however fast you were going.  That is far too quick for a
   * keyboard, and more to the point it was not *proportional*: the rate
   * should be set by the size of the movement being asked for, so a small
   * correction moves the wheel slowly and a deliberate swing moves it
   * quickly.  A rack that answers a 5 % input at the same rate as a
   * 100 % one is a rack that cannot be used gently, which is exactly what
   * "too sensitive" describes.
   *
   * So the rate here is `maxSteer / interval` scaled by how much lock is
   * involved -- the larger of where the wheel is and where it is being
   * sent, so that a swing away from centre and a return to it are both
   * governed by the deflection they cover -- with a floor so the last
   * fraction of a correction still converges in bounded time, and a
   * quicker return on the way back.
   */
  _rack(dt, axes) {
    const m = this.m;
    /* `handlingRef`, not `topSpeed` -- see the note in `METRICS`. */
    const speedFrac = Math.min(1, Math.abs(this.speed) / m.handlingRef);
    /* The lock closes with speed.  Without this the car is a shopping
     * trolley at 120 km/h -- full lock at speed is not a corner, it is a
     * spin, and no amount of grip modelling makes it feel intentional. */
    const lock = m.maxSteer * (1 - 0.68 * speedFrac * speedFrac);
    const want = (axes.steer || 0) * lock;
    const d = want - this.steer;

    /* Slower at speed. */
    const interval = STEER_INTERVAL * (1 + SPEED_STRETCH * speedFrac * speedFrac);
    const home = Math.abs(want) < Math.abs(this.steer) || want * this.steer < 0;
    let rate;
    if (home) {
      /* Coming back -- toward centre, or across it -- is a flat rate,
       * `RECENTRE` times the rate of a full-lock swing: a return time
       * proportional to the travel, which is a constant rate. */
      rate = RECENTRE * m.maxSteer / interval;
    } else {
      /* On the way out, the rate is set by how much lock is being asked
       * for -- the larger of where the wheel is and where it is going. */
      const involved = Math.max(Math.abs(want), Math.abs(this.steer)) / m.maxSteer;
      rate = (m.maxSteer / interval) * Math.max(RATE_FLOOR, Math.min(1, involved));
    }

    const maxRack = rate * dt;
    this.steer += Math.max(-maxRack, Math.min(maxRack, d));
  }

  _drive(axes) {
    const m = this.m;
    const v = this.speed;
    const speedFrac = Math.min(1, Math.abs(v) / m.topSpeed);

    for (let i = 0; i < 2; i++) this.vc.setWheelSteering(i, this.steer * STEER_SIGN);

    /* Engine force on the rear axle.  Torque tails off toward top speed
     * rather than stopping dead there, and it is force rather than
     * acceleration because the wheels have to be able to spin up on a wet
     * verge -- which is the whole point of having surfaces at all. */
    /* Reverse is on a hold, not on a threshold.
     *
     * "Brake, and if you are nearly stopped, reverse" reads fine until the
     * car is struggling for traction: it creeps below the threshold, gets a
     * reverse command, backs off, brakes again, and the whole thing surges
     * back and forth at walking pace.  That is exactly what the autopilot
     * did on its first climb.  Holding the brake for a third of a second at
     * a standstill is unambiguous. */
    if (axes.brake > 0 && Math.abs(v) < 0.6) this.reverseHold += this.P.hz;
    else if (axes.brake === 0 || v > 1) this.reverseHold = 0;
    const reversing = this.reverseHold > 0.35;

    /* The pedal moves at a finite rate even when the key does not. */
    const jerk = (axes.throttle > this.throttle ? JERK_UP : JERK_DOWN) * this.P.hz;
    this.throttle += Math.max(-jerk, Math.min(jerk, axes.throttle - this.throttle));

    let drive = 0;
    if (this.throttle > 0 && v < m.topSpeed) {
      drive = m.mass * m.accel * this.throttle * (1 - 0.85 * speedFrac * speedFrac);
    } else if (reversing && v > -m.reverse) {
      drive = -m.mass * m.reverse * axes.brake * 0.5;
    }
    for (let i = 0; i < 4; i++) {
      this.vc.setWheelEngineForce(i, drive * DRIVE_SPLIT[i] * DRIVE_SIGN);
    }

    /* Brakes are **impulses**, and the engine force beside them is a
     * **force**.
     *
     * Rapier says so in as many words -- `setWheelBrake` is documented as
     * "the maximum amount of braking *impulse* applied on the i-th wheel",
     * `setWheelEngineForce` as "the forward *force*" -- and the two sit one
     * after the other in this function, which is how a number meant as
     * newtons went in as newton-seconds and stayed there.
     *
     * The cost of the mistake was not subtle once it was measured: rolling
     * resistance of 29.4 "newtons" on four wheels, applied 120 times a
     * second, is 10 m/s^2 of deceleration.  Lifting off the throttle
     * stopped the car harder than the brake pedal did -- 18.8 m/s to zero
     * in one second -- so the car could only be driven with the throttle
     * pinned, and every small correction of it was a lurch.  That is most
     * of what "the acceleration is too sensitive" was.
     *
     * So: everything below is expressed as a force on the whole car, in
     * newtons, and converted once, here. */
    const impulse = (force) => force * this.P.hz / 4;

    let brake = 0;
    if (axes.brake > 0 && v > 0.4) brake = impulse(m.mass * m.brake * axes.brake);
    if (axes.throttle === 0 && axes.brake === 0) {
      brake += impulse(m.rollResistance * m.mass * G);
    }

    /* --- and the parking brake ---
     *
     * `prompt_16.md` item 4: *"a parked car should stay still until I hit
     * forward"*.  It did not.  Rolling resistance is `rollResistance * G`
     * -- 0.147 m/s^2, deliberately small so that lifting off is
     * a coast and not a stop -- while the tracer will lay a road at up to
     * `MAX_GRADE`, 12 %, which is 1.18 m/s^2 down the slope.  So on
     * anything steeper than about one and a half per cent a car left alone
     * rolls away, and `tools/probe/park.mjs` measures
     * exactly that: parked on three seeds for an hour of game time, one
     * rolled 195 m and another 168 m, each losing several metres of height
     * on the way.  It is also where the report's "pops up and down" comes
     * from -- 77 of those frames moved the body more than 2 cm vertically,
     * because a car creeping over a crowned and undulating road *is* going
     * up and down, and from the driver's seat a slow roll reads as a bob
     * rather than as travel.
     *
     * A car left with no pedals pressed is a car whose driver has parked
     * it, so it gets a parking brake: below walking pace, with neither
     * pedal touched, the wheels are locked with the same impulse the
     * handbrake uses.  Any throttle or brake releases it on the same frame,
     * so it can never be in the way of driving -- which is the whole of
     * "until I hit forward".
     *
     * Deliberately the *velocity* rather than `this.speed`: the forward
     * component is near zero for a car sliding sideways down a bank, and a
     * parking brake that engages there would be a handbrake nobody asked
     * for. */
    const held = this.body.linvel();
    if (axes.throttle === 0 && axes.brake === 0
        && Math.hypot(held.x, held.y, held.z) < PARK_SPEED) {
      brake = impulse(m.mass * 4 * G);
    }
    for (let i = 0; i < 4; i++) this.vc.setWheelBrake(i, brake);

    /* The handbrake locks the rear axle, which off the road is how you get
     * the back round rather than how you stop. */
    if (axes.handbrake) {
      for (let i = 2; i < 4; i++) {
        this.vc.setWheelBrake(i, impulse(m.mass * 4 * G));
        this.vc.setWheelEngineForce(i, 0);
      }
    }

    /* Grip from what is under each wheel, and this is what makes off-road
     * feel like off-road rather than tarmac in a different colour. */
    const g = this.grip;
    for (let i = 0; i < 4; i++) this.vc.setWheelFrictionSlip(i, SLIP * g);

    /* Aero drag, which Rapier does not model and a car very much has.
     *
     * As an *impulse*, not `addForce`.  Rapier's forces persist until
     * `resetForces` -- they are not cleared per step -- so adding one every
     * substep accumulates, and what should have been a 17 N breeze became
     * several thousand newtons of headwind within a few seconds.  The
     * symptom was a car that accelerated briskly, slowed, stopped, and then
     * drove itself backwards up the hill it had just come down, which is
     * why this took an afternoon: everything about it looked like a
     * traction problem. */
    const lin = this.body.linvel();
    const sp = Math.hypot(lin.x, lin.y, lin.z);
    if (sp > 0.5) {
      const f = -m.drag * m.mass * sp * this.P.hz;
      this.body.applyImpulse({ x: lin.x * f, y: 0, z: lin.z * f }, true);
    }

    this.vc.updateVehicle(this.P.hz);
  }

  /* ------------------------------- readout ----------------------------- */

  /** Body state back into the shape the rest of the game reads. */
  _read() {
    const t = this.body.translation();
    this.pos.set(t.x, t.y, t.z);
    const r = this.body.rotation();
    this.quat.set(r.x, r.y, r.z, r.w);

    _fwd.set(0, 0, 1).applyQuaternion(this.quat);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _right.set(1, 0, 0).applyQuaternion(this.quat);

    this.yaw = Math.atan2(_fwd.z, _fwd.x);
    /* Pitch and roll are read off the body rather than integrated, and
     * they keep their old signs so the chase camera's lean still leans the
     * right way. */
    this.pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
    this.roll = Math.asin(Math.max(-1, Math.min(1, -_right.y)));

    const lin = this.body.linvel();
    this.speed = lin.x * _fwd.x + lin.y * _fwd.y + lin.z * _fwd.z;
    /* Sideways, for the sound of the tyres letting go. */
    this.slide = lin.x * _right.x + lin.y * _right.y + lin.z * _right.z;
    this.wheelSpin += (this.speed / this.m.axleHeight) * this.P.hz;

    let contacts = 0;
    for (let i = 0; i < 4; i++) if (this.vc.wheelIsInContact(i)) contacts++;

    /* Where each wheel *is*, so the wheel meshes can be put there.
     *
     * The strut is bolted on at `SUSPENSION.rest` above the body origin
     * and hangs straight down, so the hub sits `rest - length` above the
     * origin: zero at full droop, and the static sag above it standing
     * still.  Without this the meshes are pinned at full droop and the
     * tyres are buried 5 cm in the tarmac for the whole game -- which is
     * the ride height being wrong, not the wheels, and it is why the body
     * used to be shimmed by an eyeballed 10 cm in `model.js`.
     *
     * Order is the order the wheels were added in: front axle first and,
     * within an axle, -x before +x.  `model.js` sorts its hubs to match. */
    for (let i = 0; i < 4; i++) {
      const len = this.vc.wheelSuspensionLength(i);
      this.wheelY[i] = len == null ? 0
        : Math.max(-SUSPENSION.travel, Math.min(SUSPENSION.travel, SUSPENSION.rest - len));
    }
    this.airborne = contacts === 0;
    this.stranded = contacts ? 0 : this.stranded + Math.abs(this.speed) * this.P.hz;

    /* What we are standing on.  One sample under the middle of the car is
     * enough for grip -- the four-corner version cost four road queries a
     * frame and never once disagreed with the middle by enough to matter. */
    const s = this.T.surfaceAt(this.pos.x, this.pos.z);
    this.surface = s.cls === 'road' ? 'road' : s.cls === 'gravel' ? 'gravel' : s.cls;
    this.grip = (GRIP[this.surface] ?? 0.55) * (s.wet ? 0.7 : 1) * this.weatherGrip;
  }

  /** Copy the state onto an Object3D. */
  applyTo(obj) {
    obj.position.copy(this.pos);
    /* The body's own rotation, because the body's forward is the model's
     * forward.  The old version rebuilt this from yaw, pitch and roll in a
     * fixed order, which is fine until the car is upside down in a ditch --
     * and it can be, now. */
    obj.quaternion.copy(this.quat);
  }

  /** Upside down, or wedged.  The cue for the recover prompt. */
  get inTrouble() {
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    return _up.y < 0.25;
  }
}
