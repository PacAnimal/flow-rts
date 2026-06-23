// Decoration definitions: a pure data table, one entry per Decoration type (CONTEXT.md). Each
// declares its sprite(s), Footprint size in Tiles, whether it blocks (an obstacle), how many to
// scatter per level, and its sprite scale range. Engine-agnostic: no Phaser, no game state.
// The placer in MapScene reads this; adding a type (a 2×2 boulder, say) is a new entry.
// See docs/adr/0009.

export const DECORATIONS = {
  tree: {
    id: 'tree',
    sprites: Array.from({ length: 27 }, (_, i) => `tree${i + 1}`),
    w: 1, h: 1,
    blocking: true,     // an obstacle — Units path around a tree's Tile
    count: 220,         // attempts to scatter per level (best-effort)
    clustered: false,   // spread uniformly across the map rather than in clumps
    scale: [1.5, 2.5],  // sprite size ≈ this × TILE (random in range)
    originY: 0.85,      // anchor near the trunk base
  },
};

export function getDecoration(id) {
  return DECORATIONS[id] || null;
}
