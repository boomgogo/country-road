import { launch } from './cdp.mjs';
const variants = (process.env.VARIANTS || '').split(',');
const b = await launch();
for (const v of variants) {
  await b.send('Page.navigate', { url: `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00&dynres=0${v}` });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
  await b.evaluate(`new Promise(r => setTimeout(r, 3000))`);
  const out = await b.evaluate(`new Promise((resolve) => {
    const g = __game; const r = g.renderer; const gl = r.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    let cur = null; const pending = []; const acc = {}; const cnt = {};
    const mark = (name) => { if (cur) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(cur); cur = null; } if (name) { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); cur = { q, name }; } };
    const wrapM = (obj, fn, before, after) => { const f = obj[fn]; obj[fn] = function(...a) { mark(before); const o = f.apply(this, a); mark(after); return o; }; };
    const P = g.pipeline;
    if (g.clouds) wrapM(g.clouds, 'render', 'clouds', null);
    wrapM(r.shadowMap, 'render', 'shadow', 'scene');
    const pr = P.render.bind(P); P.render = () => { mark('scene'); pr(); mark(null); };
    wrapM(P.look.quad, 'render', 'look', null); wrapM(P.fxaa.quad, 'render', 'fxaa', null);
    const cpu = []; const frames = []; let last = performance.now();
    const origStep = g.step;
    const poll = () => { for (let i = pending.length - 1; i >= 0; i--) { const p = pending[i]; if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) { acc[p.name] = (acc[p.name]||0) + gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6; cnt[p.name] = (cnt[p.name]||0)+1; } gl.deleteQuery(p.q); pending.splice(i, 1); } } };
    let n = 0;
    const tick = (t) => { frames.push(t); poll(); if (++n < 200) requestAnimationFrame(tick); else { const res = {}; const nf = cnt.scene ? cnt.scene/2 : 1; for (const k in acc) res[k] = +(acc[k] / (k === 'scene' ? cnt.scene/2 : cnt[k])).toFixed(1); const d = frames.slice(1).map((t,i)=>t-frames[i]); res.fps = +(1000 / (d.reduce((a,b)=>a+b)/d.length)).toFixed(1); res.rt = [P.rtScene.width, P.rtScene.height]; res.gpuSum = +Object.entries(res).filter(([k]) => ['scene','shadow','clouds','look','fxaa'].includes(k)).reduce((a,[,v])=>a+v,0).toFixed(1); resolve(res); } };
    requestAnimationFrame(tick);
  })`);
  // cpu time of tick+draw issuing (no sync)
  console.log((v||'(medium)').padEnd(36), JSON.stringify(out));
}
b.close();
