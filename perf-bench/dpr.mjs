/* ------------------------------------------------------------------ *
 * What reaches the panel on a high-density screen.
 *
 * Every other probe here reads the canvas, which is exactly the thing
 * that cannot see this fault: the canvas is whatever size the pipeline
 * made it, and the blur `prompt_4.md` reports is what the *compositor*
 * does to it afterwards.  So this one takes the compositor's screenshot
 * at the device's own pixels, and prints the sizes the frame passed
 * through on the way.
 *
 *     npx vite --port 5178
 *     HEADLESS=1 node perf-bench/dpr.mjs                    # all devices
 *     HEADLESS=1 DEV=surface OUT=/tmp/dpr node perf-bench/dpr.mjs
 *
 * The devices are the two in the prompt, as near as a desktop can play
 * them: the Surface Go's panel and tier, and a mid-size phone's.  The
 * GPU is this machine's, so this is a picture test and not a speed one.
 *
 * `Page.captureScreenshot` has the staleness `main.js`'s `grab()` warns
 * about, so each shot is taken after `present()`, which draws inside the
 * browser's frame callback and waits for the composite.
 * ------------------------------------------------------------------ */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.PORT || 5178;
const OUT = process.env.OUT || '/tmp/dpr';
const AT = Number(process.env.AT || 10520);

const DEVICES = {
  surface: { w: 1200, h: 800, dpr: 1.5, mobile: false, q: 'quality=medium' },
  phone:   { w: 393, h: 851, dpr: 2.75, mobile: true, q: 'quality=low&touch=0' },
  desktop: { w: 1280, h: 720, dpr: 1, mobile: false, q: 'quality=high' },
};
const pick = process.env.DEV ? process.env.DEV.split(',') : Object.keys(DEVICES);
/* `SCALE` pins the governor's level, the way a slow GPU would, since this
 * machine's GPU will not drive it down on its own. */
const SCALE = process.env.SCALE ? Number(process.env.SCALE) : null;

mkdirSync(OUT, { recursive: true });
const c = await launch({ w: 1400, h: 1000 });
await c.send('Page.enable');

for (const name of pick) {
  const d = DEVICES[name];
  await c.send('Emulation.setDeviceMetricsOverride',
               { width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: d.mobile });
  await c.send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/?rec=1&fresh&sound=0&day=1&seed=country`
       + `&t=08:20&season=spring&weather=sunny&${d.q}`,
  });
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate('!!(window.__game && window.__game.loaded)').catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await c.evaluate('window.__game.loaded');
  for (let s = 20; s <= AT; s += 500) {
    await c.evaluate(`__game.jumpTo(${s}, 50)`);
    await c.evaluate('__game.present()');
  }
  await c.evaluate(`__game.jumpTo(${AT}, 50)`);
  if (SCALE) await c.evaluate(`__game.pipeline.maxScale = ${SCALE}; dispatchEvent(new Event('resize'))`);
  for (let i = 0; i < 4; i++) await c.evaluate('__game.present()');

  const info = await c.evaluate(`(() => {
    const g = __game, p = g.pipeline, cv = g.renderer.domElement;
    return { dpr: devicePixelRatio, css: [innerWidth, innerHeight],
             canvas: [cv.width, cv.height],
             scene: [p.rtScene.width, p.rtScene.height],
             mode: p.mode || 'n/a', tier: g.quality.tier };
  })()`);
  const panel = [Math.round(d.w * d.dpr), Math.round(d.h * d.dpr)];
  const frac = (info.scene[0] / panel[0]).toFixed(2);
  console.log(name.padEnd(8), JSON.stringify(info), 'panel', panel.join('x'),
              'scene/panel', frac);
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}${SCALE ? '-s' + SCALE : ''}.png`,
                Buffer.from(shot.result.data, 'base64'));
}
c.close();
process.exit(0);
