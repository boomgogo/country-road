import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cel, flat } from '../core/toon.js';
import { assetUrl } from '../core/assets.js';
import { patchClouds } from '../world/cloudfield.js';
import { METRICS, RIDE_SAG } from './vehicle.js';
import { buildCoupe } from './body.js';

/* ------------------------------------------------------------------ *
 * Loading the car.
 *
 * The GLB is geometry and names, and nothing else: **every material it
 * ships with is thrown away** and replaced by one from `toon.js`, picked
 * by the glTF *material* name.  That is the whole reason a car model is
 * worth authoring with named materials -- `Paint`, `Glass`, `TailLight`,
 * `Tyre` -- rather than with one texture atlas.  An imported glTF
 * material renders as a photograph pasted onto a painting, and the rest
 * of this world is a painting.
 *
 * Nothing else in the model is trusted either.  Where the wheels are is
 * read off the model, but how high they sit is computed from the tyre
 * the model actually drew and the ride height the *simulation* believes
 * in, so the tyre touches the road rather than hovering over it or
 * sinking into it.  See `seat()` and `pullWheels()`.
 *
 * If the model is missing the game falls back to the neutral coupe built
 * in code.  A car is not optional, and a download is.
 * ------------------------------------------------------------------ */

/**
 * The car's palette, and it is the game's rather than the model's.
 *
 * The GLB paints itself dark slate over black trim, which is a handsome
 * car and the wrong one for this road: the chase camera holds the car
 * against tarmac for the whole film, and a dark car on a dark road is a
 * silhouette with the wheels missing.  Pale over a dark glasshouse is
 * what every still in the README was framed around.  Change `body` here
 * and the whole car changes with it.
 */
const MATS = {
  body: () => cel({ color: 0xe9eaec, roughness: 0.32, metalness: 0.12, cache: false }),
  trim: () => cel({ color: 0x1e2024, roughness: 0.70, cache: false }),
  soft: () => cel({ color: 0x2a2c31, roughness: 0.95, cache: false }),
  glass: () => cel({ color: 0x14181e, roughness: 0.08, metalness: 0.25, cache: false }),
  rim: () => cel({ color: 0x9aa0a7, roughness: 0.30, metalness: 0.55, cache: false }),
  tyre: () => cel({ color: 0x141518, roughness: 0.95, flat: true, cache: false }),
  /* Unlit, and **uncached**: `Headlights.paint` writes the colour of these
   * every frame, and a cached `flat()` is shared with anything else that
   * asked for the same hex -- which would put the brake lights on the
   * scenery. */
  light_front: () => flat({ color: 0xf0efe6, cache: false }),
  light_rear: () => flat({ color: 0xc2352c, cache: false }),
};

/** glTF material name (lower-cased, suffix stripped) -> which of `MATS`. */
const BY_MATERIAL = {
  paint: 'body', body: 'body', carpaint: 'body',
  trimblack: 'trim', trim: 'trim', black: 'trim',
  softtop: 'soft',
  glass: 'glass',
  lightlens: 'light_front', headlight: 'light_front', drl: 'light_front',
  light_front: 'light_front',
  taillight: 'light_rear', light_rear: 'light_rear',
  rim: 'rim', wheel: 'rim',
  tyre: 'tyre', tire: 'tyre',
};

/** Blender's `.001` and three's uniquing suffix are not part of the name. */
function clean(name) {
  return String(name || '').toLowerCase().replace(/\.\d+$/, '').replace(/_\d+$/, '');
}

/**
 * Which material a mesh gets.
 *
 * Material name first, object name second.  The material name is the one
 * that can tell paint from glasshouse on a body that is a single mesh;
 * the object name is what the older script-built GLB had instead, and
 * carrying both means one loader reads either.
 */
function keyFor(matName, objName) {
  const byMat = BY_MATERIAL[clean(matName)];
  if (byMat) return byMat;
  const n = clean(objName);
  if (n.startsWith('wheel') || n.startsWith('tyre')) return 'tyre';
  if (n.startsWith('light_rear')) return 'light_rear';
  if (n.startsWith('light_front')) return 'light_front';
  if (n.startsWith('glass')) return 'glass';
  return 'body';
}

/**
 * The car takes the cloud shadow too.
 *
 * Not decoration: without it a cloud crosses the road, the tarmac and the
 * verge and the trees all go down together, and the car stays lit -- which
 * reads as the car being pasted onto the scene rather than standing in it.
 * `flat()` materials (the lamp lenses) are unlit, and are left alone on
 * purpose: a lens is not shaded.
 */
function materialFor(key) {
  const mat = MATS[key]();
  return key.startsWith('light') ? mat : patchClouds(mat, key);
}

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/** Every mesh under `root`, painted and named for what it is. */
function paint(root) {
  let meshes = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const key = keyFor(o.material && o.material.name, o.name);
    o.material = materialFor(key);
    o.castShadow = true;
    o.receiveShadow = !key.startsWith('light');
    /* `Headlights.paint` finds the lamps by object name, and on a
     * multi-primitive mesh the lens arrives called `Car_Glass_mesh001_2`.
     * Rename it to what it is, once, here -- so the brake lights are a
     * property of the model's *materials* and lights.js never has to
     * learn a new naming scheme. */
    if (key === 'light_front' || key === 'light_rear') o.name = key;
  });
  return meshes;
}

