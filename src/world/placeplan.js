import { hashFloat } from '../core/rng.js';

/* ------------------------------------------------------------------ *
 * Where the places are: a schedule, before there is anything to put
 * there.
 *
 * `prompt_5.md` asks for places, after `suggest_4.md` §1: a landmark every
 * few kilometres, a small town every fifteen to twenty-five, and signposts
 * with distances.  The signposts are what decide the design.  A sign that
 * says "Wattle Creek 12" twelve kilometres before Wattle Creek has to know
 * where the town is before the road there has been traced -- so where a
 * place is cannot be a fact about the ground.  It is a fact about the
 * *road*: place `k` on a line is at arc distance `d_k`, which is a pure
 * function of the seed.
 *
 * Arc distance along one line, measured out from the origin: the forward
 * line's `s` is `d`, the backward line's is `-d`.  A town is *defined* to
 * be centred on its `d`, and `places.js` lays its lots out around that
 * point -- so a sign is exact by construction, however the road happens
 * to wind on the way.
 *
 * Nothing here is saved, because nothing here needs to be: the seed gives
 * the schedule, the schedule gives the names, and the road is already a
 * pure function of the seed.  It is small and imported statically, so the
 * load screen can say where a saved drive is; everything that *builds* a
 * place is in `places.js`, which arrives after the first frame.
 * ------------------------------------------------------------------ */

/** Metres between towns along one line. */
export const TOWN_GAP = [15000, 25000];
/** Where the first town is.  The forward line is the one every new drive
 *  starts on, so its first town is about four minutes away at cruise. */
const FIRST_TOWN = [[3600, 4400], [7000, 11000]];
/** Metres between landmarks, and how far any landmark keeps from a town. */
const LANDMARK_GAP = [2000, 4000];
const TOWN_CLEAR = 1500;
/** The landmark kinds, drawn evenly. */
export const LANDMARKS = ['farmhouse', 'woolshed', 'silos', 'windmill', 'lookout'];
/** A distance sign roughly this often between towns, metres. */
const SIGN_EVERY = 5000;

const SALT = 0x91ace;

/* ------------------------------------------------------------------ *
 * Names.
 *
 * Plain English country words, compounded: "Wattle Creek", "Stony Flat".
 * Some will be the names of real places, which is fine for words like
 * these.  It deliberately does **not** make up words in the style of an
 * Aboriginal place name out of syllables: a made-up word in that style
 * can land on a real word with a meaning, and that is not something to do
 * by accident.
 * ------------------------------------------------------------------ */
const FIRST = [
  'Wattle', 'Stony', 'Cedar', 'Ironbark', 'Grey Gum', 'Possum', 'Kelpie',
  'Bellbird', 'Black Swamp', 'Red Gum', 'Box', 'Bottlebrush', 'Curlew',
  'Magpie', 'Currawong', 'Wombat', 'Wallaby', 'Emu', 'Brolga', 'Lyrebird',
  'Platypus', 'Banksia', 'Tea Tree', 'Paperbark', 'Blackwood', 'Stringybark',
  'Yellow Box', 'Bluegum', 'Silver', 'Sandy', 'Rocky', 'Long', 'Broad',
  'Deep', 'Clear', 'Shepherds', 'Drovers', 'Bullock', 'Coach', 'Tin Hut',
  'Sawpit', 'Quartz', 'Slate', 'She-oak', 'Sugarloaf', 'Mulberry',
  'Cockatoo', 'Kangaroo', 'Settlers', 'Ferny',
];
const SECOND = [
  'Creek', 'Flat', 'Gully', 'Springs', 'Crossing', 'Downs', 'Vale', 'Ridge',
  'Plains', 'Bend', 'Hill', 'Hollow', 'Waters', 'Park', 'Valley', 'Point',
  'Rise', 'Gap', 'Junction', 'Corner',
];

/** Every acceptable pairing, in a fixed order.  "Rocky Rise" is a name;
 *  "Spring Springs" would not be, so pairs that repeat a word are out. */
const NAMES = (() => {
  const out = [];
  for (const a of FIRST) {
    const last = a.split(' ').pop().toLowerCase();
    for (const b of SECOND) {
      const w = b.toLowerCase();
      if (w.startsWith(last) || last.startsWith(w)) continue;
      out.push(`${a} ${b}`);
    }
  }
  return out;
})();

/**
 * Town `k` of line `line`, by name.
 *
 * A stride through the whole list rather than a hash per town, so no name
 * comes up twice in a drive: the two lines interleave on the same stride,
 * and a stride coprime to the list's length visits every entry before it
 * repeats one.  About nine hundred names is about twenty thousand
 * kilometres of road.
 */
