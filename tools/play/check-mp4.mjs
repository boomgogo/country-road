#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Does a film decode?  Opens it in Chrome's own <video>, reports its
 * duration and size, and saves frames at a few times as PNGs -- the
 * check `film.mjs` cannot make on itself, since it only ever encodes.
 *
 *     node tools/play/check-mp4.mjs <film.mp4> [out-dir] [t1,t2,...]
 * ------------------------------------------------------------------ */
import { launch } from '../../perf-bench/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';

const file = resolve(process.argv[2]);
const out = process.argv[3] || dirname(file);
const times = process.argv[4] ? process.argv[4].split(',').map(Number) : null;
mkdirSync(out, { recursive: true });
process.env.HEADLESS = '1';
const c = await launch({ w: 640, h: 360, port: 9335, profile: `${process.cwd()}/chrome-prof-check`,
                         args: ['--allow-file-access-from-files'] });
await c.send('Page.enable');
/* Same origin as the film, so the video can be drawn to a canvas. */
await c.send('Page.navigate', { url: 'file://' + dirname(file) + '/' });
await new Promise((r) => setTimeout(r, 1000));
const info = await c.evaluate(`new Promise((ok, no) => {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto';
  v.onloadedmetadata = () => ok({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
  v.onerror = () => no(new Error('video error ' + (v.error && v.error.code)));
  v.src = ${JSON.stringify(basename(file))};
  window.__v = v;
})`);
console.log(basename(file), JSON.stringify(info));
const ts = times || [0, info.duration / 2, Math.max(0, info.duration - 0.5)];
for (const t of ts) {
  const png = await c.evaluate(`new Promise((ok) => {
    const v = __v;
    v.onseeked = () => {
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      cv.getContext('2d').drawImage(v, 0, 0);
      ok(cv.toDataURL('image/png'));
    };
    v.currentTime = ${t};
  })`);
  const p = join(out, `${basename(file, '.mp4')}-at-${t.toFixed(1)}s.png`);
  writeFileSync(p, Buffer.from(String(png).split(',')[1], 'base64'));
  console.log('  ', p);
}
c.close();
process.exit(0);
