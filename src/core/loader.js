/* ------------------------------------------------------------------ *
 * The load screen, and the reason it exists.
 *
 * The bug it fixes is not a loading bug.  It is this: *the keyboard is
 * deaf until something gives the document focus.*  `Input` binds `keydown`
 * on `window`, keyboard events go to whatever has focus, and a page opened
 * by typing a URL leaves focus in the address bar -- so W does nothing,
 * the HUD says `parked -- W to drive`, and the only cure anyone finds is
 * to click on the canvas.  Nothing in the game is broken: the physics is
 * stepping, the world is building, the car is placed and parked and ready.
 * The key simply never arrives.
 *
 * It is also a bug that gets reported as something else every single time,
 * because "I press W and nothing happens" reads as controls that are not
 * wired up.  That is the third time in this project's history that a
 * working control has been reported as broken because nothing on screen
 * said what state it was in.
 *
 * **A load screen fixes it by construction.**  If the game cannot be
 * driven until something is clicked, and clicking is what gives the
 * document focus, then the keyboard is live for every player from the
 * first frame they can drive in.  The loading is the honest reason for the
 * click, and the click is the fix.
 *
 * Two things fall out for free: the first frame stops being a lie (the
 * recorder already steps the world 90 times before frame zero, because
 * "a cold start films forty frames of empty hillside" -- a human got that
 * cold start), and a user gesture exists before anything needs one, which
 * is what an `AudioContext` will want the day audio lands.
 *
 * Under `?rec` none of this happens at all.  Five harnesses open a page
 * and wait on a promise and none of them can click; if the bypass is
 * wrong they do not fail, they *time out*.  See `skipped` below.
 *
 * **And it is a pause menu now.**  `prompt_5.md` item 2 asks for `Esc` to
 * quit to this screen with the same two choices, so the overlay is no
 * longer removed from the document when the drive starts -- it keeps its
 * `gone` class, which the stylesheet already makes invisible and
 * click-through, and `pause()` takes the class off again.  Rebuilding it
 * in JavaScript was never an option for the reason `index.html` gives at
 * the markup: nothing in this file runs until the physics wasm has
 * downloaded.
 * ------------------------------------------------------------------ */

/** The steps, in the order they are reported.  Weights sum to 1. */
const STEPS = [
  ['physics', 0.10],
  ['landscape', 0.34],
  ['scenery', 0.18],
  ['stars', 0.06],
  ['car', 0.14],
  ['settling', 0.18],
];

const LABEL = {
  physics: 'starting the engine',
  landscape: 'raising the land',
  scenery: 'planting the verges',
  stars: 'hanging the stars',
  car: 'delivering the car',
  settling: 'letting it settle',
};

