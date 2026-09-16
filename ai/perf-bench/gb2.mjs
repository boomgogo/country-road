import { launch } from './cdp.mjs';
const QS = process.env.QS || '';
const b = await launch();
await b.send('Page.navigate', { url: `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00&dynres=0${QS}` });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
await b.evaluate(`new Promise(r => setTimeout(r, 5000))`);
await b.evaluate(`(() => { window.requestAnimationFrame = () => 0; })()`);
await b.evaluate(`new Promise(r => setTimeout(r, 300))`);
const out = await b.evaluate(`(async () => {
  const g = __game, r = g.renderer, gl = r.getContext(), px = new Uint8Array(4), P = g.pipeline;
  const sync = () => { const p = r.getRenderTarget(); r.setRenderTarget(null); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); r.setRenderTarget(p); };
  for (let i = 0; i < 5; i++) { g.step(1/60); g.chunks.flush(); }
  g.step(1/60); sync();
  r.shadowMap.autoUpdate = false;
  const M = g.chunks.material;
  const chunksM = () => [...g.chunks.live.values()].map(c => c.mesh);
  const hidden = [];
  const cm = chunksM();
  g.scene.traverse(o => { if ((o.isMesh || o.isPoints || o.isLine) && !cm.includes(o) && o.visible) hidden.push(o); });
  const time = (label, n = 12) => {
    r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); sync();
    r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); sync();
    const ts = [];
    for (let i = 0; i < n; i++) { const t = performance.now(); r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); sync(); ts.push(performance.now() - t); }
    ts.sort((a,b)=>a-b); return [label, +ts[n>>1].toFixed(1)];
  };
  const baseOBC = M.onBeforeCompile, baseKey = M.customProgramCacheKey;
  let vid = 0;
  const variant = (reps) => {
    const id = ++vid;
    M.onBeforeCompile = (s, rr) => { baseOBC(s, rr); for (const [a, b] of reps) { if (!s.fragmentShader.includes(a)) console.log('MISSING', a); s.fragmentShader = s.fragmentShader.split(a).join(b); } };
    M.customProgramCacheKey = () => baseKey() + '_v' + id;
    M.needsUpdate = true;
  };
  const texs = Object.values(M.userData.uniforms).map(u => u.value).filter(v => v && v.isTexture);
  const aniso = (n) => texs.forEach(t => { t.anisotropy = n; t.needsUpdate = true; });
  const res = [];
  hidden.forEach(o => o.visible = false);
  res.push(time('ground only: base (aniso ' + texs[0].anisotropy + ')'));
  aniso(1); res.push(time('aniso 1')); aniso(${process.env.ANISO || 4});
  variant([['diffuseColor.rgb *= col;', 'diffuseColor.rgb *= vec3(0.4,0.6,0.3);']]);
  res.push(time('FRAG_BODY -> const'));
  variant([['return mix( texture2D( t, a ).rgb, texture2D( t, b ).rgb, 0.30 + 0.30 * k );', 'return texture2D( t, a ).rgb;']]);
  res.push(time('single-tap detile'));
  variant([['float cloudShade = cloudShadow( wPosCloud );', 'float cloudShade = 1.0;']]);
  res.push(time('no cloud shadow'));
  variant([['#include <lights_fragment_begin>', ''], ['#include <lights_fragment_maps>', ''], ['#include <lights_fragment_end>', '']]);
  res.push(time('no lighting (and no cloud shadow)'));
  variant([]);
  M.fog = false; M.needsUpdate = true; res.push(time('no fog')); M.fog = true; M.needsUpdate = true;
  chunksM().forEach(m => m.receiveShadow = false); M.needsUpdate = true; res.push(time('no shadow receive'));
  chunksM().forEach(m => m.receiveShadow = true); M.needsUpdate = true;
  res.push(time('base again'));
  // overshading: rebuild everything at >= 4 m
  const far = g.chunks.farLod;
  g.chunks.farLod = [{ within: Infinity, step: ${process.env.FORCE || 4} }];
  g.chunks.update(g.car.pos.x, g.car.pos.z, Math.cos(g.car.yaw), Math.sin(g.car.yaw), 0); g.chunks.flush();
  g.chunks.update(g.car.pos.x, g.car.pos.z, Math.cos(g.car.yaw), Math.sin(g.car.yaw), 0); g.chunks.flush();
  chunksM().forEach(m => m.visible = true);
  const st = {}; for (const c of g.chunks.live.values()) st[c.step] = (st[c.step]||0)+1;
  res.push(time('all chunks >= ${process.env.FORCE || 4} m ' + JSON.stringify(st)));
  variant([['diffuseColor.rgb *= col;', 'diffuseColor.rgb *= vec3(0.4,0.6,0.3);']]);
  res.push(time('  ... and FRAG_BODY const'));
  return res;
})()`);
for (const [k, v] of out) console.log(k.padEnd(50), v);
b.close();
