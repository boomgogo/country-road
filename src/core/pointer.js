/* ------------------------------------------------------------------ *
 * Looking around, and how far away to stand.
 *
 * Two gestures, both of which belong to the *camera* and neither of which
 * is a driving input.  That last part is load-bearing: autodrive hands
 * back the moment the driver asks for anything, and a player who drags the
 * mouse to look at the scenery has not asked to drive.  So none of this
 * goes anywhere near `Input.active()`.
 *
 * Drag rotates the rig's yaw and pitch about the car, at a fixed radius --
 * `ChaseCamera` adds these to its spring *targets*, so the view swings to
 * where you dragged rather than snapping, and the distance the rig holds
 * is untouched by any of it.  The wheel scales that distance.
 *
 * In a *mounted* mode -- bonnet view -- the same two numbers turn a head
 * instead: the eye is bolted to the car and only the aim springs, so a drag
 * changes where the driver is looking and not where the driver is.  Which
 * is why the limits below belong to the mode and not to this file.
 *
 * **One zoom, not one per mode**, and that is `prompt_5.md` item 1.
 *
 * The wheel used to scale each camera mode's range separately, over a 5x
 * span (0.6 to 3.0), against a gap between the two chase modes' base
 * ranges of 1.6x -- 5.6-7.0 m against 9.0-12.0. So a player who scrolled
 * out once in `chase` and in once in `chase far` had literally swapped
 * them: chase at 3.0x sits 15 m back, chase far at 0.6x sits 4.4 m back.
 * Nothing on screen said the zoom was anything but default, because the
 * mode name was a 1.8-second toast and the zoom had no readout at all.
 *
 * Measured on a clean session, the modes are the right way round -- 5.66 m
 * against 9.34 m, label and distance agreeing on every press of C. It is
 * only reachable *state* that inverts them. With one shared multiplier,
 *
 *     chase.range * z  <  chaseFar.range * z    for every z
 *
 * is true by construction rather than by tuning, and no sequence of wheel
 * events can put them the wrong way round. The price is the thing this
 * comment used to argue for -- "a bit further back" really is a different
 * answer in the two views -- and the modes' own base ranges already say
 * so. An invariant beats a preference here.
 *
 * Pointer events rather than mouse events, so a finger on a phone drags
 * the view for free.  Not pointer lock: the prompt asks for click and
 * drag, and pointer lock takes the cursor away from the page to do it.
 *
 * **And two fingers are the wheel.**  A phone has no scroll wheel, so the
 * distance control -- the whole of the argument above about one zoom
 * rather than one per mode -- was simply unreachable on the device that
 * most needs to be able to pull the camera back.  A pinch drives the same
 * single `want`, through the same clamp, so nothing said above stops being
 * true; it is a second way to spell `deltaY`.
 *
 * The second finger *suspends* the drag rather than sharing with it.  Two
 * fingers moving apart also move their midpoint, and a pinch that swung
 * the view by the drift of the midpoint is a pinch that ends looking
 * somewhere else.
 * ------------------------------------------------------------------ */

/** Radians per pixel dragged.  A 400 px drag is about 80 degrees. */
const SENS = 0.0035;

/**
 * How far the view can be swung from behind the car -- **per mode**, and
 * they live on the mode table in `car/camera.js` rather than here.
 *
 * They were three module constants shared by every mode, which is why
 * `prompt_16.md` asks for two opposite things in items 2 and 3: bonnet view
 * wants a much tighter band than chase view, and chase view wants no band
 * at all.  One set of numbers cannot answer both, and the mode is the thing
 * that knows which answer it wants.
 *
 * `yaw: null` means unbounded, and that is item 3: the old `Math.PI` was a
 * wall exactly at the front of the car, so the drag stopped precisely where
 * the view got interesting.  Unbounded is implemented as a **wrap** rather
 * than an accumulator, for two reasons.  `ChaseCamera` drives its yaw
 * through `angleDelta`, so a target that jumps by 2*PI is a target that has
 * not moved and the spring never sees the seam; and the recentring below
 * would otherwise have to unwind three whole turns to get back behind the
 * car, which is the one thing the old clamp was accidentally protecting.
 * A wrap gives unlimited rotation in both directions *and* a return that
 * always takes the short way home.
 *
 * The wrap only mis-reads a drag covering more than half a turn inside a
 * single `pointermove`, which at `SENS` is 900 px in one event.
 */
const FALLBACK_LOOK = { yaw: null, up: -0.55, down: 0.85 };

/** After letting go: how long the view holds, and how fast it comes back. */
const HOLD = 0.4;
const RETURN_TAU = 0.5;

/** What the wheel is allowed to do to the rig's range, and how fast.
 *  Narrower at the top than the old per-mode 3.0: one multiplier has to
 *  suit a 5.6 m rig and a 12 m one, and 2.2x of the far one is 26 m,
 *  which is as far away as a car can be and still be the subject. */
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.2;
const ZOOM_PER_NOTCH = 0.0012;    // per unit of deltaY
const ZOOM_TAU = 0.15;

