import * as THREE from 'three';
import { cel, flat } from '../core/toon.js';
import { METRICS } from './vehicle.js';

/* ------------------------------------------------------------------ *
 * The neutral coupe.
 *
 * Not the modelled car.  The chase camera puts the car across the bottom third
 * of every frame, so something has to be there from the first frame, and
 * the modelled car is a download.  So: a stand-in of the same silhouette class,
 * built in code, pale over a dark glasshouse.  The modelled car replaces it
 * when it lands, at the same dimensions, so nothing has to be re-tuned.
 *
 * The shape is one extruded side profile with a width taper applied
 * afterwards -- forty lines for a body that reads as a car, against
 * several hundred for the same thing assembled out of boxes.
 * ------------------------------------------------------------------ */

const L = METRICS.bodyLength;
const W = METRICS.bodyWidth;

/**
 * The side profile, in metres, nose at +z.
 *
 * Redrawn once the shape could be seen from the side rather than from
 * behind: the first one had a 2.7 m cabin and an 0.86 m tail, and with the
 * glasshouse painted dark across all of it the car read as a pickup with a
 * canopy on the back.  A coupe is a *third* bonnet, a third cabin, a third
 * deck, and its tail is lower than its screen base.
 */
function profile() {
  const s = new THREE.Shape();
  const hl = L / 2;
  s.moveTo(hl - 0.12, 0.40);                                   // under the nose
  s.lineTo(hl, 0.54);                                          // nose tip, low
  s.bezierCurveTo(hl - 0.10, 0.74, hl - 0.30, 0.80, hl - 0.55, 0.84);
  s.bezierCurveTo(hl - 1.05, 0.88, hl - 1.35, 0.89, hl - 1.58, 0.92);  // bonnet
  s.bezierCurveTo(hl - 2.00, 0.99, hl - 2.22, 1.18, hl - 2.42, 1.28);  // screen
  s.bezierCurveTo(hl - 2.70, 1.325, hl - 2.95, 1.33, hl - 3.20, 1.31); // roof
  s.bezierCurveTo(hl - 3.70, 1.26, hl - 4.05, 1.04, hl - 4.26, 0.90);  // fastback
  s.lineTo(hl - 4.44, 0.82);                                   // rear deck
  s.lineTo(-hl, 0.74);
  s.lineTo(-hl, 0.44);                                         // tail panel
  s.lineTo(-hl + 0.18, 0.36);
  s.lineTo(hl - 0.12, 0.40);
  return s;
}

const WB = METRICS.wheelbase / 2 / (L / 2);   // axle position in -1..1 body space

function taper(geo) {
  const p = geo.attributes.position;
  const hl = L / 2;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = z / hl;                                 // -1 tail .. +1 nose
    /* The rear overhang tucks in hard.  From directly astern -- which is
     * the chase camera's whole life -- a body as wide at the tail as it is
     * at the axle hides both rear tyres behind itself, which is physically
     * true of a real car and is exactly what read in stills as "no wheels
     * visible at all".  Narrower at the tail than the track, the tyres
     * show past the bumper. */
    let k = 1 - 0.20 * Math.max(0, t) ** 2 - 0.30 * Math.max(0, -t) ** 3;
    // haunches: a little extra just behind the middle
    k += 0.040 * Math.exp(-((t + 0.22) ** 2) / 0.16);
    // the greenhouse is narrower than the body it sits on
    const yy = y + METRICS.axleHeight;                  // back to profile space
    if (yy > 0.98) k *= 1 - Math.min(0.30, (yy - 0.98) * 0.85);

    /* Wheel arches, and they are not decoration.  The one *systematic*
     * fault in the stills was that this car had no visible wheels at all: the
     * sill ran straight down past the hubs and the body was wider than the
     * track, so all four were inside the silhouette.  Tucking the sill in
     * over each axle -- and only over each axle -- puts the tyres back
     * outside the bodywork where a car keeps them. */
    if (yy < 0.62) {
      const overAxle = Math.max(
        Math.exp(-((t - WB) ** 2) / 0.026),
        Math.exp(-((t + WB) ** 2) / 0.030)
      );
      const low = 1 - Math.min(1, Math.max(0, (yy - 0.28) / 0.30));
      k *= 1 - 0.38 * overAxle * low;
      k *= 0.945;
    }
    p.setX(i, x * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * The glasshouse, as vertex colours on the body itself.
 *
 * It was a second, slightly smaller solid drawn dark and inset -- which
 * put its top surface a centimetre *below* the body's roof, so the whole
 * thing was buried inside the paint and the only glass you could see was
 * two dark corners where it poked out sideways.  Colouring the body's own
 * vertices cannot z-fight, cannot be inside anything, and costs one
 * attribute.
 */
function paintGlasshouse(geo, paint) {
  const p = geo.attributes.position;
  const n = p.count;
  const col = new Float32Array(n * 3);
  const body = new THREE.Color(paint);
  const glass = new THREE.Color(0x1c2027);
  const trim = new THREE.Color(0x2c2f34);
  const hl = L / 2;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const y = p.getY(i) + METRICS.axleHeight;      // profile space
    const z = p.getZ(i);
    // the cabin runs from just behind the bonnet to the base of the fastback
    /* The cabin, and only the cabin.  Running the dark all the way down
     * the fastback to the rear deck made the whole top of the car one dark
     * mass -- a canopy on a pickup bed rather than a glasshouse -- so it
     * stops where the backlight would, and the deck behind it stays body
     * colour. */
    const inCabin = z < hl - 1.50 && z > hl - 3.75;
    if (inCabin && y > 0.97) {
      c.copy(glass);
    } else if (y < 0.56) {          // dark lower valance, all the way round
      c.copy(trim);                                 // sill and lower valance
    } else {
      c.copy(body);
      // a touch darker over the shoulder, so the haunch reads
      if (y > 0.84 && y < 0.97) c.multiplyScalar(0.955);
    }
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function wheel(radius, width) {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 18, 1),
    cel({ color: 0x17181b, roughness: 0.95, flat: true })
  );
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.60, radius * 0.60, width * 1.06, 14, 1),
    cel({ color: 0x9aa0a7, roughness: 0.3, metalness: 0.6, flat: true })
  );
  rim.rotation.z = Math.PI / 2;
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.26, radius * 0.26, width * 1.12, 10, 1),
    cel({ color: 0x5d6268, roughness: 0.5, metalness: 0.4, flat: true })
  );
  hub.rotation.z = Math.PI / 2;
  g.add(tyre, rim, hub);
  return g;
}

