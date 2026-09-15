import { STEP } from '../road/trace.js';

/* ------------------------------------------------------------------ *
 * Driving itself.
 *
 * Pure pursuit onto the midline -- aim at a point some distance ahead on
 * the road and steer at it -- with the target speed set by the sharpest
 * curvature between here and there.  Needed three separate times over: for
 * the player's `F`, for the films, and for every performance run, since a
 * human driver is not a repeatable measurement.
 *
 * It computes **two independent channels**, and `F` cycles which of them
 * the autopilot is holding:
 *
 *   manual        the driver has both
 *   full          the autopilot has both
 *   steer         the autopilot holds the wheel, the driver drives
 *   speed         the autopilot holds the pedals, the driver steers
 *
 * That is `prompt_5.md`'s order and it is also the better one: `F` from a
 * standing start hands over *everything* on the first press, which is what
 * a player pressing an unfamiliar key wants, and each press after that
 * gives one channel back.
 *
 * The old behaviour -- *any* driving input drops straight back to manual
 * -- had to go, and not because four states are tidier.  It makes modes 1
 * and 2 impossible to be in at all: steering in mode 1 is the entire point
 * of mode 1, and under the old rule it would disengage the autopilot on
 * the first touch of A.
 *
 * What replaces it is a **per-channel temporary override**: input on a
 * channel the autopilot is holding suspends the autopilot *on that channel
 * only*, while held and for a moment afterwards.  Which is what a real
 * cruise control does, and it keeps the useful half of the old behaviour
 * -- you never have to reach for a key to take over -- without the half
 * that made the modes unusable.
 * ------------------------------------------------------------------ */

/**
 * How fast the autopilot drives.
 *
 * Under the 22.35 m/s cap, with headroom for the hill integral to work
 * in.  A secondary effect worth knowing about: `A_LAT` gives a corner
 * limit of `sqrt(A_LAT / k)`, which at 20 m/s only binds for radii under
 * 87 m.  `next_2.md` measured the autopilot averaging 22.5 m/s against a
 * cruise of 27 -- a fifth of the target lost to corners.  At this cruise
 * the limiter rarely binds at all, so the autopilot holds a steady speed
 * nearly everywhere, which is the relaxing drive the brief asks for.
 */
export const CRUISE = 20;

/**
 * The four states `F` cycles through, in order.
 *
 * **Nothing may test the index.** Every question about what the autopilot
 * is holding goes through `HOLDS` below, keyed by name, because this array
 * has now been reordered once and the three `this.mode === 2` tests that
 * used to be scattered through this file would all have inverted silently.
 * The one place the number still escapes is the save, and `core/save.js`
 * migrates it -- see `MODES_V1`.
 */
export const MODES = ['manual', 'full', 'steer', 'speed'];

/**
 * The order the save format used before `prompt_5.md` reordered them.
 *
 * A cookie written yesterday holds an index into *this* array. Reading it
 * through `MODES` would resume a drive in a different mode than it was
 * saved in -- auto-speed becoming full autodrive, which is the version of
 * this change that is a bug report rather than a reorder.
 */
export const MODES_V1 = ['manual', 'speed', 'steer', 'full'];

/** Which channels each mode holds.  The only thing that decides. */
const HOLDS = {
  manual: { steer: false, pedal: false },
  full:   { steer: true,  pedal: true  },
  steer:  { steer: true,  pedal: false },
  speed:  { steer: false, pedal: true  },
};

/**
 * How long the autopilot stays out of the way after the driver stops
 * asking, per channel.
 *
 * Long enough that a series of small corrections reads as the driver
 * being in charge rather than as a fight, short enough that letting go
 * gives the car back.  The steering one is the longer of the two: a
 * driver who has just steered around something wants to finish the
 * manoeuvre before the autopilot starts hunting for the midline again.
 */
const HOLD_STEER = 1.2;
const HOLD_PEDAL = 0.7;

const LOOK_MIN = 11;
const LOOK_PER_SPEED = 0.62;
/** Lateral acceleration the autopilot is willing to use.  Well under the
 *  car's 9.2 -- it is supposed to look relaxed, not quick. */
const A_LAT = 4.6;

