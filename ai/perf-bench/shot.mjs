/* ------------------------------------------------------------------ *
 * A frame, on demand.
 *
 * Every probe in this folder grows its own copy of "launch a browser,
 * wait for the loader, walk the car up the road, grab the canvas", and
 * the two things `prompt_3.md` is about are both *pictures* -- so this is
 * that sequence with nothing else in it.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 OUT=/tmp/a.png AT=10520 node ai/perf-bench/shot.mjs
 *     HEADLESS=1 OUT=/tmp/a.png Q=t=08:20&weather=sunny node ai/perf-bench/shot.mjs
 *
 * `AT` is metres along the road.  `Q` is appended to the query string, so
 * anything `README.md` documents reaches it.  `W`, `H` and `DPR` are the
 * window.  `EYE` is the camera height handed to `jumpTo`.
 *
 * Walked to, not jumped to, for the reason `ink.mjs` gives: one cold jump
 * lands with the chase camera still settling and the chunk field still
 * arriving, and a still of that is a photograph of the loader.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PORT = process.env.PORT || 5178;
const SEED = process.env.SEED || 'country';
const AT = Number(process.env.AT || 10520);
const EYE = Number(process.env.EYE || 50);
const OUT = process.env.OUT || '/tmp/shot.png';
const Q = process.env.Q || 't=08:20&season=spring&weather=sunny&quality=high';
const W = Number(process.env.W || 1280);
const H = Number(process.env.H || 720);
const DPR = Number(process.env.DPR || 1);

export async function shoot(c, { at = AT, q = Q, out = OUT, eye = EYE,
                                 w = W, h = H, dpr = DPR } = {}) {
  await c.send('Emulation.setDeviceMetricsOverride',
               { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  await c.send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&dynres=0&day=1`
       + `&seed=${SEED}&${q}`,
  });
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await c.evaluate('window.__game.loaded');
  for (let s = 20; s <= at; s += 500) {
    await c.evaluate(`__game.jumpTo(${s}, ${eye})`);
    await c.evaluate('__game.present()');
  }
  await c.evaluate(`__game.jumpTo(${at}, ${eye})`);
  for (let i = 0; i < 4; i++) await c.evaluate('__game.present()');
  const u = await c.evaluate('window.__game.grab()');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(String(u).split(',')[1], 'base64'));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await launch({ w: W, h: H });
  await c.send('Page.enable');
  console.log(await shoot(c));
  c.close();
  process.exit(0);
}
