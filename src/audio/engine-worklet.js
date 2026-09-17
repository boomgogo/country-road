/* ------------------------------------------------------------------ *
 * The flat six, one sample at a time.
 *
 * Loaded as source text (`?raw`) and handed to `audioWorklet.addModule`
 * as a Blob, so it must not import anything: it runs on the audio thread
 * in a scope that has `sampleRate`, `registerProcessor` and nothing else.
 *
 * There is no recording in here.  A loop of a real engine can only be
 * pitched, and a pitched loop is what every driving game that sounds like
 * a vacuum cleaner is doing -- the pulse spacing and the pipe resonance
 * move together, which no engine does.  So it is built the way the noise
 * is made:
 *
 *   1. **Six firings per crank cycle**, one every 120 degrees of crank,
 *      as a smooth pulse of pressure each.  The pulse is a raised cosine a
 *      few milliseconds wide rather than a click, which keeps it band
 *      limited without an oversampler.  Firing order 1-6-2-4-3-5 puts
 *      successive firings on alternate banks, so the banks take turns.
 *   2. **Each bank has its own header**, a delay line with an inverting
 *      reflection -- an open pipe end -- and the two are different lengths.
 *      Two combs a few samples apart are what put energy between the
 *      firing harmonics, and that in-between is the howl a flat six has
 *      and an inline six does not.
 *   3. **A silencer**: a boom resonance, a rasp band that opens with load,
 *      and a lowpass that opens with load and revs.  On a closed throttle
 *      the same pulses come out thin and dull, which is most of what makes
 *      a lift-off sound like a lift-off.
 *   4. **The turbos**: induction hiss, a whistle that follows boost, and a
 *      sigh of the recirculation valve when the throttle shuts on boost.
 *   5. **Overrun**: on a closed throttle above 2800 rpm an occasional
 *      firing is a pop.  Rare, because the brief for this game is a
 *      relaxing drive and not a rally stage.
 *
 * Parameters are k-rate and ramped across each block, so a gear change
 * that moves the revs by 2000 in a frame is still a glide over 3 ms and
 * not a step.
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  bandpass(f, q) {
    const w = TAU * Math.min(f, sampleRate * 0.45) / sampleRate;
    const s = Math.sin(w), c = Math.cos(w), al = s / (2 * q), a0 = 1 + al;
    this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }

  lowpass(f, q) {
    const w = TAU * Math.min(f, sampleRate * 0.45) / sampleRate;
    const s = Math.sin(w), c = Math.cos(w), al = s / (2 * q), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0;
    this.a1 = -2 * c / a0; this.a2 = (1 - al) / a0;
  }

  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** One bank's header: a delay line with a damped, inverting reflection. */
class Header {
  constructor(ms, feedback) {
    this.len = Math.max(2, Math.round(ms * 0.001 * sampleRate));
    this.buf = new Float32Array(this.len);
    this.i = 0;
    this.fb = feedback;
    this.damp = 0;
  }

  run(x) {
    const out = this.buf[this.i];
    /* One-pole lowpass in the loop: a real pipe loses its top first, so
     * the upper echoes die away before the lower ones. */
    this.damp += 0.45 * (out - this.damp);
    this.buf[this.i] = x + this.fb * this.damp;
    this.i = (this.i + 1) % this.len;
    return out + x;
  }
}

/* The cylinders are not identical and a flat six does not sound like six
 * identical ones.  A fixed few per cent either way, by firing slot. */
const CYL_AMP = [1.0, 0.9, 0.96, 0.87, 1.03, 0.92];

