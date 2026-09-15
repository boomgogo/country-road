/* ------------------------------------------------------------------ *
 * Input is data, not events.
 *
 * Everything downstream reads `axes` and nothing downstream knows where
 * they came from -- a keyboard, a gamepad, or the film director in
 * `tools/rec`.  That is not tidiness for its own sake: a game that only
 * listens to the keyboard cannot be driven from script (browsers can
 * ignore synthetic KeyboardEvents), and being unable to drive your own
 * game from a script is the thing that makes a recorded film impossible.  So the seam goes in first, before
 * there is anything to drive.
 * ------------------------------------------------------------------ */

export class Input {
  constructor(opts = {}) {
    this.axes = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    this.keys = Object.create(null);
    /** Set by the director; when true the keyboard is ignored. */
    this.scripted = false;
    /** Driving keys that were already down when autodrive engaged.  See
     *  `armTakeover` -- they do not count as a request to take over. */
    this.held = new Set();
    this.padHeld = { steer: false, throttle: false, brake: false };
    /**
     * The third source, written by `core/touch.js` and read here.
     *
     * It is a *source*, not a set of axes: a phone's pad is analog and its
     * pedals are not, so `steering` says whether the thumb is on the pad
     * at all -- which is what lets a released pad ease back to centre
     * through the same code a released `A` goes through, rather than
     * snapping the rack straight.
     */
    this.touch = { steer: 0, steering: false, throttle: 0, brake: 0, handbrake: 0 };
    this.touchHeld = { steer: false, throttle: false, brake: false, handbrake: false };
    this.onCommand = opts.onCommand || (() => {});
    this._bind();
  }

  _bind() {
    const set = (e, down) => {
      const k = e.code;
      if (down && !e.repeat) {
        const c = COMMANDS[k];
        if (c) { this.onCommand(c, e); }
      } else if (!down && RELEASES[k]) {
        /* Only two keys care about being let go: `[` and `]` scrub for as
         * long as they are held, so the release is the end of the scrub.
         * Everything else is an edge. */
        this.onCommand(RELEASES[k], e);
      }
      this.keys[k] = down;
      if (DRIVING.has(k)) e.preventDefault();
    };
    addEventListener('keydown', (e) => set(e, true), { passive: false });
    addEventListener('keyup', (e) => set(e, false), { passive: false });
    addEventListener('blur', () => { this.keys = Object.create(null); });
  }

  /** Is any driving key down at all?  Unlike `active()`, this does not
   *  care whether the key was already held when autodrive engaged -- it is
   *  asked by the time-lapse, which wants to know only whether somebody
   *  would rather be driving than resting. */
  driving() {
    for (const code of DRIVING) if (this.keys[code]) return true;
    const t = this.touch;
    return t.steering || t.throttle > 0 || t.brake > 0 || t.handbrake > 0;
  }

  /**
   * Is a human asking for something right now?
   *
   * Autodrive used to hold the axes and `sample()` was never called while
   * it was on, so the keyboard did nothing at all and nothing said why.
   * The frame loop now samples every frame and hands over the moment this
   * is true -- cruise control, not a mode you have to know the key for.
   *
   * The question is *"has the driver asked for something since autodrive
   * engaged"*, not *"is a key down"*, and the difference is the whole of
   * why `F` looked broken: press it while accelerating -- which is exactly
   * when anyone would -- and W was still down on the next frame, so the
   * autodrive that had just engaged handed straight back.  It lasted one
   * frame, every time.  `armTakeover` latches whatever is already held and
   * this ignores it until it is let go.
   */
  active() {
    if (this.scripted) return false;
    for (const code of DRIVING) {
      if (!this.keys[code]) { this.held.delete(code); continue; }
      if (!this.held.has(code)) return true;
    }
    /* Same latch for the pad, because a stick resting outside the dead
     * zone -- a worn thumbstick is usually a little off centre -- would
     * otherwise make autodrive impossible to engage at all, with no key to
     * blame for it. */
    const p = this._pad();
    if (p) {
      const h = this.padHeld;
      if (!dead(p.axes[0])) h.steer = false;
      else if (!h.steer) return true;
      if (trigger(p, 7) <= 0.05) h.throttle = false;
      else if (!h.throttle) return true;
      if (trigger(p, 6) <= 0.05) h.brake = false;
      else if (!h.brake) return true;
    }
    /* And the same latch again for the phone, for the same reason: `AUTO`
     * is a button an inch from the throttle, and a thumb resting on the
     * throttle while the other one presses it would hand the wheel back on
     * the frame after the one that took it. */
    const t = this.touch;
    const th = this.touchHeld;
    if (!t.steering) th.steer = false;
    else if (!th.steer) return true;
    if (t.throttle <= 0) th.throttle = false;
    else if (!th.throttle) return true;
    if (t.brake <= 0) th.brake = false;
    else if (!th.brake) return true;
    if (t.handbrake <= 0) th.handbrake = false;
    else if (!th.handbrake) return true;
    return false;
  }

