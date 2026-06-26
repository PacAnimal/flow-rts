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
    carryCapacity: 10,    // one alloy gather (docs/adr/0008)
    cost: { alloys: 50 },
    buildTime: 6,         // seconds the producing Building stands to make one
    producedBy: 'command_center',
  },
  marine: {
    id: 'marine',
    label: 'Marine',
    maxHealth: 55,
    damage: 12,           // viable early line: a faster Chojin (speed 3.5) closes anyway, so the
    range: 4,             // Marine must trade efficiently in numbers rather than get deleted 4:1.
    aggroRadius: 6,       // Tiles — peels off Attack-Move to engage within this (ADR-0012)
    attackCooldown: 1.0,  // seconds between attacks
    carryCapacity: 0,
    cost: { alloys: 50 },
    buildTime: 5,
    producedBy: 'barracks',
  },

  // Combat Units. Stats give each a distinct role so they fight when given an Attack-Move/Hold
  // Flow, instead of defaulting to a 1-HP non-combatant. The Factory produces Tank/Mech; the
  // Barracks also produces Zapper/Reaper (alongside the Marine). Chojin/Heavy Chojin remain
  // spawn-only (not producible) for now.
  tank: {
    id: 'tank',
    label: 'Tank',
    maxHealth: 220,       // heavy front-line brawler: durable, hits hard, but slow (speed set
    damage: 30,           // in the entity) and short-ranged — it must close distance to fight.
    range: 4,
    aggroRadius: 6,       // peels off only for nearby Enemies; it can't chase what it can't reach
    attackCooldown: 1.6,
    attackFx: 'cannon',   // one heavy, slow orange shell + concussive impact (effects.js)
    carryCapacity: 0,
    cost: { sludge: 200 }, // heavy industry runs on sludge (the Factory line)
    buildTime: 18,
    producedBy: 'factory',
  },
  mech: {
    id: 'mech',
    label: 'Mech',
    maxHealth: 140,       // fast, long-range skirmisher: outranges most foes and kites (high speed
    damage: 18,           // in the entity), but fragile — it dies fast if a brawler closes in.
    range: 5,             // trimmed from 7 so it isn't the strictly-best answer to everything;
    aggroRadius: 9,         // wide aggro so it opens fire well before Enemies reach it
    attackCooldown: 1.1,
    attackFx: 'autocannon', // rapid 3-round tracer burst (effects.js)
    carryCapacity: 0,
    cost: { sludge: 150 }, // heavy industry runs on sludge (the Factory line)
    buildTime: 14,
    producedBy: 'factory',
  },
  zapper: {
    id: 'zapper',
    label: 'Zapper',
    maxHealth: 60,        // fragile, fast-firing close-quarters bruiser
    damage: 10,
    range: 2,             // a "long-range melee" reach — zaps just beyond arm's length
    aggroRadius: 6,
    attackCooldown: 0.7,
    carryCapacity: 0,
    cost: { biopulp: 75 }, // elite Barracks infantry, funded by harvesting slain Enemies
    buildTime: 8,
    producedBy: 'barracks',
    attackFx: 'lightning', // crackling arc, not the generic laser bolt (see effects.js)
  },
  reaper: {
    id: 'reaper',
    label: 'Reaper',
    maxHealth: 70,        // fast skirmisher (speed set in the entity)
    damage: 14,
    range: 2,
    aggroRadius: 8,
    attackCooldown: 0.9,
    carryCapacity: 0,
    cost: { biopulp: 100 }, // elite Barracks infantry, funded by harvesting slain Enemies
    buildTime: 10,
    producedBy: 'barracks',
    attackFx: 'shotgun',  // close-range pellet spread, not the generic laser bolt (effects.js)
  },
  chojin: {
    id: 'chojin',
    label: 'Chojin',
    maxHealth: 110,       // melee bruiser
    damage: 16,
    range: 1.5,
    aggroRadius: 6,
    attackCooldown: 1.0,
    carryCapacity: 0,
  },
  'heavy-chojin': {
    id: 'heavy-chojin',
    label: 'Heavy Chojin',
    maxHealth: 200,       // heavy melee
    damage: 28,
    range: 1.5,
    aggroRadius: 6,
    attackCooldown: 1.4,
    carryCapacity: 0,
  },
};

// tileW/tileH are the Building's Footprint in Tiles. `builder` marks a Building that can run the
// Build Action (docs/adr/0018) — only the Command Center, for now. `buildable` + cost + buildTime
// (the SOLO-Worker seconds to construct; N builders finish in buildTime/N, capped at 4) belong to
// the types a Worker crew can raise from a Construction Site. Numbers live here, not as Parameters
// (same call as UNIT_TYPES cost/buildTime, ADR-0013).
export const BUILDING_TYPES = {
  command_center: { id: 'command_center', label: 'Command Center', maxHealth: 1500, tileW: 6, tileH: 6, builder: true },
  barracks:       { id: 'barracks',       label: 'Barracks',       maxHealth: 800,  tileW: 6, tileH: 6, buildable: true, cost: { alloys: 150 }, buildTime: 20 },
  factory:        { id: 'factory',        label: 'Factory',        maxHealth: 900,  tileW: 6, tileH: 6, buildable: true, cost: { alloys: 250 }, buildTime: 30 },
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

// Building types a Worker crew can raise from a Construction Site — drives the Build node's
// building-type dropdown (docs/adr/0018). Mirrors producibleBy for Units. The Command Center is
// not buildable (it is the builder), so a base can't bootstrap itself from nothing.
export function buildableBuildings() {
  return Object.values(BUILDING_TYPES).filter((b) => b.buildable);
}
