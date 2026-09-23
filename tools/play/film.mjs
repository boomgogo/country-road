#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * A continuous film of one drive.  `prompt_4.md` item 2: "one entire
 * drive continuously of 2 game-days, without cut in the middle".
 *
 *     npx vite --port 5178
 *     node tools/play/film.mjs --survey country,hills,coast,...   # pick a seed
 *     node tools/play/film.mjs --seed hills --hours 48 --out /media/DRIVE2/country-road/two-days
 *
 * Two game-days is 2 880 s of game at one game second per real second:
 * 48 minutes of film, 86 400 frames at 30 fps.  Every frame is *stepped*
 * -- `__game.step(1/30)` -- so the film is the same film however long the
 * machine takes over it, and nothing is dropped.
 *
 * The frames never leave the GPU process as pixels.  Each one goes from
 * the canvas into a `VideoFrame` and into an H.264 `VideoEncoder` in the
 * page, and only the encoded bytes -- tens of kilobytes a frame -- cross
 * to Node over CDP, where `mp4-muxer` writes them straight into the file.
 * There is no ffmpeg on the machine this was made on, and this way none
 * is needed.  Every eighth frame is also handed to a second encoder, so
 * the 8x time-lapse is made in the same pass, from the same frames, and
 * is just as continuous.
 *
 * Also written: `log.jsonl`, `lib.mjs`'s state every ten seconds of film;
 * `stills/`, one PNG a game-hour -- a minute of film -- for the contact
 * sheet; `README.md`.
 *
 * The drive is the autopilot and nothing else, in the chase camera
 * throughout -- a change of camera is a cut in everything but name.
 * `lib.mjs`'s `Watch` runs over it all the same, and the README says
 * what, if anything, it saw.
 *
 * Flags:
 *   --seed s         default `country`
 *   --hours n        game-hours, default 48
 *   --out dir        default /media/DRIVE2/country-road/two-days
 *   --size WxH       default 1920x1080
 *   --bitrate n      master, bits/s, default 16e6
 *   --lapse n        time-lapse factor, default 8
 *   --survey a,b,c   print each seed's first 48 hours of weather and stop
 *   --port n         dev server, default 5178
 *   --cdp n          Chrome's debugging port, default 9334 -- not the
 *                    probes' 9333, so the probes can run meanwhile
 * ------------------------------------------------------------------ */
import { openSync, writeSync, closeSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Muxer, StreamTarget } from 'mp4-muxer';
import { openGame, Watch } from './lib.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const SEED = String(arg('seed', 'country'));
const HOURS = Number(arg('hours', 48));
const OUT = String(arg('out', '/media/DRIVE2/country-road/two-days'));
const [W, H] = String(arg('size', '1920x1080')).split('x').map(Number);
const BITRATE = Number(arg('bitrate', 16e6));
const LAPSE = Number(arg('lapse', 8));
const PORT = Number(arg('port', 5178));
const CDP = Number(arg('cdp', 9334));
const SURVEY = arg('survey', '');

const FPS = 30;
const PROFILE = `${process.cwd()}/chrome-prof-film`;

/* ------------------------------- survey --------------------------------- */

if (SURVEY) {
  for (const seed of String(SURVEY).split(',')) {
    const g = await openGame({ clock: 'stepped', seed, port: PORT, cdpPort: CDP, profile: PROFILE,
                               w: 640, h: 360, headless: true });
    const f = await g.c.evaluate('__game.weather.forecast(__game.clock, 48).map((h) => h.state)');
    g.close();
    const runs = [];
    for (const s of f) {
      if (runs.length && runs[runs.length - 1][0] === s) runs[runs.length - 1][1]++;
      else runs.push([s, 1]);
    }
    const kinds = new Set(f);
    console.log(`${seed.padEnd(12)} ${kinds.size} kinds  ${runs.map(([s, n]) => `${s}x${n}`).join(' ')}`);
  }
  process.exit(0);
}

/* -------------------------------- film ---------------------------------- */

mkdirSync(join(OUT, 'stills'), { recursive: true });
const LOG = join(OUT, 'log.jsonl');
writeFileSync(LOG, '');

function mp4(path) {
  const fd = openSync(path, 'w');
  const muxer = new Muxer({
    target: new StreamTarget({
      onData: (data, position) => { writeSync(fd, data, 0, data.length, position); },
    }),
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    /* Not fast-start: that holds every chunk in memory until the end so
     * the index can go first, and 48 minutes of 1080p does not fit. */
    fastStart: false,
    firstTimestampBehavior: 'offset',
  });
  return { muxer, fd, path, chunks: 0 };
}

const master = mp4(join(OUT, `two-days-${W}x${H}p${FPS}.mp4`));
const lapse = mp4(join(OUT, `two-days-timelapse-${LAPSE}x.mp4`));

