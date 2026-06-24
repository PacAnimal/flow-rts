// Shared Runner state for on-map things that fight (CONTEXT.md: Runner, Health, Faction).
// Both Unit and Building mix this in: a Faction, a current/max Health pair, and a health bar
// that only shows once damaged. Death (Health reaching 0) is handled by the world, which owns
// removal and occupancy — this module only tracks the state and draws the bar.

import { TILE } from '../constants.js';
import { FACTION } from '../units.js';

// Give `entity` (which already has `.scene` and `.sprite`) its Health + Faction.
export function attachHealth(entity, maxHealth, faction = FACTION.PLAYER) {
  entity.faction = faction;
  entity.maxHealth = maxHealth;
  entity.health = maxHealth;
  entity._healthBar = entity.scene.add.graphics().setVisible(false);
}

// Subtract Damage; clamp at 0. Returns true if this blow destroyed the Runner.
export function applyDamage(entity, amount) {
  if (entity.health <= 0) return false;
  entity.health = Math.max(0, entity.health - amount);
  return entity.health <= 0;
}

// Redraw the health bar centred at (cx) with its top at (topY), `w` px wide. Hidden at full
// Health; turns from green to red as Health drops. Depth sits above sprites.
export function drawHealthBar(entity, cx, topY, w) {
  const g = entity._healthBar;
  if (!g) return;
  if (entity.health <= 0) { g.setVisible(false); return; }
  const frac = entity.health / entity.maxHealth;
  const h = 5;
  const x = cx - w / 2;
  g.clear();
  g.fillStyle(0x5a0000, 1).fillRect(x, topY, w, h);
  g.fillStyle(0xdd1111, 1).fillRect(x, topY, w * frac, h);
  g.setDepth(2e6).setVisible(true);
}

export function destroyHealthBar(entity) {
  if (entity._healthBar) { entity._healthBar.destroy(); entity._healthBar = null; }
}

export { FACTION, TILE };
