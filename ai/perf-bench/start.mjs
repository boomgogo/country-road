import { launch } from './cdp.mjs';
const b = await launch();
await b.send('Page.navigate', { url: `http://127.0.0.1:${process.env.PORT || 5178}/?auto=full&fresh&seed=country&sound=0&t=10:00&dynres=0` });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 20); f(); })`);
const o = await b.evaluate(`new Promise(r => { const t0 = performance.now(); let last = t0; const big = []; const f = (t) => { const d = t - last; last = t; if (d > 50) big.push([+((t - t0)/1000).toFixed(2), +d.toFixed(0)]); if (t - t0 < 5000) requestAnimationFrame(f); else r(big); }; requestAnimationFrame(f); })`);
console.log(JSON.stringify(o));
b.close();
