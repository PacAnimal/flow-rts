// The combat layer (docs/adr/0012). Self-contained: a Unit carries a combat *intent*
// (`unit.combat = { mode, dest }`) set by the Attack-Move / Hold executors, and this system
// resolves it each frame — acquire the nearest Enemy, chase or hold, and attack on cooldown.
// Engine- and Phaser-free: it reads plain {x,y} positions, drives the injected MovementSystem,
// and applies Damage through a callback. Targeting lives here, never wired as Data (ADR-0012).

import { TILE } from './constants.js';
import { getUnitType } from './units.js';

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export class CombatSystem {
  // targetsFor(unit) → [{ entity, x, y, radius }] alive Enemies (point + footprint radius).
  // onAttack(attacker, entity) → apply the attacker's Damage (the world handles death).
  // statsFor(unit) → the unit's *effective* combat stats (base table + researched Upgrades,
  //   docs/adr/0021). Injected so combat stays engine-pure (ADR-0006) yet reads upgraded stats;
  //   defaults to the raw type table when no seam is wired.
  // movement → the MovementSystem, for chase (setGoal) and stop.
  constructor({ targetsFor, onAttack, movement, statsFor }) {
    this.targetsFor = targetsFor;
    this.onAttack = onAttack;
    this.movement = movement;
    this.statsFor = statsFor || ((unit) => getUnitType(unit.type));
  }

  update(units, dt) {
    for (const unit of units) this._tick(unit, dt);
  }

  _tick(unit, dt) {
    const c = unit.combat;
    if (!c) return;
    const def = this.statsFor(unit); // effective stats: base + researched Upgrades (docs/adr/0021)
    if (!def || def.damage <= 0) { c.engaged = false; return; } // non-combatant (Worker)

    const rangePx = def.range * TILE;
    const aggroPx = Math.max(def.aggroRadius, def.range) * TILE;
    c.cooldown = Math.max(0, (c.cooldown || 0) - dt);

    // Hold seeks within its attack range only (a stationary guard); Attack-Move peels off to
    // anything within the wider aggro radius (docs/adr/0012).
    const seekRadius = c.mode === 'hold' ? rangePx : aggroPx;
    const target = this._nearest(unit, seekRadius);

    if (target) {
      const edge = dist(unit.x, unit.y, target.x, target.y) - target.radius;
      if (edge <= rangePx) {                       // in range: stop, face, attack on cooldown
        this.movement.stop(unit);
        unit._vel = { x: target.x - unit.x, y: target.y - unit.y };
        if (c.cooldown <= 0) {
          this.onAttack(unit, target.entity);
          c.cooldown = def.attackCooldown * 1000;
        }
        c.engaged = true;
        return;
      }
      if (c.mode === 'attackmove') {               // out of range but aggroed: chase its Tile
        this.movement.setGoal(unit, Math.floor(target.x / TILE), Math.floor((target.y) / TILE));
        c.engaged = true;
        return;
      }
    }

    // No engageable Enemy: Attack-Move resumes toward its destination; Hold stands its ground.
    c.engaged = false;
    if (c.mode === 'attackmove' && c.dest) this.movement.setGoal(unit, c.dest.x, c.dest.y);
    else if (c.mode === 'hold') this.movement.stop(unit);
  }

  _nearest(unit, radius) {
    let best = null, bestD = Infinity;
    for (const t of this.targetsFor(unit)) {
      const edge = dist(unit.x, unit.y, t.x, t.y) - t.radius;
      if (edge < bestD && edge <= radius) { bestD = edge; best = t; }
    }
    return best;
  }
}