/**
 * Returns `{ group, wheels, steerWheels, hubs }`, the same rig `model.js`
 * returns for the GLB: `wheels` roll on `rotation.x`, `steerWheels` steer
 * on `rotation.y`, `hubs` take the suspension on `position.y`.
 *
 * They are three different objects per corner on purpose.  One object
 * cannot carry both rotations -- three.js composes an Euler as
 * `Rx * Ry * Rz`, so rolling would swing the steering axis and a wheel at
 * lock would corkscrew.
 */
export function buildCoupe(opts = {}) {
  const paint = opts.color ?? 0xe8eaec;
  const group = new THREE.Group();

  /* Placement, and it is worth being exact about it because getting it
   * wrong is invisible in the code and glaring on screen.  The shape is
   * authored in (along, up); extruding runs it along +z, and rotating by
   * -90 degrees puts length on z with the nose at +z and width on x.  Then
   * the whole thing drops by the axle height, because the *vehicle's*
   * origin is at hub level -- the first version left both offsets in and
   * the car flew along a third of a metre above its own wheels. */
  const geo = new THREE.ExtrudeGeometry(profile(), {
    depth: W, bevelEnabled: true, bevelThickness: 0.06,
    bevelSize: 0.07, bevelSegments: 2, curveSegments: 8,
  });
  geo.rotateY(-Math.PI / 2);
  geo.translate(W / 2, -METRICS.axleHeight, 0);
  taper(geo);

  paintGlasshouse(geo, paint);
  const body = new THREE.Mesh(geo, cel({
    vertexColors: true, roughness: 0.34, metalness: 0.1, cache: false,
  }));
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // lights: two slivers front, one bar rear
  const lampGeo = new THREE.BoxGeometry(0.42, 0.11, 0.10);
  for (const sx of [-1, 1]) {
    const lamp = new THREE.Mesh(lampGeo, flat({ color: 0xf3f0e2 }));
    lamp.position.set(sx * 0.60, 0.755 - METRICS.axleHeight, L / 2 - 0.20);
    group.add(lamp);
  }
  /* Tail lights proud of the panel, not inside it.  At z = -L/2 + 0.04 the
   * bar sat *within* the tail's own bevel and never showed a pixel. */
  for (const sx of [-1, 1]) {
    /* Bigger, brighter, and clear of the tail's bevel.  Two rounds of
     * stills showed "no lighting element on the car" as a systematic
     * fault, and both earlier attempts put the bar inside the bodywork or
     * down in the dark valance where nothing showed. */
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.30, 0.13, 0.18),
      flat({ color: 0xd4463a })
    );
    lamp.position.set(sx * W * 0.19, 0.70 - METRICS.axleHeight, -L / 2 + 0.03);
    group.add(lamp);
  }

  const R = METRICS.axleHeight;
  const hw = METRICS.track / 2, wb = METRICS.wheelbase / 2;
  const wheels = [];
  const hubs = [];
  /* Front axle first, -x before +x within an axle: the order `Vehicle`
   * adds its wheels in, and so the order `car.wheelY` comes back in. */
  for (const [z, x] of [[wb, -hw], [wb, hw], [-wb, -hw], [-wb, hw]]) {
    const spin = wheel(R, 0.24);
    const hub = new THREE.Group();
    hub.position.set(x, 0, z);      // the vehicle origin is already hub height
    hub.userData.hubY = 0;          // and this tyre is exactly `axleHeight`
    hub.add(spin);
    group.add(hub);
    hubs.push(hub);
    wheels.push(spin);
  }
  return { group, wheels, steerWheels: [hubs[0], hubs[1]], hubs };
}
