import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * Headlights.
 *
 * Two spot lights, positioned from the car's own quaternion every frame
 * rather than parented to it -- the car mesh is swapped out from under
 * everything when the GLB lands, and anything hung on that group goes
 * with it.
 *
 * **They exist from boot, at zero intensity.**  That is not laziness, it
 * is the single most important line in this file: three.js recompiles
 * *every material in the scene* when the number of lights changes, so
 * adding the lamps at dusk and removing them at dawn would stall for
 * several hundred milliseconds twice a game-day, for ever.  The
 * intensity is free to change; the count is not.
 *
 * `castShadow` is off.  A shadow-casting spot is another shadow map and
 * another render of the scene, and at night the shadow it would cast is
 * of the car onto ground the car is already sitting on.
 * ------------------------------------------------------------------ */

/** Where the lamps sit, in the car's own frame: +Z is forward. */
const MOUNT = [
  { x: -0.68, y: 0.62, z: 1.94 },
  { x: 0.68, y: 0.62, z: 1.94 },
];

/**
 * Beam strength, in candela.
 *
 * With `decay: 1` the falloff is 1/d, so this divided by the distance in
 * metres is roughly what lands: 120 puts about 6 on the road ten metres
 * ahead and about 2 at thirty, which reads as a headlight rather than as
 * a torch.  It is deliberately not physical -- a real dipped beam is tens
 * of thousands of candela with a sharp cut-off -- because what is wanted
 * here is a pool of light with a soft edge that does not blow out the
 * tarmac immediately in front of the car.
 */
const LEVEL = 120;

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _f = new THREE.Vector3();

export class Headlights {
  constructor(scene) {
    this.lamps = [];
    for (const m of MOUNT) {
      /* Intensity is in **candela**, not the 0-2 range a directional
       * light's irradiance uses, and the two sit in the same scene so it
       * is an easy mistake to carry across: at an intensity of 2.3 with
       * `decay: 1` the beam delivers 2.3/20 at twenty metres, which is
       * nothing at all.  The first night shot had lamps that were plainly
       * "on" and a road ahead that was plainly black.  See `LEVEL`. */
      const light = new THREE.SpotLight(0xfff4d8, 0, 110, 0.46, 0.42, 1.0);
      light.castShadow = false;
      light.visible = false;
      const target = new THREE.Object3D();
      scene.add(light, target);
      light.target = target;
      this.lamps.push({ light, target, mount: m });
    }
    /** What the lamp *meshes* should look like.  `model.js` builds them as
     *  unlit basic materials, so "on" is a colour, not an intensity. */
    this.glow = 0;
  }

  /**
   * @param clock  for `night`, the same scalar the moon and stars use, so
   *               the lamps can never disagree with the sky about dusk
   * @param car    position and orientation
   * @param wet    a wet road at night is darker, so more light helps
   */
  update(clock, car, wet = 0) {
    /* One scalar decides everything, and it is the sky's own.  Lamps that
     * come on at a fixed clock time are wrong at both solstices, where
     * sunset moves by two game-hours. */
    const on = clock.night;
    this.glow = on;
    const level = on * LEVEL * (1 + 0.25 * wet);

    for (const lamp of this.lamps) {
      /* Always written, never left stale.  `visible` is the optimisation;
       * the intensity is the state, and a lamp reading 2.3 at noon because
       * the loop returned early is a lie to anything that measures it. */
      lamp.light.intensity = level;
      lamp.light.visible = level > 0.01;
      if (!lamp.light.visible) continue;

      /* Mount point and aim, both from the body quaternion.  The aim is
       * a few metres ahead and slightly down -- headlights point at the
       * road, not at the horizon, and a spot aimed level lights the sky. */
      _p.set(lamp.mount.x, lamp.mount.y, lamp.mount.z).applyQuaternion(car.quat);
      _p.add(car.pos);
      lamp.light.position.copy(_p);

      _f.set(0, 0, 1).applyQuaternion(car.quat);
      _t.copy(_p).addScaledVector(_f, 26);
      _t.y -= 3.4;
      lamp.target.position.copy(_t);
      lamp.target.updateMatrixWorld();
    }
  }

  /**
   * Paint the lamp meshes.
   *
   * The GLB's `light_front` and `light_rear` are unlit basic materials,
   * so switching them on is a matter of colour: a dim grey by day, and a
   * near-white that reads as emissive at night.  Called whenever the car
   * model changes, and once a frame after that -- it is two colour writes.
   */
  paint(coupe, braking = false) {
    if (!coupe || !coupe.group) return;
    const g = this.glow;
    coupe.group.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.color) return;
      const n = o.name || '';
      if (n.startsWith('light_front')) {
        const v = 0.55 + 0.45 * g;
        o.material.color.setRGB(v, v * 0.985, v * 0.92);
      } else if (n.startsWith('light_rear')) {
        const v = braking ? 1 : 0.45 + 0.35 * g;
        o.material.color.setRGB(0.76 * v, 0.21 * v, 0.17 * v);
      }
    });
  }
}
