/* ------------------------------------------------------------------ *
 * The save, in a cookie.
 *
 * The brief says cookie, so it is a cookie.  The record is one line of
 * tilde-separated fields rather than JSON -- about sixty bytes, no URI
 * encoding to read through, and legible in devtools without a parser:
 *
 *   br.save = 2~<seed>~<clock>~<arc>~<odometer>~<camera>~<autodrive>
 *
 * `<autodrive>` is a mode *name*; see `VERSION` below for why.
 *
 * **Tilde, not a full stop**, and that is not a style choice.  The first
 * version separated on `.` and wrote the numbers with `toFixed(1)`, so
 * every value contributed a second separator of its own: a seven-field
 * record came back as ten fields, the camera field parsed as `"0"` and
 * the autodrive mode as `1234`.  A separator that can occur inside a
 * field is not a separator.
 *
 * Everything in it is either a seed or a position, because the world is a
 * pure function of the seed: the terrain, the road, the scatter, the
 * grass, the weather and the time of year all rebuild themselves from
 * those two numbers.  There is nothing else worth persisting, and a save
 * format that stores derived state is a save format that goes stale the
 * first time a generator is touched.
 *
 * A pedantic note for the record, since the brief mentions it: clearing
 * the browser *cache* does not clear cookies -- clearing *site data*
 * does.  The behaviour asked for is what a cookie gives.
 *
 * `localStorage` is a silent fallback for the contexts where
 * `document.cookie` is unavailable (`file://`, some embeddings), because
 * the alternative is a save that mysteriously never works and nothing
 * says why.
 * ------------------------------------------------------------------ */

import { MODES, MODES_V1 } from '../car/autodrive.js';

const KEY = 'br.save';
/**
 * Version 2 stores the autodrive mode by **name**.
 *
 * Version 1 stored an index into `MODES`, and `prompt_5.md` reordered that
 * array -- so every cookie written before this change means something
 * different when read through the new one. A saved auto-speed drive would
 * come back as full autodrive, which is the difference between a reorder
 * and a bug report. `read()` accepts both and maps a v1 index through
 * `MODES_V1`; nothing else about the record changed.
 */
const VERSION = 2;
const MAX_AGE = 31536000;         // a year

/** Write at most this often, in seconds of wall clock. */
const THROTTLE = 2;

export class Save {
  constructor() {
    this.last = 0;
    this.available = probe();
  }

  /**
   * Read whatever is stored, or null.
   *
   * Everything is validated on the way in: a corrupt or hand-edited
   * cookie must not be able to put the car at NaN, because `placeOn` will
   * happily do it and the failure surfaces two hundred lines away as a
   * physics body that has left the world.
   */
  read() {
    const raw = get(KEY);
    if (!raw) return null;
    const bits = raw.split('~');
    const version = Number(bits[0]);
    if (!(version === VERSION || version === 1) || bits.length < 7) return null;
    const rec = {
      seed: bits[1],
      t: Number(bits[2]),
      s: Number(bits[3]),
      odometer: Number(bits[4]),
      camera: bits[5],
      /* A name from v2; an index into the *old* order from v1. */
      auto: version === 1
        ? (MODES_V1[Number(bits[6]) | 0] || 'manual')
        : (MODES.includes(bits[6]) ? bits[6] : 'manual'),
    };
    if (!rec.seed) return null;
    for (const k of ['t', 'odometer']) {
      if (!Number.isFinite(rec[k]) || rec[k] < 0) return null;
    }
    /* `s` may be **negative**: `prompt_5.md` item 4 made the road's arc
     * coordinate signed, so a drive that went the other way out of the
     * origin saves a negative position.  Rejecting it here would silently
     * throw away exactly the saves the feature exists to make. */
    if (!Number.isFinite(rec.s)) return null;
    return rec;
  }

  /**
   * Store the current state.
   *
   * Throttled, and `force` for the page-hide path -- `pagehide` rather
   * than `unload`, which is unreliable on mobile and blocks the back/
   * forward cache on every browser that has one.
   */
  write(rec, now, force = false) {
    if (!this.available) return false;
    if (!force && now - this.last < THROTTLE) return false;
    this.last = now;
    const line = [
      VERSION, rec.seed,
      rec.t.toFixed(1), rec.s.toFixed(1), rec.odometer.toFixed(1),
      rec.camera, MODES.includes(rec.auto) ? rec.auto : 'manual',
    ].join('~');
    set(KEY, line);
    return true;
  }

  clear() {
    try {
      document.cookie = `${KEY}=; path=/; max-age=0; SameSite=Lax`;
    } catch { /* nothing to clear */ }
    try { localStorage.removeItem(KEY); } catch { /* nor here */ }
  }
}

/* --------------------------- the two backends -------------------------- */

function set(key, value) {
  try {
    document.cookie = `${key}=${value}; path=/; max-age=${MAX_AGE}; SameSite=Lax`;
    if (document.cookie.includes(key + '=')) return;
  } catch { /* fall through */ }
  try { localStorage.setItem(key, value); } catch { /* neither works */ }
}

function get(key) {
  try {
    for (const part of document.cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === key) return v.join('=');
    }
  } catch { /* fall through */ }
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Is there anywhere to write at all? */
function probe() {
  try {
    document.cookie = `br.probe=1; path=/; max-age=10; SameSite=Lax`;
    if (document.cookie.includes('br.probe=')) {
      document.cookie = 'br.probe=; path=/; max-age=0; SameSite=Lax';
      return true;
    }
  } catch { /* fall through */ }
  try {
    localStorage.setItem('br.probe', '1');
    localStorage.removeItem('br.probe');
    return true;
  } catch { return false; }
}
