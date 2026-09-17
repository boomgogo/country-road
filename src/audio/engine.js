/* ------------------------------------------------------------------ *
 * What the engine is doing, which the car does not know.
 *
 * `Vehicle` is a force on the rear axle that tails off toward 22.35 m/s;
 * it has no crank, no gears and no revs, and it should not grow them for
 * the sake of a noise.  So this is a gearbox that exists only to be
 * heard: a road speed, a pedal and a handful of flags in, an rpm and a
 * load out, for `engine-worklet.js` to turn into pressure.
 *
 * **The gearing is not a 992's.**  The real car does 50 mph in second at
 * about 4000 rpm, and this car's top speed *is* 50 mph -- geared honestly,
 * a whole drive would be heard in second and third.  So the six ratios
 * spread over the speed this car actually has, with top gear at 50 mph
 * landing a little over 3000 rpm: a relaxed cruise, a real climb through
 * the box on the way up to it, and a downshift you can hear when a bend
 * asks for the brake.
 *
 * It shifts like a twin-clutch automatic: up early on a light foot and
 * late on a heavy one, down on the brake with a blip, down two on a stamp.
 *
 * **"Heavy" is the pedal and the car together.**  A keyboard throttle is
 * all or nothing, so a player cruising on `W` has the pedal on the floor
 * at a top speed the car cannot exceed -- and a box reading only the pedal
 * held that at 6500 rpm in third, for the whole drive.  So the demand is
 * the pedal scaled by how hard the car is actually accelerating: flat out
 * from a standstill it revs out, flat out at 50 mph it settles into sixth
 * and a low, easy load.
 * ------------------------------------------------------------------ */

