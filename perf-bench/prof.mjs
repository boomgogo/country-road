import { launch } from './cdp.mjs';
import fs from 'node:fs';
const b = await launch();
const url = `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00`;
await b.send('Page.navigate', { url });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
await b.evaluate(`new Promise(r => setTimeout(r, 3000))`);
await b.evaluate(`(() => { window.requestAnimationFrame = (cb) => 0; })()`);
await b.evaluate(`new Promise(r => setTimeout(r, 300))`);
await b.send('Profiler.enable');
await b.send('Profiler.setSamplingInterval', { interval: 200 });
await b.send('Profiler.start');
// CPU only: step without waiting on GPU, but GPU backpressure may block; so render disabled
const r = await b.evaluate(`(async () => { const g = __game; const P = g.pipeline; const cr = g.clouds.render; P.render = () => {}; g.clouds.render = () => {}; let t0 = performance.now(); for (let i = 0; i < 600; i++) { g.step(1/60); if (i % 30 === 0) await new Promise(q => setTimeout(q, 0)); } return (performance.now() - t0) / 600; })()`);
const { profile } = (await b.send('Profiler.stop')).result;
console.log('cpu tick ms (no draw, 600 frames @ 60Hz sim)', r.toFixed(2));
// self time by function
const self = new Map(); const total = profile.samples.length;
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const counts = new Map(); for (const s of profile.samples) counts.set(s, (counts.get(s) || 0) + 1);
for (const [id, c] of counts) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + c); }
[...self].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, c]) => console.log((100 * c / total).toFixed(1).padStart(5) + '%', k));
b.close();