export class Loader {
  /**
   * @param {boolean} skipped  true under `?rec` and `?auto`: the overlay is
   *   removed from the document entirely and `wait()` resolves at once.
   * @param {boolean} autoStart  true when this page *is* the answer to a
   *   press: "new drive" reloads, and a player who has just asked for a
   *   drive should not be asked a second time.  The bar still runs -- the
   *   world genuinely takes four seconds -- but the prompt at the end of
   *   it never appears, and the drive begins the moment it could.
   *
   *   Safe with respect to focus, which is the one thing this file exists
   *   to protect: the press that started the reload was a real user
   *   gesture inside this document, and the reload keeps the window
   *   focused, so `start()`'s `canvas.focus()` lands on a page that can
   *   already hear the keyboard.
   */
  constructor({ skipped = false, autoStart = false } = {}) {
    this.el = document.getElementById('load');
    this.skipped = skipped || !this.el;
    this.done = 0;
    this.started = false;
    this.autoStart = autoStart;
    /** True while the drive is suspended behind the screen.  `main.js`
     *  reads it to know whether `Esc` opens or closes. */
    this.paused = false;
    /** Resolved when the player has asked to drive.  `false` = new drive. */
    this._go = null;
    this.ready = new Promise((resolve) => { this._go = resolve; });

    if (this.skipped) {
      if (this.el) this.el.remove();
      this._go('skip');
      return;
    }

    this.stepEl = document.getElementById('load-step');
    this.fillEl = document.getElementById('load-fill');
    this.choices = document.getElementById('load-choices');
    this.whereEl = document.getElementById('load-where');
    this.fork = document.getElementById('load-fork');

    /* Any of the three, because the player whose instinct is to press W
     * should be driving rather than being told to use the mouse.
     *
     * **The key listener goes on `window`, not on the overlay**, and the
     * difference is the whole feature.  A keydown is delivered to whatever
     * has focus -- which on a page nobody has clicked is `document.body`
     * -- and it then bubbles *up* to document and window.  It never
     * travels down into a child div.  With the listener on the overlay the
     * screen could only be dismissed by the mouse, on exactly the pages
     * where the mouse is the thing we are trying not to require.
     *
     * Measured before the fix, in `tools/probe/boot.mjs`: a real
     * `Input.dispatchKeyEvent` of Enter left `overlay removed after a key`
     * reading **false** and the frame loop never started. */
    this._onGo = (e) => {
      if (!this.el || !this.el.classList.contains('ready')) return;
      /* **The buttons own their own presses.**
       *
       * This guard is the whole of the "new drive does nothing" bug.  The
       * two choices are children of the overlay, so a press on one of them
       * bubbles *up* to this handler -- and `pointerdown` arrives before
       * `click` does.  Without the test below, pressing "new drive" ran
       * `start('resume')` here, latched `started`, and the button's own
       * handler then returned on its first line.  The button had never
       * worked once; "continue" only looked right because the wrong path
       * and the right path did the same thing.
       *
       * `e.target`, not `currentTarget`, and *before* `preventDefault` --
       * a `preventDefault` on a `pointerdown` inside a button is one of
       * the ways to suppress the `click` that follows it, which would have
       * replaced the bug with a quieter one. */
      if (e.target && this.choices && this.choices.contains(e.target)) return;
      /* And so does the link to the source, for the same reason and on
       * the keyboard too: Enter on a focused link must open the link and
       * nothing else, not open it *and* start the drive behind it. */
      if (e.target && this.fork && this.fork.contains(e.target)) return;
      /* With a save offered, the buttons are the only way through: a
       * stray key must not silently pick one of the two for the player.
       * `N` is the keyboard's half of "new drive" -- without it a player
       * who never touches the mouse can only ever continue, which is the
       * same class of bug as the one this whole file exists to fix. */
      if (this.el.classList.contains('resumable') && e.type === 'keydown') {
        if (e.code === 'KeyN') { e.preventDefault(); this.start('new'); return; }
        /* `Esc` closes a pause the way it opened it.  Handled here rather
         * than in `main.js`'s command table because `Input` and this both
         * listen on `window` and only one of them should act. */
        if (e.code === 'Escape' && this.paused) {
          e.preventDefault(); this.start('resume'); return;
        }
        if (e.code !== 'Enter' && e.code !== 'Space') return;
      }
      e.preventDefault();
      this.start('resume');
    };
    addEventListener('keydown', this._onGo, { passive: false });
    for (const type of ['pointerdown', 'touchstart']) {
      this.el.addEventListener(type, this._onGo, { passive: false });
    }
  }

  /**
   * Offer a saved drive.  `where` is one line of prose for the button.
   *
   * Both buttons answer `pointerdown` rather than `click`, because the
   * rest of the overlay answers `pointerdown`: a button that needs a full
   * press *and release* where the background needs only a press is a
   * difference nobody can see and everybody feels.
   */
  offerResume(where) {
    if (this.skipped) return;
    this.whereEl.textContent = where;
    this.el.classList.add('resumable');
    this._bindChoices();
  }

  /** Wire the two buttons, once.  `pause()` reuses them, and binding a
   *  second listener per pause would fire `start` twice per press. */
  _bindChoices() {
    if (this._choicesBound) return;
    this._choicesBound = true;
    this._choose('load-continue', 'resume');
    this._choose('load-new', 'new');
  }

