import { WATER_LEVEL } from '../world/terrain.js';

/* ------------------------------------------------------------------ *
 * The midline.
 *
 * The road is not authored and the land is not bulldozed to meet it: the
 * land exists first and the road is *found* in it, one 10 m step at a
 * time, by a steering controller with three feelers.
 *
 * The whole of the base rule is this:
 *
 *     bT = (avgAhead - here) / ((right - left) / 2)
 *
 * -- turn toward whichever side keeps you level.  The numerator is how
 * much the ground rises ahead, the denominator how much it tilts across;
 * their ratio is the steer that trades one against the other.  Everything
 * else in `step()` is a limiter or an override on top of that one line.
 *
 * Two things about it are worth knowing before changing anything:
 *
 *  - **The feelers read the landform coarse**, at reduced octave depth.
 *    A road that can see every hummock swerves around every hummock.
 *
 *  - **The tracer can undo.**  Four turn trackers watch accumulated
 *    heading change over trailing windows of 150 m to 1.2 km; if the road
 *    has turned through more than about 190 degrees inside one of them
 *    and it is heading away from where it set out, the tracer *deletes
 *    nodes it has already laid* and re-traces away from the trouble.
 *    That is the answer to spiralling and to self-intersection, and it
 *    works on the symptom -- going round in a circle -- rather than on
 *    the geometry.  A purely forward walk cannot do this, and a purely
 *    forward walk is what makes procedural roads eat themselves.
 * ------------------------------------------------------------------ */

export const STEP = 10;          // node spacing, metres
export const FEEL = 10;          // feeler distance, metres
export const TURN = 0.463;       // feeler half-angle and max turn, radians
export const GRAD_NORM = 0.18;   // gradient normaliser
export const SMOOTH_WINDOW = 7;  // trailing nodes over which height is eased
export const MAX_GRADE = 0.12;   // 12 %, and the surveyor's last word

/**
 * The vertical alignment, which is now designed rather than averaged.
 *
 * `PROFILE_WINDOW` nodes either side is the span the grade line is fitted
 * over -- 200 m each way, which is about what a surveyor would sight.
 * `CURVE_NODES` is the shortest vertical curve allowed for a full-range
 * change of grade: a crest taken in fewer than this many nodes is a hump,
 * not a summit, and it is the difference between a road that disappears
 * over a brow and one that simply changes angle.
 */
export const PROFILE_WINDOW = 20;   // nodes each side of the fit, 200 m
export const CURVE_NODES = 22;      // nodes for a 0 to MAX_GRADE change
/** Deepest cut or highest embankment the alignment is allowed to ask for. */
export const EARTHWORK_MAX = 12;
const PCELL = 40;                // crossing-check grid cell, metres
const CROSS_MIN = 22;            // no two parts of the road closer than this
const CROSS_IGNORE = 60;         // ...unless within 600 m along the road