export class Autodrive {
  constructor(road, car, opts = {}) {
    this.road = road;
    this.car = car;
    this.cruise = opts.cruise ?? CRUISE;
    /** 0..3, indexing `MODES`.  Take a name in preference to a number. */
    this.mode = typeof opts.mode === 'string'
      ? Math.max(0, MODES.indexOf(opts.mode))
      : (opts.mode ?? 0);
    /** Seconds left on each channel's override. */
    this.override = { steer: 0, pedal: 0 };
    this.s = 0;
    /** +1 if the car points along the road's tangent, -1 if against it. */
    this.dir = 1;
    this.axes = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    /** What `update` returns: the two channels merged with the driver's. */
    this.out = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this._sm = {};
    this._probe = {};
    /* Integral term.  A proportional-only throttle was fine against a
     * kinematic model, where asking for acceleration produced exactly that
     * acceleration.  Against a rigid body it has to climb hills, and a
     * proportional controller with a standing error of two metres a second
     * simply drives up the hill two metres a second slow -- which is what
     * the first climb of every seed looked like: 9.7 m/s against a cruise
     * of 27. */
    this.i = 0;
    /** How far off the midline we are; past a couple of car widths the
     *  autopilot is not cruising, it is coming back. */
    this.off = 0;
  }

  /** Is the autopilot holding anything at all?  Kept as a property rather
   *  than a field so every existing reader -- the HUD, the pointer, the
   *  probes, `?rec` -- goes on working unchanged. */
  get enabled() { return this.mode > 0; }
  set enabled(on) { this.setMode(on ? 'full' : 'manual'); }

  get name() { return MODES[this.mode]; }

  /** What this mode holds.  Keyed by name, never by index. */
  get holds() { return HOLDS[MODES[this.mode]] || HOLDS.manual; }

  /** Is the autopilot steering right now?  (Mode, less any override.) */
  get steering() { return this.holds.steer && this.override.steer <= 0; }
  /** ...and driving? */
  get driving() { return this.holds.pedal && this.override.pedal <= 0; }

  /** Next mode.  Returns the new one's name, for the toast. */
  cycle() { return this.setMode(MODES[(this.mode + 1) % MODES.length]); }

  /**
   * Go to a mode by name.  The one entry point that resets the controller.
   *
   * Everything `cycle` used to do inline lives here, because the save's
   * restore path needs exactly the same reset and used to do none of it --
   * a resumed drive came back with a stale integral and a stale override.
   */
  setMode(name) {
    const i = MODES.indexOf(name);
    this.mode = i < 0 ? 0 : i;
    this.override.steer = 0;
    this.override.pedal = 0;
    this.i = 0;
    this.sync();
    return MODES[this.mode];
  }

  /**
   * Arc position of the car, and **which way along the road it points**.
   *
   * The second half is new with `prompt_5.md` item 4. The arc coordinate
   * is signed now -- the road runs both ways out of the origin -- so
   * "ahead" is no longer "+s". It is `+s` if the car is pointing along the
   * road's tangent and `-s` if it is pointing back down it, and every
   * lookahead below multiplies by that.
   *
   * Without it, turning the car round makes the autopilot aim at a point
   * behind itself: it steers to bring that point in front, which turns the
   * car round again, and the car oscillates on the spot. The sign is one
   * dot product and it is the whole of the fix.
   *
   * `dir` itself is written by `main.js`, every frame, because the lead
   * servo needs it whether or not the autopilot is holding anything and
   * `sync` only runs when it is.
   */
  sync() {
    const q = this.road.nearest(this.car.pos.x, this.car.pos.z,
                                this._q || (this._q = {}));
    if (q) { this.s = q.s; this.off = q.d; }
    else this.off = 999;      // beyond the road index's horizon -- lost
  }