const WHEEL_NAMES = new Set(['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']);

/**
 * Take the four wheels out of the model and hang them on pivots of ours.
 *
 * The geometry is the model's, the *rig* is ours, and that split is the
 * whole point.  A wheel needs two rotations that must not interfere --
 * steering about Y and rolling about X -- and one object cannot carry
 * both: three.js composes a single Euler as `Rx * Ry * Rz`, so the roll
 * would swing the steering axis and a wheel at full lock would corkscrew.
 * So: a hub that steers, a spin group inside it that rolls, and the
 * model's wheel inside that.
 *
 * The hub's height is not the model's either.  The simulation's road is
 * a wheel-radius below the wheel centre and it uses `METRICS.axleHeight`
 * for that radius; the model drew whatever tyre it drew (this model's rears
 * are the larger, which is worth keeping).  Seating each hub at
 * `radius - axleHeight` puts the *drawn* tread exactly on the *simulated*
 * road, whatever size the tyre is.
 */
function pullWheels(src, group, flip) {
  const found = [];
  src.traverse((o) => {
    if (WHEEL_NAMES.has(o.name.toLowerCase())) found.push(o);
  });

  const out = [];
  for (const node of found) {
    node.updateWorldMatrix(true, false);
    node.getWorldPosition(_v);              // the hub, in the car's own frame
    node.removeFromParent();
    node.position.set(0, 0, 0);
    node.rotation.set(0, flip, 0);          // the flip its parent used to carry
    node.scale.set(1, 1, 1);
    node.updateMatrixWorld(true);

    /* The tyre's radius, off the tyre.  Y is the one axis a wheel's box
     * cannot lie about: it is neither the axle nor the direction of
     * travel, so it is the tread, on both sides of the hub. */
    _box.setFromObject(node);
    const radius = Math.max(0.05, (_box.max.y - _box.min.y) / 2);

    const spin = new THREE.Group();
    spin.add(node);
    const hub = new THREE.Group();
    hub.position.set(_v.x, radius - METRICS.axleHeight, _v.z);
    hub.userData.hubY = hub.position.y;
    hub.add(spin);
    group.add(hub);
    out.push({ hub, spin, x: _v.x, z: _v.z });
  }

  /* Into the order the *physics* uses, which is by position and not by
   * name: `Vehicle` adds its wheels front-first and, within an axle, at
   * -x then +x.  Sorting on the sign of z rather than on z itself is
   * deliberate -- the two front hubs sit a tenth of a millimetre apart in
   * z, which is enough for a plain `b.z - a.z` to decide the axle and
   * never reach the tie-break that actually matters. */
  out.sort((a, b) => (Math.sign(b.z) - Math.sign(a.z)) || (a.x - b.x));
  return out;
}

/**
 * Seat the car on the road.
 *
 * The model is authored standing on y = 0; the vehicle's origin is the
 * *hub* line, and at rest the car hangs a static sag below it -- 4.7 cm,
 * being `g / (4 * stiffness)`, and the suspension is a real spring so
 * this is not a fudge factor but where the car actually sits.  Measure
 * the model's own underside rather than trusting it to be at zero, and
 * drop it so its wheels stand on the road the wheels are raycasting
 * against.  A car that floats three centimetres over the road is the sort
 * of thing nobody notices for a week and then cannot stop seeing.
 */
function seat(src) {
  _box.setFromObject(src);
  return RIDE_SAG - METRICS.axleHeight - _box.min.y;
}

/**
 * Returns `{ group, wheels, steerWheels, hubs }` exactly as `buildCoupe`
 * does, so `main.js` cannot tell which car it got:
 *
 *   - `wheels`      roll on `rotation.x`
 *   - `steerWheels` steer on `rotation.y`
 *   - `hubs`        take the suspension on `position.y`, over `userData.hubY`
 */
export async function loadCar(url = assetUrl('models/car/sportscar_low.glb')) {
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const src = gltf.scene;

    const meshes = paint(src);
    if (!meshes) throw new Error('no meshes in ' + url);

    /* Which way the car faces.  This model is drawn nose-on-minus-Z --
     * its tail lights are at +z -- and the whole game is `+Z is forward`,
     * from the vehicle's own frame outward.  Turning the model round once,
     * here, is the cheapest place to settle it; every alternative ends up
     * with a minus sign in the chase camera. */
    const flip = Math.PI;
    src.rotation.y = flip;
    src.position.y = seat(src);
    src.updateMatrixWorld(true);

    const group = new THREE.Group();
    group.add(src);

    const corners = pullWheels(src, group, flip);
    if (corners.length !== 4) {
      throw new Error('found ' + corners.length + ' wheels in ' + url +
        ' (want wheel_FL, wheel_FR, wheel_RL, wheel_RR)');
    }

    return {
      group,
      wheels: corners.map((c) => c.spin),
      steerWheels: corners.filter((c) => c.z > 0).map((c) => c.hub),
      hubs: corners.map((c) => c.hub),
      source: url,
    };
  } catch (err) {
    console.warn('[car] falling back to the code-built coupe:', err.message);
    return { ...buildCoupe(), source: 'built-in' };
  }
}
