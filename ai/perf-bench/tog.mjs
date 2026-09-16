// Uncapped-throughput fps with in-page toggles.  PORT, QS, VARIANTS=a+b,c
import { launch } from './cdp.mjs';
const setup = {
  base: '',
  noClouds: `g.clouds.render = () => {}; g.clouds.composite.visible = false;`,
  noCloudMarch: `g.clouds.render = () => {};`,
  shOff: `g.renderer.shadowMap.autoUpdate = false;`,
  noShadowAtAll: `g.renderer.shadowMap.enabled = false; g.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); });`,
  noPost: `g.pipeline.enabled.ink = false; g.pipeline.enabled.fxaa = false;`,
  noInk: `g.pipeline.enabled.ink = false;`,
  noFxaa: `g.pipeline.enabled.fxaa = false;`,
  noGround: `const hg = () => { for (const c of g.chunks.live.values()) c.mesh.visible = false; }; const u = g.chunks.update.bind(g.chunks); g.chunks.update = (...a) => { u(...a); hg(); };`,
  noScatter: `g.scatter && g.scene.children.forEach(o => {}); { const S = new Set(); const walk = (o) => { S.add(o); o.children.forEach(walk); }; } { const u = g.scatter.update.bind(g.scatter); g.scatter.update = (...a) => { u(...a); for (const o of (g.scatter.group ? [g.scatter.group] : [])) o.visible = false; }; }`,
  hideAllButGround: `{ const cm = () => new Set([...g.chunks.live.values()].map(c => c.mesh)); const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { const s = cm(); const hid = []; g.scene.traverse(o => { if ((o.isMesh||o.isPoints||o.isLine) && o.visible && !s.has(o)) { hid.push(o); o.visible = false; } }); f(); hid.forEach(o => o.visible = true); }; }`,
  gConst: `__variant([['diffuseColor.rgb *= col;', 'diffuseColor.rgb *= vec3(0.4,0.6,0.3);']]);`,
  gNoCloudShadow: `__variant([['float cloudShade = cloudShadow( wPosCloud );', 'float cloudShade = 1.0;']]);`,
  gNoFade: `__variant([['float f0 = texture2D( tFade, uvNear ).r;', 'float f0 = 0.5;'], ['float f1 = texture2D( tFade, uvMid ).r;', 'float f1 = 0.5;'], ['float f2 = texture2D( tFade, uvFar ).r;', 'float f2 = 0.5;']]);`,
  gSingleDetile: `__variant([['textureGrad( t, b, g.xy * BREAK_RATIO, g.zw * BREAK_RATIO ).rgb', 'textureGrad( t, a, g.xy, g.zw ).rgb']]);`,
  gNoRecv: `{ const u = g.chunks.update.bind(g.chunks); g.chunks.update = (...a) => { u(...a); for (const c of g.chunks.live.values()) if (c.mesh.receiveShadow) { c.mesh.receiveShadow = false; } }; g.chunks.material.needsUpdate = true; }`,
  gNoCast: `{ const u = g.chunks.update.bind(g.chunks); g.chunks.update = (...a) => { u(...a); for (const c of g.chunks.live.values()) c.mesh.castShadow = false; }; }`,
  gFlat: `{ const SM = g.pipeline.ink.mat.constructor; const flat = new SM({ vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }', fragmentShader: 'void main(){ gl_FragColor = vec4(0.3,0.5,0.2,1.0); }' }); const u = g.chunks.update.bind(g.chunks); g.chunks.update = (...a) => { u(...a); for (const c of g.chunks.live.values()) c.mesh.material = flat; }; }`,
  lod2: `g.chunks.farLod = [{ within: 80, step: 1 }, { within: 460, step: 2 }, { within: Infinity, step: 4 }]; g.chunks.update(g.car.pos.x, g.car.pos.z, 1, 0, 0); g.chunks.flush();`,
  lod4: `g.chunks.farLod = [{ within: 80, step: 1 }, { within: 200, step: 2 }, { within: Infinity, step: 4 }]; g.chunks.update(g.car.pos.x, g.car.pos.z, 1, 0, 0); g.chunks.flush();`,
  gImplicit: `__variant([['textureGrad( t, a, g.xy, g.zw ).rgb', 'texture( t, a ).rgb'], ['textureGrad( t, b, g.xy * BREAK_RATIO, g.zw * BREAK_RATIO ).rgb', 'texture( t, b ).rgb']]);`,
  gGrassOnly1: `__variant([['vec3 parched = dry > 0.0', 'vec3 parched = false'], ['textureGrad( t, b, g.xy * BREAK_RATIO, g.zw * BREAK_RATIO ).rgb', 'textureGrad( t, a, g.xy, g.zw ).rgb']]);`,
  gNoRoad: `__variant([['if ( edge > 0.0 ) {', 'if ( false ) {']]);`,
  gNoGreen: `__variant([['if ( !hideGreen ) {', 'if ( false ) {']]);`,
  noCastTrees: `{ const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { g.scene.traverse(o => { if (o.isInstancedMesh) o.castShadow = false; }); f(); }; }`,
  noCastCar: `{ const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { g.scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh && !(o.material && o.material.customProgramCacheKey && String(o.material.customProgramCacheKey()).includes('ground'))) o.castShadow = false; }); f(); }; }`,
  noCastAll: `{ const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { g.scene.traverse(o => { o.castShadow = false; }); f(); }; }`,
  sh1024: `{ const L = g.scene.children.find(o => o.isDirectionalLight && o.castShadow); L.shadow.mapSize.set(1024, 1024); L.shadow.map && L.shadow.map.dispose(); L.shadow.map = null; }`,
  shBasic: `g.renderer.shadowMap.type = 0; g.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); });`,
  noCasters: `{ const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { g.scene.traverse(o => { if (!o.isLight) o.castShadow = false; }); f(); }; }`,
  shHalf: `{ const sm = g.renderer.shadowMap; sm.autoUpdate = false; let n = 0; const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { sm.needsUpdate = (n++ % 2) === 0; f(); }; }`,
  s060: `g.pipeline.maxScale = 0.6; dispatchEvent(new Event('resize'));`,
  s040: `g.pipeline.maxScale = 0.4; dispatchEvent(new Event('resize'));`,
  noBuild: `g.chunks.budgetMs = 0;`,
  occFirst: `{ const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { g.scene.traverse(o => { if (o.isMesh && o.castShadow && !(o.material && o.material === g.chunks.material)) o.renderOrder = -1; }); f(); }; }`,
  carFirst: `{ const f = g.pipeline.render.bind(g.pipeline); g.pipeline.render = () => { g.scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.castShadow && !(o.material && o.material === g.chunks.material)) o.renderOrder = -1; }); f(); }; }`,
  domeLast: `{ const d = g.sky.dome; d.renderOrder = 1000; d.material.vertexShader = d.material.vertexShader.replace('gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );', 'gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); gl_Position.z = gl_Position.w;'); d.material.needsUpdate = true; }`,
  lampsAlways: `{ const u = g.headlights.update.bind(g.headlights); g.headlights.update = (...a) => { u(...a); for (const l of g.headlights.lamps) l.light.visible = true; }; }`,
  noRender: `g.pipeline.render = () => {}; g.clouds.render = () => {};`,
  noTick: `{ const s = g.step; }`,
  aniso1: `Object.values(g.chunks.material.userData.uniforms).forEach(u => { if (u.value && u.value.isTexture) { u.value.anisotropy = 1; u.value.needsUpdate = true; } });`,
  s075: `g.pipeline.maxScale = 0.75; dispatchEvent(new Event('resize'));`,
};
const PORT = process.env.PORT || 5178;
const b = await launch();
for (const v of (process.env.VARIANTS || 'base').split(',')) {
  await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?auto=full&fresh&seed=country&sound=0&t=10:00&dynres=0${process.env.QS || ''}` });
  await b.evaluate(`new Promise(r => { const f = () => window.__game ? __game.loaded.then(r) : setTimeout(f, 100); f(); })`);
  await b.evaluate(`(() => { const g = __game; const M = g.chunks.material, baseOBC = M.onBeforeCompile, baseKey = M.customProgramCacheKey; let vid = 0;
    window.__variant = (reps) => { const id = ++vid; const prev = M.onBeforeCompile; M.onBeforeCompile = (s, rr) => { prev(s, rr); for (const [a, b] of reps) { if (!s.fragmentShader.includes(a)) console.error('MISSING ' + a); s.fragmentShader = s.fragmentShader.split(a).join(b); } }; const pk = M.customProgramCacheKey; M.customProgramCacheKey = () => pk() + '_v' + id; M.needsUpdate = true; };
    ${v.split('+').map(k => { if (!(k in setup)) throw new Error('no ' + k); return setup[k]; }).join('\n')} })()`);
  await b.evaluate(`new Promise(r => setTimeout(r, 4000))`);
  const nat = await b.evaluate(`new Promise(r => { const t0 = performance.now(); let n = 0; const f = () => { n++; if (performance.now() - t0 < ${process.env.MS || 8000}) requestAnimationFrame(f); else r({ fps: +(n * 1000 / (performance.now() - t0)).toFixed(1) }); }; requestAnimationFrame(f); })`);
  console.log(v.padEnd(40), JSON.stringify(nat));
}
b.close();
