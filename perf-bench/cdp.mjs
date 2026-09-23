import { spawn } from 'node:child_process';
const HEADLESS = process.env.HEADLESS === '1';
const port = 9333;
export async function launch({ w = 1920, h = 1080 } = {}) {
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${process.cwd()}/chrome-prof`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${w},${h}`, '--window-position=0,0',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
  if (HEADLESS) args.push('--headless=new', '--enable-gpu', '--use-angle=gl');
  if (process.env.CHROME_ARGS) args.push(...process.env.CHROME_ARGS.split(' '));
  const proc = spawn('google-chrome', [...args, 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (ver.find(t => t.type === 'page')) break; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  const page = ver.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else listeners.forEach(f => f(d)); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr, timeout = 600000) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  listeners.push(d => { if (d.method === 'Runtime.consoleAPICalled' && process.env.LOGS) console.log('[page]', d.params.args.map(a => a.value ?? a.description).join(' ')); if (d.method === 'Runtime.exceptionThrown') console.log('[exc]', JSON.stringify(d.params.exceptionDetails).slice(0, 500)); });
  return { send, evaluate, close: () => { ws.close(); proc.kill(); } };
}
