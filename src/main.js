import * as THREE from 'three';
import { Terrain, WATER_LEVEL } from './world/terrain.js';
import { RoadPath } from './road/spline.js';
import { ChunkField } from './world/chunks.js';
import { Scatter } from './world/scatter.js';
import { Furniture } from './road/furniture.js';
import { Sky } from './world/sky.js';
import { setAnisotropy } from './core/textures.js';
import { PAL } from './core/palette.js';
import { CEL } from './core/toon.js';
import { Pipeline } from './core/post.js';
import { hashString } from './core/rng.js';
import { Input } from './core/input.js';
import { Hud } from './core/hud.js';
import { Vehicle } from './car/vehicle.js';
import { Physics, initRapier } from './car/physics.js';
import { loadCar } from './car/model.js';
import { ChaseCamera, MODES as CAM_MODES } from './car/camera.js';
import { Autodrive, MODES as AUTO_MODES } from './car/autodrive.js';
import { Pointer } from './core/pointer.js';
import { TouchControls, coarsePointer } from './core/touch.js';
import { Clock, DAY, YEAR, HOUR, MINUTE, sunAltAt } from './world/clock.js';
import { TimeLapse, nextFirstLight } from './world/timelapse.js';
import { CloudField } from './world/cloudfield.js';
import { Clouds } from './world/clouds.js';
import { CloudGeo } from './world/cloudgeo.js';
import { Atmosphere } from './world/atmosphere.js';
import { Celestial } from './world/celestial.js';
import { Weather } from './world/weather.js';
import { Precipitation } from './world/precip.js';
import { setSeason } from './world/season.js';
import { Headlights } from './car/lights.js';
import { Loader, watchFocus } from './core/loader.js';
import { Save } from './core/save.js';
import { hashFloat } from './core/rng.js';
import { Sound } from './audio/sound.js';
import { TIERS, pickTier, gpuName, ResolutionGovernor } from './core/quality.js';

/* ------------------------------------------------------------------ *
 * country-road -- entry point.
 *
 * The frame does five things in order, and the order matters: extend the
 * road ahead of the car, read the controls, move the car, rebuild the
 * ground under its new position, then draw.  Extending first is the
 * invariant -- the terrain must never bake a chunk before the road that
 * runs through it has been traced, or it bakes a hillside where a road is
 * about to be.
 * ------------------------------------------------------------------ */

/* The physics wasm, before anything that could want it.
 *
 * Top-level await rather than a boot callback: every system below this
 * line is allowed to assume there is a physics world, and the alternative
 * -- a null world for the first few hundred milliseconds -- means every
 * one of them carries a branch for a state that exists once, at startup,
 * and is untestable afterwards.  (`vite.config.js` targets es2022 for
 * this.) */
await initRapier();

const params = new URLSearchParams(location.search);

/* ------------------------------- the save -------------------------------- *
 * Read before anything is built, because the seed itself can come out of it:
 * opening the page with no `?seed` should carry on the drive that was there,
 * not start a different world with the same name. */
const save = new Save();
const stored = params.has('fresh') ? null : save.read();
const resumable = stored && (!params.has('seed') || stored.seed === params.get('seed'))
  ? stored : null;

const seedText = params.get('seed') || (resumable && resumable.seed) || 'country';
const SEED = /^\d+$/.test(seedText) ? Number(seedText) : hashString(seedText);

/* --------------------------------- time ---------------------------------- *
 * **Every drive starts on a spring morning**, and that is `prompt_5.md`
 * item 4 overruling a decision from iteration 3.
 *
 * The day of the year used to be seeded, so a new seed opened in its own
 * season -- which `next_4.md` was pleased with and which is not what the
 * prompt wants. A first thirty seconds should be the same first thirty
 * seconds: light, green, and the beginning of a year.
 *
 * **Day 1 of 12, not day 0.** `seasonAt` cross-fades across the last
 * quarter of each season, so day 0 is spring at weight 1.0 but so is day
 * 1, and day 1 leaves two clear game-days before summer starts bleeding
 * in. Starting on the very first tick of the year would also make the
 * `?season=spring` pin and the default land on different days, which is
 * exactly the class of quiet disagreement that cost iteration 3 twelve
 * game-hours.
 *
 * The landscape, the weather and the moon phase are all still seeded --
 * only the calendar is fixed. Anyone who puts the hash back should read
 * `prompt_5.md` first.
 *
 * `?t=18:20`, `?day=7` and `?season=` all still override, because both
 * capture harnesses need them: a still shot in whatever weather the seed
 * happened to be having is not comparable with anything, including itself
 * a week later. */
const SALT_CLOCK = 0x0c10c6;
/** The day a drive starts on, out of the twelve in a year. */
const SPRING_MORNING_DAY = 1;
function startTime() {
  if (resumable) return resumable.t;
  const day = params.has('day') ? Number(params.get('day')) : SPRING_MORNING_DAY;
  let hours = 8;
  const t = params.get('t');
  if (t) {
    const [h, m] = t.split(':');
    hours = (Number(h) || 0) + (Number(m) || 0) / 60;
  }
  return day * DAY + hours * HOUR;
}
const clock = new Clock(startTime(), hashFloat(SEED, SALT_CLOCK, 1));
if (params.has('t')) clock.setTimeOfDay(clock.hour);

/* ------------------------------- weather --------------------------------- */
const weather = new Weather(SEED, { pin: params.get('weather') });
/* `?season=autumn` pins the year, which captured stills need for the
 * same reason `?t` exists.  It is a clock offset rather than a flag, so
 * everything downstream still reads one place. */
const SEASON_PIN = ['spring', 'summer', 'autumn', 'winter'].indexOf(params.get('season'));
if (SEASON_PIN >= 0) {
  const want = (SEASON_PIN + 0.5) / 4;
  /* **Snapped to a whole day**, and that is a bug fix, not a tidy-up.
   *
   * A year is twelve days and the middle of a season is (i + 0.5) / 4 of
   * it, so `want * YEAR` is four and a *half* days for summer -- and
   * adding a half day to a clock that had just been set to 11:00 by `?t`
   * gave 23:00.  Every still and every probe row that pinned both
   * `?season` and `?t` was taken twelve game-hours from the time it
   * asked for, which is how `tools/probe/clouds.mjs` came to measure a
   * cloud shadow of exactly zero at "11:00" and be right.
   *
   * `?t` alone was always correct, and so was `?season` alone. */
  const day = Math.floor(want * YEAR / DAY) * DAY;
  clock.t = Math.floor(clock.t / YEAR) * YEAR + day + (clock.t % DAY);
  clock.update();
}

const canvas = document.getElementById('view');

/* Recording mode has to be known before the context is created.
 *
 * With no `requestAnimationFrame` loop the browser still composites the
 * page on its own schedule, and WebGL is allowed to discard the drawing
 * buffer after every composite unless asked not to.  So `step()` would
 * render a perfect frame, `Page.captureScreenshot` would force a
 * composite, and the PNG that came back was a half-cleared buffer --
 * ground missing, road missing, furniture floating in haze.
 *
 * Two rounds of captured stills showed exactly that as rendering bugs,
 * and the frames were broken -- but the frames were
 * broken by the *camera*, not by the game.  Every one of those stills
 * renders correctly when the same build is opened by hand. */
const RECORDING = new URLSearchParams(location.search).has('rec');

/* `antialias` only under `?flat`.  With the cel pipeline the scene is
 * drawn into its own render target and the only thing that ever reaches
 * the canvas is the FXAA pass, so a multisampled canvas was a 4x buffer
 * resolved every frame for a full-screen quad that has no edges in it. */
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: !CEL, powerPreference: 'high-performance', stencil: false,
  preserveDrawingBuffer: RECORDING,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/**
 * How hard to work the GPU -- see `core/quality.js`.
 *
 * A phone is not a small desktop, and neither is a laptop drawing on the
 * graphics inside its CPU.  The tier comes from `?quality=`, then from the
 * films (`?rec` is always `high`: the films and the captured stills have
 * to be the same picture on every machine), then from the pointer -- a
 * finger is `low` -- and last from the GPU's own name, where integrated
 * graphics are `medium`.  `?quality=high` on a laptop and `?quality=low`
 * on a desktop both work, which is the only way to compare them at all.
 *
 * The tier is a starting point; `governor` below moves the render scale
 * from the frame rate the machine actually manages.
 */
const GPU = gpuName(renderer.getContext());
const TIER = pickTier({
  param: params.get('quality'), recording: RECORDING, coarse: coarsePointer(), gpu: GPU,
});
const Q = TIERS[TIER.name];
console.log('[quality]', TIER.name, '-', TIER.why, GPU ? `(${GPU})` : '');

