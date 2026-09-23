import { launch } from './cdp.mjs';
const b = await launch();
await b.send('Page.navigate', { url: `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00` });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
await b.evaluate(`new Promise(r => setTimeout(r, 3000))`);
await b.evaluate(`(() => { window.requestAnimationFrame = (cb) => 0; })()`);
await b.evaluate(`new Promise(r => setTimeout(r, 300))`);
const out = await b.evaluate(`(async () => {
  const g = __game; const r = g.renderer; const gl = r.getContext(); const px = new Uint8Array(4); const P = g.pipeline;
  const sync = () => { const p = r.getRenderTarget(); r.setRenderTarget(null); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); r.setRenderTarget(p); };
  r.shadowMap.autoUpdate = false;
  Object.values(g.chunks.material.userData.uniforms).forEach(u => { if (u.value && u.value.isTexture) { u.value.anisotropy = 1; u.value.needsUpdate = true; } });
  const timeScene = (n = 10) => { let tot = 0; for (let i = 0; i < n; i++) { sync(); const t = performance.now(); r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); sync(); tot += performance.now() - t; } return +(tot / n).toFixed(1); };
  const o = {};
  const live = [...g.chunks.live.values()];
  const tris = {}; const cnt = {};
  for (const c of live) { const n = c.mesh.geometry.index.count / 3; tris[c.step] = (tris[c.step]||0) + n; cnt[c.step] = (cnt[c.step]||0)+1; }
  o.cnt = cnt; o.trisK = Object.fromEntries(Object.entries(tris).map(([k,v]) => [k, Math.round(v/1000)]));
  // visible in camera frustum
  r.info.autoReset = false;
  const w = P.rtScene.width, h = P.rtScene.height;
  for (const [label, W] of [['native', w], ['tiny', Math.round(w/10)]]) {
    P.rtScene.setSize(W, Math.round(W*h/w)); timeScene(3);
    o[label] = { all: timeScene() };
    for (const st of [1, 2, 4, 8, 16]) {
      const hid = live.filter(c => c.step === st); hid.forEach(c => c.mesh.visible = false);
      r.info.reset(); r.render(g.scene, g.camera); const tr = r.info.render.triangles;
      o[label]['hide' + st] = [timeScene(), Math.round(tr/1000)];
      hid.forEach(c => c.mesh.visible = true);
    }
    live.forEach(c => c.mesh.visible = false); o[label].noGround = timeScene(); live.forEach(c => c.mesh.visible = true);
  }
  P.rtScene.setSize(w, h);
  r.info.reset(); r.render(g.scene, g.camera); o.visTrisK = Math.round(r.info.render.triangles/1000);
  return o;
})()`);
console.log(JSON.stringify(out, null, 1));
b.close();
