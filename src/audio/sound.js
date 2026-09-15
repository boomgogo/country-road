import workletSource from './engine-worklet.js?raw';
import { EngineModel } from './engine.js';
import { Birds } from './birds.js';

/* ------------------------------------------------------------------ *
 * Everything you can hear, and none of it is a recording.
 *
 * The engine is `engine-worklet.js`, driven by `engine.js`.  Everything
 * else is noise, shaped: a few seconds of white and brown noise generated
 * once, looped, and pushed through filters whose cutoffs and gains follow
 * the world every frame -- the wind by the weather's `wind` and the car's
 * speed, the tyres by what `Vehicle.surface` says is under them, the rain
 * by the rain falling *here*, which is the same number the particles use.
 * Birds (`birds.js`) and insects are synthesised and scheduled by the
 * clock: a dawn chorus, nothing in the rain, crickets on a warm night and
 * cicadas at the height of a summer day.
 *
 * Three rules the rest of the game already follows, and this follows too:
 *
 * **Nothing starts without a gesture.**  An `AudioContext` made before the
 * player has clicked is born suspended and stays that way.  The load
 * screen exists partly to own that click (see `loader.js`), so the context
 * is made in the first `pointerdown` or `keydown` the page receives --
 * which on a normal boot *is* the click that starts the drive -- and the
 * probes, which never click, never make one.
 *
 * **A pause stops time**, so it stops the sound: the context is suspended
 * with the menu up and with the tab hidden, rather than left holding a
 * drone over a frozen frame.
 *
 * **The drive is the cookie; the preference is not.**  Mute is remembered
 * in `localStorage` because it is a fact about the player, not the drive.
 * ------------------------------------------------------------------ */

const PREF = 'br_sound';
const LOOP_SECONDS = 4;

/** 0 below `a`, 1 above `b`, smooth between. */
function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** A small seeded generator, so the looped buffers are the same every load. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A two-pole bandpass applied in place, for building buffers off-thread-free. */
function bandpassInPlace(data, sr, f, q) {
  const w = 2 * Math.PI * f / sr;
  const s = Math.sin(w), c = Math.cos(w), al = s / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    data[i] = y;
  }
}

