// Condition catalog: pure metadata for the boolean tests a Branch can evaluate (CONTEXT.md,
// docs/adr/0010). Each entry has an id, a display label, and an `args` schema (param
// descriptors, same shape as node Parameters) for any arguments it takes. This drives the
// editor's Condition dropdown and its dynamic arg rows. The actual evaluation lives in the
// world (MapScene._testCondition), keyed by id — this file holds no game logic and no Phaser.

export const CONDITIONS = {
  cargo_full:         { id: 'cargo_full',         label: 'Cargo full',        args: [] },
  cargo_empty:        { id: 'cargo_empty',        label: 'Cargo empty',       args: [] },
  deposit_adjacent:   { id: 'deposit_adjacent',   label: 'Deposit adjacent',  args: [] },
  at_command_center:  { id: 'at_command_center',  label: 'At command center', args: [] },
  stockpile_gte: {
    id: 'stockpile_gte',
    label: 'Stockpile ≥ N',
    // Tests one Resource's Stockpile total against an amount. The Resource is chosen from a dropdown
    // (the `resource` arg, rendered like other selector params); unset falls back to Alloys, so Flows
    // authored before the selector existed keep their meaning.
    args: [
      { id: 'resource', type: 'resource', label: 'Resource' },
      { id: 'amount', type: 'number', label: 'Amount', min: 0, step: 10 },
    ],
  },
  // Combat Conditions (docs/adr/0012): an Enemy within attack range, or within an authored
  // radius — for `Branch`-gated guard loops.
  enemy_in_range: { id: 'enemy_in_range', label: 'Enemy in range', args: [] },
  enemy_nearby: {
    id: 'enemy_nearby',
    label: 'Enemy nearby',
    args: [{ id: 'radius', type: 'number', label: 'Tiles', min: 1, step: 1 }],
  },

  // Self-state Condition: the Runner's own Health as a percentage of its max, below a threshold.
  // The sensory half of the survival reflex — pair it with Retreat (e.g. Branch(health < 40%) →
  // Retreat) when a hands-off Flow must decide for itself whether to fall back. Reads Health, which
  // every Runner carries (CONTEXT.md), so it is valid on Unit and Building Flows alike.
  self_health_below: {
    id: 'self_health_below',
    label: 'Own health below %',
    args: [{ id: 'percent', type: 'number', label: 'Percent', min: 1, max: 100, step: 5 }],
  },

  // Force-composition Conditions: count the player's own Runners so a pre-authored Flow can cap or
  // gate production without a human watching (e.g. Branch(Marines ≥ 8) ends a Barracks train loop;
  // Branch(no Barracks) → Build a Barracks). They read live world state and change nothing.
  unit_count: {
    id: 'unit_count',
    label: 'Own unit count ≥ N',
    // `unitKind` unset ⇒ count every player Unit; set ⇒ only that type. Mirrors stockpile_gte's
    // optional selector + amount shape.
    args: [
      { id: 'unitKind', type: 'unitKind', label: 'Unit' },
      { id: 'amount', type: 'number', label: 'Amount', min: 0, step: 1 },
    ],
  },
  building_exists: {
    id: 'building_exists',
    label: 'Own building exists',
    args: [{ id: 'buildingKind', type: 'buildingKind', label: 'Building' }],
  },
};

export function getCondition(id) {
  return CONDITIONS[id] || null;
}