export class Pointer {
  constructor(canvas, chase, opts = {}) {
    this.canvas = canvas;
    this.chase = chase;
    this.enabled = opts.enabled !== false;
    this.yaw = 0;
    this.pitch = 0;
    this.dragging = false;
    this.since = 0;               // seconds since the button came up
    this._id = null;
    this._x = 0;
    this._y = 0;
    /** Every finger currently down on the canvas, by pointer id.  A mouse
     *  contributes exactly one and so never pinches. */
    this._pts = new Map();
    /** Non-null while two fingers are down: the span and the zoom the
     *  gesture started from, so the pinch is a *ratio* and cannot drift. */
    this._pinch = null;
    /** Where the wheel wants the rig's range, before easing.  One number
     *  for every mode -- see the header. */
    this.want = 1;
    if (this.enabled) this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      /* Two is the whole vocabulary.  A third finger on the canvas is a
       * palm, and a palm should not be allowed to end a pinch. */
      if (this._pts.size >= 2) return;
      this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      /* Capture keeps the rest of the gesture coming here even when the
       * finger leaves the canvas, which on a phone is most of them -- the
       * controls and the HUD cover both ends of the screen.  It throws if
       * the pointer is already gone, and losing a whole drag to that is
       * worse than losing the capture. */
      try { c.setPointerCapture(e.pointerId); } catch { /* already released */ }
      e.preventDefault();
      if (this._pts.size === 2) {
        this.dragging = false;
        this._id = null;
        this._pinch = { span: this._span(), want: this.want };
        return;
      }
      this._id = e.pointerId;
      this._x = e.clientX; this._y = e.clientY;
      this.dragging = true;
    });
    c.addEventListener('pointermove', (e) => {
      const p = this._pts.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (this._pinch) {
        if (!this.chase.zoomable) return;
        const span = this._span();
        if (span < 24 || this._pinch.span < 24) return;
        /* Fingers apart -> a shorter rig, because `want` multiplies the
         * range.  The ratio is against the span the gesture *started*
         * from, so a pinch is reversible: come back to where you began and
         * the camera is where it began. */
        this.want = clamp(this._pinch.want * (this._pinch.span / span),
                          ZOOM_MIN, ZOOM_MAX);
        return;
      }
      if (!this.dragging || e.pointerId !== this._id) return;
      this.yaw += (e.clientX - this._x) * SENS;
      this.pitch += (e.clientY - this._y) * SENS;
      this._hold();
      this._x = e.clientX; this._y = e.clientY;
    });
    /* Fires more than once per finger -- `pointerup` and then
     * `lostpointercapture` -- so everything in here is idempotent.
     *
     * Lifting one finger of a pinch does not resume the drag with the
     * other: the view would jump by however far that finger had travelled
     * during the pinch.  The remaining finger is inert until it is lifted
     * and put back down, which is what a hand does anyway. */
    const up = (e) => {
      this._pts.delete(e.pointerId);
      if (this._pinch && this._pts.size < 2) {
        this._pinch = null;
        this.since = 0;
      }
      if (e.pointerId !== this._id) return;
      this.dragging = false;
      this.since = 0;
      this._id = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
    /* A dragged canvas otherwise starts a text selection or a native image
     * drag halfway through the gesture, and the view sticks. */
    c.addEventListener('dragstart', (e) => e.preventDefault());
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('wheel', (e) => {
      if (!this.chase.zoomable) return;
      this.want = clamp(this.want * Math.exp(e.deltaY * ZOOM_PER_NOTCH),
                        ZOOM_MIN, ZOOM_MAX);
      e.preventDefault();
    }, { passive: false });
  }

  /** Pixels between the two fingers.  Only ever called with two down. */
  _span() {
    const [a, b] = this._pts.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Put the view back behind the car, now.  Used when the mode changes. */
  centre() { this.yaw = 0; this.pitch = 0; this.dragging = false; this.since = HOLD; }

  /**
   * Keep the view inside what the current mode allows.
   *
   * Applied on every drag *and* on every frame, because the mode can change
   * underneath a view that was legal in the old one -- and easing a view
   * that is suddenly out of bounds back into the band is the mode change
   * looking like a mode change rather than like a snap.
   */
  _hold() {
    const L = (this.chase.lookLimits) || FALLBACK_LOOK;
    if (L.yaw === null) {
      /* Wrap, not clamp.  See the note on FALLBACK_LOOK. */
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    } else {
      this.yaw = clamp(this.yaw, -L.yaw, L.yaw);
    }
    this.pitch = clamp(this.pitch, L.up, L.down);
  }

  /**
   * One frame.
   *
   * The recentring rule is the one judgement call in here.  Under manual
   * driving the view comes back behind the car shortly after you let go,
   * because a driver who is looking sideways at 60 mph is about to hit
   * something and did not mean to be.  Parked, or with the autopilot
   * driving, it stays exactly where it was put -- that is the whole point
   * of being able to look around while something else drives.
   */
  update(dt, car, autodriving) {
    if (!this.dragging) {
      this.since += dt;
      const sightseeing = autodriving || Math.abs(car.speed) < 1;
      if (!sightseeing && this.since > HOLD) {
        const k = 1 - Math.exp(-dt / RETURN_TAU);
        this.yaw -= this.yaw * k;
        this.pitch -= this.pitch * k;
        if (Math.abs(this.yaw) < 1e-3) this.yaw = 0;
        if (Math.abs(this.pitch) < 1e-3) this.pitch = 0;
      }
    }

    this._hold();
    this.chase.orbit.yaw = this.yaw;
    this.chase.orbit.pitch = this.pitch;

    const k = 1 - Math.exp(-dt / ZOOM_TAU);
    this.chase.zoom += (this.want - this.chase.zoom) * k;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
