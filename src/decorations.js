// Decoration definitions: a pure data table, one entry per Decoration type (CONTEXT.md). Each
// declares its sprite(s), Footprint size in Tiles, whether it blocks (an obstacle), how many to
// scatter per level, and its sprite scale range. Engine-agnostic: no Phaser, no game state.
// The placer in MapScene reads this; adding a type (a 2×2 boulder, say) is a new entry.
// See docs/adr/0009.

// obstacle_01 … obstacle_13 — the "hole" art.
const HOLE_SPRITES = Array.from({ length: 13 }, (_, i) => `obstacle_${String(i + 1).padStart(2, '0')}`);

// base_marks — ground decals. odd rows (1,3,5,7,9) are obstacles; even rows are walkable.
const MARK_BLOCKING = [1, 3, 5, 7, 9].map(i => `base_mark_${String(i).padStart(2, '0')}`);
const MARK_OPEN     = [2, 4, 6, 8  ].map(i => `base_mark_${String(i).padStart(2, '0')}`);

// dirt patches — walkable ground decals (dirt1 has 8 sprites, dirt2 has 9)
const DIRT_SPRITES = [
  ...Array.from({ length: 8 }, (_, i) => `dirt1_${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 9 }, (_, i) => `dirt2_${String(i + 1).padStart(2, '0')}`),
];

export const DECORATIONS = {
  tree: {
    id: 'tree',
    sprites: ['tree1', 'tree2'],
    w: 1, h: 1,
    blocking: true,     // an obstacle — Units path around a tree's Tile
    count: 220,         // attempts to scatter per level (best-effort)
    clustered: false,   // spread uniformly across the map rather than in clumps
    scale: [1.5, 2.5],  // sprite size ≈ this × TILE (random in range)
    originY: 0.85,      // anchor near the trunk base
  },
  hole: {
    id: 'hole',
    sprites: HOLE_SPRITES,
    w: 1, h: 1,
    blocking: true,     // an obstacle — its Tile is unwalkable
    count: 50,
    clustered: false,
    scale: [2.0, 3.5],
    originY: 0.85,
  },
  base_mark_obstacle: {
    id: 'base_mark_obstacle',
    sprites: MARK_BLOCKING,
    w: 1, h: 1,
    blocking: true,
    count: 30,
    clustered: false,
    scale: [1.5, 2.5],
    originY: 1.0,
  },
  base_mark_open: {
    id: 'base_mark_open',
    sprites: MARK_OPEN,
    w: 1, h: 1,
    blocking: false,
    count: 30,
    clustered: false,
    scale: [1.5, 2.5],
    originY: 1.0,
  },
  dirt: {
    id: 'dirt',
    sprites: DIRT_SPRITES,
    w: 1, h: 1,
    blocking: false,
    count: 80,
    clustered: false,
    scale: [1.5, 2.5],
    originY: 1.0,
  },
};

export function getDecoration(id) {
  return DECORATIONS[id] || null;
}