const g = await openGame({
  clock: 'stepped', seed: SEED, port: PORT, cdpPort: CDP, profile: PROFILE,
  w: W, h: H, query: 'dynres=0', headless: true,
});
const gpu = await g.c.evaluate('__game.quality.gpu');
console.log(`film: ${SEED}, ${HOURS} game-hours, ${W}x${H}, on ${gpu}`);

/* The encoders, in the page.  `take()` hands over what they have made so
 * far; `frames(n)` steps and encodes n frames.  Keyframes every five
 * seconds of film, so the file can be scrubbed. */
await g.c.evaluate(`(async () => {
  const cfg = (bitrate) => ({
    codec: 'avc1.640028', width: ${W}, height: ${H}, bitrate, framerate: ${FPS},
    avc: { format: 'avc' }, latencyMode: 'quality',
  });
  const ok = await VideoEncoder.isConfigSupported(cfg(${BITRATE}));
  if (!ok.supported) throw new Error('H.264 encoding is not supported here');
  const f = window.__film = { out: [], err: null, n: 0, black: 0 };
  const b64 = (u8) => u8.toBase64();
  const view = (d) => d instanceof ArrayBuffer ? new Uint8Array(d)
    : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  const make = (e, bitrate) => {
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const rec = { e, type: chunk.type, ts: chunk.timestamp, dur: chunk.duration, data: b64(data) };
        const dc = meta && meta.decoderConfig;
        if (dc) rec.meta = { codec: dc.codec, codedWidth: dc.codedWidth, codedHeight: dc.codedHeight,
                             description: dc.description ? b64(view(dc.description)) : null,
                             colorSpace: dc.colorSpace ? dc.colorSpace.toJSON?.() ?? dc.colorSpace : undefined };
        f.out.push(rec);
      },
      error: (x) => { f.err = String(x); },
    });
    enc.configure(cfg(bitrate));
    return enc;
  };
  f.enc = [make(0, ${BITRATE}), make(1, ${BITRATE})];
  const gl = __game.renderer.getContext();
  const px = new Uint8Array(4);
  const cv = __game.renderer.domElement;
  const lit = () => {
    const w = cv.width, h = cv.height;
    for (const [x, y] of [[w >> 2, h >> 2], [w - (w >> 2), h >> 2], [w >> 2, h - (h >> 2)], [w - (w >> 2), h - (h >> 2)]]) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (px[0] || px[1] || px[2]) return true;
    }
    return false;
  };
  const room = async (enc) => {
    while (enc.encodeQueueSize > 6) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
  };
  const us = 1e6 / ${FPS};
  f.frames = async (n) => {
    for (let k = 0; k < n; k++) {
      __game.step(1 / 30);
      /* grab()'s check: about one frame in a few thousand comes back from
       * a cleared buffer.  grab() redraws until it is not; the PNG it
       * makes is thrown away. */
      if (!lit()) { f.black++; __game.grab(); }
      const i = f.n++;
      const frame = new VideoFrame(cv, { timestamp: Math.round(i * us), duration: Math.round(us) });
      await room(f.enc[0]);
      f.enc[0].encode(frame, { keyFrame: i % (${FPS} * 5) === 0 });
      if (i % ${LAPSE} === 0) {
        const j = i / ${LAPSE};
        const lf = new VideoFrame(frame, { timestamp: Math.round(j * us), duration: Math.round(us) });
        await room(f.enc[1]);
        f.enc[1].encode(lf, { keyFrame: j % (${FPS} * 5) === 0 });
        lf.close();
      }
      frame.close();
    }
  };
  f.take = () => { const o = f.out; f.out = []; return o; };
  f.flush = async () => { await f.enc[0].flush(); await f.enc[1].flush(); };
})()`);

function feed(recs) {
  for (const r of recs) {
    const m = r.e === 0 ? master : lapse;
    const meta = r.meta ? { decoderConfig: {
      codec: r.meta.codec, codedWidth: r.meta.codedWidth, codedHeight: r.meta.codedHeight,
      description: r.meta.description ? Buffer.from(r.meta.description, 'base64') : undefined,
      colorSpace: r.meta.colorSpace,
    } } : undefined;
    m.muxer.addVideoChunkRaw(Buffer.from(r.data, 'base64'), r.type, r.ts, r.dur, meta);
    m.chunks++;
  }
}