/** rpm per m/s of road speed, by gear. */
const RATIO = [620, 400, 290, 220, 175, 142];
const IDLE = 780;
const REDLINE = 7400;
const SHIFT_TIME = 0.16;

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class EngineModel {
  constructor() {
    this.gear = 1;
    this.rpm = 0;
    this.load = 0;
    /** Seconds since the last shift; the box will not hunt. */
    this._since = 1;
    /** Counts down through a shift: the torque is cut and the revs swing. */
    this._shift = 0;
    this._blip = 0;
    this._running = false;
    this._crank = -1;
    this._t = 0;
    this._v = 0;
    this._accel = 0;
    this._stamp = 0;
    this._lastThrottle = 0;
  }

  /** Turn the key.  The crank, the catch, the flare and the settle. */
  ignite() {
    this._running = false;
    this._crank = 0;
    this.rpm = 0;
  }

  /** Already running -- a page that came back, or sound switched on mid-drive. */
  run() {
    this._running = true;
    this._crank = -1;
    if (this.rpm < IDLE) this.rpm = IDLE;
  }

  /** Running, or on its way there -- either way, not a key to turn again. */
  get running() { return this._running || this._crank >= 0; }

  /**
   * @param {number} dt
   * @param {object} c  speed (m/s along the nose), throttle and brake 0..1,
   *                    airborne, and `still` for a car that is being held
   *                    rather than driven -- a rest, or the warp.
   */
  update(dt, c) {
    this._t += dt;
    /* A driver who does not wait for the settle has a running engine. */
    if (this._crank > 1.05 && (c.throttle > 0.05 || Math.abs(c.speed) > 2)) this._crank = 9;
    if (this._crank >= 0) return this._cranking(dt);
    if (!this._running) { this.rpm = 0; this.load = 0; return; }

    const v = c.speed;
    const av = Math.abs(v);
    const throttle = c.still ? 0 : c.throttle;
    this._since += dt;
    if (dt > 0) {
      const a = (av - this._v) / dt;
      this._accel += (a - this._accel) * (1 - Math.exp(-dt / 0.4));
    }
    this._v = av;
    /* Pulling away counts as hard work before the estimate has caught up. */
    const effort = Math.max(smooth(0.4, 2.5, this._accel), 1 - av / 8);
    const demand = throttle * (0.25 + 0.75 * effort);
    /* A stamp: the pedal going down hard, recently. */
    if (throttle > 0.92 && this._lastThrottle < 0.6) this._stamp = 0.35;
    this._stamp = Math.max(0, this._stamp - dt);
    this._lastThrottle = throttle;

    let target;
    let load = throttle * (0.35 + 0.65 * effort);
    if (v < -0.3) {
      /* Reverse is one gear and nobody revs it. */
      this.gear = 1;
      target = Math.max(IDLE, av * 560 + throttle * 600);
    } else {
      this._box(av, demand, c.brake);
      const wheel = av * RATIO[this.gear - 1];
      /* The clutch: pulling away, the engine is ahead of the wheels until
       * the wheels catch up with it. */
      const slip = IDLE + throttle * 1700 * Math.max(0, 1 - av / 5);
      target = Math.max(wheel, slip, IDLE);
      /* In the air, or with nothing holding the rear down, the revs are
       * whatever the pedal says. */
      if (c.airborne) target = Math.max(target, IDLE + throttle * (REDLINE - IDLE) * 0.85);
    }

    /* The shift itself: torque cut on the way up, a blip on the way down. */
    if (this._shift > 0) {
      this._shift -= dt;
      load *= 0.15;
    }
    if (this._blip > 0) {
      this._blip -= dt;
      load = Math.max(load, 0.55);
    }
    if (target > REDLINE) { target = REDLINE - 150; load = 0; }

    /* The idle hunts a little, the way an idle does. */
    if (target <= IDLE + 5) {
      target = IDLE + 18 * Math.sin(this._t * 2.3) + 9 * Math.sin(this._t * 5.9);
      load = Math.max(load, 0.1);
    }

    /* A crank has inertia: it rises quicker than it falls. */
    const tau = this._shift > 0 ? 0.05 : target > this.rpm ? 0.09 : 0.16;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-dt / tau));
    this.load += (load - this.load) * (1 - Math.exp(-dt / 0.06));
  }

  _box(av, throttle, brake) {
    if (this._since < 0.45) return;
    const g = this.gear;
    const rpm = av * RATIO[g - 1];
    const up = 2500 + 4300 * Math.pow(throttle, 1.5);
    const down = 1250 + 1900 * throttle + 900 * brake;
    /* Never up on the brake: a downshift under braking lands above a
     * light foot's upshift point, and the box would hunt between two. */
    if (g < RATIO.length && rpm > up && brake < 0.05) {
      this._change(g + 1, false);
    } else if (g > 1 && rpm < down) {
      this._change(g - 1, brake > 0.1);
    } else if (g > 2 && this._stamp > 0 && av < 19 && rpm < 3300 && av * RATIO[g - 3] < 6200) {
      /* Kickdown: two at once, the way a stamp on the pedal asks for. */
      this._change(g - 2, true);
    }
  }

  _change(gear, blip) {
    const up = gear > this.gear;
    this.gear = gear;
    this._since = 0;
    if (up) this._shift = SHIFT_TIME;
    else if (blip) this._blip = 0.12;
  }

  _cranking(dt) {
    this._crank += dt;
    const t = this._crank;
    if (t < 0.75) {
      /* Cranking: two hundred-odd rpm and no fire yet. */
      this.rpm = 210 + 40 * Math.sin(t * 40);
      this.load = 0.03;
    } else if (t < 1.05) {
      /* It catches. */
      this.rpm += (2300 - this.rpm) * (1 - Math.exp(-dt / 0.08));
      this.load = 0.7;
    } else if (t < 2.6) {
      /* And settles to a fast idle, then to idle. */
      this.rpm += (IDLE - this.rpm) * (1 - Math.exp(-dt / 0.45));
      this.load += (0.12 - this.load) * (1 - Math.exp(-dt / 0.2));
    } else {
      this._crank = -1;
      this._running = true;
      this.gear = 1;
    }
  }
}