  /** Wire one choice button, on both of the ways it can be pressed. */
  _choose(id, how) {
    const el = document.getElementById(id);
    if (!el) return;
    const go = (e) => { e.stopPropagation(); e.preventDefault(); this.start(how); };
    el.addEventListener('pointerdown', go, { passive: false });
    /* Keyboard activation of a focused button arrives as `click` with no
     * pointer event in front of it, so this is not a duplicate. */
    el.addEventListener('click', go, { passive: false });
  }

  /** Mark one of `STEPS` finished. */
  step(name) {
    if (this.skipped) return;
    let acc = 0;
    let hit = false;
    for (const [key, w] of STEPS) {
      acc += w;
      if (key === name) { hit = true; break; }
    }
    if (!hit) return;
    this.done = Math.max(this.done, acc);
    this.fillEl.style.width = (this.done * 100).toFixed(0) + '%';
    const next = STEPS[STEPS.findIndex(([k]) => k === name) + 1];
    this.stepEl.textContent = next ? LABEL[next[0]] : LABEL[name];
  }

  /** The world is warm.  Show the prompt and wait to be let go. */
  offer() {
    if (this.skipped) return;
    this.fillEl.style.width = '100%';
    this.el.classList.add('ready');
    /* Asked for already.  `ready` goes on first anyway, because `start`
     * is a no-op from a screen that is not ready and because the class is
     * what hides the bar behind the fade. */
    if (this.autoStart) this.start('resume');
  }

  /**
   * Hand over.
   *
   * The focus calls are the point of the whole file.  `window.focus()`
   * pulls focus to the page from wherever it was -- the address bar, most
   * often -- and `canvas.focus()` parks it somewhere inside the document
   * that will keep it; the canvas carries a `tabindex` in `index.html` for
   * exactly this, since without one it is not focusable and the call does
   * nothing at all.
   */
  start(how = 'resume') {
    if (this.skipped || this.started) return;
    this.started = true;
    this.paused = false;
    removeEventListener('keydown', this._onGo);
    try { window.focus(); } catch { /* not focusable from here; the click did it */ }
    document.getElementById('view')?.focus?.();
    /* `gone` is opacity 0 and `pointer-events: none`, so the overlay is as
     * absent as removing it would make it -- and it is still there to be
     * brought back by `pause()`.  It used to be `this.el.remove()` after
     * 400 ms, which is why there was nothing to quit *to*. */
    this.el.classList.add('gone');
    this._go(how);
  }

  /**
   * Quit to the screen, mid-drive.  `Esc`.
   *
   * Returns a promise that resolves `'resume'` or `'new'` -- the same two
   * values `boot()` already handles, so `main.js` learns no new vocabulary
   * for this.
   *
   * `where` is the *live* state, not the saved one: the save is throttled
   * to one write every two seconds and a pause menu that reported a
   * position two seconds stale would be reporting the wrong drive.
   */
  pause(where) {
    if (this.skipped) return Promise.resolve('resume');
    this.paused = true;
    this.started = false;
    if (this.whereEl) this.whereEl.textContent = where;
    /* On a page that opened with no save the buttons were never wired,
     * because `offerResume` is what wires them and it was never called. */
    this._bindChoices();
    this.el.classList.remove('gone');
    this.el.classList.add('ready', 'resumable');
    addEventListener('keydown', this._onGo, { passive: false });
    this.ready = new Promise((resolve) => { this._go = resolve; });
    return this.ready;
  }
}

/* ------------------------------------------------------------------ *
 * And the other half: focus is not a one-time problem.
 *
 * Alt-tab away, click back on the window chrome rather than on the page,
 * and the keyboard is dead again with no explanation.  `Input` already has
 * a `blur` handler that clears the held keys, so it already knows this
 * happens -- it just never said so.
 * ------------------------------------------------------------------ */
export function watchFocus(onChange) {
  const set = () => onChange(document.hasFocus());
  addEventListener('focus', set);
  addEventListener('blur', set);
  set();
}
