/* ------------------------------------------------------------------ *
 * The controls a phone has.
 *
 * Everything in this game was reachable from a keyboard and nothing else:
 * W A S D to drive, eleven single keys for the commands, a wheel for the
 * camera distance.  On a phone that is a beautiful landscape you can look
 * at and a car you cannot move -- which is the same class of bug as every
 * other one in this project's history, a control that is not there being
 * indistinguishable from a control that is broken.
 *
 * Three things go in, and they map onto the three things the keyboard
 * already did:
 *
 *   the pad    a relative thumbstick on the bottom left.  Analog steering,
 *              which is the one axis where a phone can be *better* than a
 *              keyboard: `Input` has to ease a key into a steering angle
 *              because a key is a step function, and a thumb is not.
 *   the pedals bottom right, throttle over brake.  Binary, exactly like
 *              W and S -- holding the brake at a standstill still reverses,
 *              because that is `Vehicle`'s rule and not the keyboard's.
 *   the strip  top right: the two commands you reach for while driving
 *              (autodrive, camera) and a panel behind `☰` for the nine
 *              that you do not.
 *
 * **Nothing here touches the game.**  The pad and the pedals write into
 * `input.touch`, which `Input.sample` folds in beside the keyboard and the
 * gamepad; the buttons call the same `command()` that a keypress calls.
 * So the autopilot's per-channel override, the takeover latch, the toasts
 * and the save all work on a phone without knowing a phone exists.  That
 * is the whole point of `input.js`'s opening line -- input is data, not
 * events -- finally being cashed in.
 *
 * Looking around and the camera distance are *not* here.  They belong to
 * `core/pointer.js`, which has always used pointer events, so a finger
 * already dragged the view for free; what it gained for this is the
 * second finger, because a phone has no scroll wheel and a pinch is the
 * gesture everybody already knows.
 *
 * ## When the controls appear
 *
 * `(pointer: coarse) and (hover: none)` is the phone-or-tablet test, and
 * it is checked at boot -- but it is not the only way in.  A false
 * negative here is fatal (no controls at all, on the one device that has
 * no keyboard either), so a first `touchstart` anywhere also enables them.
 * A false positive is merely untidy, and the touchscreen laptop that
 * reports coarse-and-hover-none is rare enough to accept.  `?touch=1` and
 * `?touch=0` force it either way, which is how this gets tested on a
 * desktop at all.
 * ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const FORCED = params.get('touch');

/** Is this a device whose primary pointer is a finger? */
export function coarsePointer() {
  if (FORCED === '1') return true;
  if (FORCED === '0') return false;
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}

/** The two always-visible commands.  Everything else is behind `☰`. */
const STRIP = [
  { cmd: 'autodrive', label: 'auto' },
  { cmd: 'camera', label: 'cam' },
];

/**
 * The panel.
 *
 * `hold` is the `[` `]` pair and nothing else: they scrub for as long as
 * they are held and `timeUp` ends the scrub, which is a press *and a
 * release*, so those two buttons cannot be ordinary taps.  `keep` leaves
 * the panel open, because winding the clock two hours is four presses and
 * a panel that shut after the first would be four presses and four
 * openings.
 */
const PANEL = [
  { cmd: 'menu', label: 'pause' },
  { cmd: 'rest', label: 'rest' },
  { cmd: 'recover', label: 'back to road' },
  { cmd: 'timeBack', up: 'timeUp', label: 'time  −', keep: true },
  { cmd: 'timeFwd', up: 'timeUp', label: 'time  +', keep: true },
  { cmd: 'hud', label: 'hide hud' },
  { cmd: 'sound', label: 'sound' },
  { full: true, label: 'full screen', keep: true },
];

export class TouchControls {
  /**
   * @param {Input} input     the axes the pad and pedals write into
   * @param {object} opts     `onCommand` -- the same handler the keyboard
   *   uses; `onEnable` -- called once, when the controls actually appear,
   *   so `main.js` can retitle the hint line and the load prompt.
   */
  constructor(input, opts = {}) {
    this.input = input;
    this.t = input.touch;
    this.onCommand = opts.onCommand || (() => {});
    this.onEnable = opts.onEnable || (() => {});
    this.enabled = false;
    this.el = null;
    if (FORCED === '0') return;
    if (coarsePointer()) this.enable();
    else addEventListener('touchstart', () => this.enable(), { once: true, passive: true });
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this._build();
    document.body.classList.add('touch');
    this._noZoom();
    this._keepAwake();
    this.onEnable(this);
  }