/** Accumulated-turn watchdogs: window in nodes, revert in nodes, trip angle. */
const TRACKERS = [
  { m: 15, r: 15, a: 3.3, o: 0.0 },
  { m: 30, r: 10, a: 3.3, o: 0.5 },
  { m: 60, r: 15, a: 3.4, o: 0.75 },
  { m: 120, r: 20, a: 3.6, o: 0.8 },
];

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export class Midline {
  /**
   * @param {object} shared  a crossing index this line shares with its
   *   twin.  `prompt_5.md` item 4 asks that the player be able to drive
   *   the other way, and `RoadPath` answers it with a *second* tracer
   *   walking away from the origin on the opposite heading -- so there are
   *   now two roads in one landscape, and each of them has to know where
   *   the other one is.  `_crosses` is a revert trigger, and a revert
   *   trigger that cannot see half the road is a road that drives through
   *   itself two kilometres from the start.
   */
  constructor(terrain, { heading = 0, x = 0, z = 0, shared = null } = {}) {
    this.terrain = terrain;
    /** Which line this is, in the shared index.  0 unless there is a twin. */
    this.lineId = 0;
    if (shared) {
      this.shared = shared;
      this.lineId = shared.lines.length;
      shared.lines.push(this);
    }
    this.nodes = [];
    this.originDir = { x: Math.cos(heading), z: Math.sin(heading) };
    this.prevT = 0;
    /** Heading relative to the original bearing, accumulated unwrapped. */
    this.phi = 0;
    this.prevA = heading;
    this.waterFactor = 0;
    this.byWater = false;
    this.antiTarget = null;
    this.antiTargetRange = 0;
    this.antiWeight = 0;
    this.trackIndex = null;
    this.trackRevertCount = 0;
    this.antiTargetRevert = 0;
    this.reverts = 0;
    this.rebases = 0;
    /* The lowest the node array has fallen since anyone last looked.
     *
     * `RoadPath` indexes nodes by array index, and a revert *rewrites* the
     * indices it frees -- node 812 after a backtrack is a different point
     * in the world from node 812 before it.  The index could only notice
     * this by comparing lengths, and by the time it looked the tracer had
     * usually re-grown past where it had cut, so the comparison said
     * nothing had happened and the grids kept pointing at nodes that had
     * moved.  Downstream that is a road benched into the wrong hillside,
     * chunks built at the wrong resolution, and terrain that looks like it
     * is simply missing. */
    this.lowWater = Infinity;
    /** World-space box the reverts have abandoned since anyone last asked. */
    this.dirtyBox = null;
    /** Reverts since the road last made real progress.  Distinct from
     *  `trackRevertCount`, which the rebase resets. */
    this.stuck = 0;
    /** The highest node index a revert may not cut below.  See `_revert`. */
    this.protect = 0;
    /** The furthest the road has ever got.  Progress is a new maximum, not
     *  a run of successful steps -- a road pinned against a lake shore will
     *  happily trace fifty nodes and revert them, for ever, and by the only
     *  other measure that looks like it is doing fine. */
    this.maxLen = 1;
    this.trackers = TRACKERS.map((t) => ({ ...t, n: 0, da: 0 }));
    /** Coarse index of laid nodes, for the crossing check.  Each node lives
     *  in exactly one cell and a query sweeps the nine around it, so the
     *  cell has to be wider than the check radius. */
    this.pgrid = shared ? shared.grid : new Map();
    /** Nodes are never dropped from the front: `revisit` needs them, driving
     *  backwards needs them, and the recorder needs them.  A node is about
     *  40 bytes, so a 200 km road is 800 kB. */
    this.smoothIndex = 0;
    /** Grade of the last committed node, m/m.  The vertical curve limiter
     *  works on the *change* in this, so it has to be state. */
    this.profGrade = 0;

    const y = Math.max(terrain.coarseAt(x, z), WATER_LEVEL);
    this.nodes.push({
      i: 0, x, z, y, ys: y, cut: 0, a: heading, da: 0, t: 0, h: 0,
      cx: x + Math.cos(heading) * STEP * 0.5,
      cz: z + Math.sin(heading) * STEP * 0.5,
      nx: -Math.sin(heading), nz: Math.cos(heading),
      g: 0, gfa: 0,
    });
    this._pput(0);
  }

  _pkey(x, z) {
    return Math.floor(x / PCELL) * 73856093 ^ Math.floor(z / PCELL) * 19349663;
  }

  /** Tag a node index with the line it belongs to.  See the constructor. */
  _tag(i) { return i * 2 + this.lineId; }

  _pput(i) {
    const n = this.nodes[i];
    const k = this._pkey(n.x, n.z);
    let a = this.pgrid.get(k);
    if (!a) { a = []; this.pgrid.set(k, a); }
    a.push(this._tag(i));
  }

  /** Grow the abandoned-ground box around one node.  Consumed by `RoadPath`. */
  _dirty(x, z) {
    const b = this.dirtyBox;
    if (!b) { this.dirtyBox = { minX: x, minZ: z, maxX: x, maxZ: z }; return; }
    if (x < b.minX) b.minX = x; else if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z; else if (z > b.maxZ) b.maxZ = z;
  }

  _pdrop(i) {
    const n = this.nodes[i];
    if (!n) return;
    const a = this.pgrid.get(this._pkey(n.x, n.z));
    if (!a) return;
    const at = a.indexOf(this._tag(i));
    if (at >= 0) a.splice(at, 1);
  }

  /**
   * Has the road come back on itself?  The turn watchdogs catch a road that
   * spirals, because a spiral is a lot of turning in a short window.  They
   * do not catch a lazy 3 km loop that drifts back across its own line
   * without ever turning hard -- over 40 km that happened in 3 seeds in 60,
   * and a road crossing itself at 0.9 m is the most obvious possible tell.
   * So the geometry is checked directly, and it is checked as a *revert
   * trigger* rather than as a steering cost: by the time two lines are 25 m
   * apart, nudging the newest one is far too late.
   */
  _crosses(x, z) {
    const cx = Math.floor(x / PCELL), cz = Math.floor(z / PCELL);
    const cutoff = this.nodes.length - CROSS_IGNORE;
    const lines = this.shared ? this.shared.lines : null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const a = this.pgrid.get((cx + dx) * 73856093 ^ (cz + dz) * 19349663);
        if (!a) continue;
        for (let q = 0; q < a.length; q++) {
          const tag = a[q];
          const id = tag & 1, idx = tag >> 1;
          const mine = id === this.lineId;
          /* Recent nodes of *my own* line are ignored: 600 m of road behind
           * the tip is always within 25 m of the tip. */
          if (mine && idx >= cutoff) continue;
          /* And the first 600 m of my *twin* is ignored for the same
           * reason from the other side -- the two lines share node 0 by
           * construction and run in opposite directions out of it, so they
           * are legitimately on top of each other at the origin.  Without
           * this the very first step of either tracer reverts against the
           * other one and neither road ever leaves the start. */
          if (!mine && idx < CROSS_IGNORE) continue;
          const line = mine ? this : (lines ? lines[id] : null);
          if (!line) continue;
          const n = line.nodes[idx];
          if (!n) continue;
          const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
          if (d2 < CROSS_MIN * CROSS_MIN) return n;
        }
      }
    }
    return null;
  }

  get tail() { return this.nodes[this.nodes.length - 1]; }
  get length() { return this.nodes.length; }

  /** Extend by one node.  Returns false if it backtracked instead. */
  step() {
    const T = this.terrain;
    const tail = this.tail;

    /* ---------------------------- the feelers --------------------------- */
    const feelDist = FEEL * (1 + this.waterFactor);
    const aL = tail.a - TURN, aR = tail.a + TURN;
    const lx = tail.x + Math.cos(aL) * feelDist, lz = tail.z + Math.sin(aL) * feelDist;
    const rx = tail.x + Math.cos(aR) * feelDist, rz = tail.z + Math.sin(aR) * feelDist;
    const feelL = T.coarseAt(lx, lz);
    const feelR = T.coarseAt(rx, rz);
    const feelA = Math.max(T.coarseAt(tail.x, tail.z), WATER_LEVEL);

    this.waterFactor = 0;
    this.byWater = false;
    if (feelR < 2 * WATER_LEVEL || feelL < 2 * WATER_LEVEL) this.byWater = true;
    const feelAvg = (feelR + feelL) / 2;
    if (feelAvg < 3 * WATER_LEVEL) {
      this.waterFactor = feelAvg > WATER_LEVEL
        ? 1 - (feelAvg - WATER_LEVEL) / (2 * WATER_LEVEL)
        : 1;
    }

    const feelDif = (feelR - feelL) / 2;
    const gradLat = (feelL - feelR) / feelDist / GRAD_NORM;
    const gradLon = (feelAvg - feelA) / feelDist / GRAD_NORM;

    /* ------------------------- the base steer --------------------------- */
    let bT = feelDif !== 0 ? (feelAvg - feelA) / feelDif : 0;
    bT = Math.max(-1, Math.min(1, bT));

    /* --------------------- limits: steep-side rejection ------------------ */
    const gradLeft = (feelL - feelA) / feelDist / GRAD_NORM;
    const gradRight = (feelR - feelA) / feelDist / GRAD_NORM;
    let maxT = 1, minT = -1;
    const gl = Math.abs(gradLeft), gr = Math.abs(gradRight);
    if (gl > 1 || gr > 1) {
      const gradDif = (gradLeft - gradRight) / 2;
      const gradAvg = (gradLeft + gradRight) / 2;
      if ((gradLeft > 1 && gradRight > 1) || (gradLeft < -1 && gradRight < -1)) {
        // both sides climb (or both fall): commit to the shallower one
        if (gl < gr) { maxT = 1; minT = 1; } else { maxT = -1; minT = -1; }
      } else {
        if (gl > 1) {
          maxT = gradLeft < 0
            ? (1 + gradAvg) / Math.abs(gradDif)
            : (1 - gradAvg) / Math.abs(gradDif);
        }
        if (gr > 1) {
          minT = gradRight < 0
            ? (1 + gradAvg) / Math.abs(gradDif)
            : (1 - gradAvg) / Math.abs(gradDif);
          minT *= -1;
        }
      }
    }
    maxT *= 1.5;
    minT *= 1.5;

    /* ------------------------ limit: turn rate -------------------------- */
    const gradMean = (Math.abs(gradLat) + Math.abs(gradLon)) / 2;
    const maxDif = 0.5 + 0.5 * Math.abs(gradMean);
    if (maxT > 0) maxT = Math.min(maxT, this.prevT + maxDif);
    if (minT < 0) minT = Math.max(minT, this.prevT - maxDif);

    /* --------------------------- limit: water --------------------------- */
    if (this.byWater) {
      if (gradLat < 0) { if (maxT > 0) maxT *= 1 - this.waterFactor; }
      else if (minT < 0) { minT *= 1 - this.waterFactor; }
    }
    bT = Math.max(minT, Math.min(maxT, bT));

    /* ---------------------- flat-ground damping ------------------------- *
     * On level land the turn is scaled *down* by the square of the
     * longitudinal gradient, so the road runs nearly straight and only
     * winds where there is something to wind around.  On steep ground it
     * goes to full lock instead.  One line, and it is most of why the
     * road alternates long straights across flats with tight work on
     * a hillside -- character coming out of the land rather than out of a
     * second noise field. */
    const gl2 = gradLon * gradLon;
    if (gl2 <= 1) {
      if (!this.byWater || gradLon > 0) bT *= Math.abs(gl2);
    } else {
      bT = bT < 0 ? minT : maxT;
    }
    bT = Math.max(minT, Math.min(maxT, bT));

    /* ------------------------ the origin pull --------------------------- *
     * The road sets out on a bearing and is pulled back toward it, harder
     * the further it has wandered -- without this a controller that follows
     * contours simply circles the nearest hill for ever.
     *
     * The subtlety is what happens past half a turn.  `phi` is the heading
     * relative to the original bearing, accumulated *unwrapped*, and the
     * pull is toward the nearest multiple of a full turn rather than toward
     * zero.  So a road that has genuinely wound round 200 degrees keeps
     * going round to 360 instead of snapping back through itself, which is
     * what lets it get out of a valley whose only exit is behind it.  An
     * earlier version pulled toward zero always; it spent every step at
     * full lock and traced five nodes before the watchdogs killed it. */
    this.phi += tail.a - this.prevA;
    this.prevA = tail.a;
    const target = 2 * Math.PI * Math.round(this.phi / (2 * Math.PI));
    const err = this.phi - target;
    const originDot = Math.cos(err);

    /* ------------------- steering away from trouble --------------------- */
    const dirX = Math.cos(tail.a), dirZ = Math.sin(tail.a);
    const orthX = -dirZ, orthZ = dirX;
    this.antiWeight = 0;
    if (this.antiTargetRange > 0 && this.antiTarget) {
      const ddx = tail.x - this.antiTarget.x, ddz = tail.z - this.antiTarget.z;
      const d2 = ddx * ddx + ddz * ddz;
      let adx = this.antiTarget.x - tail.x, adz = this.antiTarget.z - tail.z;
      const al = Math.hypot(adx, adz) || 1;
      adx /= al; adz /= al;
      const antiDot = dirX * adx + dirZ * adz;
      if (d2 < this.antiTargetRange) {
        this.antiWeight = (1 - d2 / this.antiTargetRange) * ((antiDot + 1) / 2);
        const antiSide = orthX * adx + orthZ * adz;
        let antiRedirect = 2 * TURN * antiSide;
        antiRedirect = Math.max(minT, Math.min(maxT, antiRedirect));
        bT = this.antiWeight * antiRedirect + (1 - this.antiWeight) * bT;
      } else if (antiDot < -0.707) {
        this.antiTargetRange = 0;
        this.trackIndex = null;
        this.trackRevertCount = 0;
      }
    }

    let originAdjust = (1 - (originDot + 1) / 2) * (1 - this.waterFactor * this.waterFactor);
    originAdjust *= 1 - this.antiWeight;
    let originRedirect = err / TURN;
    originRedirect = Math.max(minT, Math.min(maxT, originRedirect));
    bT = originAdjust * originRedirect + (1 - originAdjust) * bT;

    /* ------------------------- the watchdogs ---------------------------- */
    for (const tr of this.trackers) {
      tr.da += tail.da;
      while (this.nodes[tr.n] && this.nodes[tr.n].i <= tail.i - tr.m) {
        tr.da -= this.nodes[tr.n].da;
        tr.n++;
      }
      if (Math.abs(tr.da) > tr.a && (this.byWater || originDot < tr.o)) {
        this._revert(tr);
        return false;
      }
    }

    /* --------------------------- lay the node --------------------------- */
    this.prevT = bT;
    let bDir = tail.a - bT * TURN;
    if (bDir < -Math.PI) bDir += 2 * Math.PI;
    else if (bDir > Math.PI) bDir -= 2 * Math.PI;

    /* Two half-steps: the first on the current heading, the second on the
     * new one, with the joint kept as the quadratic control point.  The
     * drawn road is the Bezier through it, not the polyline. */
    const half = STEP * 0.5;
    const cx = tail.x + Math.cos(tail.a) * half;
    const cz = tail.z + Math.sin(tail.a) * half;
    const nx2 = cx - tail.x, nz2 = cz - tail.z;
    const nl = Math.hypot(nx2, nz2) || 1;
    tail.cx = cx; tail.cz = cz;
    tail.nx = -nz2 / nl; tail.nz = nx2 / nl;

    const px = cx + Math.cos(bDir) * half;
    const pz = cz + Math.sin(bDir) * half;
    const sink = 0.1 * (1 - this.waterFactor);
    const pySurvey = Math.max(T.coarseAt(px, pz), WATER_LEVEL) - sink;

    /* A starting height only: `_provisional` recomputes every uncommitted
     * node from the committed head at the end of this step, and that is
     * where the grade limit and the earthwork budget are actually applied. */
    let py = tail.y + this.profGrade * STEP;
    if (py < WATER_LEVEL) py = WATER_LEVEL;

    const hit = this._crosses(px, pz);
    if (hit) { this._revert(this.trackers[1], hit); return false; }

    const node = {
      i: tail.i + 1, x: px, y: py, z: pz,
      /* The ground as surveyed, kept beside the height the road ends up
       * at.  `_profile` fits its grade line to these, and the difference
       * between the two is the earthwork. */
      ys: pySurvey, cut: 0,
      a: bDir, da: bT * TURN, t: bT, h: 0,
      cx: px, cz: pz, nx: 0, nz: 1,
      g: gradLat, gfa: Math.abs(gradLon),
    };
    this.nodes.push(node);
    this._pput(this.nodes.length - 1);
    this._profile();
    if (this.nodes.length > this.maxLen + 20) {
      this.maxLen = this.nodes.length;
      this.stuck = 0;
    }
    return true;
  }

  /**
   * Unwind.  The tracker that tripped says how far back to go; repeated
   * trips on the same tracker escalate it, because coming back to the same
   * place and making the same turn is exactly the failure this exists to
   * break.
   */
  _revert(tr, hitNode) {
    this.reverts++;
    this.stuck++;
    /* Escalate.  Backing up thirty nodes out of a box canyon puts you back
     * in the box canyon; the way out of one is to leave it entirely, so the
     * revert grows the longer the tracer has been failing in one place --
     * up to nine windows, about 2.7 km.  Three seeds in sixty were stuck
     * for thousands of attempts without this. */
    const esc = 1 + Math.min(8, Math.floor(this.stuck / 4));
    const tail = this.tail;
    let revertDistance;
    if (hitNode) {
      /* Steer away from the *old* line, not from where we are standing --
       * where we are standing is fine, it is where we were about to go that
       * is not. */
      this.trackIndex = null;
      this.antiTarget = { x: hitNode.x, z: hitNode.z };
      this.antiTargetRevert = tr.m * esc;
      revertDistance = this.antiTargetRevert;
      this.trackRevertCount++;
    } else if (this.trackIndex === tr.m && this.antiWeight > 0) {
      this.trackRevertCount++;
      this.antiTargetRevert += this.trackRevertCount * tr.r * esc;
      revertDistance = this.antiTargetRevert;
    } else {
      this.trackIndex = tr.m;
      this.antiTarget = { x: tail.x, z: tail.z };
      this.antiTargetRevert = tr.m * esc;
      this.trackRevertCount = 0;
      revertDistance = this.antiTargetRevert;
    }

    /* Never unwind past the start -- **and never past the player**.
     *
     * `protect` is the node the car is standing on, plus a margin, written
     * by `RoadPath` every frame.  Before it, a revert cascade could delete
     * the road *under the car*: measured on a reverse drive, the backward
     * line hit its twin about five kilometres out, and twelve escalating
     * reverts (up to 270 nodes each) took the line from five hundred nodes
     * back to twenty-two -- so `nearest` returned null, the autopilot lost
     * the road it was driving on, and the safety net turned the car round.
     *
     * A tracer that cannot back up far enough will keep trying and will
     * eventually rebase, which is the escape hatch this already has.  What
     * it must not do is take the world with it. */
    const keep = Math.max(1, this.protect + 1,
                          this.nodes.length - revertDistance);
    if (keep < this.lowWater) this.lowWater = keep;
    /* The ground the abandoned line ran through, so the chunk field can
     * rebuild whatever was baked against it.  Terrain within a chunk of the
     * old road was benched to it and has to be un-benched; without this the
     * world keeps a carriageway through an empty field, and the road's new
     * line runs over ground that was never cut for it. */
    for (let i = keep; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      this._dirty(n.x, n.z);
      this._pdrop(i);
    }
    if (keep < this.nodes.length) this.nodes.length = keep;

    /* The profile is committed behind the head, so a backtrack has to take
     * the commit cursor with it -- otherwise the nodes the tracer re-lays
     * keep whatever heights they inherited and the vertical alignment has a
     * step in it exactly where the road changed its mind. */
    if (this.smoothIndex > keep - 1) {
      this.smoothIndex = Math.max(0, keep - 1);
      const a = this.nodes[this.smoothIndex], b = this.nodes[this.smoothIndex - 1];
      this.profGrade = a && b ? (a.y - b.y) / STEP : 0;
    }

    const nt = this.tail;
    this.antiTargetRange = 4 * ((nt.x - this.antiTarget.x) ** 2 + (nt.z - this.antiTarget.z) ** 2);
    if (this.antiTargetRange < 400) this.antiTargetRange = 400;
    this.prevT = nt.t;
    this.phi -= (this.prevA - nt.a);
    this.prevA = nt.a;

    /* The escape hatch.  A road can find itself in country where every way
     * out trips something -- seed 19 of the 40 km sweep reverted 1689 times
     * and got two thirds of the way.  After enough failed attempts in one
     * place the thing to give up on is the *original bearing*: rebase the
     * origin pull onto the current heading and the road is free to leave in
     * a genuinely different direction.  It stands in for building a bridge,
     * which is a subsystem this project does not have. */
    if (this.trackRevertCount > 8) {
      this.rebases++;
      this.trackRevertCount = 0;
      this.originDir = { x: Math.cos(nt.a), z: Math.sin(nt.a) };
      this.phi = 0;
      this.antiTargetRange = 0;
      this.antiTarget = null;
      this.trackIndex = null;
    }

    // rewind every tracker's window onto the new tail
    for (const t2 of this.trackers) {
      t2.n = Math.max(0, this.nodes.length - t2.m);
      t2.da = 0;
      for (let k = t2.n; k < this.nodes.length; k++) t2.da += this.nodes[k].da;
    }
  }

  /**
   * The vertical alignment.
   *
   * What was here before was a trailing weighted average of the surveyed
   * ground with a grade clamp on top, and it produced a surface that
   * *followed* the land at one remove.  A road is not that.  A road is a
   * sequence of constant grades joined by vertical curves, chosen so the
   * earthwork on one side pays for the earthwork on the other, and the
   * difference is visible from the driver's seat: an averaged profile
   * rounds every crest away, and a designed one lets the road drop out of
   * sight over a brow and come back.
   *
   * So, per node, once it is `PROFILE_WINDOW` behind the head:
   *
   *  1. **Fit a grade line** by least squares to the surveyed ground over
   *     the window either side.  The slope is the grade the land is asking
   *     for; the intercept is the height that balances cut against fill
   *     over that span, which is what a surveyor means by a balanced
   *     alignment and is free once the fit is being done anyway.
   *  2. **Limit the rate of change of grade**, not just the grade.  That
   *     is what a vertical curve *is* -- `CURVE_NODES` sets the shortest
   *     one allowed, and everything else follows.
   *  3. Integrate: the node's height is the previous height plus the
   *     grade, pulled gently toward the balanced intercept so the profile
   *     cannot drift away from the ground over a long climb.
   *
   * Committed heights are never revised, so the ground can be baked behind
   * the head with no risk of it being benched to a road that then moves.
   */
  _profile() {
    const nodes = this.nodes;
    const W = PROFILE_WINDOW;
    const dg = MAX_GRADE / CURVE_NODES;      // grade change per node
    const lim = MAX_GRADE * STEP;

    while (this.smoothIndex + 1 < nodes.length - W) {
      const i = ++this.smoothIndex;
      const n = nodes[i], prev = nodes[i - 1];

      /* Least squares over the window, in node units.  `ys` is the ground
       * as surveyed; `y` is what the road ends up doing about it. */
      let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(nodes.length - 1, i + W); j++) {
        const dx = j - i, y = nodes[j].ys;
        sx += dx; sy += y; sxx += dx * dx; sxy += dx * y; cnt++;
      }
      const denom = cnt * sxx - sx * sx;
      const slope = denom !== 0 ? (cnt * sxy - sx * sy) / denom : 0;
      const balanced = (sy - slope * sx) / cnt;      // fitted height at this node

      // grade per metre, limited both in value and in how fast it may change
      let g = slope / STEP;
      const gPrev = this.profGrade;
      if (g > gPrev + dg) g = gPrev + dg;
      else if (g < gPrev - dg) g = gPrev - dg;
      if (g > MAX_GRADE) g = MAX_GRADE;
      else if (g < -MAX_GRADE) g = -MAX_GRADE;

      let y = prev.y + g * STEP;
      /* A gentle pull toward the balanced line.  Without it the integrated
       * profile is free to walk away from the ground -- the grade limiter
       * clips a hill's true slope, the error accumulates, and thirty nodes
       * later the road is on a viaduct. */
      y += (balanced - y) * 0.18;

      /* The earthwork budget.  Soft, and deliberately so: it gives way to
       * the grade limit immediately below, because a road that breaks its
       * gradient to save a cutting is not a road.  What it does buy is that
       * the alignment cannot quietly accumulate a fifty-metre embankment
       * one node at a time. */
      if (y > n.ys + EARTHWORK_MAX) y = n.ys + EARTHWORK_MAX;
      else if (y < n.ys - EARTHWORK_MAX) y = n.ys - EARTHWORK_MAX;

      // and the grade limit again, because the pull can breach it
      if (y > prev.y + lim) y = prev.y + lim;
      else if (y < prev.y - lim) y = prev.y - lim;
      if (y < WATER_LEVEL) y = WATER_LEVEL;

      n.y = y;
      n.cut = y - n.ys;              // + embankment, - cutting; for the shader
      this.profGrade = (y - prev.y) / STEP;
    }
    this._provisional();
  }

  /**
   * Heights for the nodes the profile has not reached yet.
   *
   * The last `PROFILE_WINDOW` nodes cannot be fitted -- half their window
   * does not exist -- but they are visible, drivable and mesh-able the
   * moment they are laid, so they need heights that are *continuous with
   * the committed profile*.
   *
   * Getting this wrong is subtle and expensive.  The first version left
   * them at the surveyed ground, which put a step at the boundary equal to
   * the whole depth of the earthwork: measured 106 % grade on 23 seeds in
   * 40.  The second extended the grade at the moment each node was laid --
   * better, but a node's predecessor is *re-written* when the profile
   * commits it, so the tail was extrapolated from heights that no longer
   * existed: 114 % on the first uncommitted node.
   *
   * So the tail is recomputed from the committed head every step.  It is
   * twenty nodes of arithmetic and it makes the invariant simple: no node
   * anywhere on the road is ever more than `MAX_GRADE` from its neighbour.
   */
  _provisional() {
    const nodes = this.nodes;
    const dg = MAX_GRADE / CURVE_NODES;
    const lim = MAX_GRADE * STEP;
    let y = nodes[this.smoothIndex].y;
    let g = this.profGrade;
    for (let i = this.smoothIndex + 1; i < nodes.length; i++) {
      const n = nodes[i];
      // the grade that would put us on the surveyed ground at this node
      const want = (n.ys - y) / STEP;
      let gg = g + Math.max(-dg, Math.min(dg, want - g));
      if (gg > MAX_GRADE) gg = MAX_GRADE;
      else if (gg < -MAX_GRADE) gg = -MAX_GRADE;

      let py = y + gg * STEP;
      if (py > n.ys + EARTHWORK_MAX) py = n.ys + EARTHWORK_MAX;
      else if (py < n.ys - EARTHWORK_MAX) py = n.ys - EARTHWORK_MAX;
      if (py < WATER_LEVEL) py = WATER_LEVEL;
      if (py > y + lim) py = y + lim;
      else if (py < y - lim) py = y - lim;

      n.y = py;
      n.cut = py - n.ys;
      g = (py - y) / STEP;
      y = py;
    }
  }

  /** Extend until the tail is at least `lead` metres of road past `i`. */
  extendTo(targetIndex, budget = 64) {
    let n = 0;
    while (this.tail.i < targetIndex && n < budget) {
      this.step();
      n++;
    }
    return n;
  }
}
