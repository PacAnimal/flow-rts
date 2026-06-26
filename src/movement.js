// The dynamic movement layer (docs/adr/0007). Owns each Unit's movement: a cached terrain
// Path (from pathfinding.js) plus per-frame steering — arrive-along-Path + separation from
// neighbours, clamped to Walkable terrain, with an overlap-resolution pass. Separation carries
// a tangential "pass on one side" bias and a priority asymmetry so converging Units slip past
// each other instead of head-butting/oscillating (docs/adr/0007 amendment). Phaser-free: it
// reads/writes plain {x,y} pixel positions on Unit objects and queries Walkable through an
// injected predicate. MapScene constructs it and syncs sprites afterwards.

import { TILE, UNIT_SPEED } from './constants.js';
import { findPath, smoothPath } from './pathfinding.js';

const SPEED = UNIT_SPEED * TILE;     // px/s
const RADIUS = 0.30 * TILE;          // Unit collision radius
const SEP_RANGE = 0.70 * TILE;       // start pushing apart within this distance
const WP_REACH = 0.35 * TILE;        // advance to next waypoint once this close
const ARRIVE = 0.22 * TILE;          // close enough to the final destination (lone Unit)
const ARRIVE_LOOSE = 0.85 * TILE;    // a forgiving arrival: "near enough" so Units sharing one
                                     // destination (a rally point, the Command Center) settle on
                                     // nearby Tiles instead of shoving over one (docs/adr/0017)
const SLOW_RADIUS = 1.4 * TILE;      // begin easing speed near the destination
const STUCK_MS = 700;                // no progress this long near the goal ⇒ settle (arrived)
const STUCK_SPEED = SPEED * 0.12;    // below this counts as "not making progress"

// Avoidance refinements over plain radial separation (docs/adr/0007 amendment). Pure radial
// push only fires at contact range, so two Units meeting head-on crash then slide past instead
// of anticipating. Three cheap additions make a meeting look planned:
const LOOKAHEAD = 3.5 * TILE;        // anticipate a converging neighbour this far ahead and begin
                                     // drifting aside early — long before the contact-range push
const SEP_ANTICIPATE = 0.8;          // gain on that predictive sideways drift; rotating each Unit's
                                     // away-vector a consistent way makes the pair pick opposite
                                     // sides and pass cleanly rather than head-butting
const YIELD_MORE = 1.6;             // when two *moving* Units meet, the one further from its goal
const YIELD_LESS = 0.5;             // yields harder while the one closer to arriving holds its line