await g.autodrive('full');
const total = HOURS * 60 * FPS;
const BATCH = FPS;
const watch = new Watch();
const t0 = Date.now();
let last = null;
for (let i = 0; i < total; i += BATCH) {
  await g.c.evaluate(`__film.frames(${Math.min(BATCH, total - i)})`, 3600000);
  const err = await g.c.evaluate('__film.err');
  if (err) throw new Error('encoder: ' + err);
  feed(await g.c.evaluate('__film.take()'));
  const done = i + BATCH;
  /* Ten seconds of film is ten game-minutes. */
  if (done % (10 * FPS) === 0) {
    const st = await g.state();
    const fails = watch.check(st, 10, g.errors);
    for (const f of fails) console.log(`  ! ${st.clock} ${st.km} km: ${f}`);
    appendFileSync(LOG, JSON.stringify({ frame: done, ...st }) + '\n');
    if (done % (60 * FPS) === 0) {                      // a game-hour
      /* The frame the encoder just took, read off the preserved buffer:
       * no redraw, so no difference from the film. */
      const u = await g.c.evaluate('__game.renderer.domElement.toDataURL("image/png")');
      writeFileSync(join(OUT, 'stills', `${String(done).padStart(6, '0')} day ${st.day} ${st.clock.replace(':', '')}.png`),
                    Buffer.from(String(u).split(',')[1], 'base64'));
    }
    const wall = (Date.now() - t0) / 1000;
    const rate = done / wall;
    if (done % (3 * 60 * FPS) === 0) {                   // every three game-hours
      console.log(`  ${st.clock} day ${st.day} ${st.weather.padEnd(14)} ${String(st.km).padStart(7)} km  `
        + `frame ${done}/${total}  ${rate.toFixed(1)} fps  eta ${((total - done) / rate / 60).toFixed(0)} min  `
        + `heap ${st.heapMB} MB  geo ${st.geometries}  live ${st.live}`);
    }
    last = st;
  }
}
await g.c.evaluate('__film.flush()', 600000);
feed(await g.c.evaluate('__film.take()'));
const black = await g.c.evaluate('__film.black');
g.close();
for (const m of [master, lapse]) { m.muxer.finalize(); closeSync(m.fd); }

const wall = (Date.now() - t0) / 1000;
const size = (p) => (statSync(p).size / 1e9).toFixed(2) + ' GB';
let sheet = '';
try {
  execSync(`python3 ${JSON.stringify(new URL('./sheet.py', import.meta.url).pathname)} ${JSON.stringify(join(OUT, 'stills'))} ${JSON.stringify(join(OUT, 'contact-sheet.png'))}`);
  sheet = 'contact-sheet.png';
} catch (e) { sheet = `(not made: ${String(e.message).split('\n')[0]})`; }
const commit = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return '?'; } })();
const dirty = (() => { try { return execSync('git status --porcelain src').toString().trim() ? ' + uncommitted changes' : ''; } catch { return ''; } })();

writeFileSync(join(OUT, 'README.md'), `# Two game-days, one take

\`prompt_4.md\` item 2.  Made by \`tools/play/film.mjs\`.

| | |
|---|---|
| seed | \`${SEED}\` |
| game time | day 1 08:00 to day ${1 + Math.floor(HOURS / 24)} 08:00 -- ${HOURS} game-hours |
| drive | ${last ? last.km : '?'} km, full autodrive, chase camera throughout |
| film | ${W}x${H}, ${FPS} fps, ${(total / FPS / 60).toFixed(1)} min, H.264 at ${(BITRATE / 1e6).toFixed(0)} Mbit/s |
| time-lapse | every ${LAPSE}th frame of the same take, ${(total / LAPSE / FPS / 60).toFixed(1)} min |
| rendered on | ${gpu} |
| render time | ${(wall / 3600).toFixed(2)} h, ${(total / wall).toFixed(1)} frames/s |
| cleared frames redrawn | ${black} |
| code | ${commit}${dirty} |

Files:

- \`${master.path.split('/').pop()}\` (${size(master.path)}) -- the whole drive, every frame
- \`${lapse.path.split('/').pop()}\` (${size(lapse.path)}) -- the same drive at ${LAPSE}x
- \`log.jsonl\` -- the car, the clock, the weather and the world's bookkeeping, every ten game-minutes
- \`stills/\` -- one frame a game-hour; ${sheet}

**One take.**  Every frame from the first to the last was stepped and
encoded in a single run; nothing was cut, joined or re-timed.  The
time-lapse is frame selection from that same run.

**No sound.**  The engine is an AudioWorklet that runs on the real-time
clock, and a stepped film has no real time for it to run on.

**What the watch saw** (off the road under the autopilot, stuck, fallen,
no ground, page exceptions):

${watch.failures.length ? watch.failures.map((f) => `- ${f.clock}, ${f.km} km: ${f.what}`).join('\n') : '- nothing'}
`);
console.log(`done in ${(wall / 3600).toFixed(2)} h: ${master.path} (${size(master.path)}), ${lapse.path} (${size(lapse.path)})`);
console.log(watch.failures.length ? `${watch.failures.length} watch failures -- see README` : 'watch: clean');