  /* ------------------------------------------------------------------ *
   * Zoom: a control this game does not have, and which iOS hands out
   * anyway.
   *
   * `user-scalable=no` in the viewport meta has been ignored by Safari
   * since iOS 10 -- page zoom is an accessibility guarantee, and for a
   * document that is the right call.  So a second tap on the throttle
   * zooms the page *into* the throttle, and every tap after that lands
   * somewhere the control no longer is.  Neither `touch-action: none` nor
   * the `preventDefault` on `pointerdown` in `_pedal` stops it: WebKit
   * builds pointer events on top of touch events and does not let the
   * pointer one cancel the touch default.  Only a `preventDefault` on the
   * *touch* event does.
   *
   * Two of those, then:
   *
   *   - every touch that ends on a control, unconditionally.  Nothing in
   *     here waits for a `click` -- the buttons all fire on
   *     `pointerdown` -- so there is no default left worth keeping.
   *   - anywhere else, only the second of a quick pair.  A single tap on
   *     the canvas keeps whatever the browser wanted to do with it; it is
   *     the double tap, and only the double tap, that zooms.
   *
   * And the way back out.  Cancelling `gesturestart` is what stops a
   * two-finger pinch scaling the page out from under the pinch that is
   * meant to be moving the camera -- but unconditionally it also cancels
   * the *only* gesture that undoes a zoom already in progress, which is
   * how a double tap became a trap with no way back.  So it stands down
   * whenever the page is actually scaled: while it is, a pinch belongs to
   * Safari and the player can get back to 1x.
   * ------------------------------------------------------------------ */

  _noZoom() {
    /* Comfortably wider than the ~300 ms Safari itself waits, because a
     * double tap that zooms is worse than a click that does not fire. */
    const QUICK = 400;
    let last = -Infinity;
    document.addEventListener('touchend', (e) => {
      const now = performance.now();
      const onControl = e.target instanceof Node && this.el && this.el.contains(e.target);
      if (onControl || now - last < QUICK) e.preventDefault();
      last = now;
    }, { passive: false });

    for (const type of ['gesturestart', 'gesturechange']) {
      document.addEventListener(type, (e) => {
        if (pageScale() > 1.02) return;
        e.preventDefault();
      }, { passive: false });
    }
  }

  /* ------------------------------------------------------------------ *
   * The DOM
   * ------------------------------------------------------------------ */

