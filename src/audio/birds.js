/* ------------------------------------------------------------------ *
 * Birds, rendered rather than played.
 *
 * The first version drove an oscillator from the frequency automation:
 * a pure sine gliding for 30-120 ms between pitches picked at random.
 * That is a theremin, and it was reported as "a weird alien sound".  It
 * got three things wrong, and they are the three things this file is for.
 *
 *   1. **A bird's note is short and its sweeps are fast and curved.**  A
 *      syllable is tens of milliseconds; the pitch moves along a curve
 *      inside it, and the loudness follows the pitch -- a syrinx is
 *      loudest near the top of its sweep.  So each call is rendered here
 *      sample by sample into a buffer: a phase integrated along a smooth
 *      contour, with a couple of harmonics, a fast shaky wobble and a
 *      breath of noise riding on the tone.
 *   2. **A bird repeats itself.**  Random pitch every time is what makes
 *      a synth sound like a synth.  A `Singer` is given a song once, from
 *      a small scale of its own, and sings it again and again with small
 *      variations -- which is what makes a morning sound like a place
 *      with birds in it rather than a generator.
 *   3. **A bird is somewhere.**  Each singer has a position and a
 *      distance, fixed for as long as it is in earshot.  Distance takes
 *      the top off (air absorbs high frequencies) as well as the level,
 *      and the whole population turns over slowly as the car drives
 *      through one territory and into the next.
 *
 * Four kinds, loosely after what sings along a road on the NSW coast:
 * a fluting carol, whistles (a whistler's phrase or a whipbird's crack),
 * chirps and a trill.  The trill is a run of discrete syllables, not a
 * tone shaken by a square wave, which was the other alien.
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

/** Frequency along a list of `[u, hz]` keys, eased between them. */
function contour(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [u1, f1] = keys[i];
    if (u <= u1) {
      const [u0, f0] = keys[i - 1];
      const t = (u - u0) / (u1 - u0);
      const e = 0.5 - 0.5 * Math.cos(Math.PI * t);
      /* In log frequency: a sweep through an octave sounds even. */
      return f0 * Math.pow(f1 / f0, e);
    }
  }
  return keys[keys.length - 1][1];
}

/**
 * One syllable into `out`, starting at sample `at`.
 *
 * @param {object} s  dur (s), keys ([u, hz] contour), amp, harm (relative
 *                    harmonic levels, fundamental first), wob (depth as a
 *                    fraction of pitch), wobRate (Hz), breath (noise share),
 *                    attack/release (fractions of dur)
 */
function syllable(out, at, sr, s, r) {
  const n = Math.floor(s.dur * sr);
  const harm = s.harm || [1, 0.18, 0.05];
  const attack = s.attack ?? 0.12, release = s.release ?? 0.3;
  let lo = Infinity, hi = 0;
  for (const [, f] of s.keys) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
  const span = hi - lo || 1;
  const wob = s.wob ?? 0.006, wobRate = s.wobRate ?? (35 + r() * 25);
  const breath = s.breath ?? 0.05;
  const flutter = s.flutter ?? 0;
  /* The breath is noise *narrowed* before it rides the tone.  White noise
   * times a sine is still white noise -- the first version of this put a
   * full-band hiss under every syllable, which is most of what sounded
   * synthetic about it.  Smoothed (two poles, ~350 Hz) first, it lands
   * as a rough edge on the note itself. */
  const nA = 1 - Math.exp(-TAU * 350 / sr);
  let noise = 0, noise2 = 0;
  let ph = r() * TAU, wobPh = r() * TAU;
  for (let i = 0; i < n && at + i < out.length; i++) {
    const u = i / n;
    let f = contour(s.keys, u);
    wobPh += TAU * wobRate / sr;
    f *= 1 + wob * Math.sin(wobPh);
    if (f * harm.length > sr * 0.45) f = sr * 0.45 / harm.length;
    ph += TAU * f / sr;
    let v = 0;
    for (let k = 0; k < harm.length; k++) v += harm[k] * Math.sin(ph * (k + 1));
    noise += nA * ((r() * 2 - 1) - noise);
    noise2 += nA * (noise - noise2);
    v += breath * noise2 * Math.sin(ph) * 18;
    const rise = Math.min(1, u / attack);
    const fall = Math.min(1, (1 - u) / release);
    const env = Math.sin(0.5 * Math.PI * rise) * Math.sin(0.5 * Math.PI * fall);
    const tilt = 0.65 + 0.35 * (f - lo) / span;
    /* A voice is never quite steady: the level shivers with the wobble. */
    const shiver = 1 - flutter * (0.5 + 0.5 * Math.sin(wobPh * 0.5));
    out[at + i] += v * env * tilt * shiver * s.amp;
  }
  return at + n;
}