export class Sound {
  /**
   * @param {object} o
   * @param {boolean} o.disabled  `?rec`, or `?sound=0` -- never make a context.
   */
  constructor({ disabled = false, forced = null } = {}) {
    this.disabled = disabled;
    let pref = null;
    try { pref = localStorage.getItem(PREF); } catch { /* private window */ }
    /** What the player wants.  `?sound=1` / `?sound=0` override the pref. */
    this.on = forced != null ? forced : pref !== '0';
    this.ctx = null;
    this.engine = new EngineModel();
    this._paused = false;
    this._hidden = document.hidden;
    this._ready = false;
    this._started = false;
    this._airT = 0;
    this._t = 0;
    this._r = rng(0x5eed);

    if (disabled) return;
    const gesture = () => this._gesture();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) {
      addEventListener(ev, gesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      this._hidden = document.hidden;
      this._apply();
    });
  }

  /* ------------------------------ control ------------------------------ */

  /** Flip the preference.  Returns the new state, for the toast. */
  toggle() {
    this.on = !this.on;
    try { localStorage.setItem(PREF, this.on ? '1' : '0'); } catch { /* fine */ }
    if (this.on && !this.ctx) this._open();
    this._apply();
    return this.on;
  }

  /** The pause menu is up, or it has gone. */
  setPaused(p) {
    this._paused = p;
    this._apply();
  }

  _gesture() {
    if (!this.on) return;
    if (!this.ctx) this._open();
    else this._apply();
  }

  _apply() {
    const ctx = this.ctx;
    if (!ctx) return;
    const live = this.on && !this._paused && !this._hidden;
    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(live ? 0.75 : 0, now, 0.03);
    if (live) {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      /* Switched back on mid-drive: the engine was running all along. */
      if (this._started && !this.engine.running) this.engine.run();
    } else if (ctx.state === 'running') {
      /* After the fade, so the suspend does not cut a waveform mid-cycle. */
      setTimeout(() => {
        if (!(this.on && !this._paused && !this._hidden)) ctx.suspend().catch(() => {});
      }, 120);
    }
  }

  /* ------------------------------- graph ------------------------------- */

  async _open() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.disabled = true; return; }
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    const sr = ctx.sampleRate;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    /* Two buses, because the bonnet camera is *inside* the car: the world
     * goes dull through the glass and the engine goes dull through the
     * bulkhead, by different amounts. */
    this.envLP = this._lp(16000);
    this.envGain = ctx.createGain();
    this.envLP.connect(this.envGain).connect(this.master);
    this.engLP = this._lp(12000);
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engLP.connect(this.engGain).connect(this.master);

    /* A little air round the things that are out in the landscape. */
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(1.6);
    const verbGain = ctx.createGain();
    verbGain.gain.value = 0.35;
    this.verb.connect(verbGain).connect(this.envLP);
    this.wild = ctx.createGain();
    this.wild.connect(this.envLP);
    this.wild.connect(this.verb);
    /* Each call is normalised to full scale when it is rendered; this is
     * where they are put back in the landscape. */
    const birdBus = ctx.createGain();
    birdBus.gain.value = 0.1;
    birdBus.connect(this.wild);
    this.birds = new Birds(ctx, birdBus, this._r);

    const white = this._noise('white');
    const brown = this._noise('brown');
    const crackle = this._crackle(360, 0x0c0ffee);

    const L = (buf, filter, to = this.envLP) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(filter).connect(g).connect(to);
      src.start(0, this._r() * LOOP_SECONDS);
      return { src, f: filter, g };
    };

    this.layers = {
      windLow:  L(brown, this._lp(400)),
      windHigh: L(white, this._bp(1100, 0.8)),
      rushHigh: L(white, this._bp(600, 0.6)),
      rushLow:  L(brown, this._lp(170)),
      road:     L(brown, this._bp(300, 0.9)),
      spray:    L(white, this._hp(2800)),
      gravel:   L(crackle, this._bp(2100, 0.7)),
      brush:    L(brown, this._bp(650, 0.5)),
      twigs:    L(this._crackle(90, 0xb005), this._lp(1400)),
      splash:   L(white, this._bp(750, 0.5)),
      rainHiss: L(white, this._bp(4200, 0.5)),
      rainLow:  L(brown, this._lp(500)),
      patter:   L(this._patter(), this._hp(700)),
      crickets: L(this._crickets(), this._lp(9000), this.wild),
      cicadas:  L(this._cicadas(), this._lp(9000), this.wild),
    };

    /* The tyres letting go: a narrow tone with a wander in it. */
    const sq = ctx.createOscillator();
    sq.type = 'triangle';
    sq.frequency.value = 1050;
    const wob = ctx.createOscillator();
    wob.frequency.value = 6.5;
    const wobDepth = ctx.createGain();
    wobDepth.gain.value = 45;
    wob.connect(wobDepth).connect(sq.frequency);
    const sqF = this._bp(1300, 2.5);
    const sqG = ctx.createGain();
    sqG.gain.value = 0;
    sq.connect(sqF).connect(sqG).connect(this.envLP);
    sq.start(); wob.start();
    this.layers.squeal = { src: sq, f: sqF, g: sqG };

    this._ready = true;
    this._apply();

    try {
      const url = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.engineNode = new AudioWorkletNode(ctx, 'flat-six', { outputChannelCount: [1] });
      this.engineNode.connect(this.engLP);
    } catch (e) {
      console.warn('[sound] no engine:', e);
    }
  }

  _lp(f) { const n = this.ctx.createBiquadFilter(); n.type = 'lowpass'; n.frequency.value = f; n.Q.value = 0.7; return n; }
  _hp(f) { const n = this.ctx.createBiquadFilter(); n.type = 'highpass'; n.frequency.value = f; n.Q.value = 0.7; return n; }
  _bp(f, q) { const n = this.ctx.createBiquadFilter(); n.type = 'bandpass'; n.frequency.value = f; n.Q.value = q; return n; }

  /* ------------------------------ buffers ------------------------------ */

  _buffer(fill) {
    const ctx = this.ctx;
    const n = Math.round(ctx.sampleRate * LOOP_SECONDS);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) fill(buf.getChannelData(c), c, ctx.sampleRate);
    return buf;
  }

  /** White or brown, two uncorrelated channels, seamless at the loop. */
  _noise(kind) {
    return this._buffer((d, c) => {
      const r = rng(kind === 'white' ? 11 + c : 71 + c);
      if (kind === 'white') {
        for (let i = 0; i < d.length; i++) d[i] = (r() * 2 - 1) * 0.5;
        return;
      }
      let b = 0;
      for (let i = 0; i < d.length; i++) {
        b = (b + 0.02 * (r() * 2 - 1)) / 1.02;
        d[i] = b * 3.5;
      }
      /* A random walk does not end where it began, and the step at the
       * wrap is a click every four seconds.  Tilt it until it does. */
      const drift = d[d.length - 1] - d[0];
      for (let i = 0; i < d.length; i++) d[i] -= drift * i / (d.length - 1);
    });
  }

  /** Sparse impulses: stones under a tyre, or twigs. */
  _crackle(perSecond, seed) {
    return this._buffer((d, c, sr) => {
      const r = rng(seed + c);
      const count = Math.round(perSecond * LOOP_SECONDS);
      for (let k = 0; k < count; k++) {
        const at = Math.floor(r() * (d.length - 40));
        const a = (r() < 0.5 ? -1 : 1) * Math.pow(r(), 2.2);
        const len = 4 + Math.floor(r() * 24);
        for (let i = 0; i < len; i++) d[at + i] += a * Math.exp(-i / (len * 0.3)) * (r() * 2 - 1);
      }
    });
  }

  /** Raindrops on a steel roof and a glass screen. */
  _patter() {
    return this._buffer((d, c, sr) => {
      const r = rng(303 + c);
      const count = 140 * LOOP_SECONDS;
      for (let k = 0; k < count; k++) {
        const at = Math.floor(r() * (d.length - 800));
        const a = 0.15 + 0.85 * Math.pow(r(), 3);
        const f = 900 + r() * 2600;
        const len = Math.floor(sr * (0.004 + r() * 0.012));
        for (let i = 0; i < len; i++) {
          const e = Math.exp(-i / (len * 0.25));
          d[at + i] += a * e * (0.6 * Math.sin(2 * Math.PI * f * i / sr) + 0.4 * (r() * 2 - 1));
        }
      }
    });
  }

  /** A few field crickets, each on a period that divides the loop exactly. */
  _crickets() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.round(sr * LOOP_SECONDS);
    const buf = ctx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const r = rng(4242);
    for (let k = 0; k < 6; k++) {
      const f = 4200 + r() * 1200;
      const per = LOOP_SECONDS / (4 + Math.floor(r() * 4));  // 0.5..1 s
      const off = r() * per;
      const pulses = 3 + Math.floor(r() * 2);
      const amp = 0.08 + 0.18 * r();
      const pan = r();
      const gl = amp * Math.cos(pan * Math.PI / 2), gr = amp * Math.sin(pan * Math.PI / 2);
      for (let t0 = off; t0 < LOOP_SECONDS; t0 += per) {
        for (let p = 0; p < pulses; p++) {
          const s0 = Math.floor((t0 + p * 0.028) * sr);
          const len = Math.floor(0.016 * sr);
          for (let i = 0; i < len; i++) {
            const idx = (s0 + i) % n;
            const e = Math.sin(Math.PI * i / len);
            const v = e * e * Math.sin(2 * Math.PI * f * i / sr);
            L[idx] += v * gl; R[idx] += v * gr;
          }
        }
      }
    }
    return buf;
  }

  /** A stand of cicadas: a buzz that swells and falls over the loop. */
  _cicadas() {
    return this._buffer((d, c, sr) => {
      const r = rng(777 + c);
      const pulse = 220 + c * 9;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const am = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * pulse * t), 4);
        const swell = 0.55 + 0.45 * Math.sin(2 * Math.PI * t / LOOP_SECONDS + c);
        d[i] = (r() * 2 - 1) * am * swell;
      }
      bandpassInPlace(d, sr, 5200 - c * 300, 4);
      bandpassInPlace(d, sr, 5200 - c * 300, 4);
      for (let i = 0; i < d.length; i++) d[i] *= 2.2;
    });
  }

  /** A generated room the size of a valley. */
  _impulse(seconds) {
    const ctx = this.ctx;
    const n = Math.round(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      const r = rng(9001 + c);
      for (let i = 0; i < n; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / n, 3.5) * 0.4;
    }
    return buf;
  }

  /* ------------------------------ one-shots ---------------------------- */

  /** The car coming back down onto its springs. */
  _thump(strength) {
    const ctx = this.ctx, t = ctx.currentTime + 0.005;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    g.gain.setValueAtTime(0.6 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc.connect(g).connect(this.envLP);
    osc.start(t);
    osc.stop(t + 0.32);
    osc.onended = () => g.disconnect();
  }

  /* ------------------------------- frame ------------------------------- */

  /**
   * @param {number} dt  real seconds
   * @param {object} s   the world, as `main.js` sees it this frame
   */
  update(dt, s) {
    if (!this._ready || !this.on || this._paused || this._hidden) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const set = (param, v, tau = 0.08) => param.setTargetAtTime(v, now, tau);
    this._t += dt;
    const car = s.car;
    const Ly = this.layers;

    /* ---- the engine ---- */
    if (this.engineNode) {
      if (!this._started) {
        this._started = true;
        if (Math.abs(car.speed) < 0.5 && !s.still) this.engine.ignite();
        else this.engine.run();
      }
      this.engine.update(dt, {
        speed: car.speed, throttle: car.throttle || 0, brake: s.brake,
        airborne: car.airborne, still: s.still,
      });
      const p = this.engineNode.parameters;
      set(p.get('rpm'), this.engine.rpm, 0.012);
      set(p.get('load'), this.engine.load, 0.02);
      set(p.get('starter'), this.engine.starter, 0.02);
    }

    /* ---- where the ear is ---- */
    const inside = s.view === 'bonnet';
    const far = s.view === 'chaseFar';
    const zoom = Math.max(0.5, s.zoom || 1);
    const warp = clamp01(s.warp || 0);
    const hush = clamp01(s.hush || 0);
    set(this.engGain.gain, (inside ? 0.85 : far ? 0.7 : 1) / Math.sqrt(zoom) * (1 - warp), 0.1);
    set(this.engLP.frequency, (inside ? 1900 : far ? 6500 : 11000) * (1 - 0.85 * warp) + 200, 0.1);
    set(this.envLP.frequency, (inside ? 3200 : 16000) * (1 - 0.55 * hush) * (1 - 0.9 * warp) + 300, 0.15);
    set(this.envGain.gain, (inside ? 0.65 : 1) * (s.lapsing ? 0.35 : 1) * (1 - warp), 0.15);

    /* ---- wind ---- */
    const h = s.here;
    const gust = 0.5 + 0.3 * Math.sin(this._t * 0.37) + 0.2 * Math.sin(this._t * 1.13 + 1.7);
    const wind = h.wind * (1 - 0.3 * hush);
    set(Ly.windLow.g.gain, 0.04 + 0.3 * wind * gust, 0.4);
    set(Ly.windLow.f.frequency, 220 + 520 * wind * gust, 0.4);
    set(Ly.windHigh.g.gain, 0.07 * wind * gust * gust, 0.4);

    const v = Math.hypot(car.speed, car.slide || 0);
    const sv = Math.min(1.2, v / 22.35);
    set(Ly.rushHigh.g.gain, 0.12 * sv * sv);
    set(Ly.rushHigh.f.frequency, 450 + 45 * v);
    set(Ly.rushLow.g.gain, 0.3 * sv * sv);

    /* ---- tyres ---- */
    const air = car.airborne;
    const surf = car.surface;
    const onRoad = !air && surf === 'road';
    const loose = !air && (surf === 'gravel' || surf === 'rock');
    const soft = !air && (surf === 'grass' || surf === 'verge' || surf === 'shore');
    const water = !air && surf === 'water';
    set(Ly.road.g.gain, (onRoad ? 0.3 : surf === 'rock' ? 0.12 : 0) * Math.min(1, sv * 1.1), 0.06);
    set(Ly.road.f.frequency, 170 + 15 * v, 0.06);
    set(Ly.spray.g.gain, air ? 0 : 0.2 * (s.wetness || 0) * Math.pow(Math.min(1, sv), 1.2) * (onRoad ? 1 : 0.5));
    set(Ly.gravel.g.gain, loose ? 0.8 * clamp01(v / 12) * (surf === 'rock' ? 0.5 : 1) : 0, 0.06);
    Ly.gravel.src.playbackRate.setTargetAtTime(0.6 + Math.min(1.2, v / 18), now, 0.1);
    set(Ly.brush.g.gain, soft ? 0.3 * clamp01(v / 10) : 0, 0.06);
    set(Ly.twigs.g.gain, soft ? 0.5 * clamp01(v / 10) : 0, 0.06);
    Ly.twigs.src.playbackRate.setTargetAtTime(0.5 + Math.min(1.5, v / 12), now, 0.1);
    set(Ly.splash.g.gain, water ? 0.45 * clamp01(v / 6) : 0, 0.06);

    const slide = Math.abs(car.slide || 0);
    const locked = s.handbrake && Math.abs(car.speed) > 3;
    const squeal = onRoad ? Math.max(clamp01((slide - 1.8) / 3.5), locked ? 0.5 : 0) : 0;
    set(Ly.squeal.g.gain, 0.05 * squeal, 0.05);
    Ly.squeal.src.frequency.setTargetAtTime(950 + 120 * Math.min(1, slide / 6), now, 0.1);

    if (air) this._airT += dt;
    else {
      if (this._airT > 0.2) this._thump(Math.min(1, this._airT / 0.9));
      this._airT = 0;
    }

    /* ---- rain ---- */
    const rain = h.rain;
    set(Ly.rainHiss.g.gain, 0.2 * rain, 0.3);
    set(Ly.rainLow.g.gain, 0.2 * rain * rain, 0.3);
    set(Ly.patter.g.gain, (inside ? 0.6 : 0.3) * Math.sqrt(rain), 0.3);

    /* ---- the living things ---- */
    const wet = rain + h.snow;
    const fair = (1 - smooth(0.04, 0.25, wet)) * (1 - smooth(0.65, 1, h.wind));
    const sw = s.season;   // spring, summer, autumn, winter
    const warm = sw[0] * 0.6 + sw[1] + sw[2] * 0.6 + sw[3] * 0.05;
    const quiet = s.lapsing ? 0 : 1;
    set(Ly.crickets.g.gain, 0.9 * s.night * warm * fair * quiet, 1.2);
    const noon = smooth(0.35, 0.8, s.sunAlt);
    set(Ly.cicadas.g.gain, 0.05 * (sw[1] + 0.25 * sw[0]) * noon * fair * quiet, 1.5);

    const chorus = 1 + 2.5 * Math.exp(-Math.pow((s.sunAlt - 0.06) / 0.1, 2));
    const birds = 0.28 * s.daylight * chorus * fair * (1 - 0.55 * sw[3]) * quiet;
    this.birds.update(dt, birds, Math.abs(car.speed) * dt);
  }
}
