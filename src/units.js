// Unit- and Building-type definitions: a pure data table, one entry per type (CONTEXT.md).
// Combat numbers (maxHealth, damage, range, aggroRadius, attackCooldown), economy (cost,
// buildTime), and carry capacity are properties of the *type*, not Parameters on any Node —
// the same call ADR-0008 made for gather rates and ADR-0012/0013 made for combat/production.
// Engine-agnostic: no Phaser, no game state. range/aggroRadius are in Tiles (the world converts
// to pixels). Adding a unit or building type is a new entry here.

// Which side a Runner belongs to (CONTEXT.md Faction). CRITTER is a third side hostile to both.
export const FACTION = { PLAYER: 'player', ENEMY: 'enemy', CRITTER: 'critter' };

export const UNIT_TYPES = {
  biter: {
    id: 'biter',
    label: 'Biter',
    maxHealth: 90,
    damage: 14,
    range: 1.5,
    aggroRadius: 10,     // aggressive — peels off at anything within sight
    attackCooldown: 1.3,
    carryCapacity: 0,
  },
  worker: {
    id: 'worker',
    label: 'Worker',
    maxHealth: 40,
    damage: 0,            // workers do not fight
    range: 0,
    aggroRadius: 0,
    attackCooldown: 0,
    carryCapacity: 10,    // one crystal gather (docs/adr/0008)
    cost: { crystals: 50 },
    buildTime: 6,         // seconds the producing Building stands to make one
    producedBy: 'command_center',
  },
  marine: {
    id: 'marine',
    label: 'Marine',
    maxHealth: 55,
    damage: 8,
    range: 4,             // Tiles — attacks an Enemy within this reach
    aggroRadius: 6,       // Tiles — peels off Attack-Move to engage within this (ADR-0012)
    attackCooldown: 1.0,  // seconds between attacks
    carryCapacity: 0,
    cost: { crystals: 50 },
    buildTime: 5,
    producedBy: 'barracks',
  },
};

export const BUILDING_TYPES = {
  command_center: { id: 'command_center', label: 'Command Center', maxHealth: 1500 },
  barracks:       { id: 'barracks',       label: 'Barracks',       maxHealth: 800  },
  factory:        { id: 'factory',        label: 'Factory',        maxHealth: 900  },
};

export function getUnitType(id) {
  return UNIT_TYPES[id] || null;
}

export function getBuildingType(id) {
  return BUILDING_TYPES[id] || null;
}

// The unit types a given Building (by its type key) can produce — drives the Train node's
// unit-type dropdown (docs/adr/0013). A Building constrains the menu to what it makes.
export function producibleBy(buildingKey) {
  return Object.values(UNIT_TYPES).filter((u) => u.producedBy === buildingKey);
}

// Building types that can produce at least one Unit — Command Center, Barracks (docs/adr/0016).
// Drives the Library's per-building "new Flow" buttons: only producer Buildings get Train Flows.
export function producerBuildings() {
  return Object.values(BUILDING_TYPES).filter((b) => producibleBy(b.id).length > 0);
}
