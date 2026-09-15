import { launch } from './cdp.mjs';
import fs from 'node:fs';
const src = fs.readFileSync('bench2.mjs', 'utf8');
const setup = eval('({' + src.slice(src.indexOf('const setup = {') + 15, src.indexOf('};\nfor (const v')) + '})');
setup.noPost = `g.pipeline.enabled.ink = false; g.pipeline.enabled.fxaa = false;`;
setup.hideAll = `g.scene.children.forEach(o => { if (!o.isLight) o.visible = false; }); g.clouds.render = () => {};`;
setup.noGround = `const hg = () => { for (const c of g.chunks.live.values()) c.mesh.visible = false; }; const u = g.chunks.update.bind(g.chunks); g.chunks.update = (...a) => { u(...a); hg(); };`;
setup.noRender = `g.pipeline.render = () => {}; g.clouds.render = () => {};`;
setup.s075 = `g.pipeline.maxScale = 0.75; dispatchEvent(new Event('resize'));`;
setup.s060 = `g.pipeline.maxScale = 0.6; dispatchEvent(new Event('resize'));`;
setup.aniso1 = `Object.values(g.chunks.material.userData.uniforms).forEach(u => { if (u.value && u.value.isTexture) { u.value.anisotropy = 1; u.value.needsUpdate = true; } });`;
setup.shOff = `g.renderer.shadowMap.autoUpdate = false;`;
setup.shHalf = `{ const sm = g.renderer.shadowMap; sm.autoUpdate = false; let n = 0; const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { sm.needsUpdate = (n++ % 2) === 0; f(); }; }`;
const base = process.env.BASE || 'http://127.0.0.1:5178/';
const variants = (process.env.VARIANTS || 'full').split(',');
const b = await launch();
for (const v of variants) {
  await b.send('Page.navigate', { url: `${base}?auto=full&fresh&seed=country&sound=0&t=10:00${process.env.QS || ''}` });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
  await b.evaluate(`(() => { const g = __game; ${v.split('+').map(k => setup[k] ?? '').join('\n')} })()`);
  await b.evaluate(`new Promise(r => setTimeout(r, 4000))`);
  const nat = await b.evaluate(`new Promise(r => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 241) requestAnimationFrame(f); else { const d = ts.slice(1).map((t,i)=>t-ts[i]).sort((a,b)=>a-b); r({ fps: +(1000/(d.reduce((a,b)=>a+b)/d.length)).toFixed(1), p50: +d[120].toFixed(1), p95: +d[228].toFixed(1) }); } }; requestAnimationFrame(f); })`);
  console.log(v.padEnd(50), JSON.stringify(nat));
}
b.close();
