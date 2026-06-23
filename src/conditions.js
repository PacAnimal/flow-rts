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
    // Implicitly Crystals for now (the only Resource); a Resource selector waits for a second.
    args: [{ id: 'amount', type: 'number', label: 'Amount', min: 0, step: 10 }],
  },
};

export function getCondition(id) {
  return CONDITIONS[id] || null;
}
