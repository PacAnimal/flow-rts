// The dynamic movement layer (docs/adr/0007). Owns each Unit's movement: a cached terrain
// Path (from pathfinding.js) plus per-frame steering — arrive-along-Path + separation from
// neighbours, clamped to Walkable terrain, with an overlap-resolution pass. Phaser-free: it
// reads/writes plain {x,y} pixel positions on Unit objects and queries Walkable through an
// injected predicate. MapScene constructs it and syncs sprites afterwards.

import { TILE, UNIT_SPEED } from './constants.js';
import { findPath, smoothPath } from './pathfinding.js';

const SPEED = UNIT_SPEED * TILE;     // px/s
const RADIUS = 0.30 * TILE;          // Unit collision radius
const SEP_RANGE = 0.70 * TILE;       // start pushing apart within this distance
const WP_REACH = 0.35 * TILE;        // advance to next waypoint once this close
const ARRIVE = 0.22 * TILE;          // close enough to the final destination (lone Unit)
const SLOW_RADIUS = 1.4 * TILE;      // begin easing speed near the destination
const STUCK_MS = 700;                // no progress this long near the goal ⇒ settle (arrived)
const STUCK_SPEED = SPEED * 0.12;    // below this counts as "not making progress"

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
  setGoal(unit, tx, ty) {
    const mv = this._mv(unit);
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
        if (dist(unit.x, unit.y, goal.x, goal.y) <= ARRIVE) mv.arrived = true;
        else if (moved < STUCK_SPEED * s) { if ((mv.stuck += dt) > STUCK_MS) mv.arrived = true; }
        else mv.stuck = 0;
      }
    }

    // Pass 3 — shove apart any residual overlap so Units never sit on top of each other.
    this._resolveOverlaps(units);
  }

  // Desired velocity = arrive-along-Path (only while travelling) + separation (always).
  _steer(unit, units) {
    let vx = 0, vy = 0;
    const mv = unit.mv;

    if (mv && mv.path && !mv.arrived) {
      while (mv.wp < mv.path.length - 1 && dist(unit.x, unit.y, mv.path[mv.wp].x, mv.path[mv.wp].y) < WP_REACH) mv.wp++;
      const tgt = mv.path[mv.wp];
      const d = dist(unit.x, unit.y, tgt.x, tgt.y);
      if (d > 0) {
        // ease down near the final destination so Units settle instead of orbiting
        const goal = mv.path[mv.path.length - 1];
        const dGoal = dist(unit.x, unit.y, goal.x, goal.y);
        const speed = dGoal < SLOW_RADIUS ? SPEED * Math.max(0.15, dGoal / SLOW_RADIUS) : SPEED;
        vx += (tgt.x - unit.x) / d * speed;
        vy += (tgt.y - unit.y) / d * speed;
      }
    }

    for (const other of units) {
      if (other === unit) continue;
      const dx = unit.x - other.x, dy = unit.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < SEP_RANGE) {
        const push = (1 - d / SEP_RANGE) * SPEED;
        vx += dx / d * push;
        vy += dy / d * push;
      }
    }

    // clamp to top speed (separation can fully override seek in a crowd ⇒ Units yield)
    const sp = Math.hypot(vx, vy);
    if (sp > SPEED) { vx = vx / sp * SPEED; vy = vy / sp * SPEED; }
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
