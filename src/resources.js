// Resource definitions: a pure data table, one entry per Resource type (CONTEXT.md). Each
// entry carries the gather/deliver rates and a Deposit's starting amount — properties of the
// type, so the Gather/Deliver nodes stay parameterless and adapt to what they handle (docs/adr/
// 0008). Engine-agnostic: no Phaser, no game state. Adding a Resource (Gas, Wood…) is a new entry.

export const RESOURCES = {
  alloys: {
    id: 'alloys',
    label: 'Alloys',
    glyph: '⬡',           // shown in the Unit's Cargo readout
    gatherTime: 3,        // seconds a Worker stands to gather one yield
    deliverTime: 1.5,     // seconds a Worker stands to unload its Cargo at the Command Center
    yield: 10,            // amount taken into Cargo per gather
    depositAmount: 100,   // a Deposit of this Resource starts with this much (≈10 gathers)
    sprites: Array.from({ length: 9 }, (_, i) => `alloys${i + 1}`),
  },
  sludge: {
    id: 'sludge',
    label: 'Sludge',
    glyph: '●',
    gatherTime: 4,        // viscous — slower to gather than alloys
    deliverTime: 1.5,
    yield: 10,
    depositAmount: 120,   // pools run deeper (≈12 gathers)
    sprites: Array.from({ length: 9 }, (_, i) => `sludge${i + 1}`),
  },
  biopulp: {
    id: 'biopulp',
    label: 'Biopulp',
    glyph: '☠',
    gatherTime: 2,        // fresh organic matter — faster to harvest than mineral deposits
    deliverTime: 1.5,
    yield: 10,
    depositAmount: 60,    // a single body yields less than a geological deposit (≈6 gathers)
    sprites: Array.from({ length: 9 }, (_, i) => `biopulp${i + 1}`),
  },
};

export function getResource(id) {
  return RESOURCES[id] || null;
}
