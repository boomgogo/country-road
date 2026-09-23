import { launch } from './cdp.mjs';
const b = await launch();
await b.send('Page.navigate', { url: `http://127.0.0.1:${process.env.PORT}/?auto=full&fresh&seed=country&sound=0&t=16:00&dynres=0` });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
await b.evaluate(`new Promise(r => setTimeout(r, 4000))`);
await b.evaluate(`(() => { window.requestAnimationFrame = () => 0; })()`);
const o = await b.evaluate(`(async () => {
  const g = __game, r = g.renderer, gl = r.getContext(), px = new Uint8Array(4);
  const sync = () => { r.setRenderTarget(null); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); };
  const out = []; let prog = r.info.programs.length;
  for (let m = 16 * 60; m <= 22 * 60; m += 4) {
    g.setTime(m / 60); sync(); const t = performance.now(); g.step(1/60); sync(); const d = performance.now() - t;
    const p = r.info.programs.length;
    if (d > 120 || p !== prog) out.push([Math.floor(m/60) + ':' + String(m%60).padStart(2,'0'), +d.toFixed(0), p]);
    prog = p;
    await new Promise(q => setTimeout(q, 0));
  }
  return out;
})()`);
console.log(process.env.PORT, JSON.stringify(o));
b.close();
