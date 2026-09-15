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
  r.shadowMap.autoUpdate = false;
  const W = +(${JSON.stringify(process.env.W || '0')}); if (W) { P.rtScene.setSize(W, Math.round(W * P.rtScene.height / P.rtScene.width)); }
  const timeScene = (n = 10) => { let tot = 0; for (let i = 0; i < n; i++) { sync(); const t = performance.now(); r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); sync(); tot += performance.now() - t; } return +(tot / n).toFixed(1); };
  const gm = g.chunks.material;
  const origOBC = gm.onBeforeCompile; const origKey = gm.customProgramCacheKey;
  let n = 0;
  const variant = (name, fn) => { gm.onBeforeCompile = (sh, rr) => { origOBC(sh, rr); fn(sh); }; const k = 'exp' + (++n); gm.customProgramCacheKey = () => origKey() + k; gm.needsUpdate = true; timeScene(3); const t = timeScene(); console.log(name, t); return t; };
  const o = { rt: [P.rtScene.width, P.rtScene.height] };
  o.base = timeScene(4), o.base = timeScene();

  const U = gm.userData.uniforms; const texes = Object.values(U).map(u => u.value).filter(v => v && v.isTexture);
  o.texInfo = texes.map(t => [t.image?.width, t.anisotropy, t.generateMipmaps, t.minFilter]);
  for (const A of [8, 4, 2, 1]) { texes.forEach(t => { t.anisotropy = A; t.needsUpdate = true; }); timeScene(3); o['aniso' + A] = timeScene(); console.log('aniso', A, o['aniso'+A]); }
  o.singleDetileAniso1 = variant('singleDetile', sh => { sh.fragmentShader = sh.fragmentShader.replace(/return mix\\( texture2D\\( t, a \\)\\.rgb, texture2D\\( t, b \\)\\.rgb, [^;]*;/, 'return texture2D( t, a ).rgb;'); });
  return o;
})()`);
console.log(JSON.stringify(out));
b.close();