  _build() {
    const el = document.createElement('div');
    el.className = 'tc';
    el.innerHTML = `
      <div class="tc-steer" id="tc-steer"><b>steer</b><i class="tc-knob" id="tc-knob"></i></div>
      <div class="tc-pedals">
        <div class="tc-pedal" id="tc-gas"><b>▲</b></div>
        <div class="tc-pedal tc-brake" id="tc-brake"><b>▼</b></div>
      </div>
      <div class="tc-pad tc-hand" id="tc-hand"><b>hand<br>brake</b></div>
      <div class="tc-strip">
        ${STRIP.map((b) => `<div class="tc-btn" data-cmd="${b.cmd}">${b.label}</div>`).join('')}
        <div class="tc-btn tc-more" id="tc-more">☰</div>
      </div>
      <div class="tc-panel" id="tc-panel">
        ${PANEL.map((b, i) => `<div class="tc-btn" data-i="${i}">${b.label}</div>`).join('')}
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    this.knob = el.querySelector('#tc-knob');
    this.panel = el.querySelector('#tc-panel');

    this._steer(el.querySelector('#tc-steer'));
    this._pedal(el.querySelector('#tc-gas'), 'throttle');
    this._pedal(el.querySelector('#tc-brake'), 'brake');
    this._pedal(el.querySelector('#tc-hand'), 'handbrake');

    for (const b of el.querySelectorAll('.tc-strip .tc-btn[data-cmd]')) {
      this._tap(b, () => this.onCommand(b.dataset.cmd));
    }
    this._tap(el.querySelector('#tc-more'), () => {
      this.panel.classList.toggle('open');
    });
    /* Anything else on the screen shuts it.  A panel that covers a third
     * of a phone and can only be closed by the button that opened it is a
     * panel you close by accident with the throttle. */
    addEventListener('pointerdown', (e) => {
      if (!this.panel.classList.contains('open')) return;
      if (e.target instanceof Node
          && (this.panel.contains(e.target) || el.querySelector('#tc-more').contains(e.target))) return;
      this.panel.classList.remove('open');
    }, true);
    for (const b of this.panel.querySelectorAll('.tc-btn')) {
      const spec = PANEL[Number(b.dataset.i)];
      this._tap(b, () => {
        if (spec.full) this._fullscreen();
        else this.onCommand(spec.cmd);
        if (!spec.keep) this.panel.classList.remove('open');
      }, spec.up ? () => this.onCommand(spec.up) : null);
    }
  }

  /* ------------------------------------------------------------------ *
   * The pad
   *
   * Relative, not absolute: wherever the thumb lands is straight ahead.
   * An absolute pad -- steer read off the distance from the pad's own
   * centre -- puts the car into a corner the instant a thumb lands
   * slightly off, which on a 92 px control is every time.
   *
   * Past full lock the origin follows the thumb, so coming back off lock
   * steers immediately rather than after however far the thumb overshot.
   * That is the one piece of joystick behaviour everybody notices only
   * when it is missing.
   * ------------------------------------------------------------------ */

  _steer(pad) {
    let id = null;
    let origin = 0;
    let range = 110;
    const set = (v) => {
      this.t.steer = curve(v);
      this.t.steering = true;
      this.knob.style.transform = `translateX(${(v * range).toFixed(1)}px)`;
    };
    pad.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      capture(pad, id);
      pad.classList.add('on');
      /* Off the control's real width, so the sweep is the same fraction of
       * the pad on a 360 px phone and a 1024 px tablet. */
      range = Math.max(55, Math.min(140, pad.getBoundingClientRect().width * 0.36));
      origin = e.clientX;
      set(0);
      e.preventDefault();
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - origin;
      if (dx > range) { origin = e.clientX - range; dx = range; }
      else if (dx < -range) { origin = e.clientX + range; dx = -range; }
      set(dx / range);
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      pad.classList.remove('on');
      /* `steering` false rather than a steer of zero, so `Input` eases the
       * wheel back to centre from wherever it was instead of snapping --
       * the same easing a released A or D gets. */
      this.t.steering = false;
      this.t.steer = 0;
      this.knob.style.transform = 'translateX(0px)';
    };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('lostpointercapture', up);
  }

  /* One pedal.  Binary, and captured, so a thumb that slides off the
   * button mid-corner does not silently lift off the throttle. */
  _pedal(el, axis) {
    let id = null;
    const down = (e) => {
      if (id !== null) return;
      id = e.pointerId;
      capture(el, id);
      el.classList.add('on');
      this.t[axis] = 1;
      e.preventDefault();
    };
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('on');
      this.t[axis] = 0;
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  /**
   * A button.
   *
   * `pointerdown` rather than `click`, to match the load screen's two
   * choices and for the reason given there: a control that needs a press
   * *and a release* where its neighbours need only a press is a difference
   * nobody can see and everybody feels.  `onUp` is the scrub keys' release.
   */
  _tap(el, onDown, onUp = null) {
    if (!el) return;
    let id = null;
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      capture(el, id);
      el.classList.add('on');
      e.preventDefault();
      e.stopPropagation();
      onDown();
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('on');
      if (onUp) onUp();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  /* ------------------------------------------------------------------ *
   * The two bits of phone housekeeping
   * ------------------------------------------------------------------ */

  /** Full screen, where there is such a thing.  iOS on a phone has no
   *  element fullscreen at all, so the button hides itself rather than
   *  sitting there doing nothing -- which is the bug this file is about. */
  _fullscreen() {
    const d = document;
    const root = d.documentElement;
    if (!root.requestFullscreen) return;
    if (d.fullscreenElement) d.exitFullscreen?.();
    else root.requestFullscreen().catch(() => {});
  }

  /**
   * A drive is minutes of watching the road with nothing being tapped,
   * which is exactly what a phone reads as "asleep".
   *
   * Asked for three times over, because the first ask is the one most
   * likely to be refused: the controls can appear before the load screen
   * has been touched, and a browser is entitled to want a gesture and to
   * drop the lock whenever the tab stops being visible.
   */
  async _keepAwake() {
    if (!navigator.wakeLock) return;
    const take = async () => {
      if (document.visibilityState !== 'visible' || this._lock) return;
      try {
        this._lock = await navigator.wakeLock.request('screen');
        this._lock.addEventListener('release', () => { this._lock = null; });
      } catch { /* refused; the next gesture or foreground will ask again */ }
    };
    document.addEventListener('visibilitychange', take);
    addEventListener('pointerdown', take, { once: true });
    take();
  }
}

/**
 * How far Safari has pinched the page, where there is a way to ask.
 *
 * 1 is "not zoomed" everywhere else, which is the answer that keeps the
 * pinch guard above switched on.
 */
function pageScale() {
  const v = typeof visualViewport !== 'undefined' ? visualViewport : null;
  return v && typeof v.scale === 'number' ? v.scale : 1;
}

/**
 * Hold the rest of the gesture, wherever it goes.
 *
 * Capture is what stops a thumb that slides off the throttle mid-corner
 * from silently lifting off it, and what lets the pad be swept past its
 * own edge.  It throws if the pointer is already gone by the time the
 * handler runs -- a fast tap, or a synthetic event from a probe -- and
 * that is not a reason to lose the press.
 */
function capture(el, id) {
  try { el.setPointerCapture(id); } catch { /* already released */ }
}

/**
 * Thumb travel to steering angle.
 *
 * Not linear: a phone's whole steering range is about 40 mm of thumb, and
 * a straight mapping spends most of it on angles the road never asks for
 * while the shallow corrections that hold a lane live in the first three
 * millimetres.  Squaring is too much -- the corners of this road are real
 * -- so it is half-and-half, which halves the gain at centre and keeps
 * full lock at full travel.
 */
function curve(v) {
  const a = Math.abs(v);
  return Math.sign(v) * a * (0.45 + 0.55 * a);
}
