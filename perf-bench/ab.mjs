// A/B: GPU-synced pass costs and a pixel diff of the same frame, on two servers.
import { launch } from './cdp.mjs';
import fs from 'node:fs';
const QS = process.env.QS || '';
const PORTS = (process.env.PORTS || '5180,5178').split(',');
const b = await launch();
const shots = {};
for (const port of PORTS) {
  await b.send('Page.navigate', { url: `http://127.0.0.1:${port}/?rec&fresh&seed=country&sound=0&t=${process.env.T || "10:00"}&dynres=0${QS}` });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? r() : setTimeout(f, 100); f(); })`);
  await b.evaluate(`new Promise(r => setTimeout(r, 2500))`);
  const out = await b.evaluate(`(async () => {
    const g = __game, r = g.renderer, gl = r.getContext(), px = new Uint8Array(4), P = g.pipeline;
    const sync = () => { const p = r.getRenderTarget(); r.setRenderTarget(null); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); r.setRenderTarget(p); };
    g.jumpTo(${process.env.AT || 900}, 40);
    ${process.env.SETUP || ''}
    g.step(0); sync();
    const cm = [...g.chunks.live.values()].map(c => c.mesh);
    const scene = () => { r.setRenderTarget(P.rtScene); r.clear(); r.render(g.scene, g.camera); };
    const med = (f, n = 12) => { f(); sync(); f(); sync(); const ts = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); sync(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return +ts[n >> 1].toFixed(1); };
    r.shadowMap.autoUpdate = false;
    const o = { tier: g.quality.tier };
    o.scene = med(scene);
    const hid = []; g.scene.traverse(x => { if ((x.isMesh || x.isPoints || x.isLine) && !cm.includes(x) && x.visible) hid.push(x); });
    hid.forEach(x => x.visible = false); o.groundOnly = med(scene); hid.forEach(x => x.visible = true);
    r.shadowMap.autoUpdate = true; r.shadowMap.needsUpdate = true;
    o.draw = med(() => { r.shadowMap.needsUpdate = true; P.render(); });
    // the frame, pixels: grade output (rtB) is 8-bit
    P.render(); sync();
    const W = P.rtB.width, H = P.rtB.height, buf = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(P.rtB, 0, 0, W, H, buf);
    o.W = W; o.H = H;
    let s = ''; for (let i = 0; i < buf.length; i += 4) s += String.fromCharCode(buf[i], buf[i+1], buf[i+2]);
    o.px = btoa(s);
    o.png = g.grab();
    return o;
  })()`);
  shots[port] = Buffer.from(out.px, 'base64');
  fs.writeFileSync(`shot_${port}.png`, Buffer.from(out.png.split(',')[1], 'base64'));
  delete out.px; delete out.png;
  console.log(port, JSON.stringify(out));
}
if (PORTS.length === 2) {
  const [a, c] = PORTS.map(p => shots[p]);
  let n = 0, big = 0, max = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - c[i]); if (d) n++; if (d > 4) big++; if (d > max) max = d; }
  console.log('diff channels: any', n, '>4', big, 'max', max, 'of', a.length);
  const W = +process.env.W || 2849, H = a.length / 3 / W;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((H - 1 - y) * W + x) * 3, o = (y * W + x) * 4;
    const d = Math.max(Math.abs(a[i]-c[i]), Math.abs(a[i+1]-c[i+1]), Math.abs(a[i+2]-c[i+2]));
    const g = (a[i] + a[i+1] + a[i+2]) / 6;
    rgba[o] = d > 2 ? 255 : g; rgba[o+1] = d > 2 ? Math.max(0, 255 - d * 4) : g; rgba[o+2] = d > 2 ? 0 : g; rgba[o+3] = 255;
  }
  const url = await b.evaluate(`(() => { const W = ${W}, H = ${H}; const s = atob('${rgba.toString('base64')}'); const u = new Uint8ClampedArray(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(new ImageData(u, W, H), 0, 0); const d = document.createElement('canvas'); d.width = W >> 1; d.height = H >> 1; d.getContext('2d').drawImage(c, 0, 0, d.width, d.height); return d.toDataURL('image/png'); })()`);
  fs.writeFileSync('diff.png', Buffer.from(url.split(',')[1], 'base64'));
}
b.close();
