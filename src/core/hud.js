/* ------------------------------------------------------------------ *
 * The readout.
 *
 * Two numbers and a hint line.  The off switch is not a nicety: the films
 * and the promo stills want the picture with no HUD at all.  `H` hides
 * it, and the recorder sets `clean` before frame zero.
 * ------------------------------------------------------------------ */

const M_PER_MILE = 1609.344;

/**
 * Four autodrive states now, not two.
 *
 * Each one says what the *driver* still has, because that is the question
 * a player actually has when they see the badge -- "what am I holding?"
 * rather than "what is the machine holding?"
 */
const MODE_TEXT = {
  parked: 'parked  —  W to drive     F for autodrive',
  driving: 'driving',
  speed: 'auto speed  —  you steer',
  steer: 'auto steering  —  you drive',
  full: 'full autodrive  —  W A S D to take over',
};

/**
 * The same four states, named after controls a phone has.
 *
 * Two of the five lines above name keys, and on a phone they name keys
 * that do not exist -- `parked — W to drive` in front of a player holding
 * a device with no W is the same failure as a control that is not wired
 * up, told in words.  `Hud.touch` swaps the table; `core/touch.js` sets it
 * at the moment the controls appear.
 */
const MODE_TEXT_TOUCH = {
  parked: 'parked  —  hold ▲ to drive',
  driving: 'driving',
  speed: 'auto speed  —  you steer',
  steer: 'auto steering  —  you drive',
  full: 'full autodrive  —  touch to take over',
};

export class Hud {
  constructor(root = document.body) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-corner hud-left"><b class="hud-n" id="hud-dist">0.0</b><i>miles</i></div>
      <div class="hud-corner hud-right"><b class="hud-n" id="hud-spd">0</b><i>mph</i></div>
      <div class="hud-stack">
        <p class="hud-hint" id="hud-hint"></p>
        <p class="hud-mode" id="hud-mode"></p>
        <p class="hud-sky" id="hud-sky"></p>
        <p class="hud-rest" id="hud-rest"><b id="hud-rest-label"></b><i id="hud-rest-bar"></i></p>
      </div>
      <p class="hud-cam" id="hud-cam"></p>
      <p class="hud-toast" id="hud-toast"></p>
      <p class="hud-focus" id="hud-focus">click to drive</p>`;
    root.appendChild(this.el);
    this.dist = this.el.querySelector('#hud-dist');
    this.spd = this.el.querySelector('#hud-spd');
    this.hint = this.el.querySelector('#hud-hint');
    this.modeEl = this.el.querySelector('#hud-mode');
    this.skyEl = this.el.querySelector('#hud-sky');
    this.camEl = this.el.querySelector('#hud-cam');
    this.toastEl = this.el.querySelector('#hud-toast');
    this.restEl = this.el.querySelector('#hud-rest');
    this.restLabel = this.el.querySelector('#hud-rest-label');
    this.restBar = this.el.querySelector('#hud-rest-bar');
    this._lastRest = null;
    this._mode = null;
    this._modeText = MODE_TEXT;
    this.visible = true;
    this._toastUntil = 0;
    this._lastSpd = -1;
    this._lastDist = '';
    this._lastSky = '';
    this._lastCam = '';
  }

  setHint(text) { this.hint.textContent = text; }

  /** Name the controls after the device holding them.  See `MODE_TEXT_TOUCH`. */
  set touch(on) {
    this._modeText = on ? MODE_TEXT_TOUCH : MODE_TEXT;
    /* The badge only redraws when the state *changes*, and the state has
     * not: forget what is on screen so the next frame writes the new
     * wording rather than keeping the old one until the car moves. */
    this._mode = null;
  }

  /**
   * Who is driving, permanently on screen.
   *
   * Three states now rather than two: the game starts with the car parked
   * and nobody driving, and a badge that read `driving` beside a car that
   * is not moving is the sort of small lie that makes a player think the
   * controls are broken.
   */
  setMode(state) {
    if (state === this._mode) return;
    this._mode = state;
    this.modeEl.textContent = this._modeText[state] ?? state;
    this.modeEl.className = 'hud-mode ' + (state === 'autodrive' ? 'auto' : 'manual');
  }

  /**
   * Time, season and weather, in that order.
   *
   * One line, and it earns its place: with a 24-minute day and a 12-day
   * year, a player who cannot see the clock has no way to tell whether
   * the sky is doing something deliberate or something broken.
   */
  setSky(text) {
    if (text === this._lastSky) return;
    this._lastSky = text;
    this.skyEl.textContent = text;
  }

  /**
   * Which camera, and what the wheel has done to it.
   *
   * A *state*, for the fourth time in this project's history that a
   * control nobody could see the state of was reported as broken.
   * `prompt_5.md` item 1 says chase and chase far are the wrong way round;
   * measured, the cycle is right -- but the wheel could put them the wrong
   * way round and nothing said so.  `core/pointer.js` has since made that
   * impossible; this makes it visible, which is the half that would have
   * stopped the report.
   *
   * The zoom suffix appears only when the wheel has been touched, so the
   * line is two words in the ordinary case.
   */
  setCamera(name, zoom = 1) {
    const text = Math.abs(zoom - 1) < 0.02
      ? name : `${name}   ${zoom.toFixed(1)}×`;
    if (text === this._lastCam) return;
    this._lastCam = text;
    this.camEl.textContent = text;
  }

  /**
   * What `Z` will do right now, and how far through it we are.
   *
   * A *state*, not a toast, for the reason three separate things in this
   * project have been reported broken when they were not: a control the
   * player cannot see the state of is a control the player believes is
   * dead.  The line names one of the three labels from the prompt --
   * "rest until morning", "...the rain is over", "...the snow is over"
   * -- and is empty the rest of the time, which is most of the time.
   *
   * The labels lost "mostly" in `prompt_5.md`, and so did the behaviour:
   * the rest now stops on a measurement of the weather at the car rather
   * than on the hour the forecast named, so "over" is a promise the code
   * keeps.  See `rest()` in `main.js`.
   */
  setRest(label, progress = 0) {
    if (label !== this._lastRest) {
      this._lastRest = label;
      this.restLabel.textContent = label;
      this.restEl.style.opacity = label ? '1' : '0';
    }
    this.restBar.style.width = label && progress > 0
      ? (progress * 100).toFixed(0) + '%' : '0';
  }

  /** Timed message.  Uses the *simulation* clock so the recorder's stepped
   *  time holds it for the right number of frames rather than for whatever
   *  the wall clock does while a frame takes 90 ms to capture. */
  toast(text, now, secs = 1.8) {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    this._toastUntil = now + secs;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
    return this.visible;
  }

  set clean(on) {
    this.el.style.display = on || !this.visible ? 'none' : '';
    this._clean = on;
  }

  update(metres, speedMs, now) {
    if (this._clean || !this.visible) return;
    const mi = (metres / M_PER_MILE).toFixed(1);
    if (mi !== this._lastDist) { this.dist.textContent = mi; this._lastDist = mi; }
    const mph = Math.round(Math.abs(speedMs) * 2.23694);
    if (mph !== this._lastSpd) { this.spd.textContent = String(mph); this._lastSpd = mph; }
    if (this._toastUntil && now > this._toastUntil) {
      this.toastEl.style.opacity = '0';
      this._toastUntil = 0;
    }
  }
}