  /**
   * Has the handbrake been pulled since autodrive engaged?
   *
   * The handbrake is the one input that switches autodrive *off* rather
   * than overriding a channel: nobody pulls it wanting the autopilot to
   * pick the car back up seven tenths of a second later.  It goes through
   * the same latch as `active()`, so `F` pressed with `Space` already down
   * does not disengage on the next frame.
   */
  handbrakePulled() {
    if (this.scripted) return false;
    if (this.keys.Space && !this.held.has('Space')) return true;
    return this.touch.handbrake > 0 && !this.touchHeld.handbrake;
  }

  /**
   * Take note of what is already held, and stop counting it.
   *
   * Called wherever autodrive is engaged.  Everything latched here has to
   * go back to rest before it can take the wheel again.
   */
  armTakeover() {
    this.held.clear();
    for (const code of DRIVING) if (this.keys[code]) this.held.add(code);
    const p = this._pad();
    this.padHeld = {
      steer: !!(p && dead(p.axes[0])),
      throttle: !!(p && trigger(p, 7) > 0.05),
      brake: !!(p && trigger(p, 6) > 0.05),
    };
    const t = this.touch;
    this.touchHeld = {
      steer: t.steering, throttle: t.throttle > 0, brake: t.brake > 0,
      handbrake: t.handbrake > 0,
    };
  }

  /** The first connected pad, or null. */
  _pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p) return p;
    return null;
  }

  /** Fold whatever the keyboard and pads are doing into the axes. */
  sample(dt) {
    if (this.scripted) return this.axes;
    const k = this.keys;
    const a = this.axes;
    const up = k.KeyW || k.ArrowUp;
    const down = k.KeyS || k.ArrowDown;
    const left = k.KeyA || k.ArrowLeft;
    const right = k.KeyD || k.ArrowRight;

    a.throttle = up ? 1 : 0;
    a.brake = down ? 1 : 0;
    /* The handbrake was in `DRIVING` -- so `Space` had its default
     * scrolling suppressed -- and read by nothing.  It matters now that
     * there is somewhere to slide. */
    a.handbrake = k.Space ? 1 : 0;

    /* Steering is eased rather than switched, because a key is a step
     * function and a steering wheel is not.  The car has its own rate limit
     * on top of this; both are wanted, and they do different jobs -- this
     * one is the driver's hands, that one is the rack. */
    const want = (left ? -1 : 0) + (right ? 1 : 0);
    const rate = want === 0 ? 6.5 : 4.2;
    a.steer += (want - a.steer) * Math.min(1, dt * rate);
    if (Math.abs(a.steer) < 0.002) a.steer = 0;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const lx = dead(p.axes[0]);
      if (lx) a.steer = lx;
      const rt = p.buttons[7] ? p.buttons[7].value : 0;
      const lt = p.buttons[6] ? p.buttons[6].value : 0;
      if (rt > 0.02) a.throttle = rt;
      if (lt > 0.02) a.brake = lt;
      break;
    }

    /* The phone, last, and by `Math.max` for the two pedals: a tablet with
     * a keyboard attached has both, and neither should be able to lift the
     * other's foot.  Steering is an assignment rather than a max because
     * it is signed -- and when the thumb is off the pad the keyboard easing
     * above has already carried `a.steer` a little further back toward
     * centre, which is exactly what should happen. */
    const t = this.touch;
    if (t.steering) a.steer = t.steer;
    if (t.throttle > 0) a.throttle = Math.max(a.throttle, t.throttle);
    if (t.brake > 0) a.brake = Math.max(a.brake, t.brake);
    if (t.handbrake > 0) a.handbrake = Math.max(a.handbrake, t.handbrake);
    return a;
  }
}

function trigger(p, i) { return p.buttons[i] ? p.buttons[i].value : 0; }

function dead(v, d = 0.12) {
  if (v === undefined) return 0;
  return Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);
}

const DRIVING = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);

const COMMANDS = {
  Escape: 'menu',
  KeyF: 'autodrive',
  KeyZ: 'rest',
  KeyT: 'recover',
  KeyC: 'camera',
  KeyH: 'hud',
  KeyR: 'reseed',
  KeyO: 'ink',
  KeyG: 'grade',
  KeyP: 'photo',
  KeyM: 'sound',
  BracketLeft: 'timeBack',
  BracketRight: 'timeFwd',
};

/** Commands that also fire on key *up*.  See `_bind`. */
const RELEASES = {
  BracketLeft: 'timeUp',
  BracketRight: 'timeUp',
};