setAnisotropy(Math.min(Q.anisotropy, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
/** How far the world is drawn, in metres. */
const VIEW = 1400;
/* The fog colour is the sky's own horizon colour, exactly.  When they
 * differ at all, fully-fogged terrain reads *brighter* than the sky above
 * it and the far ridge appears as a white cliff with a hard top edge --
 * which is what "no aerial perspective" looked like in the second round
 * of stills.  Aerial perspective is not just fading; it is fading to the
 * right colour. */
const HAZE = CEL ? PAL.fog : 0xdcebf2;
/* Fog far has to close *before* the ground runs out, or the last ring of
 * chunks ends in mid-air against the sky and the world has a visible
 * edge.  The chunk field reaches 850 m to the side; the fog is done at
 * 1050 and the far ring is only ever seen through most of it. */
/* Fog, and this took three attempts to get right.
 *
 * Linear fog over 60-780 m looked reasonable on a flat road and destroyed
 * every valley: ground 400 m away and 60 m below the car came out as a
 * flat white sheet, which read as missing geometry until the fog was
 * turned off and the terrain was found perfectly intact underneath it.
 *
 * Exponential-squared was the second attempt, and it takes a hillside a
 * kilometre out from readable to 92 % white.  So: linear again, but far
 * later.  180-1500 m keeps the middle distance and still leaves the far
 * ring at 93 %, which the matched colour finishes off. */
const VIEW_DIST = 1400;
scene.fog = new THREE.Fog(HAZE, 180, 1500);
/* The clear colour matters even with a sky dome in front of it, because
 * anything the dome fails to cover shows through as this.  It was black,
 * and the first sky dome was built at 2.2x the view distance -- outside
 * the camera's own far plane -- so the whole top of the sky was clipped
 * away and the hole was filled with, precisely, black. */
scene.background = new THREE.Color(HAZE);

const camera = new THREE.PerspectiveCamera(66, 1, 0.4, VIEW * 1.45);
camera.rotation.order = 'YXZ';

/* --------------------------------- light --------------------------------- */
/* Two lights and a hemisphere, which is the classic anime setup: one warm
 * quantised key, one strong cool bounce from the opposite quarter, and a
 * ground-tinted hemisphere so nothing in shadow ever goes black.  The fill
 * is deliberately strong -- a drawn background has *coloured* shadows, not
 * dark ones -- and under `?flat` the same rig just reads as an overcast
 * day. */
const sun = new THREE.DirectionalLight(CEL ? PAL.sun : 0xfff6e8, CEL ? 2.15 : 1.55);
sun.castShadow = true;
/**
 * The cascade, and why it is four times wider than it was.
 *
 * It was +/-45 m over a 2048 map, chosen "for a car shadow with a shape":
 * 4.4 cm per texel, and you can see the roofline in it.  What that number
 * also decided, and nobody wrote down, is that **nothing further than
 * 45 m from the car casts a shadow at all** -- so a landscape of a hundred
 * trees had at most one tree's shadow in it, and a parked player watching
 * the sun move saw nothing move with it.  That is `prompt_5.md` item 8,
 * and it is a framing decision that had quietly become an art decision.
 *
 * Measured at 17:00 with the sun at 20.6 degrees, by rendering the frame
 * twice with `castShadow` on and off and counting pixels that differ by
 * more than 4/255:
 *
 *     +/- 45 m, 2048     1.65 %      <- as shipped
 *     +/-110 m, 2048     3.76 %
 *     +/-140 m, 3072     4.67 %
 *     +/-200 m, 3072     5.10 %      <- here
 *     +/-300 m, 4096     5.19 %
 *
 * It saturates at 200: past that the extra area is beyond the fog and
 * behind the hill anyway.  `plan_5.md` proposed a second light with its
 * own 300 m cascade for the middle distance; the measurement says the
 * second light would buy 0.09 % of frame for a third directional light in
 * every shader and a shadow pass per frame, so there is one cascade.
 *
 * 13 cm per texel at 3072 -- the car is 35 texels rather than 100, and
 * side by side at the chase camera's distance the two are not tellable
 * apart.  What is past 200 m is the horizon term in `groundmat.js`, which
 * is a heightfield question and not a shadow-map one.
 */
const SH = 200;
const SHADOW_MAP = Q.shadowMap;
/** How far above its target the shadow rig always sits, in metres. */
const SHADOW_HEIGHT = 300;
/** Metres per shadow texel.  The biases below are written in these. */
const SH_TEXEL = (2 * SH) / SHADOW_MAP;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.left = -SH; sun.shadow.camera.right = SH;
sun.shadow.camera.top = SH; sun.shadow.camera.bottom = -SH;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 1400;
sun.shadow.bias = -0.0005;
/* Normal bias in metres.  It was 0.9 -- which does stop the acne, by
 * pushing every shadow most of a metre off whatever cast it, and the
 * result was a landscape of soft grey blobs only loosely attached to the
 * trees above them.  It is written in *texels* now, because that is the
 * unit acne is actually measured in: a wider cascade has bigger texels and
 * needs proportionally more, and hard-coding 0.09 for a 4.4 cm texel meant
 * the number silently became two texels' worth instead of two. */
sun.shadow.normalBias = 2.2 * SH_TEXEL;
scene.add(sun, sun.target);
/* The key light is the only shadow caster and it is re-aimed at the moon
 * at night rather than being joined by a second light -- see
 * `atmosphere.js`.  Its colour and intensity are written every frame. */
/* A strong hemisphere against a weaker sun.  Soft daylight -- bright,
 * everything lit from everywhere -- is the calm the drive wants, and a
 * hard directional key with black shadow sides read as harsh and dark. */
const hemi = new THREE.HemisphereLight(
  CEL ? PAL.hemiSky : 0xdfeefb, CEL ? PAL.hemiGround : 0x7a7c58, CEL ? 1.15 : 1.85);
scene.add(hemi);
/* The cool bounce.  It follows the daylight rather than being constant --
 * a strong blue fill at midnight is what makes a night scene look like a
 * day scene with the brightness turned down. */
let fill = null;
if (CEL) {
  fill = new THREE.DirectionalLight(PAL.fill, 0.95);
  fill.position.set(120, 70, -110);
  scene.add(fill, fill.target);
}

/* --------------------------------- world --------------------------------- */
const terrain = new Terrain(SEED);
const road = new RoadPath(terrain, { heading: 0 });
terrain.road = road;

/* Wider, and less of an ellipse.  At 850 m with a 0.35 tail the ground
 * ran out inside the fog on the flanks, and the sky dome showed through
 * the gap in exactly the fog's colour -- so it read as haze rather than as
 * missing world, which is why it survived two rounds of stills. */
const chunks = new ChunkField(scene, terrain, road, {
  radius: VIEW_DIST, forward: 0.7, farLod: Q.farLod,
  /* `?lod=1` pins the road corridor to 1 m spacing whatever the tier
   * would have chosen.  A diagnostic for the verge creases and nothing
   * else -- see `ChunkField._lodFor` and `ai/plan_3.md`. */
  corridorStep: Number(params.get('lod')) || undefined,
});
/**
 * How far ahead of the car the road is kept traced, in metres of tarmac.
 *
 * The field's reach is a straight line and this is an arc length, and the
 * two are not the same number: the road winds, at a measured route
 * efficiency of about 0.75 and as little as 0.57 on the worst seed in the
 * sweep, so a kilometre of tarmac buys 570 to 750 m of ground.  Leading by
 * the reach alone therefore leaves the far side of the ellipse with no
 * road in it; it gets built bare, and the road arrives afterwards.  That
 * is the whole of the discontinuity this is fixing, and it needs no
 * backtracking at all to happen -- measured on `?seed=country`, twelve
 * chunks wrong at once by as much as 16 m, with the tracer having reverted
 * exactly zero times.
 *
 * Rather than guess the ratio, watch it: `NEED` is what the ground
 * actually requires, in a straight line, and the lead is walked up when
 * the traced tail is inside that and down when it is comfortably beyond.
 * Tracing runs at 700 km/s, so tarmac bought here is close to free, and
 * every metre of it is a chunk not rebuilt later -- with the old
 * arc-length lead the rebuild path fires 616 times in five kilometres and
 * doubles the median frame time doing it.
 *
 * `?lead=1` pins the old behaviour, which is how the rebuild path gets
 * exercised.
 */
const NEED = () => chunks.reach() + 250;
const LEAD_PIN = Number(params.get('lead') || 0);
const LEAD_MAX = 3;
let roadLead = NEED();

road.extend(0, LEAD_PIN ? NEED() * LEAD_PIN : NEED() * 1.6, 20000, 600);
const scatter = new Scatter(scene, terrain, road, { seed: SEED });
const furniture = new Furniture(scene, terrain, road);
const sky = new Sky(scene, VIEW * 1.12);   // inside camera.far, deliberately
/* The volumetric layer.  `?clouds=off` puts the bare dome back, which the
 * seam probe needs; `?clouds=full` marches at full resolution, which is
 * how the half-res upsample gets to be proved free rather than
 * asserted; `?clouds=raw` turns off the temporal resolve, which is the
 * layer as it stood before `plan_8` and is the only way to see what the
 * resolve is for -- a still frame of `raw` and a still frame of `on` are
 * nearly the same picture, and it is the *motion* that separates them, so
 * the A/B has to be driven rather than screenshotted.
 *
 * `?maxstep=N` overrides the march's longest stride, which `plan_9` cut
 * from 450 to 150 to take the horizontal layering off far cloud.
 * `?maxstep=450` is that layering, and unlike `raw` it *is* a still. */
/* **And since `plan_2.md` there are two layers.**
 *
 * `geo` is the default: clusters of cel-shaded lobes with the world's own
 * ink around them (`world/cloudgeo.js`).  `prompt_2.md` asked for a sky
 * that matches the drawing under it, and a raymarch is a photograph
 * however good it is.  `?clouds=march` is the volumetric layer above,
 * which is the better physics and stays reachable; `full` and `raw` are
 * its two variants and are described in the paragraph above this one. */
const CLOUD_MODE = params.get('clouds') || 'geo';
const MARCHING = CLOUD_MODE === 'march' || CLOUD_MODE === 'full'
  || CLOUD_MODE === 'raw' || CLOUD_MODE === 'on';
/* One cloud field, whichever layer draws it: the sky reads it, every lit
 * material takes its shadow from it, and the rain falls out of the thick
 * part of it.  Built from the same seed as everything else -- and
 * **before** the layer, which needs the erosion volume it owns. */
const cloudField = new CloudField(SEED);
weather.field = cloudField;
const clouds = CLOUD_MODE === 'off'
  ? null
  : (MARCHING
    ? new Clouds(scene, {
      scale: CLOUD_MODE === 'full' ? 1 : Q.cloudScale,
      history: CLOUD_MODE === 'full' ? 1 : Q.cloudHistory,
      temporal: CLOUD_MODE !== 'raw',
      maxStep: Number(params.get('maxstep')) || undefined,
      field: cloudField,
    })
    : new CloudGeo(scene, {
      field: cloudField,
      clouds: Q.cloudCount,
      detail: Q.cloudDetail,
    }));
sky.set(CEL ? PAL.skyTop : 0xa6c6e2, CEL ? PAL.skyMid : 0xdcebf2, HAZE);
/* The sun, the moon, five thousand real stars, and the rain.  All four sit
 * inside the dome and outside everything else. */
/* The one thing other than the frame that is allowed to move the clock.
 * Both the rest (`Z`) and the scrub (`[` `]`) go through it. */
const lapse = new TimeLapse(clock, weather);
const celestial = new Celestial(scene);
const precip = new Precipitation(scene);
const atmos = new Atmosphere();

/* There is no water plane any more.
 *
 * There was: one 9 km square at y = 2, translucent, re-centred on the car
 * every frame.  That is not a body of water held by the shape of the land,
 * it is a sheet of glass laid across the world -- it existed over ground
 * that was nowhere near it, it reached 4.5 km when the terrain reached 2.4,
 * and every hole in the ground showed it through, which is what made a
 * missing chunk look like a lake on a hillside.  `ChunkField` builds the
 * surface per chunk now, from the same heights as the ground, over the
 * parts of it that are actually submerged. */

/* ---------------------------------- car ---------------------------------- */
/* The car is a download, so it arrives late; the game starts on the
 * code-built coupe and swaps when the GLB lands.  `?car=coupe` keeps the
 * built-in one. */
let coupe = { group: new THREE.Group(), wheels: [], steerWheels: [], hubs: [] };
scene.add(coupe.group);

/* Kept as a promise so the load screen can wait on it -- with a timeout,
 * because the rule above still holds: a car is not optional and a download
 * is, and the built-in coupe is already standing by. */
const carReady = params.get('car') !== 'coupe'
  ? loadCar().then((c) => {
      scene.remove(coupe.group);
      coupe = c;
      scene.add(coupe.group);
      console.log('[car]', c.source);
    })
  : import('./car/body.js').then(({ buildCoupe }) => {
      scene.remove(coupe.group);
      coupe = buildCoupe();
      scene.add(coupe.group);
    });

/* The physics world has to exist before the car does, and its wasm is a
 * download -- so everything from here to the frame loop happens inside
 * `boot()` below, and the module's top level only builds the world.  A
 * `?rec` capture waits on the same promise, which is why `__game.ready`
 * exists. */
const physics = new Physics({ radius: 190 });
const car = new Vehicle(terrain, physics);
car.placeOn(road, 20);

/* The headlights exist from boot at zero intensity, and this is the whole
 * reason: three.js recompiles every material in the scene when the light
 * count changes, so switching them in at dusk would stall the frame twice
 * a game-day, for ever. */
const headlights = new Headlights(scene);

const chase = new ChaseCamera(camera);
/* The game starts with the car parked and nobody driving it.
 *
 * It started with autodrive on, which is right for a film and wrong for a
 * person: the first thing that happens on opening the page should be
 * nothing, until they ask for something.  The films still need a driver,
 * so `?rec` engages it, and `?auto` is there for watching it drive
 * by hand -- `tools/rec/record.mjs` passes `?rec=1` already and is
 * unchanged. */
/* `?auto` takes a mode **name** now -- `?auto=steer` is auto-steering --
 * and a bare `?auto` still means full, which is what the films want.
 *
 * It used to take a number, and `prompt_5.md` reordered the modes, so a
 * number would now mean something else. Names cannot rot that way. A
 * number is still accepted and still indexes `AUTO_MODES`, which is the
 * one place this can still surprise somebody; the save has a real
 * migration instead (`core/save.js`). */
function startMode() {
  if (resumable) return resumable.auto;
  if (RECORDING) return 'full';
  if (params.has('auto')) {
    const v = params.get('auto');
    if (AUTO_MODES.includes(v)) return v;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n < AUTO_MODES.length
      ? AUTO_MODES[n] : 'full';
  }
  return 'manual';
}
const auto = new Autodrive(road, car, { mode: startMode() });
const input = new Input({ onCommand: command });
/* Looking around belongs to the camera, not to the driver: it is wired to
 * the chase rig and never to the axes, so a player dragging the view while
 * the autopilot drives does not take the wheel off it by accident.  Off
 * under `?rec`, so a film's framing can never depend on where a mouse
 * happened to be. */
const pointer = new Pointer(canvas, chase, { enabled: !RECORDING });
const hud = new Hud();
/* The engine and the landscape.  Nothing is made until the first click or
 * key -- see `audio/sound.js` -- and never under `?rec`.  `?sound=0` and
 * `?sound=1` override the remembered preference for one visit. */
const sound = new Sound({
  disabled: RECORDING,
  forced: params.get('sound') === '0' ? false : params.get('sound') === '1' ? true : null,
});
hud.setHint('W A S D  drive     SPACE  handbrake     DRAG  look     SCROLL  distance     T  back to the road     F  autodrive     [ ]  time     Z  rest     C  camera     M  sound     H  hud     ESC  menu');

/* And the same controls for a device with no keys.
 *
 * `TouchControls` writes into `input.touch` and calls the same `command()`
 * the keyboard calls, so nothing below this line knows a phone exists --
 * the autopilot's per-channel override, the takeover latch, the toasts and
 * the save all work on a phone because they work on `axes`.  Off under
 * `?rec` for the same reason the pointer is: a film's framing must not
 * depend on what was on screen.
 *
 * It decides for itself whether to appear -- see `core/touch.js` -- and
 * says so here, because three things on screen name keys. */
const touch = RECORDING ? { enabled: false } : new TouchControls(input, {
  onCommand: command,
  onEnable: () => {
    hud.touch = true;
    /* The keyboard hint names eleven keys and `body.touch` hides it.  What
     * replaces it is only the two things a *gesture* does, because every
     * other control is now a button with its own name on it.  Said once,
     * for five seconds, rather than parked on a screen that has none to
     * spare. */
    hud.toast('drag  look     pinch  distance', 0, 5);
    const go = document.getElementById('load-go');
    if (go) go.textContent = 'tap to drive';
  },
});

/* The load screen, and the focus handoff that is the whole point of it.
 *
 * Skipped entirely under `?rec` -- five harnesses open a page and wait on
 * a promise, and none of them can click. */
/*
 * `?go` is the memory of the press that got us here.  "New drive" reloads
 * the page, and the reloaded page used to come up on the same prompt the
 * player had just answered -- two screens for one decision.  The flag says
 * "this load *is* the answer": the bar still runs, and the drive begins at
 * the end of it with nothing to click.
 *
 * It is stripped from the address bar below, so that a copied URL, a
 * bookmark, or an F5 four miles later comes back to the ordinary screen
 * with its continue/new choice rather than silently resuming for you.
 */
const loader = new Loader({
  skipped: RECORDING || params.has('auto'),
  autoStart: params.has('go'),
});
if (params.has('go')) {
  const clean = new URLSearchParams(location.search);
  clean.delete('go');
  const q = clean.toString();
  history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
}
/* And the recurrence: alt-tab away and the keyboard is dead again, which
 * `Input`'s own `blur` handler already knew about and never said. */
/* `!touch.enabled`, because the overlay this raises says "click to drive"
 * and exists to explain a *keyboard* that has gone deaf.  A phone has no
 * keyboard to lose, and some mobile browsers report the document as
 * unfocused while it is plainly being driven -- which would put a full
 * screen of text over the road with no way to dismiss it. */
watchFocus((has) => {
  document.body.classList.toggle('blurred', !has && !RECORDING && !touch.enabled);
});

/**
 * How much snow is lying.
 *
 * Not the same as the weather's `snow`, which is snow *falling*.  Lying
 * snow is mostly a function of the season -- it is there through winter
 * whether or not it happens to be snowing at this minute -- with a lift
 * while it falls.  Without the distinction the landscape turns white for
 * ten minutes and then green again, which is neither of the two things it
 * could sensibly be.
 */
function seasonSnow(w) {
  const winter = clock.season.weights[3];
  return Math.min(1, winter * (0.55 + 0.45 * Math.min(1, w.snow * 2)));
}

let simTime = 0;
let odometer = 0;
/** Seconds spent upside down or under water, for the automatic recover. */
let troubleFor = 0;

/**
 * Back onto the road, facing the right way.
 *
 * Being able to leave the road means being able to end up on your roof in
 * a ditch, and a driving game that can strand you needs a way out that is
 * not a page reload.  `T`, because `R` is reseed -- and automatically
 * after a few seconds of being upside down, because the player who has
 * just rolled the car is exactly the player who has not read the hint
 * line.
 */
function recover() {
  const near = road.nearest(car.pos.x, car.pos.z, {});
  car.placeOn(road, near ? near.s : auto.s);
  auto.i = 0;
  troubleFor = 0;
  hud.toast('back on the road', simTime);
}

/**
 * Cycle the autopilot, and say what it is now holding.
 *
 * `F` is the only thing that changes the mode.  That is a change from the
 * old two-state version, where *any* driving input dropped straight back
 * to manual -- which cannot survive four states, because steering in
 * "auto speed" is the entire point of "auto speed" and the old rule would
 * have disengaged on the first touch of A.
 *
 * What replaced it lives in `Autodrive.update`: a per-channel temporary
 * override, held while the driver asks and for a moment after.  So the
 * useful half of the old behaviour survives -- you never have to reach
 * for a key to take over -- without the half that made the modes unusable.
 *
 * Engaging still has to latch what is already held.  Press `F` while
 * accelerating, which is exactly when anyone would, and W is still down on
 * the next frame; without the latch the override fires immediately and the
 * mode that had just engaged does nothing at all.  It lasted one frame,
 * every time, and looked precisely like a key that does not work.
 */
function cycleAuto() {
  const was = auto.mode;
  const name = auto.cycle();
  if (auto.mode > 0) input.armTakeover();
  if (was > 0 && auto.mode === 0) keepRack();
  hud.toast(name === 'manual' ? 'autodrive off' : name.replace('speed', 'auto speed')
    .replace('steer', 'auto steering').replace('full', 'full autodrive'), simTime);
}

/**
 * Letting go leaves the rack where it is: the driver's axis is at zero,
 * the road wheels are wherever the autopilot left them, and snapping one
 * to the other mid-corner is a twitch nobody asked for.
 */
function keepRack() {
  input.axes.steer = Math.max(-1, Math.min(1, car.steer / car.m.maxSteer));
}

/**
 * The handbrake switches any of the three autodrive modes straight to
 * manual.  See `Input.handbrakePulled` for why it is not just another
 * per-channel override.
 */
function handbrakeOff() {
  auto.setMode('manual');
  keepRack();
  hud.toast('autodrive off', simTime);
}

/**
 * Which of the states to show, with enough hysteresis that a car rolling
 * to a stop at a junction does not flicker between two of them.
 */
let parked = true;
function badge(axes) {
  if (auto.mode > 0) { parked = false; return auto.name; }
  const v = Math.abs(car.speed);
  if (parked) { if (axes.throttle > 0 || axes.brake > 0 || v > 0.8) parked = false; }
  else if (v < 0.3 && axes.throttle === 0) parked = true;
  return parked ? 'parked' : 'driving';
}

/**
 * A different world, from nothing.
 *
 * `R` and the load screen's "new drive" are the same action and now call
 * the same function.  Two things matter here:
 *
 * **The seed is new.**  It used to reload with `?seed=${seedText}&fresh=1`
 * -- the *same* world, from a reading of "from the start" that
 * `prompt_4.md` overrides.  Everything downstream is a pure function of
 * the seed, so a new seed opens in a different landscape with different
 * weather without another line of code.  The *calendar* is no longer among
 * them: `prompt_5.md` item 4 fixes every drive to a spring morning, so a
 * new drive is a new place at the same hour of the same day, not a new
 * season.
 *
 * **The save goes first.**  A new world means the old record is not just
 * stale, it is *wrong*: an arc position into a road that no longer exists.
 * And `?fresh` is not needed on the way out, because `resumable` already
 * requires the stored seed to match the requested one.
 */
function freshStart() {
  save.clear();
  /* `go` carries the press across the reload -- see the `Loader` at its
   * construction.  Pressing "new drive" is already the answer to "do you
   * want to drive", and being asked it again on the far side of a
   * four-second load is the kind of small rudeness that reads as a bug. */
  location.search = `?seed=${Math.floor(Math.random() * 1e9)}&go=1`;
}

/**
 * The scrub, and why it is no longer a `+=`.
 *
 * `[` and `]` used to call `clock.shift(HOUR / 2)`: thirty game-minutes in
 * a single frame, which is **7.5 degrees of sun between two rendered
 * frames**.  That is almost certainly the "jumping from one game-hour to
 * the next" of `prompt_4.md` item 3 -- the clock was always continuous,
 * but the only control that let anyone watch the sky move teleported it.
 *
 * Now a tap runs thirty game-minutes as a *lapse*, over about a second and
 * a quarter of real time, and holding the key keeps going at the same
 * rate.  25 game-minutes a second is 6 degrees of sun a second: fast
 * enough to see, slow enough to watch.
 */
const SCRUB = HOUR / 2;
const SCRUB_RATE = 25 * MINUTE;    // game-minutes per real second

/**
 * Rest, and what there is to rest through.
 *
 * One key.  The HUD line above it names the single thing `Z` will do right
 * now, which is the whole of the interface: the player never picks from a
 * menu, and the label is one of the three the prompt asks for.
 *
 * Night wins over rain when both apply, because "it's possible to just
 * drive from first light to last light" is the stated goal and the rain
 * will usually have moved on by morning anyway.  A second press at dawn,
 * in the rain, then offers the rain.
 */
/**
 * Rain and snow below this counts as over.
 *
 * Under `precip.js`'s own visibility floor, so there is nothing left to
 * draw -- which is the standard the player is actually applying when they
 * look out of the windscreen and decide whether it is still raining.
 */
const DRY = 0.02;

function restLabel() {
  if (lapse.active) return '';
  if (clock.night > 0.35) return 'rest until morning';
  /* The *local* amount, not the regional one, for the same reason the stop
   * condition below reads it: what the player can see out of the
   * windscreen is what is falling here, and offering to rest through rain
   * that is two kilometres away is offering to rest through nothing. */
  const p = weather.p, h = weather.here;
  if (Math.max(p.snow, h.snow) > 0.08) return 'rest until the snow is over';
  if (Math.max(p.rain, h.rain) > 0.08) return 'rest until the rain is over';
  return '';
}

/**
 * Where the rest would stop.  Separate from the label because it is a
 * *search* -- a game-minute scan over twenty game-hours for first light,
 * or a twenty-hour projection of the weather -- and the label is read
 * every frame while the search happens once, on the press.
 *
 * Two different kinds of answer, deliberately. First light is a
 * *geometric* event and `nextFirstLight` bisects it to a sixteenth of a
 * game-minute; there is nothing to wait for after it. The rain is not: it
 * blends out over game-hours, so `Weather.projectDry` runs the real
 * weather forward until it is actually dry rather than naming the hour a
 * dry state is drawn in.
 */
function restTarget(label) {
  if (label === 'rest until morning') return nextFirstLight(sunAltAt, clock.t);
  const t = weather.projectDry(clock, { dry: DRY, hours: 20 });
  return t !== null && t > clock.t + HOUR / 4 ? t : null;
}

/** Every rest takes about this long in real seconds, whatever it skips. */
const REST_SECONDS = 2.2;

/**
 * A little slack past the projected dry time.
 *
 * The projection and the lapse run the same `Weather.update` in the same
 * one-game-minute steps, so they should arrive at the same game-minute --
 * but the projection starts from `clock.t` exactly while the lapse starts
 * from wherever the frame it was pressed on left the clock, and a rest
 * that stopped one sub-step short of dry would be the whole bug again.
 * A quarter of a game-hour costs nothing and removes the question.
 */
const REST_SLACK = HOUR / 4;

function rest() {
  const label = restLabel();
  const to = label ? restTarget(label) : null;
  if (!label || to === null) {
    /* Two different nothings.  With no label there is nothing to rest
     * through; with a label and no target the projection looked twenty
     * game-hours ahead and never found a dry minute, which is a different
     * fact and the player should hear it rather than be told their key
     * did nothing. */
    hud.toast(label
      ? 'it is not letting up today'
      : 'nothing to rest through', simTime);
    return;
  }
  const night = label === 'rest until morning';
  const span = to - clock.t;
  /* On the side of the road: the car is stopped rather than left rolling
   * at 20 m/s through twelve hours of frozen physics. */
  car.halt();
  input.axes.throttle = 0;
  input.axes.brake = 0;

  /* **The projection bounds the rest; a measurement ends it.**
   *
   * `restTarget` has already run the real weather forward to the
   * game-minute at which the rain will actually have stopped, so `span` is
   * a true duration rather than the hour at which a dry state gets drawn.
   * The thing that *stops* the lapse is still the weather at the car,
   * sampled on the lapse's own one-game-minute sub-step: the two agree by
   * construction, and if they ever stop agreeing the measurement wins,
   * which is the right way round.
   *
   * The night rest keeps its exact target instead: first light is a
   * geometric event, `nextFirstLight` bisects it to a sixteenth of a
   * game-minute, and there is nothing to wait for after it. */
  const dryEnough = () =>
    weather.here.rain + weather.here.snow < DRY &&
    weather.p.rain + weather.p.snow < DRY;

  lapse.run({
    /* A fixed *duration*, not a fixed multiplier, so a two-hour wait for
     * rain and a twelve-hour night both take about two seconds -- and a
     * short rest is not over before the eye has found the sky. */
    rate: Math.max(HOUR, span / REST_SECONDS),
    max: night ? span : span + REST_SLACK,
    label,
    until: night ? (c) => c.t >= to - 1e-6 : dryEnough,
    onDone: () => {
      /* Again on arrival: the frame that ends the lapse is the first frame
       * of physics in twelve game-hours, and a car that has been standing
       * still for all of them should not come out of it rolling. */
      car.halt();
      hud.setRest('', 0);
      /* And say so when the cap was what stopped it.  Stopping in the wet
       * is the bug being fixed here; stopping in the wet *silently* is the
       * same bug with the evidence removed. */
      if (!night && !dryEnough()) {
        hud.toast(`${clock.clockText}   the ${weather.here.snow > weather.here.rain
          ? 'snow' : 'rain'} has not let up`, simTime, 2.6);
      } else {
        hud.toast(`${clock.clockText}   ${weather.text}`, simTime, 2.6);
      }
    },
  });
}

/* ------------------------------ the pause -------------------------------- *
 * `Esc` quits to the load screen, which is now also the pause menu.
 *
 * Three things have to be true and only the first is obvious.
 *
 * **The clock must not move.**  A player who steps away with the menu up
 * should not come back to a different season.  `Z` is the way to skip
 * time and it costs you watching it happen; a pause that stopped time as
 * well would be a second, invisible one.  So `frame()` gates on `paused`
 * and runs neither `tick` nor `draw`.
 *
 * **"Continue" means the drive that is running**, not the drive in the
 * cookie.  A reload would cost four seconds and land at whatever arc
 * position the save last wrote -- and the save is throttled to one write
 * every two seconds.  A pause menu that loses two seconds of your drive is
 * a bug, so continue is one line: unpause.  "New drive, fresh start" is
 * still `freshStart()` and still reloads, because a new world genuinely is
 * a new page.
 *
 * **The save goes first**, so a player who quits the tab from the menu
 * loses nothing.
 * ------------------------------------------------------------------------ */
let paused = false;
async function openMenu() {
  if (paused || loader.skipped || !loader.el) return;
  paused = true;
  /* Forced, not throttled: this may be the last thing that happens before
   * the tab is closed. */
  if (!RECORDING) {
    save.write({ seed: seedText, t: clock.t, s: auto.s, odometer,
                 camera: chase.mode, auto: auto.name }, simTime, true);
  }
  /* The *live* state, not the saved one -- see `Loader.pause`. */
  const miles = (odometer / 1609.344).toFixed(1);
  sound.setPaused(true);
  const how = await loader.pause(
    `${miles} miles · ${clock.season.name} · ${clock.clockText}`);
  if (how === 'new') { freshStart(); return; }
  paused = false;
  sound.setPaused(false);
  /* The wall clock has been running the whole time the menu was up, and
   * `frame()` takes its `dt` from it.  Without this the first frame after
   * a resume is a `dt` of however long the player stood in the menu,
   * clamped to 50 ms -- which is a visible lurch and, worse, 50 ms of
   * physics with the keys the menu was dismissed with still held. */
  wall.getDelta();
  frame();
}

function command(cmd) {
  if (cmd === 'menu') {
    openMenu();
  } else if (cmd === 'autodrive') {
    cycleAuto();
  } else if (cmd === 'rest') {
    rest();
  } else if (cmd === 'timeBack' || cmd === 'timeFwd') {
    /* These two were bound in `input.js` from the day it was written and
     * handled nowhere until iteration 3, and then handled by teleport.  A
     * 24-minute day is a long time to wait to see a sunset; it is also
     * short enough that the sunset is worth watching arrive. */
    if (lapse.active) return;
    const sign = cmd === 'timeFwd' ? 1 : -1;
    lapse.run({
      rate: sign * SCRUB_RATE,
      /* The floor is the old jump's size, so a tap does what a tap always
       * did -- it just takes a second and a quarter over it.  Holding
       * keeps going, and `hold` is what makes the key release matter. */
      min: SCRUB,
      hold: true,
      label: '',
      onDone: () => hud.toast(clock.clockText + '  ' + clock.season.name, simTime),
    });
  } else if (cmd === 'timeUp') {
    /* Released.  `min` in the run above means a tap still covers its half
     * hour before this can stop it. */
    lapse.release();
  } else if (cmd === 'camera') {
    hud.toast(chase.cycle(), simTime);
    pointer.centre();
  } else if (cmd === 'hud') {
    hud.toggle();
  } else if (cmd === 'sound') {
    hud.toast('sound ' + (sound.toggle() ? 'on' : 'off'), simTime);
  } else if (cmd === 'ink') {
    if (pipeline) { pipeline.enabled.ink = !pipeline.enabled.ink; hud.toast('ink ' + (pipeline.enabled.ink ? 'on' : 'off'), simTime); }
  } else if (cmd === 'grade') {
    if (pipeline) { pipeline.enabled.grade = !pipeline.enabled.grade; hud.toast('grade ' + (pipeline.enabled.grade ? 'on' : 'off'), simTime); }
  } else if (cmd === 'recover') {
    recover();
  } else if (cmd === 'reseed') {
    freshStart();
  }
}

/**
 * Everything that is painted rather than simulated: the camera, the sky,
 * the celestial bodies, the precipitation and the three lights.
 *
 * A function of its own because there are now two callers.  The ordinary
 * frame runs it after the car has moved; a time-lapse runs it with the car
 * standing still, which is the only way the sky can wheel over during a
 * rest -- the alternative is a skip that ends on a frame of the sky it
 * started from and then snaps.
 *
 * `moving` is what the two callers differ by, and it is only three lines:
 * the chase camera and the pointer must not integrate while the world is
 * frozen, or a two-second rest ends with the camera somewhere else.
 */
function paintWorld(dt, w, { moving = true, braking = false } = {}) {
  if (moving) {
    pointer.update(dt, car, auto.mode > 0);
    chase.update(dt, car);
  }
  sky.update(dt, camera, atmos, w.wind);
  if (clouds) clouds.update(camera, atmos, w, clock);
  /* A third of the old global fade.  The cloud layer now occludes the
   * stars and the moon *per pixel* -- it draws after them and over them --
   * so fading the whole field out by the cover number as well would hide
   * the stars in the gaps.  What is left is the honest part: a sky with
   * cloud in it is hazier everywhere, not only where the cloud is. */
  celestial.update(clock, camera, w.cloud * 0.35, renderer.getPixelRatio());
  /* The particles are the one thing that is unambiguously *local*: the
   * rain you can see out of the windscreen is the rain that is falling on
   * this square kilometre, not the county's average. */
  precip.update(dt, weather.here, camera, car, atmos.light);
  if (moving) chase.collide(terrain, car);

  /* The key light now *points somewhere*, and the somewhere moves.
   *
   * One light, re-aimed at whichever body is up -- the sun by day, the
   * moon by night -- rather than two lights switched between, because the
   * light *count* is what three.js recompiles every material in the scene
   * over.  The shadow camera still follows on a snapped grid: unsnapped,
   * the cascade re-rasterises every frame and the edge of every shadow
   * crawls. */
  const SNAP = 4;
  const gx = Math.round(car.pos.x / SNAP) * SNAP;
  const gz = Math.round(car.pos.z / SNAP) * SNAP;
  sun.target.position.set(gx, car.pos.y, gz);
  /* Up the key direction, far enough that the light always sits a fixed
   * height above the target -- **and along the real direction**.
   *
   * It used to be a fixed 260 m with `Math.max(40, dir.y * 260)` on the
   * height, and that `max` is a lie about where the sun is: below 8.8
   * degrees of elevation it pulled the light's y up without touching x or
   * z, so the shadow direction stopped matching the sun's exactly when
   * shadows are longest and most worth looking at.  Scaling the *distance*
   * by 1/sin(altitude) instead keeps the light 300 m above the target at
   * every hour with the direction untouched.  The clamp is on the ratio,
   * so a sun on the horizon gives a very long rig rather than an infinite
   * one, and `castShadow` below has switched off by then anyway. */
  const keyY = Math.max(0.10, atmos.key.dir.y);
  const dist = Math.min(3000, SHADOW_HEIGHT / keyY);
  sun.position.set(
    gx + atmos.key.dir.x * dist,
    car.pos.y + atmos.key.dir.y * dist,
    gz + atmos.key.dir.z * dist);
  /* The far plane has to reach past the target by the cascade's own reach,
   * or the far half of a 200 m box is clipped out of the shadow map and
   * the hillside stops casting halfway across.  Quantised so the
   * projection matrix is not rebuilt every frame. */
  const wantFar = Math.ceil((dist + SH * 3) / 200) * 200;
  if (sun.shadow.camera.far !== wantFar) {
    sun.shadow.camera.far = wantFar;
    sun.shadow.camera.updateProjectionMatrix();
  }
  sun.color.copy(atmos.key.colour);
  sun.intensity = atmos.key.level;
  /* Below the horizon the key casts nothing, and leaving the shadow map
   * on would light the world from underneath.  The floor is 3.4 degrees
   * rather than 1.1: under that the rig's 1/sin has hit its clamp, so the
   * light is no longer 300 m up and a hill inside the cascade can be
   * *above* it, which puts its shadow on the wrong side of itself. */
  /* Switched by the shadow's *intensity*, not by `castShadow`.  Turning
   * `castShadow` off changes the light configuration every lit material
   * is compiled for, so every dusk recompiled the whole scene -- a
   * 350 ms freeze on an Intel HD 630, the first time each session.  At
   * zero intensity the shadow term is exactly 1, which is the same
   * picture, and with `autoUpdate` off the map is not drawn either, so the
   * night still saves the pass. */
  const casting = atmos.key.dir.y > 0.06 && atmos.key.level > 0.05;
  sun.shadow.intensity = casting ? 1 : 0;
  sun.shadow.autoUpdate = casting;
  hemi.color.copy(atmos.hemi.sky);
  hemi.groundColor.copy(atmos.hemi.ground);
  hemi.intensity = atmos.hemi.level;
  if (fill) fill.intensity = 0.95 * clock.daylight;

  headlights.update(clock, car, w.wetness);
  headlights.paint(coupe, braking);
}

/**
 * What the ear is told, once a frame.
 *
 * The engine hears the car and the pedals; the rest hears the same
 * numbers the picture is painted from -- the weather *here*, the lying
 * snow, the sun's altitude -- so a shower you can see is a shower you can
 * hear and it stops in the same place.  `still` is a car nobody is
 * driving: a rest, which owns the pedals.
 */
const _ear = { car };
function listen(dt, w, axes, lapsing) {
  _ear.brake = axes ? axes.brake : 0;
  _ear.lapsing = lapsing;
  _ear.still = lapsing;
  _ear.warp = 0;
  _ear.view = chase.mode;
  _ear.zoom = chase.zoom;
  _ear.here = weather.here;
  _ear.wetness = w.wetness;
  /* Snow deadens a landscape, falling or lying. */
  _ear.hush = Math.max(weather.here.snow, 0.6 * seasonSnow(w));
  _ear.season = clock.season.weights;
  _ear.daylight = clock.daylight;
  _ear.night = clock.night;
  _ear.sunAlt = clock.sun.alt;
  sound.update(dt, _ear);
}

/* Scratch for the per-frame road queries.  Two objects rather than two
 * allocations a frame. */
const _near = {};
const _tan = {};

/* --------------------------------- frame --------------------------------- */
function tick(dt) {
  simTime += dt;

  /* 0. time, weather, and the one palette everything reads.
   *
   * This runs before anything that draws, and the order inside it is not
   * negotiable: the clock decides where the sun is, the weather decides
   * how much of it gets through, and the atmosphere turns those two into
   * the colours that the sky, the fog, the background, both lights, the
   * clouds and the grade all get written from.  Six consumers, one
   * source -- which is the only way the fog colour and the sky's horizon
   * colour can be guaranteed to be the same colour, and three separate
   * comments in this file are about what happens when they are not. */
  /* A time-lapse owns the clock while it runs, and moves the weather with
   * it -- so the ordinary advance is skipped rather than added to.  See
   * `timelapse.js`: this is the only other thing in the project that is
   * allowed to move `clock.t`. */
  /* Where "here" is, for the local half of the weather.  Before the
   * update, because `localAt` is evaluated inside it. */
  weather.at.x = car.pos.x;
  weather.at.z = car.pos.z;

  const lapsing = lapse.step(dt);
  if (!lapsing) clock.advance(dt);
  const w = lapsing ? weather.p : weather.update(dt, clock);
  /* The cloud field drifts on the *game* clock, so it is in the right
   * place after a rest rather than where it was twelve hours ago.  During
   * a lapse the field is advanced by the lapse itself. */
  if (!lapsing) cloudField.update(dt, w, clock);
  atmos.update(clock, w, seasonSnow(w), weather.here);

  sky.set(atmos.top, atmos.mid, atmos.haze);
  sky.setSun(clock.sun.dir, atmos.key.colour, clock.daylight);
  sky.setRainbow(weather.rainbow(clock));
  scene.fog.color.copy(atmos.haze);
  scene.fog.near = atmos.fog.near;
  scene.fog.far = atmos.fog.far;
  scene.background.copy(atmos.haze);
  if (pipeline) pipeline.setNight(clock.night, atmos.grade);

  /* And the season block, which four materials share by reference. */
  setSeason(clock.season.weights, seasonSnow(w), w.wetness);

  /* Weather in the tyres.  Deliberately mild -- the whole brief for this
   * iteration is a relaxing drive, and a car that steps out in the wet is
   * the opposite of that. */
  car.weatherGrip = weather.here.grip;

  /* And while a lapse is running, that is the whole frame.
   *
   * The sky is still painted -- that is the point of resting on screen
   * rather than in a black fade -- but nothing is simulated: no physics,
   * no road, no chunk field.  The car is standing still, so
   * there is nothing under it to rebuild, and running the chunk field at
   * twenty thousand times real speed would queue several thousand chunks
   * for a landscape that is not moving. */
  if (lapsing) {
    /* Any driving key ends it where it stands.  A player who changes their
     * mind half a second into a twelve-hour rest should not have to watch
     * the other eleven and a half. */
    if (input.driving()) lapse.cancel();
    paintWorld(0, w, { moving: false, braking: false });
    listen(dt, w, null, true);
    hud.update(odometer, car.speed, simTime);
    hud.setSky(`${clock.clockText}   ${clock.season.name}   ${weather.text}`);
    hud.setRest(lapse.label, lapse.progress);
    return;
  }

  /* 1. the road always leads the ground.
   *
   * The lead is the chunk field's own forward reach plus a margin, not a
   * constant: it was 1600 m against a field that asks for ground 2380 m
   * ahead, so every chunk built in the last 780 m of that ellipse found no
   * road, took the coarsest LOD and baked bare hillside where the road was
   * about to be.  The tracer runs at 4600 km/s in the sweep, so leading by
   * a couple of kilometres is free; what is not free is a chunk that has
   * to be thrown away and rebuilt once the road arrives. */
  const q = road.nearest(car.pos.x, car.pos.z, _near);
  const s = q ? q.s : 0;
  /* **Which way along the road the car is pointing.**
   *
   * The arc coordinate is signed since `prompt_5.md` item 4, so "ahead"
   * is not "+s" any more -- it is +s or -s depending on the car's heading
   * against the road's tangent.  Everything that leads the trace, and the
   * autopilot's whole lookahead, needs it, and it is maintained here
   * rather than inside `Autodrive` because it is wanted every frame and
   * the autopilot only runs when it is holding something.
   *
   * A dead band, because a car crossing the road exactly sideways would
   * otherwise flip the sign every frame and the lead would thrash. */
  if (q) {
    road.sampleAt(s, _tan);
    const along = _tan.tx * Math.cos(car.yaw) + _tan.tz * Math.sin(car.yaw);
    if (Math.abs(along) > 0.12) auto.dir = along > 0 ? 1 : -1;
  }
  /* Buy tarmac until the traced tail is out past the ground being built,
   * and give it back when it is well past.  Both rates are per second so
   * the servo does not depend on the frame rate, and the cap keeps a road
   * that loops back on itself from tracing for ever. */
  /* What the tracers may not take back.  Before the extend, so a revert
   * inside this frame's tracing already knows. */
  road.protect(s);
  const need = NEED();
  /* **Both ways.**  `prompt_5.md` item 4 gave the road a backward half, so
   * there are two tails and the servo watches whichever one the car is
   * driving toward.  `auto.dir` is +1 when the car points along the road's
   * tangent and -1 when it points back down it, and it is maintained
   * whether or not the autopilot is holding anything. */
  const ahead = auto.dir >= 0 ? road.tail : road.tailBack;
  const straight = Math.hypot(ahead.x - car.pos.x, ahead.z - car.pos.z);
  if (LEAD_PIN) roadLead = need * LEAD_PIN;
  else if (straight < need) roadLead = Math.min(need * LEAD_MAX, roadLead + 900 * dt);
  else if (straight > need * 1.3) roadLead = Math.max(need, roadLead - 300 * dt);
  /* The lead goes where the car is going and a shorter one goes behind it,
   * so turning round is never a wait for the tarmac to arrive: at cruise
   * the trailing 600 m is four times the distance a U-turn covers. */
  if (auto.dir >= 0) road.extend(s, roadLead, 64, 600);
  else { road.extendBehind(s, roadLead, 64); road.extendAhead(s, 600, 64); }

  /* Two ways the ground and the road can disagree, and both are rebuilds.
   *
   * The road *left*: the tracer backtracked, and the ground it abandoned
   * was benched to a carriageway that is no longer there.  Rare -- about
   * five reverts in a whole road.
   *
   * The road *arrived*: ground that was built before the road was traced
   * through it, which happens constantly and with no backtracking at all,
   * because the field is an ellipse in straight lines and the lead is in
   * arc length.  Nothing was rebuilding those: `_relod` reacts only to a
   * change of resolution, and a chunk that was already at 1 m stays at
   * 1 m for ever.  See `RoadPath.takeLaidBoxes`.
   *
   * Both boxes get a chunk's margin either side, for the earthworks: a
   * 12 m embankment daylights nearly thirty metres past the platform. */
  /* Four boxes, not two: one dirty and one laid **per line**.  Merging
   * the two lines' boxes into one spans the whole road and invalidates the
   * ground under the car -- see `RoadPath.laidBoxes`. */
  for (const box of [...road.takeDirtyBoxes(), ...road.takeLaidBoxes()]) {
    if (box) chunks.invalidate(box.minX - 64, box.minZ - 64, box.maxX + 64, box.maxZ + 64);
  }

  /* 2. controls.
   *
   * The driver always wins, and now wins *per channel*: the autopilot is
   * handed what the human is asking for and merges it, holding only the
   * channels its mode says it holds and standing off any channel the
   * driver is touching.  So `A` in "auto speed" steers the car without
   * disengaging anything, which is the entire point of the mode.
   *
   * `input.active()` and `armTakeover` are still here and still doing the
   * job they were written for: they are what stops `F` pressed with `W`
   * held from reading as an immediate override. */
  const manual = input.sample(dt);
  const held = input.active();
  if (auto.mode > 0 && input.handbrakePulled()) handbrakeOff();
  const axes = auto.mode > 0 ? auto.update(dt, held ? manual : null) : manual;
  hud.setMode(badge(axes));

  /* 3. the car -- and the ground it is standing on has to be in the
   * physics world before the wheels look for it, or the first frame after
   * a chunk arrives is a frame of the car falling through the hole where
   * it will be. */
  physics.syncTerrain(chunks, car.pos.x, car.pos.z);
  physics.syncRails(furniture, road, car.pos.x, car.pos.z);
  physics.syncTrees(scatter, car.pos.x, car.pos.z);
  car.update(dt, axes);
  car.applyTo(coupe.group);
  /* The wheels, on three channels that must not be the same object -- see
   * `body.js:buildCoupe`.  The roll is *positive* about +X: with forward
   * on +Z, a rotation about +X carries the top of the wheel forward, and
   * the minus sign that used to be here had all four spinning backwards
   * down the road.  Invisible on a smooth cylinder, which is what the
   * built-in coupe has and is why it survived this long. */
  for (const w of coupe.wheels) w.rotation.x = car.wheelSpin;
  for (const w of coupe.steerWheels) w.rotation.y = -car.steer;
  /* And the suspension, so the tyres stay on the tarmac over a crest
   * instead of the whole car rising off it. */
  const hubs = coupe.hubs;
  if (hubs) for (let i = 0; i < hubs.length; i++) {
    hubs[i].position.y = hubs[i].userData.hubY + car.wheelY[i];
  }

  // 4. the ground under it
  const fx = Math.cos(car.yaw), fz = Math.sin(car.yaw);
  chunks.update(car.pos.x, car.pos.z, fx, fz, dt);
  scatter.update(car.pos.x, car.pos.z);
  furniture.update(Math.max(0, s - 200), s + 620);

  paintWorld(dt, w, { moving: true, braking: axes.brake > 0.1 });
  listen(dt, w, axes, false);

  /* The safety net.  Upside down, or under water, and no amount of
   * throttle will fix it -- so count the seconds and put the car back. */
  if (car.inTrouble || car.pos.y < WATER_LEVEL - 0.4) troubleFor += dt;
  else troubleFor = 0;
  if (troubleFor > 3.5) recover();

  odometer += Math.abs(car.speed) * dt;
  hud.update(odometer, car.speed, simTime);
  hud.setSky(`${clock.clockText}   ${clock.season.name}   ${weather.text}`);
  /* Cheap: three comparisons.  The *search* for where a rest would end
   * happens on the press, not here. */
  hud.setRest(restLabel(), 0);
  /* And which camera, with the wheel's multiplier when it is not 1.  Every
   * frame, because the zoom eases and the toast that used to be the only
   * readout was gone in 1.8 seconds -- see `hud.setCamera`. */
  hud.setCamera(CAM_MODES[chase.mode].name, chase.zoom);

  /* The save, throttled to once every couple of seconds.  It stores a
   * seed and two positions and nothing derived, because everything else
   * in the world is a pure function of those. */
  if (!RECORDING) {
    save.write({
      seed: seedText, t: clock.t, s, odometer,
      camera: chase.mode, auto: auto.name,
    }, simTime);
  }
}

/* --------------------------------- loop ---------------------------------- */
/* The pipeline has to exist before the first `resize()`, which is called
 * at module scope: `resize` asks it for its render-target size, and a
 * `const` referenced before its initialiser throws.  The symptom was not
 * an error anyone saw -- it was a 2x2 render target upscaled to the
 * window, which reads as a perfectly smooth vertical gradient and looks
 * exactly like a sky with no world in it. */
const pipeline = CEL ? new Pipeline(renderer, scene, camera,
  { maxScale: Q.scale }) : null;

/**
 * `?sky=only`: hide everything that is not the sky.
 *
 * `tools/cloud/compare.mjs` puts our sky beside a photograph of one, and a
 * photograph of a sky has no road in it -- a comparison whose bottom third
 * is hillside is a comparison of hillsides.  A layer mask rather than a
 * traversal, so it costs one line in `draw` and nothing per object: the
 * sky dome, the celestial bodies and the cloud composite stay on layer 0
 * and everything the world builds is moved to layer 1 at creation.
 *
 * Except that moving several thousand objects to a layer is exactly the
 * kind of bookkeeping that goes wrong when a pool hands a mesh back.  So
 * it is the camera's `layers` that changes and the *scene* is walked once
 * per draw instead -- under `?sky=only` only, which is a capture mode.
 */
const SKY_ONLY = params.get('sky') === 'only';

function hideWorld(on) {
  for (const o of scene.children) {
    if (o === sky.dome || o === celestial.group || o === (clouds && clouds.composite)
        || o.isLight) continue;
    o.visible = !on;
  }
}

function draw() {
  /* The cloud march goes into its own target first: it is read by a quad
   * that draws inside the main render, so it cannot be produced during
   * one. */
  if (clouds) clouds.render(renderer);
  if (SKY_ONLY) hideWorld(true);
  if (pipeline) pipeline.render();
  else renderer.render(scene, camera);
  if (SKY_ONLY) hideWorld(false);
}

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (pipeline) pipeline.setSize(w, h);
  else renderer.setSize(w, h, false);
  /* Off the *render target's* size, not the window's: `Pipeline` scales
   * the scene to a pixel budget, and a cloud buffer sized to the window
   * would be a different fraction of the frame on every machine. */
  if (clouds) {
    const rt = pipeline ? pipeline.rtScene : null;
    clouds.setSize(rt ? rt.width : w, rt ? rt.height : h);
  }
}
addEventListener('resize', resize);
/* Two ways a phone changes the size of the viewport without a `resize`
 * that arrives in time: the rotation (the event fires before the new
 * metrics are readable, hence the tick of delay) and the address bar
 * sliding away as you scroll -- which is not a scroll here, but the
 * visual viewport still moves for it. */
addEventListener('orientationchange', () => setTimeout(resize, 150));
visualViewport?.addEventListener('resize', resize);
resize();

/* Dynamic resolution: the render scale follows the frame rate, inside the
 * tier's range.  Never under `?rec`, whose frames are stepped by a script
 * at whatever speed the machine manages and have to be the same picture
 * every time, and never without the cel pipeline, which is what scales. */
const governor = new ResolutionGovernor({
  scale: Q.scale, minScale: Q.minScale, maxScale: Q.maxScale,
  enabled: !RECORDING && !!pipeline && params.get('dynres') !== '0',
  effective: (s) => pipeline.scaleFor(innerWidth, innerHeight, s),
  apply: (s) => { pipeline.maxScale = s; resize(); },
});

/* The recorder drives `step()` itself at a fixed dt, so thirty steps are
 * one second of film however long the machine takes over them, and the
 * film is the same film every time.  A hook rather than a monkeypatch on
 * requestAnimationFrame, because we own the loop; the sibling project has
 * to patch rAF only because its recorder cannot change the page. */
/* The wall clock, as distinct from `clock`, which is the world's. */
const wall = new THREE.Clock();
function frame() {
  /* The pause gate.  Not a `dt` of zero: `tick` would still run the road,
   * the chunk field and the road, and `draw` would still cost a frame for
   * a picture nobody can see behind an opaque overlay. */
  if (paused) return;
  const raw = wall.getDelta();
  const dt = Math.min(0.05, raw);
  governor.frame(raw);
  tick(dt);
  draw();
  requestAnimationFrame(frame);
}

function step(dt) {
  tick(dt);
  draw();
}

/* ------------------------------ the boot --------------------------------- *
 * The world is *built* here and only starts *running* when the player asks
 * for it.  That distinction matters more in this iteration than it would
 * have in any previous one: with a clock and a weather model, a loader left
 * up for forty seconds would otherwise quietly burn forty game-minutes of
 * weather before the car had moved. */
loader.step('physics');

/* Resuming means tracing to the saved arc position before any ground is
 * built around the wrong place.  The tracer runs at 700 km/s, so eight
 * kilometres of resume costs about 11 ms -- but it has to happen *before*
 * the first `chunks.flush()`, not after. */
let startS = 20;
if (resumable) {
  /* No `Math.max(20, ...)` any more: the arc coordinate is signed and a
   * saved drive can legitimately be a kilometre *behind* the origin. */
  startS = resumable.s;
  road.extend(Math.max(0, startS), Math.abs(startS) + roadLead, 20000,
              Math.max(600, roadLead - startS));
  odometer = resumable.odometer;
  /* Cycle to the saved camera, **bounded**.
   *
   * The unbounded version of this loop is what a malformed save cookie
   * turned into a hang: it spun for ever on a camera name that no amount
   * of cycling would ever produce, on the module's top level, so the page
   * never finished executing and `window.__game` never existed.  A save
   * file is untrusted input like any other. */
  for (let i = 0; i < 4 && chase.mode !== resumable.camera; i++) chase.cycle();
}
car.placeOn(road, startS);

/* Ground under the car before the first step, not four frames later: the
 * wheels raycast, and a raycast against an empty world is a car falling. */
chunks.update(car.pos.x, car.pos.z, Math.cos(car.yaw), Math.sin(car.yaw), 0);
chunks.flush();
loader.step('landscape');
/* These chunks were built against the road as it now stands, so the box
 * the startup trace accumulated is already accounted for.  Left unclaimed
 * it would arrive at the first frame and invalidate the entire world. */
road.takeLaidBoxes();
physics.syncTerrain(chunks, car.pos.x, car.pos.z);
car.placeOn(road, startS);

scatter.update(car.pos.x, car.pos.z);
loader.step('scenery');

if (RECORDING) {
  document.body.classList.add('clean');
  hud.clean = true;
  /* Settle the world before frame zero: the chunk builder is on a 4 ms
   * budget, so a cold start films forty frames of empty hillside. */
  for (let i = 0; i < 90; i++) step(1 / 30);
} else {
  boot();
}

/**
 * Everything between "the page exists" and "the player is driving".
 *
 * The GLB is waited on with a timeout rather than awaited outright,
 * because `main.js`'s own rule about it still holds -- *a car is not
 * optional, and a download is* -- and the code-built coupe is already the
 * fallback if it never lands.
 */
async function boot() {
  await Promise.race([carReady, sleep(2500)]);
  loader.step('car');
  await Promise.race([celestial.ready, sleep(1500)]);
  loader.step('stars');

  /* Settle, exactly as the recorder does, so the first frame the player
   * sees is of a world that has finished arriving rather than one that is
   * still turning up.  `step` rather than `frame` -- the loop has not
   * started yet and must not, or the clock runs under the loader. */
  for (let i = 0; i < 30; i++) {
    tick(1 / 30);
    chunks.flush();
  }
  /* Those thirty steps moved the clock a second and the car not at all;
   * put both back so the drive starts where the save said it did. */
  clock.t = startTime();
  clock.update();
  car.placeOn(road, startS);
  odometer = resumable ? resumable.odometer : 0;
  simTime = 0;
  draw();
  loader.step('settling');

  if (resumable) {
    const miles = (resumable.odometer / 1609.344).toFixed(1);
    loader.offerResume(`${miles} miles · ${clock.season.name} · ${clock.clockText}`);
  }
  loader.offer();

  const how = await loader.ready;
  if (how === 'new') {
    freshStart();
    return;
  }
  frame();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Snapshots that came back off a cleared drawing buffer; see `grab`. */
let grabRetries = 0;

/* The handle the recorder and the probes drive everything through. */
window.__game = {
  scene, camera, renderer, terrain, road, chunks, scatter,
  car, chase, auto, input, hud, sky, furniture, pipeline, physics, pointer,
  sound,
  clock, weather, atmos, celestial, precip, headlights, save, loader, lapse,
  cloudField, clouds, touch, governor,
  /** Which tier, why, and on what -- see `core/quality.js`. */
  quality: { tier: TIER.name, why: TIER.why, gpu: GPU },
  /** For `tools/probe/rest.mjs`: what `Z` would do, and doing it. */
  restLabel, restTarget, rest,
  /** Dismiss the load screen from a script.  A probe that cannot click
   *  otherwise has no way past it -- see `loader.js`. */
  start(how = 'resume') { loader.start(how); },
  /** Resolves when the world has finished arriving.  Capture harnesses
   *  should wait on this rather than on a sleep. */
  get loaded() { return loader.ready; },
  /** Put the clock somewhere, for the probes and for `?t`. */
  setTime(hours) { clock.setTimeOfDay(hours); },
  get odometer() { return odometer; },
  get simTime() { return simTime; },
  clean(on = true) { hud.clean = on; document.body.classList.toggle('clean', on); },
  step, recording: RECORDING,
  /**
   * Render inside the browser's own frame callback and resolve when it is
   * done.  `step()` on its own renders whenever the script says so, which
   * can be an arbitrary time before the compositor next runs -- and a
   * screenshot taken across that gap catches whatever the compositor had,
   * not what was drawn.  Awaiting a rAF puts the draw immediately before
   * the composite, which is the only ordering the capture can rely on.
   */
  present() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        draw();
        requestAnimationFrame(() => resolve(true));
      });
    });
  },

  /**
   * The rendered frame, as a PNG data URL, read straight off the canvas.
   *
   * `Page.captureScreenshot` grabs the *compositor's* surface, and the
   * compositor runs on its own schedule -- so a frame drawn by `step()`
   * and then captured could come back as whatever had last been
   * composited, which in practice meant stills of a scene from several
   * seconds and one teleport ago.  Three separate "rendering bugs" in two
   * rounds of captured stills were this and nothing else.  Reading the
   * canvas is exact, and it is only possible at all because recording mode
   * asks for `preserveDrawingBuffer`.
   *
   * The `finish()` is not defensive; without it about one frame in two
   * hundred came back **entirely black**, and the films flickered.
   * `toDataURL` snapshots the drawing buffer, and the draw above has only
   * been *issued* -- the commands are still in flight on the GPU when the
   * snapshot is taken, and losing that race gives a cleared buffer rather
   * than a stale one, which is why it is black rather than a frame late.
   * It is a race, so it went unseen: 800 captured frames without the sync
   * gave five black, with it none, and one bad frame per seven seconds of
   * film is invisible in a still and impossible to miss in a film.
   *
   * `finish()` is the sledgehammer of GL synchronisation and here that is
   * exactly right -- this path is never on a player's frame budget, and
   * the alternative (a fence, polled) buys nothing when the very next
   * thing we do is block on a PNG encode anyway.
   *
   * It is not quite the whole cure -- one frame in a few thousand still
   * came back black with the sync in -- so the snapshot is *checked*, and
   * a cleared buffer is drawn again rather than handed back.  Four
   * corners, because a cleared buffer is zero everywhere and a rendered
   * frame is not: even the moonlit shots have a sky above the horizon.  A
   * real frame that does read zero at all four costs a redraw and is then
   * returned anyway, so the test is allowed to be wrong in that
   * direction and not in the other.
   *
   * A redraw is not quite free of consequence: `draw` advances the cloud
   * march, which is progressive, so a film that had to retry a frame
   * differs from one that did not by a fraction of a cloud march on that
   * frame.  That is the price of the frame not being black, and it is
   * worth paying -- but it is why the recorder counts retries and says so
   * rather than swallowing them.
   */
  grab() {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    const w = canvas.width, h = canvas.height;
    const corners = [[w >> 2, h >> 2], [w - (w >> 2), h >> 2],
                     [w >> 2, h - (h >> 2)], [w - (w >> 2), h - (h >> 2)]];
    let url = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      draw();
      gl.finish();
      url = canvas.toDataURL('image/png');
      let lit = false;
      for (const [x, y] of corners) {
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (px[0] || px[1] || px[2]) { lit = true; break; }
      }
      if (lit) return url;
      grabRetries++;
    }
    return url;
  },
  /** How many snapshots came back cleared and had to be drawn again. */
  get grabRetries() { return grabRetries; },
  /** Put the car at an arc position and settle the world around it. */
  jumpTo(metres, settle = 60) {
    car.placeOn(road, metres);
    chunks.reset();
    odometer = metres;
    chase.started = false;
    for (let i = 0; i < settle; i++) {
      step(1 / 30);
      /* Build the whole outstanding queue rather than a frame's worth.  A
       * still is not a frame of gameplay -- it has to be of a world that
       * has finished arriving, or it is a photograph of the loader. */
      chunks.flush();
    }
    chunks.flush();
  },
  seed: seedText,
  seedNumber: SEED,
};