export function townName(seed, line, k) {
  const n = NAMES.length;
  const off = Math.floor(hashFloat(seed, SALT, 7) * n);
  let stride = 7 + Math.floor(hashFloat(seed, SALT, 8) * (n - 14));
  while (gcd(stride, n) !== 1) stride++;
  return NAMES[(off + (2 * k + line) * stride) % n];
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

/* ------------------------------------------------------------------ *
 * The schedule.
 * ------------------------------------------------------------------ */

/**
 * One line's places, generated outward as far as anyone asks.
 *
 * Every entry is `{ line, d, s, kind, side, seed }`, with `name` and `k`
 * on towns and `towns` on distance signs.  `side` is which side of the
 * road a landmark is put on, +1 for the road's right-hand side as
 * `sampleAt` gives it.  The stream is generated in order with its own
 * seeded draws per entry, so asking for more of it never changes what
 * was already there.
 */
class LinePlan {
  constructor(seed, line) {
    this.seed = seed;
    this.line = line;
    this.towns = [];
    this.entries = [];
    this.until = 0;
  }

  _r(a, b) { return hashFloat(this.seed, SALT + this.line, a * 131 + b); }

  /** Generate until the schedule is known out to `d` and one town past. */
  ensure(d) {
    while (this.until < d + TOWN_GAP[1] * 2) this._nextTown();
  }

  _nextTown() {
    const k = this.towns.length;
    const lo = k === 0 ? FIRST_TOWN[this.line] : TOWN_GAP;
    const prev = k === 0 ? 0 : this.towns[k - 1].d;
    const d = Math.round(prev + lo[0] + (lo[1] - lo[0]) * this._r(k, 1));
    const town = {
      line: this.line, k, d, s: this.line ? -d : d, kind: 'town',
      side: this._r(k, 2) < 0.5 ? -1 : 1,
      seed: Math.floor(this._r(k, 3) * 0x7fffffff),
      name: townName(this.seed, this.line, k),
    };
    this.towns.push(town);

    /* Landmarks between the last town and this one.  Clear of both by
     * `TOWN_CLEAR`, and on the forward line the first one comes early, so
     * a new drive has something in its first couple of minutes. */
    let c = k === 0
      ? (this.line === 0 ? 1100 + 700 * this._r(k, 4) : 2000 + 2000 * this._r(k, 4))
      : prev + TOWN_CLEAR + 1000 * this._r(k, 4);
    let j = 0;
    while (c < d - TOWN_CLEAR) {
      const r = this._r(k * 64 + j, 5);
      this.entries.push({
        line: this.line, d: Math.round(c), s: this.line ? -Math.round(c) : Math.round(c),
        kind: LANDMARKS[Math.floor(r * LANDMARKS.length) % LANDMARKS.length],
        side: this._r(k * 64 + j, 6) < 0.5 ? -1 : 1,
        seed: Math.floor(this._r(k * 64 + j, 7) * 0x7fffffff),
      });
      j++;
      c += LANDMARK_GAP[0] + (LANDMARK_GAP[1] - LANDMARK_GAP[0]) * this._r(k * 64 + j, 8);
    }

    /* Distance signs on the way to this town: one just clear of the last
     * town (or just past the start), one every `SIGN_EVERY` or so, and one
     * a kilometre and a half before this one.  "Just clear" is past the
     * widest a town can spread, 800 m, and its own end signs.  Each names
     * the next two towns further out, which it can, because the next town
     * is generated before anyone asks for this sign's text -- see
     * `ensure`. */
    const from = k === 0 ? (this.line === 0 ? 160 : 600) : prev + 1150;
    const signs = [from];
    for (let x = from + SIGN_EVERY; x < d - 3000; x += SIGN_EVERY) signs.push(x);
    signs.push(d - 1500);
    for (const x of signs) {
      if (x <= 0 || x >= d - 600) continue;
      this.entries.push({
        line: this.line, d: Math.round(x), s: this.line ? -Math.round(x) : Math.round(x),
        kind: 'sign', side: 0, seed: Math.round(x), towns: k,
      });
    }
    this.entries.push(town);
    this.entries.sort((a, b) => a.d - b.d);
    this.until = d;
  }
}

export class PlacePlan {
  constructor(seed) {
    this.seed = seed;
    this.lines = [new LinePlan(seed, 0), new LinePlan(seed, 1)];
  }

  /** Every scheduled entry whose signed `s` is in [s0, s1]. */
  between(s0, s1) {
    const out = [];
    for (const L of this.lines) {
      const a = L.line ? -s1 : s0, b = L.line ? -s0 : s1;
      if (b < 0) continue;
      L.ensure(b);
      for (const e of L.entries) {
        if (e.d >= a && e.d <= b) out.push(e);
      }
    }
    return out;
  }

  /** The towns a distance sign at entry `e` names: the next two out. */
  signTowns(e) {
    const L = this.lines[e.line];
    L.ensure(e.d + TOWN_GAP[1] * 2);
    return L.towns.filter((t) => t.d > e.d).slice(0, 2);
  }

  /** The `k`-th town of a line. */
  town(line, k) {
    const L = this.lines[line];
    while (L.towns.length <= k) L._nextTown();
    return L.towns[k];
  }

  /**
   * The town nearest a signed arc position, by road, and how far.  For
   * the load screen's "near Wattle Creek" and the pause menu.
   */
  nearestTown(s) {
    const line = s < 0 ? 1 : 0;
    const d = Math.abs(s);
    const L = this.lines[line];
    L.ensure(d);
    let best = null, bd = Infinity;
    for (const t of L.towns) {
      const dd = Math.abs(t.d - d);
      if (dd < bd) { bd = dd; best = t; }
    }
    /* The other line's first town can be the nearer one close to the
     * origin, where the two lines meet. */
    const o = this.lines[1 - line];
    o.ensure(0);
    if (o.towns[0] && o.towns[0].d + d < bd) { best = o.towns[0]; bd = o.towns[0].d + d; }
    return best ? { name: best.name, metres: bd, town: best } : null;
  }

  /** One line of prose for where `s` is.  "near Wattle Creek", or
   *  "6 km from Stony Flat" when the nearest town is further than that. */
  where(s) {
    const n = this.nearestTown(s);
    if (!n) return '';
    if (n.metres < 3000) return `near ${n.name}`;
    return `${Math.round(n.metres / 1000)} km from ${n.name}`;
  }
}
