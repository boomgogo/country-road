import { launch } from './cdp.mjs';
const b = await launch();
const url = `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00${process.env.QS || ''}`;
await b.send('Page.navigate', { url });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
await b.evaluate(`new Promise(r => setTimeout(r, 3000))`);
await b.evaluate(`(() => { window.requestAnimationFrame = (cb) => 0; })()`);
await b.evaluate(`new Promise(r => setTimeout(r, 300))`);
const out = await b.evaluate(`(async () => {
  const g = __game; const r = g.renderer; const gl = r.getContext(); const px = new Uint8Array(4); const P = g.pipeline;
  const sync = () => { const p = r.getRenderTarget(); r.setRenderTarget(null); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); r.setRenderTarget(p); };
  // group objects
  const groups = new Map();
  g.scene.traverse(o => {
    if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
    const mat = [].concat(o.material)[0];
    const k = (o.isInstancedMesh ? 'inst:' : '') + (o.name || '') + '|' + (mat.type) + '|' + (mat.customProgramCacheKey ? String(mat.customProgramCacheKey()).slice(0,30) : '') + (mat.alphaTest ? '|aT' : '') + (mat.transparent ? '|tr' : '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  });
  r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
  g.clouds.render = () => {};
  const timeScene = (n = 12) => { let tot = 0; for (let i = 0; i < n; i++) { sync(); const t = performance.now(); r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); sync(); tot += performance.now() - t; } return tot / n; };
  r.info.autoReset = false;
  timeScene(5);
  r.info.reset(); r.setRenderTarget(P.rtScene); r.render(g.scene, g.camera);
  const totalInfo = { calls: r.info.render.calls, tris: r.info.render.triangles };
  const base = timeScene();
  const res = [];
  for (const [k, objs] of groups) {
    const vis = objs.filter(o => o.visible);
    if (!vis.length) continue;
    let tris = 0; for (const o of vis) { const gg = o.geometry; const n = gg.index ? gg.index.count : gg.attributes.position.count; tris += (n/3) * (o.isInstancedMesh ? o.count : 1); }
    vis.forEach(o => o.visible = false);
    const t = timeScene();
    vis.forEach(o => o.visible = true);
    res.push({ k, n: vis.length, trisK: Math.round(tris/1000), saveMs: +(base - t).toFixed(1) });
  }
  res.sort((a,b) => b.saveMs - a.saveMs);
  // also shadow pass alone
  r.shadowMap.autoUpdate = true;
  let st = 0; for (let i = 0; i < 8; i++) { sync(); const t = performance.now(); r.shadowMap.needsUpdate = true; r.setRenderTarget(P.rtScene); r.render(g.scene, g.camera); sync(); st += performance.now() - t; }
  return { base: +base.toFixed(1), withShadowUpdate: +(st/8).toFixed(1), totalInfo, rt: [P.rtScene.width, P.rtScene.height], res };
})()`);
console.log(JSON.stringify(out, null, 1));
b.close();
