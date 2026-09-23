import { launch } from './cdp.mjs';
const b = await launch();
await b.send('Page.navigate', { url: `http://127.0.0.1:5178/?auto=full&fresh&seed=country&sound=0&t=10:00&dynres=0` });
await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
await b.evaluate(`new Promise(r => setTimeout(r, 5000))`);
const o = await b.evaluate(`(() => {
  const g = __game; const rows = {};
  g.scene.traverseVisible(o => {
    if (!(o.isMesh || o.isPoints || o.isLine)) return;
    const mat = [].concat(o.material)[0];
    const idx = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
    const inst = o.isInstancedMesh ? o.count : 1;
    let name = o.name || (o.parent && o.parent.name) || '';
    const k = (o.isInstancedMesh ? 'I:' : '') + mat.type + ':' + (mat.customProgramCacheKey ? String(mat.customProgramCacheKey()).slice(0, 30) : '') + ':' + name + (o.castShadow ? ' [cast]' : '') + (o.receiveShadow ? ' [recv]' : '') + (mat.transparent ? ' [T]' : '') + (mat.alphaTest ? ' [aT]' : '');
    const r = rows[k] || (rows[k] = { n: 0, tris: 0 });
    r.n++; r.tris += Math.round(idx / 3) * inst;
  });
  return Object.entries(rows).sort((a, b) => b[1].tris - a[1].tris);
})()`);
for (const [k, v] of o) console.log(String(v.n).padStart(5), String(v.tris).padStart(9), k);
b.close();
