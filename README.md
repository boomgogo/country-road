# country-road

An endless road through open country, traced through a procedural landscape
and drawn as a cel-shaded picture. Built in Three.js, no engine.


```bash
npm install
npm run dev            # http://127.0.0.1:5178/?seed=country
npm run build && npx vite preview --port 5179


# deploy
npx wrangler login
npm run deploy
```

| key | |
|---|---|
| `W A S D` | drive — and taking the controls switches autodrive off |
| `SPACE` | handbrake |
| `T` | back onto the road, if you have ended up somewhere you cannot leave |
| `F` | autodrive — manual, full, auto steering, auto speed |
| `[` `]` | wind the clock — a tap is half a game-hour, holding keeps going |
| `Z` | rest until morning, or until the rain or snow is over |
| `C` | camera — chase, chase far, bonnet; the wheel moves the eye |
| `ESC` | quit to the load screen: continue, or a new drive |
| `M` | sound on or off — remembered between visits |
| `H` | hide the HUD |
| `O` / `G` | toggle the ink pass / the colour grade |
| `R` | a new seed |
| `N` | on the load screen, with a saved drive: start a fresh one |

Everything in that table is on the phone's `☰` panel too, except `O`, `G`
and `R` — the two render toggles and the reseed, all three of which the load
screen or a query string already reaches.

Mouse: drag to look around, scroll to change the camera distance.

## On a phone

Open it on a phone and the controls change to fit: a thumb pad on the left
that steers by how far you sweep it, a throttle and a brake on the right
(hold the brake at a standstill to reverse), and a strip of buttons in the
top corner — `AUTO`, `CAM`, and `☰` for the other eight commands. Drag
anywhere on the road to look around and pinch to change the camera distance;
the wheel and every key still work if there is one attached.

The controls appear when the browser says the pointer is coarse, and on the
first touch regardless. `?touch=1` puts them on a desktop, which is how they
get tested; `?touch=0` takes them away.

`?quality=low` — the default on a touch device — halves the shadow map,
marches the cloud layer at 0.4 of the frame rather than 0.5, and drops the
scene's supersample from 1.75× to 1.25×. `?quality=high` is the desktop
picture, on any device.

`?seed=` takes a word or a number. `?flat` puts the pre-cel renderer back —
standard materials, no post. It only works on the dev server (`npm run dev`);
the production build always draws cel.
`?rec=1` hands the frame loop to a script and skips the load screen.
`?lod=1` pins the ground in the road corridor to 1 m vertex spacing however
far it is from the car — a diagnostic for the ink on the verge, and an
expensive one: it is the case `FAR_LOD` exists to prevent.
`?car=coupe` keeps the code-built stand-in instead of the modelled car.
`?auto` starts with full autodrive (`?auto=steer`, `?auto=speed` for the
others) and skips the load screen.
`?debug=1` puts a few lines top left: the tier and GPU, the screen's density,
the canvas and scene sizes and which route the picture took to the screen,
the frame rate and the governor's level, and whether the ground is keeping
up with the car. It is the thing to screenshot when a device looks wrong.

`?t=18:20`, `?season=autumn`, `?weather=heavyRain` and `?day=7` pin the sky, and
they are useful for screenshots — with a 24-minute day and hourly weather, a
still shot at whatever the seed happened to be doing is not comparable with
anything, including itself an hour later. `?clouds=off` puts the bare gradient
dome back and `?clouds=full` marches the layer at full resolution. `?sky=only`
hides the world so the frame is dome plus cloud layer and nothing else.
`?fresh` ignores the saved drive.

Every drive starts on a **spring morning** — day 1 of the twelve-day year, at
08:00. The landscape, the weather and the moon are still seeded; only the
calendar is fixed, so a first thirty seconds is the same first thirty seconds.

---

## Playing it from a script

Both need the dev server (`npm run dev`) and Google Chrome.

```bash
node tools/play/autoplay.mjs --minutes 20             # play, and check it all works
node tools/play/autoplay.mjs --realtime --throttle 4 --quality low
node tools/play/film.mjs --survey country,drift,hills # 48 hours of weather per seed
node tools/play/film.mjs --seed country --hours 48 --out /media/DRIVE2/country-road/two-days
node tools/play/check-mp4.mjs <film.mp4>              # does it decode; frames as PNG
```

`autoplay.mjs` plays with the keys a player has: autodrive, the cameras, a
nudge of the wheel, the handbrake, off into a field and `T`, the part-auto
modes, the clock, a rest through the night. Every action is checked, and so
is every few seconds of driving — off the road under the autopilot, stuck,
fallen through the ground, no ground, an exception. A minute of play is a
game-hour. Exits non-zero on any failure.

`film.mjs` records one continuous drive: every frame stepped, encoded to
H.264 in the page by WebCodecs and muxed to MP4 in Node, with an 8x
time-lapse made from the same frames in the same pass. No ffmpeg needed.
About 11 frames a second on an Intel HD 630, so two game-days is two hours.

The probes behind `prompt_4.md`'s fixes are in `perf-bench/`: `dpr.mjs` (what
reaches the panel on a high-density screen), `void.mjs` (does the ground keep
up on a throttled CPU), `seam.mjs` (holes in the ground, counted),
`far.mjs` (the world a long way from the origin).

