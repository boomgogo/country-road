/**
 * One place for every colour in the cel-shaded pass.
 *
 * Narrow on purpose: three greens, two dry golds, a grey-violet rock, one
 * ink, and a sky.  A wide palette is what makes cel shading look like a
 * filter over a photograph rather than like a drawing -- the whole point
 * of quantising light is that the *colours* are chosen too.
 *
 * The structure is the sibling project's (`ref/dp-sakura-crossing`, MIT);
 * the values are not.  That is a Japanese suburb in blossom season and
 * this is British upland in late summer, and almost nothing carries over
 * but the discipline.
 */
export const PAL = {
  /* --- sky & atmosphere ---
   *
   * `skyTop` was #6f9fd0, and against the fair-weather references in
   * `ref/cloud/` that is not a zenith -- it is what a zenith looks like
   * two thirds of the way down toward the horizon.  A real fine day is
   * strongly saturated overhead and pale at the horizon, and the gradient
   * between them is most of what makes a sky read as deep rather than as
   * a backdrop.  Deepened toward `day_cloud_3.jpg`'s own zenith, with
   * `skyMid` left where it is so the ramp gets steeper rather than the
   * whole dome getting darker. */
  skyTop: 0x3f82c9,
  skyMid: 0xa8c9e4,
  skyHaze: 0xdfe9ee,
  cloud: 0xfbfcfd,
  fog: 0xdfe9ee,

  // --- light ---
  sun: 0xfff4dc,
  fill: 0x9fb8e0,
  hemiSky: 0xd6e7f6,
  hemiGround: 0x7d7c58,

  // --- ink ---
  ink: 0x2f3341,

  // --- ground ---
  grass: 0x7d9450,
  grassDry: 0xa8ab6a,
  grassHigh: 0xbcb87e,
  heather: 0x7c6a63,
  rock: 0x8b8a92,
  rockDark: 0x6d6c76,
  gravel: 0x9c988e,
  sand: 0xc9bd94,
  road: 0x585b66,
  roadWorn: 0x676a75,
  lineWhite: 0xeceade,
  water: 0x5b86a3,

  // --- trees ---
  leafLow: 0x4a6b39,
  leafMid: 0x5c7f42,
  leafHigh: 0x74964f,
  needleLow: 0x33553f,
  needleMid: 0x40684a,
  bark: 0x5b4c3e,

  // --- the car ---
  paint: 0xeef0f2,
  glass: 0x2b323e,
  tyre: 0x22242a,
  lampRed: 0xc0392b,
  lampWhite: 0xf3f1e4,
  chrome: 0x9aa1a9,
};