// A Unit at Tile (tx,ty) stands at the Tile's bottom-centre (feet), matching where Units spawn.
const standPoint = (tx, ty) => ({ x: (tx + 0.5) * TILE, y: (ty + 1) * TILE });
const tileAt = (px, py) => ({ x: Math.floor(px / TILE), y: Math.floor((py - TILE * 0.5) / TILE) });
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export class MovementSystem {
  // `isWalkable(tx,ty)` + grid bounds describe the terrain.
  constructor({ isWalkable, width, height }) {
    this.isWalkable = isWalkable;
    this.w = width;
    this.h = height;
  }

  _mv(unit) {
    if (!unit.mv) unit.mv = { goalTx: null, goalTy: null, path: null, wp: 0, arrived: true, stuck: 0 };
    return unit.mv;
  }

  // Set (or refresh) where this Unit is heading. A new destination Tile recomputes the Path;
  // the same destination is a no-op. No route ⇒ arrived (give up). Called from Move's executor.
  // `loose` is how close counts as arrived (docs/adr/0017): false ⇒ snug (ARRIVE), e.g. the
  // gather approach; true ⇒ ARRIVE_LOOSE, a forgiving rally/delivery Move that many Units share.
  setGoal(unit, tx, ty, loose = false) {
    const mv = this._mv(unit);
    mv.arriveR = loose ? ARRIVE_LOOSE : ARRIVE;
    if (mv.goalTx === tx && mv.goalTy === ty) return;
    mv.goalTx = tx; mv.goalTy = ty; mv.stuck = 0;
    const start = tileAt(unit.x, unit.y);
    const tiles = findPath(start, { x: tx, y: ty }, this.isWalkable, this.w, this.h);
    if (!tiles) { mv.path = null; mv.arrived = true; return; }
    mv.path = smoothPath(tiles, this.isWalkable).map((t) => standPoint(t.x, t.y));
    mv.wp = 0;
    mv.arrived = false;
  }

  arrived(unit) {
    return !!(unit.mv && unit.mv.arrived);
  }

  // Stop a Unit in place: drop its Path and clear its goal so steering no longer seeks (the
  // separation pass still applies). Used by the combat layer when a Unit halts to attack.
  stop(unit) {
    const mv = this._mv(unit);
    mv.path = null;
    mv.arrived = true;
    mv.goalTx = null;
    mv.goalTy = null;
  }

  // Advance every Unit one frame. `dt` is in ms (Phaser delta).
  update(units, dt) {
    const s = dt / 1000;
    if (s <= 0) return;

    // Pass 1 — desired velocity per Unit from current positions (path-follow + separation).
    const vel = units.map((unit) => this._steer(unit, units));

    // Pass 2 — integrate, clamp to Walkable, update arrival/stuck.
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const v = vel[i];
      unit._vel = v; // expose to directional sprite logic
      const nx = unit.x + v.x * s;
      const ny = unit.y + v.y * s;
      const moved = dist(unit.x, unit.y, nx, ny);
      this._placeClamped(unit, nx, ny);

      const mv = unit.mv;
      if (mv && mv.path && !mv.arrived) {
        const goal = mv.path[mv.path.length - 1];
        // Suspend the stuck-timer while attacking (docs/adr/0012): a Unit fighting near its goal
        // must not falsely "arrive" mid-fight.
        const engaged = unit.combat && unit.combat.engaged;
        const stuckThresh = (unit.speed ?? SPEED) * 0.12 * s;
        if (dist(unit.x, unit.y, goal.x, goal.y) <= (mv.arriveR ?? ARRIVE)) mv.arrived = true;
        else if (moved < stuckThresh && !engaged) { if ((mv.stuck += dt) > STUCK_MS) mv.arrived = true; }
        else if (!engaged) mv.stuck = 0;
      }
    }

    // Pass 3 — shove apart any residual overlap so Units never sit on top of each other.
    this._resolveOverlaps(units);
  }

  // Distance left to the goal for an *actively moving* Unit, else null (idle/arrived). Used to
  // rank priority between two movers (docs/adr/0007 amendment) — idle Units stay outside the
  // asymmetry so a crowd still shoves them aside as ADR-0007 intends.
  _goalDist(unit) {
    const mv = unit.mv;
    if (!mv || !mv.path || mv.arrived) return null;
    const g = mv.path[mv.path.length - 1];
    return dist(unit.x, unit.y, g.x, g.y);
  }

  // Desired velocity = arrive-along-Path (only while travelling) + separation (always).
  _steer(unit, units) {
    const topSpeed = unit.speed ?? SPEED;
    let vx = 0, vy = 0;
    let dirx = 0, diry = 0;          // our normalised seek direction, for the tangential bias
    const mv = unit.mv;

    if (mv && mv.path && !mv.arrived) {
      while (mv.wp < mv.path.length - 1 && dist(unit.x, unit.y, mv.path[mv.wp].x, mv.path[mv.wp].y) < WP_REACH) mv.wp++;
      const tgt = mv.path[mv.wp];
      const d = dist(unit.x, unit.y, tgt.x, tgt.y);
      if (d > 0) {
        // ease down near the final destination so Units settle instead of orbiting
        const goal = mv.path[mv.path.length - 1];
        const dGoal = dist(unit.x, unit.y, goal.x, goal.y);
        const speed = dGoal < SLOW_RADIUS ? topSpeed * Math.max(0.15, dGoal / SLOW_RADIUS) : topSpeed;
        dirx = (tgt.x - unit.x) / d;
        diry = (tgt.y - unit.y) / d;
        vx += dirx * speed;
        vy += diry * speed;
      }
    }

    const selfGoal = this._goalDist(unit);   // null ⇒ this Unit is idle/arrived (no priority claim)

    for (const other of units) {
      if (other === unit) continue;
      const dx = unit.x - other.x, dy = unit.y - other.y;   // away-vector (other → us)
      const d = Math.hypot(dx, dy);
      if (d <= 0 || d >= LOOKAHEAD) continue;
      const ux = dx / d, uy = dy / d;

      // Priority asymmetry: only between two *moving* Units (docs/adr/0007 amendment). The one
      // closer to its goal holds its line; the further one yields harder. This stops both Units
      // dodging identically and oscillating. Idle/arrived Units keep symmetric separation.
      const otherGoal = this._goalDist(other);
      const bothMoving = selfGoal != null && otherGoal != null;
      let yield_ = 1;
      if (bothMoving) {
        if (otherGoal < selfGoal) yield_ = YIELD_MORE;
        else if (otherGoal > selfGoal) yield_ = YIELD_LESS;
      }

      // Contact-range radial separation: the base push-apart so Units never pile up.
      if (d < SEP_RANGE) {
        const push = (1 - d / SEP_RANGE) * topSpeed;
        vx += ux * push * yield_;
        vy += uy * push * yield_;
      }

      // Predictive tangential drift (docs/adr/0007 amendment): for two converging movers, start
      // veering aside well before contact. `ahead` is how far in front of our heading the neighbour
      // sits; rotating the away-vector a consistent +90° gives opposing Units opposite tangents, so
      // they commit to opposite sides early and the meeting reads as planned, not a last-instant
      // slide. The drift ramps up as the gap closes and fades once the neighbour is no longer ahead.
      if (bothMoving && (dirx || diry)) {
        const ahead = -(dirx * ux + diry * uy);   // dot(seekDir, dirToOther); >0 ⇒ neighbour ahead
        if (ahead > 0) {
          const ramp = 1 - d / LOOKAHEAD;          // stronger the closer the converging Units get
          const tan = ahead * ramp * SEP_ANTICIPATE * topSpeed * yield_;
          vx += -uy * tan;
          vy += ux * tan;
        }
      }
    }

    // clamp to top speed (separation can fully override seek in a crowd ⇒ Units yield)
    const sp = Math.hypot(vx, vy);
    if (sp > topSpeed) { vx = vx / sp * topSpeed; vy = vy / sp * topSpeed; }
    return { x: vx, y: vy };
  }

  // Move toward (nx,ny) but never onto unwalkable terrain; slide along walls by trying each axis.
  _placeClamped(unit, nx, ny) {
    if (this._walkablePx(nx, ny)) { unit.x = nx; unit.y = ny; return; }
    if (this._walkablePx(nx, unit.y)) { unit.x = nx; return; }
    if (this._walkablePx(unit.x, ny)) { unit.y = ny; return; }
    // fully blocked — stay put
  }

  _walkablePx(px, py) {
    const t = tileAt(px, py);
    return this.isWalkable(t.x, t.y);
  }

  _resolveOverlaps(units) {
    const min = 2 * RADIUS;
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < units.length; i++) {
        for (let j = i + 1; j < units.length; j++) {
          const a = units[i], b = units[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d > 0 && d < min) {
            const off = (min - d) / 2;
            const ux = dx / d, uy = dy / d;
            this._placeClamped(a, a.x - ux * off, a.y - uy * off);
            this._placeClamped(b, b.x + ux * off, b.y + uy * off);
          }
        }
      }
    }
  }
}