/* ----------------------------- the songs ----------------------------- */
/* Each returns a list of syllables with a start time `t`, in seconds.
 * `song` is the singer's fixed material; `r` varies one rendition. */

function carolSong(r) {
  /* A mellow bird: its own five-note scale, and a motif drawn from it. */
  const base = 850 + r() * 550;
  const scale = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 2].map((x) => base * x);
  const motif = [];
  const count = 4 + Math.floor(r() * 3);
  for (let i = 0; i < count; i++) {
    const kind = r();
    motif.push({
      kind: kind < 0.45 ? 'flute' : kind < 0.75 ? 'slur' : 'gurgle',
      a: Math.floor(r() * scale.length),
      b: Math.floor(r() * scale.length),
      dur: 0.07 + r() * 0.1,
      gap: 0.025 + r() * 0.06,
    });
  }
  return { scale, motif, twitter: r() < 0.6, wobRate: 28 + r() * 20 };
}

function carolRender(song, r) {
  const out = [];
  let t = 0;
  const harm = [1, 0.32, 0.1, 0.04];
  for (const m of song.motif) {
    /* A rendition drops the odd note, and never plays one quite the same. */
    if (r() < 0.12) continue;
    const fa = song.scale[m.a] * (1 + (r() - 0.5) * 0.03);
    const fb = song.scale[m.b] * (1 + (r() - 0.5) * 0.03);
    const dur = m.dur * (0.9 + r() * 0.2);
    if (m.kind === 'flute') {
      /* Scooped up into from below, the way a sung note is, then held
       * with a shiver and let fall. */
      out.push({ t, dur, amp: 0.9, harm, wob: 0.015, wobRate: song.wobRate, flutter: 0.3,
        breath: 0.04, keys: [[0, fa * 0.78], [0.12, fa * 1.04], [0.3, fa], [0.8, fa * 0.98], [1, fa * 0.86]] });
    } else if (m.kind === 'slur') {
      out.push({ t, dur: dur * 0.8, amp: 0.85, harm, wob: 0.01, wobRate: song.wobRate, flutter: 0.2,
        breath: 0.04, keys: [[0, fa * 0.9], [0.1, fa], [0.85, fb], [1, fb * 0.92]] });
    } else {
      /* Quick alternation between two neighbouring notes, run together:
       * the warble. */
      const lo = Math.min(fa, fb), hi = lo * 1.2;
      const steps = 3 + Math.floor(r() * 3);
      const sd = 0.03 + r() * 0.012;
      const keys = [];
      for (let k = 0; k <= steps; k++) keys.push([k / steps, k % 2 ? hi : lo]);
      out.push({ t, dur: sd * steps, amp: 0.75, harm, wob: 0.004, attack: 0.05, release: 0.15, keys });
      t += sd * steps - dur;
    }
    t += dur + m.gap * (0.8 + r() * 0.4);
  }
  if (song.twitter && r() < 0.8) {
    t += 0.04;
    const hi = song.scale[6] * 1.9;
    for (let k = 0, n = 3 + Math.floor(r() * 4); k < n; k++) {
      const f = hi * (1 + (r() - 0.5) * 0.12);
      out.push({ t, dur: 0.028 + r() * 0.012, amp: 0.4, harm: [1, 0.12], wob: 0,
        attack: 0.2, release: 0.5, keys: [[0, f * 0.8], [0.35, f], [1, f * 0.7]] });
      t += 0.045 + r() * 0.015;
    }
  }
  return out;
}

function whistleSong(r) {
  return r() < 0.55
    ? { kind: 'whistler', p: 1800 + r() * 700, count: 2 + Math.floor(r() * 3), note: 0.1 + r() * 0.05 }
    : { kind: 'whipbird', p: 1500 + r() * 600, hold: 0.7 + r() * 0.5, reply: r() < 0.6 };
}

