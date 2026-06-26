// Unit Upgrade definitions: a pure data table, one entry per Upgrade (docs/adr/0021, CONTEXT.md).
// An Upgrade is a permanent, player-wide improvement to a single Unit type, unlocked by the
// Research Action. Cost, research time, prerequisites, and the effect live here — not as Parameters
// on any Node — the same call ADR-0008/0012/0013 made for gather rates, combat stats, and
// production. Engine-agnostic: no Phaser, no game state. The player-wide registry of *which*
// Upgrades are researched lives in MapScene; this table is just the catalogue.
//
// An Upgrade targets exactly one Unit type (`unitType`) and carries either:
//   • `modifiers` — additive deltas merged onto that type's base stats by MapScene's effectiveStats
//     seam (live-read stats like damage/range apply retroactively for free; stored stats like
//     maxHealth/carryCapacity are also bumped on existing Units when research completes), or
//   • `grants`    — named ability flags the world reads for Upgrades that change *how* a Unit fights
//     rather than its numbers (the v1 transforming proof is Tank `splash`).
// `requires` is the reserved prerequisite hook (empty today — the model is flat, docs/adr/0021).

import { getUnitType } from './units.js';

export const UPGRADES = {
  // Command Center → Worker
  reinforced_cargo: {
    id: 'reinforced_cargo', label: 'Reinforced Cargo', unitType: 'worker',
    cost: { alloys: 120 }, researchTime: 18, requires: [],
    modifiers: { carryCapacity: 10 }, // one trip hauls double (10 → 20)
  },
  worker_plating: {
    id: 'worker_plating', label: 'Hardened Frames', unitType: 'worker',
    cost: { alloys: 100 }, researchTime: 16, requires: [],
    modifiers: { maxHealth: 30 },
  },

  // Barracks → Marine / Zapper / Reaper (single-Unit targeted, docs/adr/0021)
  marine_shields: {
    id: 'marine_shields', label: 'Combat Shields', unitType: 'marine',
    cost: { alloys: 150 }, researchTime: 20, requires: [],
    modifiers: { maxHealth: 25 },
  },
  marine_weapons: {
    id: 'marine_weapons', label: 'Weapon Calibration', unitType: 'marine',
    cost: { alloys: 150 }, researchTime: 20, requires: [],
    modifiers: { damage: 6 },
  },
  marine_barrels: {
    id: 'marine_barrels', label: 'Extended Barrels', unitType: 'marine',
    cost: { alloys: 175 }, researchTime: 24, requires: [],
    modifiers: { range: 1.5 },
  },
  zapper_overcharge: {
    id: 'zapper_overcharge', label: 'Capacitor Overcharge', unitType: 'zapper',
    cost: { biopulp: 125 }, researchTime: 20, requires: [],
    modifiers: { damage: 5 },
  },
  reaper_plating: {
    id: 'reaper_plating', label: 'Ablative Plating', unitType: 'reaper',
    cost: { biopulp: 125 }, researchTime: 20, requires: [],
    modifiers: { maxHealth: 20 },
  },

  // Factory → Tank / Mech (heavy industry runs on sludge, like the vehicles themselves)
  tank_plating: {
    id: 'tank_plating', label: 'Armor Plating', unitType: 'tank',
    cost: { sludge: 250 }, researchTime: 30, requires: [],
    modifiers: { maxHealth: 60 },
  },
  tank_shaped_charges: {
    id: 'tank_shaped_charges', label: 'Shaped Charges', unitType: 'tank',
    cost: { sludge: 300 }, researchTime: 36, requires: [],
    grants: ['splash'], // transforming proof: the cannon deals splash damage around its target
  },
  mech_optics: {
    id: 'mech_optics', label: 'Targeting Optics', unitType: 'mech',
    cost: { sludge: 200 }, researchTime: 26, requires: [],
    modifiers: { range: 1 },
  },
};

export function getUpgrade(id) {
  return UPGRADES[id] || null;
}

// The Upgrades a given Building (by its type key) can Research — those whose target Unit it produces
// (docs/adr/0021). Drives the Research node's upgrade dropdown, mirroring producibleBy for Train.
export function researchableBy(buildingKey) {
  return Object.values(UPGRADES).filter((u) => getUnitType(u.unitType)?.producedBy === buildingKey);
}
