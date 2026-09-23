import { launch } from './cdp.mjs';
const base = process.env.BASE || 'http://127.0.0.1:5178/';
const qs = process.env.QS || '';
const variants = (process.env.VARIANTS || 'full').split(',');
const b = await launch();
const setup = {
  full: '',
  noInk: `g.pipeline.enabled.ink = false;`,
  noFxaa: `g.pipeline.enabled.fxaa = false;`,
  noClouds: `g.clouds.render = () => {}; g.clouds.composite.visible = false;`,
  noShadow: `g.renderer.shadowMap.enabled = false; g.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); });`,
  scale1: `g.pipeline.maxScale = 1; g.pipeline.pixelBudget = 1; dispatchEvent(new Event('resize'));`,
  aniso2: `g.chunks.material.userData.uniforms && Object.values(g.chunks.material.userData.uniforms).forEach(u => { if (u.value && u.value.isTexture) { u.value.anisotropy = 2; u.value.needsUpdate = true; } });`,
  aniso4: `g.chunks.material.userData.uniforms && Object.values(g.chunks.material.userData.uniforms).forEach(u => { if (u.value && u.value.isTexture) { u.value.anisotropy = 4; u.value.needsUpdate = true; } });`,
  c33: `g.clouds.scale = 0.33; dispatchEvent(new Event('resize'));`,
  c25: `g.clouds.scale = 0.25; dispatchEvent(new Event('resize'));`,
  histHalf: `{ const f = g.clouds.setSize.bind(g.clouds); g.clouds.setSize = (w, h) => { f(w, h); for (const rt of g.clouds.hist) rt.setSize(Math.round(w/2), Math.round(h/2)); }; dispatchEvent(new Event('resize')); }`,
  sh2048: `{ let L; g.scene.traverse(o => { if (o.isDirectionalLight && o.shadow && o.shadow.mapSize.x > 1000) L = o; }); L.shadow.mapSize.set(2048, 2048); L.shadow.map && L.shadow.map.dispose(); L.shadow.map = null; }`,
  sh1024: `{ let L; g.scene.traverse(o => { if (o.isDirectionalLight && o.shadow && o.shadow.mapSize.x > 1000) L = o; }); L.shadow.mapSize.set(1024, 1024); L.shadow.map && L.shadow.map.dispose(); L.shadow.map = null; }`,
  scale075: `g.pipeline.maxScale = 0.75; g.pipeline.pixelBudget = 1; g.pipeline.setSize = ((f) => function(w,h){ f.call(this,w,h); })(g.pipeline.setSize); dispatchEvent(new Event('resize'));`,
};
for (const v of variants) {
  const url = `${base}?auto=full&fresh&seed=country&sound=0&t=10:00${qs}`;
  await b.send('Page.navigate', { url });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
  await b.evaluate(`new Promise(r => setTimeout(r, 3000))`);
  if (v === 'full' || process.env.NAT) {
    const nat = await b.evaluate(`new Promise(r => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 181) requestAnimationFrame(f); else { const d = ts.slice(1).map((t,i)=>t-ts[i]).sort((a,b)=>a-b); r({ fps: +(1000/(d.reduce((a,b)=>a+b)/d.length)).toFixed(1), p50: d[90], p95: d[171] }); } }; requestAnimationFrame(f); })`);
    console.log('natural rAF', v, JSON.stringify(nat));
  }
  await b.evaluate(`(() => { window.requestAnimationFrame = (cb) => 0; })()`);
  await b.evaluate(`new Promise(r => setTimeout(r, 300))`);
  const res = await b.evaluate(`(async () => {
    const g = __game; const r = g.renderer; const gl = r.getContext(); const px = new Uint8Array(4);
    ${v.split('+').map(k => setup[k]).join('\n')}
    const sync = () => { const p = r.getRenderTarget(); r.setRenderTarget(null); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); r.setRenderTarget(p); };
    const acc = {}; const add = (k, t) => acc[k] = (acc[k] || 0) + t;
    const wrap = (obj, name, key) => { const f = obj[name]; obj[name] = function(...a) { sync(); const t = performance.now(); const out = f.apply(this, a); sync(); add(key, performance.now() - t); return out; }; };
    if (g.clouds) wrap(g.clouds, 'render', 'clouds');
    const sm = r.shadowMap; wrap(sm, 'render', 'shadow');
    const P = g.pipeline;
    P.ink.quad.render = ((f) => function(x){ sync(); const t = performance.now(); f.call(this, x); sync(); add('ink', performance.now()-t); })(P.ink.quad.render);
    P.grade.quad.render = ((f) => function(x){ sync(); const t = performance.now(); f.call(this, x); sync(); add('grade', performance.now()-t); })(P.grade.quad.render);
    P.fxaa.quad.render = ((f) => function(x){ sync(); const t = performance.now(); f.call(this, x); sync(); add('fxaa', performance.now()-t); })(P.fxaa.quad.render);
    wrap(P, 'render', 'pipelineTotal');
    for (let i = 0; i < 15; i++) { g.step(1/60); sync(); }
    for (const k in acc) delete acc[k];
    const N = 40; let tot = 0; const info = [];
    for (let i = 0; i < N; i++) {
      sync(); const t0 = performance.now(); g.step(1/60); sync(); tot += performance.now() - t0;
      if (i % 8 === 0) await new Promise(q => setTimeout(q, 0));
    }
    const o = { v: ${JSON.stringify(v)}, step: +(tot/N).toFixed(1), rt: [P.rtScene.width, P.rtScene.height] };
    for (const k in acc) o[k] = +(acc[k]/N).toFixed(1);
    o.sceneMinusShadow = +(o.pipelineTotal - (o.ink||0) - (o.grade||0) - (o.fxaa||0) - (o.shadow||0)).toFixed(1);
    o.cpuTick = +(o.step - o.pipelineTotal - (o.clouds||0)).toFixed(1);
    return o;
  })()`);
  console.log(JSON.stringify(res));
}
b.close();
