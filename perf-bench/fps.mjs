// Real rAF fps on one or more servers/query variants.  RUNS="5180:&quality=medium,5178:&quality=medium"
import { launch } from './cdp.mjs';
const b = await launch();
for (const run of process.env.RUNS.split(',')) {
  const [port, qs = ''] = run.split(/:(.*)/s);
  await b.send('Page.navigate', { url: `http://127.0.0.1:${port}/?auto=full&fresh&seed=country&sound=0&t=10:00${qs}` });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
  await b.evaluate(`new Promise(r => setTimeout(r, ${process.env.WAIT || 5000}))`);
  const nat = await b.evaluate(`new Promise(r => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 301) requestAnimationFrame(f); else { const d = ts.slice(1).map((t,i)=>t-ts[i]).sort((a,b)=>a-b); r({ fps: +(1000/(d.reduce((a,b)=>a+b)/d.length)).toFixed(1), p50: +d[150].toFixed(1), p95: +d[285].toFixed(1) }); } }; requestAnimationFrame(f); })`);
  const info = await b.evaluate(`(() => { const g = __game; return { q: g.quality.tier, scale: g.pipeline.scale, rt: [g.pipeline.rtScene.width, g.pipeline.rtScene.height] }; })()`);
  console.log(run.padEnd(40), JSON.stringify(nat), JSON.stringify(info));
}
b.close();
