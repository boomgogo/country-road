import { launch } from './cdp.mjs';
const variants = (process.env.VARIANTS || '').split(',');
const b = await launch();
for (const v of variants) {
  await b.send('Page.navigate', { url: `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00${v}` });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
  await b.evaluate(`new Promise(r => setTimeout(r, ${process.env.WAIT || 4000}))`);
  const nat = await b.evaluate(`new Promise(r => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 241) requestAnimationFrame(f); else { const d = ts.slice(1).map((t,i)=>t-ts[i]).sort((a,b)=>a-b); r({ fps: +(1000/(d.reduce((a,b)=>a+b)/d.length)).toFixed(1), p50: +d[120].toFixed(1), p95: +d[228].toFixed(1) }); } }; requestAnimationFrame(f); })`);
  const info = await b.evaluate(`(() => { const g = __game; const c = {}; let tris = 0; for (const ch of g.chunks.live.values()) { c[ch.step] = (c[ch.step]||0)+1; } return { q: g.quality.tier, scale: g.pipeline.scale, rt: [g.pipeline.rtScene.width, g.pipeline.rtScene.height], chunks: c, lvl: g.governor.levels[g.governor.i] }; })()`);
  console.log((v || '(default)').padEnd(40), JSON.stringify(nat), JSON.stringify(info));
}
b.close();
