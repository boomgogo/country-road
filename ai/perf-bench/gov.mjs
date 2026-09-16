// Live run with the governor on: log scale and fps every second.
import { launch } from './cdp.mjs';
const PORT = process.env.PORT || 5178;
const b = await launch();
await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?auto=full&fresh&seed=country&sound=0&t=10:00${process.env.QS || ''}` });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
const log = await b.evaluate(`new Promise(r => { const out = []; let n = 0, last = performance.now(), t0 = last; const f = (t) => { n++; if (t - last >= 1000) { const g = __game; out.push([+((t - t0)/1000).toFixed(0), +(n * 1000 / (t - last)).toFixed(1), g.pipeline.scale.toFixed(3), g.pipeline.rtScene.width]); n = 0; last = t; } if (t - t0 < ${process.env.SECS || 60} * 1000) requestAnimationFrame(f); else r(out); }; requestAnimationFrame(f); })`, 900000);
for (const row of log) console.log(row.join('\t'));
b.close();
