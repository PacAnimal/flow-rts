// Resource definitions: a pure data table, one entry per Resource type (CONTEXT.md). Each
// entry carries the gather rates and a Deposit's starting amount — properties of the type, so
// the Gather node stays parameterless and adapts to whatever it's beside (docs/adr/0008).
// Engine-agnostic: no Phaser, no game state. Adding a Resource (Gas, Wood…) is a new entry.

export const RESOURCES = {
  crystals: {
    id: 'crystals',
    label: 'Crystals',
    glyph: '◆',           // shown in the Unit's Cargo readout
    gatherTime: 3,        // seconds a Worker stands to gather one yield
    yield: 10,            // amount taken into Cargo per gather
    depositAmount: 100,   // a Deposit of this Resource starts with this much (≈10 gathers)
    sprites: Array.from({ length: 18 }, (_, i) => `crystals${i + 1}`),
  },
};

export function getResource(id) {
  return RESOURCES[id] || null;
}