function whistleRender(song, r) {
  const out = [];
  const harm = [1, 0.06, 0.02];
  const j = () => 1 + (r() - 0.5) * 0.025;
  if (song.kind === 'whistler') {
    /* A few even notes, then the loud ringing up-and-over at the end. */
    let t = 0;
    const p = song.p * j();
    for (let k = 0; k < song.count; k++) {
      out.push({ t, dur: song.note, amp: 0.6, harm, wob: 0.003, breath: 0.03,
        keys: [[0, p * 1.03], [0.3, p], [1, p * 0.94]] });
      t += song.note + 0.07 + r() * 0.02;
    }
    out.push({ t, dur: 0.24, amp: 1, harm, wob: 0.004, breath: 0.03, attack: 0.08, release: 0.25,
      keys: [[0, p * 0.92], [0.45, p * 1.45], [0.7, p * 1.55], [1, p * 1.15]] });
  } else {
    /* The whipbird: a long, faintly rising note, and the crack. */
    const p = song.p * j();
    const hold = song.hold * (0.9 + r() * 0.2);
    out.push({ t: 0, dur: hold, amp: 0.55, harm, wob: 0.006, wobRate: 6, breath: 0.03,
      attack: 0.08, release: 0.04, keys: [[0, p * 0.97], [0.9, p * 1.05], [1, p * 1.08]] });
    out.push({ t: hold + 0.015, dur: 0.07, amp: 1, harm: [1, 0.15], wob: 0, breath: 0.12,
      attack: 0.1, release: 0.4, keys: [[0, p * 1.3], [0.8, p * 3.6], [1, p * 3.2]] });
    if (song.reply) {
      /* And the mate's answer, a little way off. */
      let t = hold + 0.3;
      for (let k = 0; k < 2; k++) {
        out.push({ t, dur: 0.09, amp: 0.45, harm, wob: 0.002,
          keys: [[0, p * 1.2], [0.4, p * 1.1], [1, p * 0.85]] });
        t += 0.14;
      }
    }
  }
  return out;
}

function chirpSong(r) {
  return {
    f: 3400 + r() * 2400,
    shape: r() < 0.5 ? 'chevron' : 'down',
    count: 2 + Math.floor(r() * 4),
    beat: 0.1 + r() * 0.07,
    reel: r() < 0.4,
  };
}

function chirpRender(song, r) {
  const out = [];
  let t = 0;
  const harm = [1, 0.22, 0.08];
  const count = Math.max(1, song.count + Math.floor(r() * 3) - 1);
  for (let k = 0; k < count; k++) {
    const f = song.f * (1 + (r() - 0.5) * 0.08);
    const dur = 0.04 + r() * 0.025;
    const keys = song.shape === 'chevron'
      ? [[0, f * 0.72], [0.3, f], [1, f * 0.62]]
      : [[0, f * 1.1], [0.2, f], [1, f * 0.58]];
    out.push({ t, dur, amp: 0.8, harm, wob: 0.01, breath: 0.1, attack: 0.1, release: 0.45, keys });
    t += song.beat * (0.9 + r() * 0.2);
  }
  if (song.reel) {
    /* A fairy-wren's reel: a quick run that speeds up and falls away. */
    let gap = 0.07;
    for (let k = 0, n = 5 + Math.floor(r() * 6); k < n; k++) {
      const f = song.f * 1.1 * (1 - k * 0.02);
      out.push({ t, dur: 0.028, amp: 0.55 * (1 - k * 0.04), harm, wob: 0, breath: 0.08,
        attack: 0.15, release: 0.5, keys: [[0, f], [1, f * 0.7]] });
      t += gap;
      gap = Math.max(0.035, gap * 0.9);
    }
  }
  return out;
}

function trillSong(r) {
  return {
    f: 2800 + r() * 2200,
    rate: 13 + r() * 8,         // syllables per second
    count: 9 + Math.floor(r() * 12),
    intro: r() < 0.5,
  };
}

function trillRender(song, r) {
  const out = [];
  let t = 0;
  const harm = [1, 0.14, 0.04];
  if (song.intro) {
    const f = song.f * 0.8;
    out.push({ t, dur: 0.12, amp: 0.6, harm, wob: 0.004, keys: [[0, f], [0.5, f * 1.08], [1, f]] });
    t += 0.2;
  }
  const count = song.count + Math.floor(r() * 4) - 2;
  const period = 1 / (song.rate * (0.95 + r() * 0.1));
  for (let k = 0; k < count; k++) {
    const u = k / Math.max(1, count - 1);
    /* Swell in, drift down, fade out. */
    const amp = Math.min(1, 0.35 + u * 2.5) * Math.min(1, (1 - u) * 3 + 0.25);
    const f = song.f * (1.04 - 0.12 * u);
    out.push({ t, dur: period * 0.55, amp: 0.7 * amp, harm, wob: 0, breath: 0.06,
      attack: 0.15, release: 0.5, keys: [[0, f * 1.18], [0.25, f * 1.1], [1, f * 0.78]] });
    t += period;
  }
  return out;
}