class FlatSix extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 9000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;          // 0..1 of a 720-degree cycle
    this.slot = 0;           // which of the six firings is next
    this.rpm = 0;
    this.load = 0;
    this.boost = 0;
    this.bov = 0;
    this.lastLoad = 0;
    this.pulses = [
      { pos: 1e9, width: 1, amp: 0, noise: 0 },
      { pos: 1e9, width: 1, amp: 0, noise: 0 },
    ];
    this.headers = [new Header(5.1, -0.55), new Header(6.3, -0.5)];
    this.boom = new Biquad();
    this.rasp = new Biquad();
    this.tone = new Biquad();
    this.intake = new Biquad();
    this.hiss = new Biquad();
    this.mech = new Biquad();
    this.dcX = 0; this.dcY = 0;
    this.firingEnv = 0;
    this.whistle = 0;
    this.seed = 22222;
  }

  rand() {
    /* xorshift: `Math.random` is allowed here, but a sound that cannot be
     * reproduced cannot be measured. */
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0];
    if (!L) return true;
    const n = L.length;
    const sr = sampleRate;

    const rpm0 = this.rpm, rpm1 = params.rpm[0];
    const load0 = this.load, load1 = params.load[0];

    /* Once a block: the filters and the slow state. */
    const load = load1, rpm = rpm1;
    this.boom.bandpass(95 + rpm * 0.012, 1.1);
    this.rasp.bandpass(480 + rpm * 0.06, 1.4);
    this.tone.lowpass(650 + 2800 * load + rpm * 0.18, 0.75);
    this.intake.bandpass(1500 + rpm * 0.12, 0.9);
    this.hiss.bandpass(2600, 0.6);
    this.mech.bandpass(5200, 1.2);

    /* Boost builds with revs under load and bleeds away quickly off it. */
    const want = Math.max(0, load - 0.25) / 0.75 * Math.min(1, Math.max(0, (rpm - 1600) / 3000));
    const blockT = n / sr;
    this.boost += (want - this.boost) * (1 - Math.exp(-blockT / (want > this.boost ? 0.55 : 0.12)));
    /* The throttle shut on boost: the recirculation valve sighs. */
    if (this.lastLoad - load1 > 0.35 && this.boost > 0.35) this.bov = Math.max(this.bov, this.boost);
    this.lastLoad = load1;
    const bovDecay = Math.exp(-1 / (0.3 * sr));

    for (let k = 0; k < n; k++) {
      const f = k / n;
      const r = rpm0 + (rpm1 - rpm0) * f;
      const ld = load0 + (load1 - load0) * f;

      /* The crank. */
      const cps = r / 120;                   // cycles per second
      this.phase += cps / sr;
      if (this.phase >= 1) this.phase -= 1;
      const due = Math.floor(this.phase * 6);
      if (due !== this.slot && r > 60) {
        this.slot = due;
        const bank = due & 1;
        const p = this.pulses[bank];
        /* A bank fires every third of a cycle; the pulse is kept under
         * two-thirds of that so it never runs into the next one. */
        const bankGap = sr / (cps * 3);
        p.width = Math.max(8, Math.min(0.0032 * sr, bankGap * 0.62));
        p.pos = 0;
        /* A firing's strength is mostly load, and a closed throttle still
         * burns something.  Idle is lumpy, full load is even. */
        const rough = (1 - ld) * 0.22;
        let a = CYL_AMP[due] * (0.2 + 0.8 * ld) * (1 + rough * this.rand());
        let noise = 0.15 + 0.35 * ld;
        if (ld < 0.05 && r > 2800 && Math.abs(this.rand()) < 0.012 * (r - 2800) / 4000) {
          a = 1.6; noise = 1.2;
          p.width = Math.min(0.006 * sr, bankGap * 0.9);
        }
        p.amp = a;
        p.noise = noise;
        this.firingEnv = 1;
      }

      /* The two banks, each through its own header. */
      let ex = 0;
      for (let b = 0; b < 2; b++) {
        const p = this.pulses[b];
        let x = 0;
        if (p.pos < p.width) {
          const w = 0.5 - 0.5 * Math.cos(TAU * p.pos / p.width);
          x = p.amp * w * (1 + p.noise * this.rand());
          p.pos++;
        }
        ex += this.headers[b].run(x);
      }

      let v = 0.55 * ex
        + 1.1 * this.boom.run(ex)
        + (0.25 + 0.9 * ld) * this.rasp.run(ex);
      v = this.tone.run(v);

      /* Induction and turbo. */
      this.firingEnv *= 0.994;
      const white = this.rand();
      v += this.intake.run(white) * (0.02 + 0.16 * ld) * (0.6 + 0.4 * this.firingEnv) * Math.min(1, r / 3000);
      this.whistle += TAU * (1900 + 5200 * this.boost) / sr;
      if (this.whistle > TAU) this.whistle -= TAU;
      v += Math.sin(this.whistle) * 0.018 * this.boost * this.boost;
      this.bov *= bovDecay;
      v += this.hiss.run(white) * this.bov * 0.35;
      v += this.mech.run(white) * 0.012 * Math.min(1, r / 6000);

      /* DC block, then a soft ceiling. */
      const y = v - this.dcX + 0.995 * this.dcY;
      this.dcX = v; this.dcY = y;
      L[k] = Math.tanh(y * 1.4) * 0.6;
    }

    for (let c = 1; c < out.length; c++) out[c].set(L);
    this.rpm = rpm1; this.load = load1;
    return true;
  }
}

registerProcessor('flat-six', FlatSix);
