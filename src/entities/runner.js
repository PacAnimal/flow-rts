// Shared Runner state for on-map things that fight (CONTEXT.md: Runner, Health, Faction).
// Both Unit and Building mix this in: a Faction, a current/max Health pair. Health bars are
// rendered as DOM elements by MapScene (immune to camera zoom). Death (Health reaching 0) is
// handled by the world, which owns removal and occupancy — this module only tracks the state.

import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

// Give `entity` its Health + Faction.
export function attachHealth(entity, maxHealth, faction = FACTION.PLAYER) {
  entity.faction = faction;
  entity.maxHealth = maxHealth;
  entity.health = maxHealth;
}

// Subtract Damage; clamp at 0. Returns true if this blow destroyed the Runner.
export function applyDamage(entity, amount) {
  if (entity.health <= 0) return false;
  entity.health = Math.max(0, entity.health - amount);
  return entity.health <= 0;
}

export { FACTION, TILE };