const KINDS = [
  { weight: 0.3, song: carolSong, render: carolRender, pause: [3, 7] },
  { weight: 0.25, song: whistleSong, render: whistleRender, pause: [5, 11] },
  { weight: 0.3, song: chirpSong, render: chirpRender, pause: [2, 6] },
  { weight: 0.15, song: trillSong, render: trillRender, pause: [4, 9] },
];

/* ------------------------------ the birds ---------------------------- */

class Singer {
  constructor(r) {
    let pick = r() * KINDS.reduce((a, k) => a + k.weight, 0);
    this.kind = KINDS.find((k) => (pick -= k.weight) <= 0) || KINDS[0];
    this.song = this.kind.song(r);
    this.pan = r() * 1.8 - 0.9;
    /** 0 is in the next tree, 1 is across the valley. */
    this.far = 0.15 + r() * 0.85;
    this.level = 1 / (1 + 2.5 * this.far);
    this.rest = 0;
    this.renditions = [];
  }
}

export class Birds {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} out  where the calls go -- `Sound.wild`
   * @param {() => number} r
   */
  constructor(ctx, out, r) {
    this.ctx = ctx;
    this.out = out;
    this.r = r;
    this.pool = [];
    this.last = null;
    this._next = 1.5;
    this._travel = 0;
    this._clock = 0;
  }

  /**
   * @param {number} dt
   * @param {number} rate      songs per second, for the whole population
   * @param {number} moved     metres the car covered this frame
   */
  update(dt, rate, moved) {
    this._clock += dt;
    for (const s of this.pool) s.rest -= dt;

    /* Territories: every couple of hundred metres, or every forty seconds
     * standing still, one bird drops out of earshot and another arrives. */
    this._travel += moved + dt * 5;
    if (this._travel > 200) {
      this._travel = 0;
      if (this.pool.length) this.pool.splice(Math.floor(this.r() * this.pool.length), 1);
    }
    while (this.pool.length < 5) this.pool.push(new Singer(this.r));

    if (rate < 0.005) return;
    this._next -= dt * rate;
    if (this._next > 0) return;
    this._next = -Math.log(1 - this.r() * 0.999);

    /* Mostly the bird that just sang sings again once it has drawn
     * breath, and another answers now and then. */
    const ready = this.pool.filter((s) => s.rest <= 0);
    if (!ready.length) return;
    const singer = this.last && this.last.rest <= 0 && this.r() < 0.55
      ? this.last
      : ready[Math.floor(this.r() * ready.length)];
    this._sing(singer);
  }

  _sing(s) {
    const [lo, hi] = s.kind.pause;
    s.rest = lo + this.r() * (hi - lo);
    this.last = s;

    /* Three renditions per bird, rendered as it first needs them and then
     * reused -- the variation is in the rendering, so a bird cycling
     * through three is plenty. */
    const i = Math.floor(this.r() * 3);
    if (!s.renditions[i]) s.renditions[i] = this._render(s);
    const buf = s.renditions[i];

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + (this.r() - 0.5) * 0.02;
    const g = ctx.createGain();
    g.gain.value = s.level;
    const pan = ctx.createStereoPanner();
    pan.pan.value = s.pan;
    src.connect(g).connect(pan).connect(this.out);
    src.start(ctx.currentTime + 0.02);
    src.onended = () => pan.disconnect();
  }

  _render(s) {
    const ctx = this.ctx, sr = ctx.sampleRate, r = this.r;
    const syl = s.kind.render(s.song, r);
    let end = 0;
    for (const x of syl) end = Math.max(end, x.t + x.dur);
    const data = new Float32Array(Math.ceil((end + 0.05) * sr));
    for (const x of syl) syllable(data, Math.floor(x.t * sr), sr, x, r);

    /* Distance: the air takes the top off before it takes the level. */
    const fc = 14000 - 10500 * s.far;
    const a = 1 - Math.exp(-TAU * fc / sr);
    let y = 0, peak = 0;
    for (let i = 0; i < data.length; i++) {
      y += a * (data[i] - y);
      data[i] = y;
      peak = Math.max(peak, Math.abs(y));
    }
    const norm = peak > 0 ? 1 / peak : 0;
    for (let i = 0; i < data.length; i++) data[i] *= norm;

    const buf = ctx.createBuffer(1, data.length, sr);
    buf.copyToChannel(data, 0);
    return buf;
  }
}
