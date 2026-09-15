/* ------------------------------------------------------------------ *
 * Seeded randomness.
 *
 * The world is a pure function of (seed, position), so nothing here may
 * ever consult Math.random.  Two things are needed: a stream generator
 * for "give me the next value" (used while building one cell's gradient
 * lattice), and a positional hash for "what does this chunk look like"
 * (used by scatter, which has to answer the same question for the same
 * chunk after it has been thrown away and rebuilt).
 * ------------------------------------------------------------------ */

/** Turn any string into a 32-bit seed. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32 -- small, fast, and good enough for scenery.  Returns a
 * function producing floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Integer hash of three coordinates plus the world seed.  This is the
 * one every chunk-local generator starts from: `mulberry32(hash3(ix, iz,
 * salt, seed))` gives that chunk its own repeatable stream.
 */
export function hash3(x, y, z, seed = 0) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0;
  h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** A float in [0, 1) straight from a coordinate -- no stream to carry. */
export function hashFloat(x, y, z, seed = 0) {
  return hash3(x, y, z, seed) / 4294967296;
}

/** Convenience: a seeded stream for one chunk. */
export function chunkRng(ix, iz, salt, seed) {
  return mulberry32(hash3(ix, salt, iz, seed));
}