  /**
   * One frame.
   *
   * @param manual  what the human is asking for.  Whichever channels the
   *   autopilot is not holding pass straight through, so the driver's
   *   input is never filtered by a controller that is not driving.
   */
  update(dt, manual = null) {
    const car = this.car;
    const road = this.road;
    this.sync();

    /* --- who has which channel --------------------------------------- *
     * A held input suspends its own channel and re-arms the timer; the
     * timer then runs down after the key is released.  Note this reads
     * `manual` rather than `Input.active()`: the question is "is the
     * driver asking for something on *this* channel", and the answer for
     * the throttle must not be changed by the steering. */
    if (manual) {
      if (Math.abs(manual.steer) > 0.02) this.override.steer = HOLD_STEER;
      else this.override.steer = Math.max(0, this.override.steer - dt);
      if (manual.throttle > 0.02 || manual.brake > 0.02 || manual.handbrake) {
        this.override.pedal = HOLD_PEDAL;
      } else {
        this.override.pedal = Math.max(0, this.override.pedal - dt);
      }
    } else {
      this.override.steer = Math.max(0, this.override.steer - dt);
      this.override.pedal = Math.max(0, this.override.pedal - dt);
    }

    /* Aim closer when we are off the road, so the return is a turn onto it
     * rather than a long diagonal that never quite arrives. */
    const wide = Math.min(1, this.off / 12);
    const look = (LOOK_MIN + Math.abs(car.speed) * LOOK_PER_SPEED) * (1 - 0.55 * wide);
    road.sampleAt(this.s + look * this.dir, this._sm);
    const tx = this._sm.x - car.pos.x;
    const tz = this._sm.z - car.pos.z;

    // steer toward the aim point, in the car's own frame
    const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
    const ahead = tx * fx + tz * fz;
    const side = tx * -fz + tz * fx;
    const alpha = Math.atan2(side, Math.max(0.2, ahead));
    const dist = Math.hypot(tx, tz);
    // the pure-pursuit steer angle for this wheelbase and this aim point
    const steer = Math.atan2(2 * car.m.wheelbase * Math.sin(alpha), Math.max(1, dist));
    this.axes.steer = Math.max(-1, Math.min(1, steer / car.m.maxSteer));

    /* Target speed from the *worst* curvature between here and the horizon,
     * not the curvature at the aim point: braking has to start before the
     * corner, and the corner has to be visible from where the braking is. */
    let worstK = 0;
    const horizon = Math.max(40, Math.abs(car.speed) * 3.4);
    for (let d = 0; d <= horizon; d += STEP) {
      const k = Math.abs(road.sampleAt(this.s + d * this.dir, this._probe).k);
      const weight = 1 - 0.55 * (d / horizon);
      if (k * weight > worstK) worstK = k * weight;
    }
    const vCorner = worstK > 1e-5 ? Math.sqrt(A_LAT / worstK) : 999;
    const target = Math.min(this.cruise, vCorner);

    /* Slow down to get back on the road, and slow right down if we are
     * somewhere the road is not. */
    const cap = this.off > 6 ? Math.min(target, 12 + 20 / Math.max(1, this.off / 6)) : target;

    const err = cap - car.speed;
    /* Integrate only while the pedal is not already on the floor, which is
     * the cheap version of anti-windup and the only one this needs. */
    if (this.axes.throttle < 0.98 && this.axes.brake < 0.02) this.i += err * dt;
    this.i = Math.max(-4, Math.min(6, this.i));
    if (err < -1.5) this.i = Math.min(this.i, 0);

    const demand = err * 0.34 + this.i * 0.22;
    if (demand > 0) { this.axes.throttle = Math.min(1, demand); this.axes.brake = 0; }
    else { this.axes.throttle = 0; this.axes.brake = Math.min(1, -demand * 0.5); }

    /* --- merge -------------------------------------------------------- *
     * Both channels were computed above whatever the mode is, because the
     * steering term needs the speed term's arc tracking and because a
     * channel that is only computed when it is used is a channel that
     * jumps when it is switched on. */
    const out = this.out;
    const m = manual || REST;
    if (this.driving) {
      out.throttle = this.axes.throttle;
      out.brake = this.axes.brake;
      out.handbrake = 0;
    } else {
      out.throttle = m.throttle;
      out.brake = m.brake;
      out.handbrake = m.handbrake;
      /* Hand the integral back at zero, or the moment the autopilot takes
       * the pedals again it corrects for an error it accumulated while
       * somebody else was driving. */
      this.i = 0;
    }
    out.steer = this.steering ? this.axes.steer : m.steer;
    return out;
  }
}

/** What a null `manual` means: nobody is asking for anything. */
const REST = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
