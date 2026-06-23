import Phaser from 'phaser';
import { Worker } from '../entities/Worker.js';
import { CommandCenter } from '../entities/CommandCenter.js';
import { Barracks } from '../entities/Barracks.js';
import { Factory } from '../entities/Factory.js';
import { TILE, EXTRUDE, UNIT_CARRY_CAPACITY } from '../constants.js';
import { flowLibrary } from '../flow/library.js';
import { openAssignOverlay } from '../flow/assign.js';
import { registerPositionPicker } from '../flow/positionPicker.js';
import { startRun, tickRun } from '../flow/runtime.js';
import { MovementSystem } from '../movement.js';
import { getResource, RESOURCES } from '../resources.js';
import { DECORATIONS } from '../decorations.js';
import '../flow/editor.css'; // shared overlay chrome — styles the Start/Pause button
const MAP_W = 120;
const MAP_H = 90;

// Tiles kept clear of crystals/decorations around the command center, beyond its footprint,
// so the start area stays open (docs/adr/0009).
const START_CLEARANCE = 3;

// How close (in Tiles, to the footprint) a Worker must be to deliver Cargo. Forgiving, since a
// large blocking Building makes Units settle a Tile or two short of touching it (docs/adr/0008).
const DELIVER_RANGE = 2;

// localStorage key for per-Unit Flow assignments ({ [unit.label]: flowId }).
const ASSIGN_KEY = 'flow-rts.assignments.v1';

// tileset layout: grass (0-2), hill autotile (3-18), shadow (19), ramp (20), ramp-ground (21)
// hill autotile index = T_HILL_BASE + bitmask
// bitmask bits: 0=N exposed, 1=S exposed, 2=E exposed, 3=W exposed
const T_GRASS_A   = 0;
const T_GRASS_B   = 1;
const T_GRASS_C   = 2;
const T_HILL_BASE = 3;   // indices 3..18
const T_SHADOW    = 19;
const T_RAMP      = 20;
const T_RAMP_GND  = 21;
const TOTAL_TILES = 22;

function mkRNG(seed) {
  let s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s = (s >>> 0) || 1) / 0x100000000;
  };
}

export class MapScene extends Phaser.Scene {
  constructor() { super('MapScene'); }

  preload() {
    this.load.image('command_center', '/sprites/command_center.png');
    this.load.image('barracks', '/sprites/barracks.png');
    this.load.image('factory', '/sprites/factory.png');
    this.load.image('worker', '/sprites/worker.png');
    this.load.image('tree1', '/sprites/tree1.png');
    this.load.image('tree2', '/sprites/tree2.png');
    this.load.image('crystals1', '/sprites/crystals1.png');
    this.load.image('crystals2', '/sprites/crystals2.png');
    for (let i = 1; i <= 13; i++) {
      const n = String(i).padStart(2, '0');
      this.load.image(`obstacle_${n}`, `/sprites/obstacles/obstacles_${n}.png`);
    }
    for (let i = 1; i <= 9; i++) {
      const n = String(i).padStart(2, '0');
      this.load.image(`base_mark_${n}`, `/sprites/decor/base_marks_${n}.png`);
    }
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, '0');
      this.load.image(`dirt1_${n}`, `/sprites/decor/dirt1_${n}.png`);
    }
    for (let i = 1; i <= 9; i++) {
      const n = String(i).padStart(2, '0');
      this.load.image(`dirt2_${n}`, `/sprites/decor/dirt2_${n}.png`);
    }
    this.load.image('gravel',  '/sprites/decor/gravel.png');
    this.load.image('gravel2', '/sprites/decor/gravel2.png');
    this.load.image('gravel3', '/sprites/decor/gravel3.png');
    this.load.image('gravel4', '/sprites/decor/gravel4.png');
  }

  create() {
    // The simulation starts paused: no Flow ticks and no Unit movement until START is pressed
    // (docs/adr/0005). Set before spawning Units so their Runs don't begin at assignment.
    this._running = false;

    // Shared Tile-occupancy layer (docs/adr/0009): `${tx},${ty}` → { kind, blocking }. Every
    // footprint feature (Deposit, Decoration, Building) registers here. Spawn rejects a
    // placement if any of its Footprint Tiles is occupied; walkable() blocks on blocking ones.
    this._occupied = new Map();

    // Deposits (docs/adr/0008): a list plus a Tile→Deposit lookup the gather code consults.
    // Deposits also register in the occupancy layer above.
    this._deposits = [];
    this._depositByTile = new Map(); // `${tx},${ty}` → Deposit

    // The player's Stockpile (docs/adr/0008): Resource id → amount, grown when a Worker delivers
    // its Cargo at the command center. Shown in the materials panel.
    this._stockpile = {};

    this._makeTileset();
    const { tiles, isHill, isRamp } = this._generateTerrain();
    this._isHill = isHill;
    this._isRamp = isRamp;
    this._drawGroundBase();
    this._drawAlgorithmicNoise();
    this._drawGravelLayer();
    this._drawGravel2Layer();
    this._drawGravel3Layer();
    this._drawGravel4Layer();
    this._buildTilemap(tiles);
    this._spawnBuildings();   // reserve command-center footprint + start clearance first
    this._placeCrystals();    // clustered crystal Deposits (docs/adr/0009)
    this._placeDecorations(); // trees, holes — scattered, no overlap (docs/adr/0009)
    this._spawnUnits();
    this._setupCamera();
    this.input.mouse?.disableContextMenu(); // allow right-click as a cancel gesture
    registerPositionPicker((opts) => this._beginPositionPick(opts));

    // The static-terrain + dynamic-steering movement layer (docs/adr/0007). Owns Unit Paths
    // and avoidance; the interpreter reaches it only through the world context below.
    this._movement = new MovementSystem({
      isWalkable: (tx, ty) => this.walkable(tx, ty),
      width: MAP_W,
      height: MAP_H,
    });

    // The world context handed to the Flow interpreter: the only surface through which a
    // node's effect reaches the game (docs/adr/0006). The interpreter has no Phaser; these
    // primitives do. Move sets a goal and reads whether the Unit has arrived; the actual
    // pathing/steering runs in update()'s movement pass.
    this._world = {
      moveToward: (unit, destTile) => {
        this._movement.setGoal(unit, destTile.x, destTile.y);
        return this._movement.arrived(unit);
      },
      position: (unit) => ({ x: unit.x, y: unit.y }),
      walkable: (tx, ty) => this.walkable(tx, ty),
      adjacentDeposit: (unit) => this._adjacentDeposit(unit),
      collect: (unit, deposit) => this._collect(unit, deposit),
      deliver: (unit) => this._deliver(unit),
    };

    this._buildStartButton();
    this._buildMaterialsPanel();
  }

  // Per-frame loop (docs/adr/0005, 0007): while running, tick every Run (a running Move sets
  // its goal), then integrate movement for all Units at once (so idle Units also get shoved),
  // then sync sprites. Paused ⇒ nothing ticks and nothing moves.
  update(_time, delta) {
    if (!this.units || !this._running) return;
    for (const unit of this.units) {
      const run = unit.run;
      if (!run || run.status !== 'running') continue;
      const entry = flowLibrary.get(run.flowId);
      if (!entry) { run.status = 'halted'; continue; }
      tickRun(run, unit, entry.model, this._world, delta);
    }
    this._movement.update(this.units, delta);
    for (const unit of this.units) this._placeUnit(unit);
  }

  // A Tile is Walkable if it is lowland ground or a ramp (hill tops are not) AND not held by a
  // blocking occupant — a Deposit, a blocking Decoration, or a Building (CONTEXT.md, ADR-0009).
  // Non-blocking occupants (e.g. trees) reserve a Tile for spawning but stay Walkable.
  walkable(tx, ty) {
    if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return false;
    const occ = this._occupied.get(`${tx},${ty}`);
    if (occ && occ.blocking) return false;
    return !(this._isHill(tx, ty) && !this._isRamp(tx, ty));
  }

  // ── tileset ──────────────────────────────────────────────────────────────

  _makeTileset() {
    const canvas = document.createElement('canvas');
    canvas.width  = TILE * TOTAL_TILES;
    canvas.height = TILE;
    const ctx = canvas.getContext('2d');

    // grass tiles (0-2) are transparent — base ground color comes from _drawGroundBase()

    // pre-generate all 16 hill autotile variants
    for (let mask = 0; mask < 16; mask++) {
      const ox      = (T_HILL_BASE + mask) * TILE;
      const variant = (mask ^ (mask >> 2)) & 1; // stable 2-colour variation
      this._drawHillBase(ctx, ox, variant);
      if (mask & 1) this._drawNorthEdge(ctx, ox);
      if (mask & 2) this._drawSouthCliff(ctx, ox);
      if (mask & 4) this._drawEastCliff(ctx, ox);
      if (mask & 8) this._drawWestCliff(ctx, ox);
    }

    this._drawShadowTile(ctx, T_SHADOW  * TILE);
    this._drawRampTile(ctx,   T_RAMP    * TILE);
    this._drawRampGndTile(ctx, T_RAMP_GND * TILE);

    // extrude each tile by EXTRUDE px: stretch to cover border, then blit crisp interior on top
    const SLOT = TILE + 2 * EXTRUDE;
    const dst  = document.createElement('canvas');
    dst.width  = SLOT * TOTAL_TILES;
    dst.height = TILE + 2 * EXTRUDE;
    const dctx = dst.getContext('2d');
    for (let t = 0; t < TOTAL_TILES; t++) {
      const sx = t * TILE, dx = t * SLOT;
      dctx.drawImage(canvas, sx, 0, TILE, TILE, dx,           0,       SLOT, TILE + 2 * EXTRUDE); // stretched border
      dctx.drawImage(canvas, sx, 0, TILE, TILE, dx + EXTRUDE, EXTRUDE, TILE, TILE);               // crisp interior
    }

    this.textures.addCanvas('tileset', dst);
  }

  _drawHillBase(ctx, ox, variant) {
    ctx.fillStyle = variant ? '#68b440' : '#6aba45';
    ctx.fillRect(ox, 0, TILE, TILE);
    const g = mkRNG(ox * 17 + 3);
    ctx.fillStyle = variant ? '#7ccc4e' : '#80ce52';
    for (let i = 0; i < 12; i++) ctx.fillRect((ox + g() * TILE) | 0, (g() * TILE) | 0, 2, 2);
    ctx.fillStyle = variant ? '#56983a' : '#58a038';
    for (let i = 0; i < 8;  i++) ctx.fillRect((ox + g() * TILE) | 0, (g() * TILE) | 0, 2, 2);
  }

  // thin dark band — terrain drops to the north here
  _drawNorthEdge(ctx, ox) {
    ctx.fillStyle = '#1e3e10';
    ctx.fillRect(ox, 0, TILE, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(ox, 0, TILE, 3);
  }

  // full cliff face — most prominent, south-facing
  _drawSouthCliff(ctx, ox) {
    const splitY = (TILE * 0.54) | 0;
    const cliffH = (TILE * 0.27) | 0;

    ctx.fillStyle = '#c8ff80'; // bright crest highlight
    ctx.fillRect(ox, splitY - 2, TILE, 2);

    ctx.fillStyle = '#7a5c28'; // cliff face
    ctx.fillRect(ox, splitY, TILE, cliffH);

    // rock striations
    const g = mkRNG(ox * 13 + 5);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    for (let i = 0; i < 8; i++) ctx.fillRect((ox + g() * TILE) | 0, splitY, 2, cliffH);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 4; i++) ctx.fillRect((ox + g() * TILE) | 0, splitY, 1, cliffH);

    ctx.fillStyle = '#3a2810'; // deep base shadow
    ctx.fillRect(ox, splitY + cliffH, TILE, TILE - splitY - cliffH);
  }

  // narrow ridge strip on right edge: inner highlight → cliff → outer shadow
  _drawEastCliff(ctx, ox) {
    ctx.fillStyle = '#6ab040';  // inner highlight
    ctx.fillRect(ox + TILE - 12, 0, 1, TILE);
    ctx.fillStyle = '#7a5c28';  // cliff face
    ctx.fillRect(ox + TILE - 11, 0, 7, TILE);
    ctx.fillStyle = '#3a2810';  // outer shadow
    ctx.fillRect(ox + TILE - 4,  0, 4, TILE);
  }

  // mirror of east
  _drawWestCliff(ctx, ox) {
    ctx.fillStyle = '#3a2810';  // outer shadow
    ctx.fillRect(ox,      0, 4, TILE);
    ctx.fillStyle = '#7a5c28';  // cliff face
    ctx.fillRect(ox + 4,  0, 7, TILE);
    ctx.fillStyle = '#6ab040';  // inner highlight
    ctx.fillRect(ox + 11, 0, 1, TILE);
  }

  _drawShadowTile(ctx, ox) {
    ctx.fillStyle = '#4a8c40';
    ctx.fillRect(ox, 0, TILE, TILE);
    const grad = ctx.createLinearGradient(ox, 0, ox, TILE * 0.5);
    grad.addColorStop(0, 'rgba(0,0,0,0.52)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(ox, 0, TILE, (TILE * 0.5) | 0);
  }

  // ramp: hill green on top, dirt path replaces cliff face on bottom
  _drawRampTile(ctx, ox) {
    this._drawHillBase(ctx, ox, 0);
    const splitY = (TILE * 0.54) | 0;

    ctx.fillStyle = '#c8ff80'; // crest line (matches south cliff)
    ctx.fillRect(ox, splitY - 2, TILE, 2);

    ctx.fillStyle = '#b89a60'; // dirt path
    ctx.fillRect(ox, splitY, TILE, TILE - splitY);

    // subtle path-side shadows (edges of the ramp opening)
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(ox,              splitY + 2, 4, TILE - splitY - 2);
    ctx.fillRect(ox + TILE - 4,   splitY + 2, 4, TILE - splitY - 2);

    // dirt texture
    const g = mkRNG(ox * 23 + 7);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    for (let i = 0; i < 8; i++) {
      ctx.fillRect((ox + 4 + g() * (TILE - 8)) | 0, (splitY + g() * (TILE - splitY)) | 0, 3, 2);
    }
  }

  // ground tile directly below a ramp: path fading into grass
  _drawRampGndTile(ctx, ox) {
    ctx.fillStyle = '#4a8c40';
    ctx.fillRect(ox, 0, TILE, TILE);

    ctx.fillStyle = '#b89a60'; // path colour at top
    ctx.fillRect(ox, 0, TILE, (TILE * 0.22) | 0);

    const grad = ctx.createLinearGradient(ox, (TILE * 0.18) | 0, ox, (TILE * 0.45) | 0);
    grad.addColorStop(0, 'rgba(74,140,64,0)');
    grad.addColorStop(1, 'rgba(74,140,64,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(ox, (TILE * 0.18) | 0, TILE, (TILE * 0.32) | 0);

    const g = mkRNG(ox * 41 + 2);
    ctx.fillStyle = '#3a7030';
    for (let i = 0; i < 15; i++) {
      ctx.fillRect((ox + g() * TILE) | 0, ((TILE * 0.3 + g() * TILE * 0.7)) | 0, 2, 2);
    }
  }

  // ── terrain generation ────────────────────────────────────────────────────

  _generateTerrain() {
    const buf = new Uint8Array(MAP_W * MAP_H); // 0=grass, 1=hill, 2=ramp
    const r = mkRNG(42);

    for (let i = 0; i < 16; i++) {
      const cx = (r() * (MAP_W - 28) + 14) | 0;
      const cy = (r() * (MAP_H - 28) + 14) | 0;
      const rx = (r() * 10 + 5) | 0;
      const ry = (r() * 6  + 4) | 0;
      for (let dy = -ry; dy <= ry; dy++) {
        for (let dx = -rx; dx <= rx; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) {
            if ((dx / rx) ** 2 + (dy / ry) ** 2 <= 1) buf[y * MAP_W + x] = 1;
          }
        }
      }
    }

    // ramps are still elevated (buf >= 1) but rendered as paths not cliffs
    this._placeRamps(buf);

    const isHill = (x, y) =>
      x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && buf[y * MAP_W + x] >= 1;
    const isRamp = (x, y) =>
      x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && buf[y * MAP_W + x] === 2;

    const tiles = Array.from({ length: MAP_H }, (_, y) =>
      Array.from({ length: MAP_W }, (_, x) => {
        const cell = buf[y * MAP_W + x];

        if (cell === 2) return T_RAMP;

        if (cell === 1) {
          let mask = 0;
          if (!isHill(x, y - 1)) mask |= 1; // N exposed
          if (!isHill(x, y + 1)) mask |= 2; // S exposed
          if (!isHill(x + 1, y)) mask |= 4; // E exposed
          if (!isHill(x - 1, y)) mask |= 8; // W exposed
          return T_HILL_BASE + mask;
        }

        // grass — check for shadow or ramp-ground
        if (isRamp(x, y - 1)) return T_RAMP_GND;
        if (isHill(x, y - 1)) return T_SHADOW;
        return (x * 3 + y * 11) % 3; // T_GRASS_A/B/C
      })
    );

    return { tiles, isHill, isRamp };
  }

  // punch 2-wide ramps into south-facing cliff runs of ≥5 tiles
  _placeRamps(buf) {
    const r = mkRNG(77);
    for (let y = 2; y < MAP_H - 2; y++) {
      let runStart = -1;
      for (let x = 0; x <= MAP_W; x++) {
        const cliff = x < MAP_W &&
          buf[y * MAP_W + x] === 1 &&
          buf[(y + 1) * MAP_W + x] === 0;

        if (cliff && runStart === -1) {
          runStart = x;
        } else if (!cliff && runStart !== -1) {
          const runLen = x - runStart;
          if (runLen >= 5) {
            // keep at least 1 cliff cell on each side of the ramp
            const off = (r() * (runLen - 4)) | 0;
            const rx  = runStart + 1 + off;
            buf[y * MAP_W + rx]     = 2;
            buf[y * MAP_W + rx + 1] = 2;
          }
          runStart = -1;
        }
      }
    }
  }

  // ── tilemap ───────────────────────────────────────────────────────────────

  _buildTilemap(tiles) {
    const map = this.make.tilemap({ data: tiles, tileWidth: TILE, tileHeight: TILE });
    const ts  = map.addTilesetImage('tileset', 'tileset', TILE, TILE, EXTRUDE, 2 * EXTRUDE);
    map.createLayer(0, ts, 0, 0).setDepth(-50);
  }

  // ── ground noise system ──────────────────────────────────────────────────────

  // Solid base rectangle — everything sits on top of this.
  _drawGroundBase() {
    this.add.graphics()
      .fillStyle(0x000000)
      .fillRect(0, 0, MAP_W * TILE, MAP_H * TILE)
      .setDepth(-300);
  }

  // Ground noise: 640×640 tiles at 50% overlap with Hann window alpha (sin²×sin²).
  // ADD blend mode on a black base gives an exact partition of unity — at every world
  // pixel the 4 overlapping tiles' Hann weights sum to 1, so there are no seams and
  // no base colour bleed.  4 unique seeded variants break up the periodic repetition.
  _drawAlgorithmicNoise() {
    const SIZE   = 640;
    const STRIDE = SIZE >> 1;  // 320 — 50% overlap gives Hann partition of unity

    const makeGrid = (G, rng) => {
      const ng = new Float32Array((G + 1) * (G + 1));
      for (let y = 0; y < G; y++)
        for (let x = 0; x < G; x++)
          ng[y * (G + 1) + x] = rng();
      for (let y = 0; y <= G; y++) ng[y * (G + 1) + G] = ng[(y % G) * (G + 1)];
      for (let x = 0; x <= G; x++) ng[G * (G + 1) + x] = ng[x % G];
      return ng;
    };

    const sample = (ng, G, nx, ny) => {
      const gx = nx * G, gy = ny * G;
      const x0 = Math.min(G - 1, gx | 0), y0 = Math.min(G - 1, gy | 0);
      const x1 = x0 + 1, y1 = y0 + 1;
      const fx = gx - x0, fy = gy - y0;
      const s  = t => t * t * (3 - 2 * t);
      const sfx = s(fx), sfy = s(fy);
      return ng[y0*(G+1)+x0]*(1-sfx)*(1-sfy)
           + ng[y0*(G+1)+x1]*sfx*(1-sfy)
           + ng[y1*(G+1)+x0]*(1-sfx)*sfy
           + ng[y1*(G+1)+x1]*sfx*sfy;
    };

    const mkTex = (seed) => {
      const cvs  = document.createElement('canvas');
      cvs.width  = cvs.height = SIZE;
      const ctx  = cvs.getContext('2d', { willReadFrequently: true });
      const imgd = ctx.getImageData(0, 0, SIZE, SIZE);
      const d    = imgd.data;
      const rng  = mkRNG(seed);
      // 4 octaves: 40px → 20px → 10px → 5px grain — no coarse blobs that look cloudy
      const octaves = [[16, 0.25], [32, 0.30], [64, 0.30], [128, 0.15]]
        .map(([G, w]) => ({ G, w, ng: makeGrid(G, rng) }));
      for (let y = 0; y < SIZE; y++) {
        // sample at pixel centre (+0.5) for exact discrete partition of unity
        const ay = Math.sin(Math.PI * (y + 0.5) / SIZE);
        for (let x = 0; x < SIZE; x++) {
          let n = 0;
          for (const { G, w, ng } of octaves) n += sample(ng, G, x / SIZE, y / SIZE) * w;
          const v  = Math.round((n - 0.5) * 50);
          const ax = Math.sin(Math.PI * (x + 0.5) / SIZE);
          const i  = (y * SIZE + x) * 4;
          d[i]   = Math.max(0, Math.min(255, 56 + v));
          d[i+1] = Math.max(0, Math.min(255, 36 + Math.round(v * 0.55)));
          d[i+2] = Math.max(0, Math.min(255, 32 + Math.round(v * 0.65)));
          d[i+3] = Math.round(ax * ax * ay * ay * 255);
        }
      }
      ctx.putImageData(imgd, 0, 0);
      return cvs;
    };

    const keys = [99887, 31415, 27182, 16180].map((seed, i) => {
      const key = `_gnd_noise_${i}`;
      this.textures.addCanvas(key, mkTex(seed));
      return key;
    });

    // collect placements, sort by texture for max WebGL batching (ADD is commutative so order is irrelevant visually)
    const rng   = mkRNG(44556);
    const tiles = [];
    for (let ty = -1; ty * STRIDE < MAP_H * TILE; ty++)
      for (let tx = -1; tx * STRIDE < MAP_W * TILE; tx++)
        tiles.push({ tx, ty, key: keys[(rng() * 4) | 0] });
    tiles.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

    for (const { tx, ty, key } of tiles)
      this.add.image(tx * STRIDE, ty * STRIDE, key)
        .setOrigin(0, 0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(-200);
  }

  // Scatter gravel.png instances across the map: grid + jitter + random rotation.
  // The texture is already 88% transparent (sparse pebbles); overlapping instances
  // give natural coverage without any additional alpha mask needed.
  _drawGravelLayer() {
    // gravel.png is 1254×1254 — scale down for fine detail, pack tightly for density
    const SCALE  = 0.28;
    const STEP   = 150;
    const JITTER = 45;
    const rng    = mkRNG(33221);
    for (let gy = 0; gy < MAP_H * TILE; gy += STEP) {
      for (let gx = 0; gx < MAP_W * TILE; gx += STEP) {
        const px = gx + (rng() - 0.5) * 2 * JITTER;
        const py = gy + (rng() - 0.5) * 2 * JITTER;
        this.add.image(px, py, 'gravel')
          .setScale(SCALE)
          .setRotation(rng() * Math.PI * 2)
          .setAlpha(0.4)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(-150);
      }
    }
  }

  // gravel2 scattered on top of gravel (-140), different seed/step for visual variety
  _drawGravel2Layer() {
    const SCALE  = 0.28;
    const STEP   = 170;
    const JITTER = 55;
    const rng    = mkRNG(78901);
    for (let gy = 0; gy < MAP_H * TILE; gy += STEP) {
      for (let gx = 0; gx < MAP_W * TILE; gx += STEP) {
        const px = gx + (rng() - 0.5) * 2 * JITTER;
        const py = gy + (rng() - 0.5) * 2 * JITTER;
        this.add.image(px, py, 'gravel2')
          .setScale(SCALE)
          .setRotation(rng() * Math.PI * 2)
          .setAlpha(0.4)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(-140);
      }
    }
  }

  // gravel3 scattered on top of gravel2 (-130), distinct seed/step
  _drawGravel3Layer() {
    const SCALE  = 0.28;
    const STEP   = 190;
    const JITTER = 60;
    const rng    = mkRNG(56789);
    for (let gy = 0; gy < MAP_H * TILE; gy += STEP) {
      for (let gx = 0; gx < MAP_W * TILE; gx += STEP) {
        const px = gx + (rng() - 0.5) * 2 * JITTER;
        const py = gy + (rng() - 0.5) * 2 * JITTER;
        this.add.image(px, py, 'gravel3')
          .setScale(SCALE)
          .setRotation(rng() * Math.PI * 2)
          .setAlpha(0.4)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(-130);
      }
    }
  }

  // gravel4 scattered on top of gravel3 (-120), tighter step for fine surface detail
  _drawGravel4Layer() {
    const SCALE  = 0.28;
    const STEP   = 130;
    const JITTER = 40;
    const rng    = mkRNG(13579);
    for (let gy = 0; gy < MAP_H * TILE; gy += STEP) {
      for (let gx = 0; gx < MAP_W * TILE; gx += STEP) {
        const px = gx + (rng() - 0.5) * 2 * JITTER;
        const py = gy + (rng() - 0.5) * 2 * JITTER;
        this.add.image(px, py, 'gravel4')
          .setScale(SCALE)
          .setRotation(rng() * Math.PI * 2)
          .setAlpha(0.35)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(-120);
      }
    }
  }

  // ── occupancy (docs/adr/0009) ───────────────────────────────────────────────

  // A Tile is clear to place something on: in bounds (with a 1-Tile border), flat walkable
  // ground (no hill, ramp, or cliff-shadow), and not already occupied by anything.
  _groundClear(tx, ty) {
    if (tx < 1 || tx >= MAP_W - 1 || ty < 1 || ty >= MAP_H - 1) return false;
    if (this._isHill(tx, ty) || this._isRamp(tx, ty) || this._isHill(tx, ty - 1)) return false;
    return !this._occupied.has(`${tx},${ty}`);
  }

  // True if every Tile of a w×h Footprint anchored at (tx,ty) is clear.
  _footprintFree(tx, ty, w, h) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        if (!this._groundClear(tx + dx, ty + dy)) return false;
    return true;
  }

  // Mark a w×h Footprint occupied by `kind` (blocking or not) so spawning avoids it and, when
  // blocking, walkable() routes Units around it.
  _occupy(tx, ty, w, h, kind, blocking) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        this._occupied.set(`${tx + dx},${ty + dy}`, { kind, blocking });
  }

  // Reserve a non-blocking clearance rectangle (Footprint + margin) so nothing spawns there but
  // Units can still stand in it. Won't overwrite an existing (e.g. blocking) occupant.
  _reserveClearance(tx, ty, w, h, margin) {
    for (let y = ty - margin; y < ty + h + margin; y++)
      for (let x = tx - margin; x < tx + w + margin; x++) {
        const key = `${x},${y}`;
        if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && !this._occupied.has(key))
          this._occupied.set(key, { kind: 'clearance', blocking: false });
      }
  }

  // ── crystals ──────────────────────────────────────────────────────────────

  // Crystal Deposits spawn in contiguous blobs of 3–6: a seed Tile plus random adjacent free
  // Tiles, so each cluster reads as one tight patch (docs/adr/0009).
  _placeCrystals() {
    const r = mkRNG(1337);

    // A guaranteed starter cluster: the clear Tile nearest map centre (just outside the
    // command-center clearance), so Workers always have crystals to gather near the base.
    const starter = this._nearestClearTile((MAP_W / 2) | 0, (MAP_H / 2) | 0);
    if (starter) this._growCrystalCluster(starter, 4 + ((r() * 3) | 0), r); // 4–6

    const CLUSTERS = 22;
    for (let i = 0; i < CLUSTERS; i++) {
      let seed = null;
      for (let tries = 0; tries < 30 && !seed; tries++) {
        const tx = (r() * (MAP_W - 10) + 5) | 0;
        const ty = (r() * (MAP_H - 10) + 5) | 0;
        if (this._groundClear(tx, ty)) seed = { x: tx, y: ty };
      }
      if (seed) this._growCrystalCluster(seed, 3 + ((r() * 4) | 0), r);
    }
  }

  // Spiral outward from (cx,cy) for the closest clear Tile — used to anchor the starter crystal
  // cluster just beyond the reserved clearance around the command center.
  _nearestClearTile(cx, cy) {
    for (let radius = 0; radius <= 25; radius++)
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue; // ring only
          if (this._groundClear(cx + dx, cy + dy)) return { x: cx + dx, y: cy + dy };
        }
    return null;
  }

  _growCrystalCluster(seed, target, r) {
    const placed = [];
    const place = (tx, ty) => {
      const img = this.add.image(tx * TILE + TILE * 0.5, ty * TILE + TILE * 0.5,
        r() < 0.5 ? 'crystals1' : 'crystals2');
      img.setOrigin(0.5, 0.5);
      img.setScale(TILE * (0.8 + r() * 0.5) / 1024);
      img.setDepth(ty * TILE + TILE); // sort as if grounded at the Tile's bottom edge
      this._addDeposit('crystals', tx, ty, img); // registers Deposit + occupancy
      placed.push({ x: tx, y: ty });
    };
    place(seed.x, seed.y);
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (placed.length < target) {
      const frontier = [];
      for (const p of placed)
        for (const [dx, dy] of DIRS) {
          const nx = p.x + dx, ny = p.y + dy;
          if (this._groundClear(nx, ny) && !frontier.some((f) => f.x === nx && f.y === ny))
            frontier.push({ x: nx, y: ny });
        }
      if (!frontier.length) break; // hemmed in — settle for a smaller cluster
      const pick = frontier[(r() * frontier.length) | 0];
      place(pick.x, pick.y);
    }
  }

  // ── decorations (docs/adr/0009) ─────────────────────────────────────────────

  // Scatter every Decoration type from the data table; each registers its Footprint in the
  // occupancy layer so nothing overlaps and blocking types make their Tiles unwalkable.
  _placeDecorations() {
    const r = mkRNG(999);
    for (const def of Object.values(DECORATIONS)) this._scatterDecoration(def, r);
  }

  _scatterDecoration(def, r) {
    if (def.clustered) {
      const clusters = Math.ceil(def.count / 5);
      for (let c = 0; c < clusters; c++) {
        const cx = (r() * (MAP_W - 6) + 3) | 0;
        const cy = (r() * (MAP_H - 6) + 3) | 0;
        const n = 3 + ((r() * 4) | 0);
        for (let k = 0; k < n; k++)
          this._tryPlaceDecoration(def, cx + ((r() * 7 - 3) | 0), cy + ((r() * 7 - 3) | 0), r);
      }
    } else {
      for (let i = 0; i < def.count; i++)
        this._tryPlaceDecoration(def, (r() * (MAP_W - 2) + 1) | 0, (r() * (MAP_H - 2) + 1) | 0, r);
    }
  }

  // Best-effort: place one Decoration of `def` at (tx,ty) if its Footprint is free, else skip.
  _tryPlaceDecoration(def, tx, ty, r) {
    if (!this._footprintFree(tx, ty, def.w, def.h)) return;
    const key = def.sprites[(r() * def.sprites.length) | 0];
    const px = (tx + def.w * 0.5) * TILE;
    const py = (ty + def.h) * TILE; // base at the Footprint's bottom edge
    const img = this.add.image(px, py, key);
    img.setOrigin(0.5, def.originY);
    const [lo, hi] = def.scale;
    img.setScale(def.w * TILE * (lo + r() * (hi - lo)) / Math.max(img.width, img.height));
    img.setDepth(py);
    this._occupy(tx, ty, def.w, def.h, `deco:${def.id}`, def.blocking);
  }

  // ── deposits & gathering (docs/adr/0008) ────────────────────────────────────

  _addDeposit(type, tx, ty, sprite) {
    const def = getResource(type);
    const deposit = { type, tx, ty, amount: def ? def.depositAmount : 0, sprite };
    this._deposits.push(deposit);
    this._depositByTile.set(`${tx},${ty}`, deposit);
    this._occupy(tx, ty, 1, 1, 'deposit', true); // Deposits block their Tile (docs/adr/0009)
    return deposit;
  }

  // The Tile a Unit currently stands on (feet at the Tile's bottom-centre — matches movement.js).
  _unitTile(unit) {
    return { x: Math.floor(unit.x / TILE), y: Math.floor((unit.y - TILE * 0.5) / TILE) };
  }

  // World primitive: the nearest Deposit on a Tile 8-adjacent to the Unit, or null. Returns an
  // opaque handle plus its gather time so the interpreter can time the gather (docs/adr/0008).
  _adjacentDeposit(unit) {
    const { x: ux, y: uy } = this._unitTile(unit);
    let best = null, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const dep = this._depositByTile.get(`${ux + dx},${uy + dy}`);
        if (!dep) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { best = dep; bestD = d; }
      }
    }
    if (!best) return null;
    // Full for this Resource ⇒ nothing to gather: the Worker no-ops rather than standing idle.
    if (this._cargoRoom(unit, best.type) <= 0) return null;
    const def = getResource(best.type);
    return { handle: best, gatherTime: def ? def.gatherTime : 0 };
  }

  // How much more of `type` this Unit can carry, given its Cargo (single slot) and capacity.
  _cargoRoom(unit, type) {
    const held = unit.cargo && unit.cargo.type === type ? unit.cargo.amount : 0;
    return (unit.carryCapacity ?? UNIT_CARRY_CAPACITY) - held;
  }

  // World primitive: take one yield from the Deposit into the Unit's Cargo, deplete it, and
  // remove the Deposit (freeing its Tile) once empty.
  _collect(unit, deposit) {
    const def = getResource(deposit.type);
    if (!def || deposit.amount <= 0) return;
    const got = Math.min(def.yield, deposit.amount, this._cargoRoom(unit, deposit.type));
    if (got <= 0) return; // Cargo full
    deposit.amount -= got;
    if (unit.cargo && unit.cargo.type === deposit.type) unit.cargo.amount += got;
    else unit.cargo = { type: deposit.type, amount: got };
    if (deposit.amount <= 0) this._removeDeposit(deposit);
    this._refreshUnitLabel(unit);
  }

  _removeDeposit(deposit) {
    deposit.sprite.destroy();
    this._depositByTile.delete(`${deposit.tx},${deposit.ty}`);
    this._occupied.delete(`${deposit.tx},${deposit.ty}`); // free the Tile (docs/adr/0009)
    this._deposits = this._deposits.filter((d) => d !== deposit);
  }

  // World primitive: if the Worker is beside the Command Center and carrying Cargo, move it all
  // into the player's Stockpile and empty the Cargo (docs/adr/0008). No-op otherwise.
  _deliver(unit) {
    if (!unit.cargo || !this._adjacentToCommandCenter(unit)) return;
    const { type, amount } = unit.cargo;
    this._stockpile[type] = (this._stockpile[type] || 0) + amount;
    unit.cargo = null;
    this._refreshUnitLabel(unit);
    this._updateMaterialsPanel();
  }

  // True if the Unit is within DELIVER_RANGE Tiles of the Command Center's Footprint (Chebyshev
  // distance to the footprint rectangle). Forgiving, because the blocking footprint + steering
  // leave a Unit settled a Tile or two short of actually touching the building.
  _adjacentToCommandCenter(unit) {
    const cc = this._commandCenter;
    if (!cc) return false;
    const { x: ux, y: uy } = this._unitTile(unit);
    const dx = Math.max(cc.tx - ux, ux - (cc.tx + cc.tileW - 1), 0);
    const dy = Math.max(cc.ty - uy, uy - (cc.ty + cc.tileH - 1), 0);
    return Math.max(dx, dy) <= DELIVER_RANGE;
  }

  // ── buildings ─────────────────────────────────────────────────────────────

  _spawnBuildings() {
    const cx = (MAP_W / 2) | 0;
    const cy = (MAP_H / 2) | 0;

    const place = (BuildingClass, tx, ty, w, h) => {
      const b = new BuildingClass(this, tx, ty);
      this._reserveClearance(tx, ty, w, h, START_CLEARANCE);
      this._occupy(tx, ty, w, h, 'building', true);
      return b;
    };

    // command center at map center
    const tx = cx - 1, ty = cy - 1;
    this._commandCenter = place(CommandCenter, tx, ty, 3, 3);

    // barracks 6 tiles to the right
    this._barracks = place(Barracks, tx + 6, ty, 3, 3);

    // factory 6 tiles to the left
    this._factory = place(Factory, tx - 6, ty, 3, 3);
  }

  // ── units ─────────────────────────────────────────────────────────────────

  _spawnUnits() {
    this.units = [];
    this._assignments = this._loadAssignments(); // { [unit.label]: flowId }
    const cx = MAP_W / 2 | 0;
    const cy = MAP_H / 2 | 0;
    // three targets spaced 5 tiles apart — spiral outward from each until flat ground found
    [cx - 5, cx, cx + 5].forEach((targetX, i) => {
      for (let r = 0; r <= 8; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const tx = targetX + dx, ty = cy + dy;
            if (this.walkable(tx, ty) && !this._isHill(tx, ty - 1)) {
              const worker = new Worker(this, tx * TILE + TILE * 0.5, ty * TILE + TILE);
              this._registerUnit(worker, `Worker ${i + 1}`);
              return;
            }
          }
        }
      }
    });
  }

  // Make a Unit selectable and give it a Flow-name label above its sprite.
  _registerUnit(unit, label) {
    unit.label = label;
    unit.carryCapacity = UNIT_CARRY_CAPACITY; // per-Unit Cargo limit (upgradeable later)
    // Restore a persisted assignment, but only if that Flow still exists in the Library.
    const savedId = this._assignments[label];
    unit.assignedFlowId = savedId && flowLibrary.get(savedId) ? savedId : null;
    unit.sprite.setInteractive({ useHandCursor: true });
    unit.sprite.setData('unit', unit);

    unit.labelText = this.add.text(unit.x, unit.y - TILE - 6, '', {
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
      color: '#ffffff',
      backgroundColor: 'rgba(0,0,0,0.55)',
      padding: { x: 5, y: 2 },
    }).setOrigin(0.5, 1).setDepth(1e6);

    this.units.push(unit);
    this._refreshUnitLabel(unit);
    this._startRun(unit);
  }

  // Label above a Unit: its Flow name plus a Cargo readout (e.g. "Worker 1  ·  ◆20") so
  // gathering is observable until there's a real animation/HUD (docs/adr/0008).
  _refreshUnitLabel(unit) {
    const entry = unit.assignedFlowId ? flowLibrary.get(unit.assignedFlowId) : null;
    const parts = [];
    if (entry) parts.push(entry.name);
    if (unit.cargo) {
      const def = getResource(unit.cargo.type);
      parts.push(`${def ? def.glyph : ''}${unit.cargo.amount}`);
    }
    unit.labelText.setText(parts.join('  ·  '));
  }

  // (Re)start a Unit's Run from its assigned Flow's OnStart. Called when a Unit is registered
  // and when its Assignment changes — a fresh Assignment runs from the top. A Run only exists
  // while the simulation is running (docs/adr/0005): paused, or with no Flow assigned, idle.
  _startRun(unit) {
    const entry = this._running && unit.assignedFlowId ? flowLibrary.get(unit.assignedFlowId) : null;
    unit.run = entry ? startRun(entry.id, entry.model) : null;
  }

  // START/PAUSE (docs/adr/0005). PAUSE only flips the flag — update() then freezes, so every
  // Run keeps its cursor and every Unit keeps its position. START resumes those frozen Runs
  // exactly where they were and starts any assigned Unit that has no Run yet (firing OnStart),
  // so the very first START launches the Flows and later ones continue rather than restart.
  _setRunning(running) {
    this._running = running;
    if (running) for (const unit of this.units) if (!unit.run) this._startRun(unit);
    this._updateStartBtn();
  }

  _buildStartButton() {
    const btn = document.createElement('button');
    btn.className = 'sim-toggle';
    btn.addEventListener('click', () => this._setRunning(!this._running));
    document.body.appendChild(btn);
    this._startBtn = btn;
    this._updateStartBtn();
  }

  _updateStartBtn() {
    if (!this._startBtn) return;
    this._startBtn.textContent = this._running ? '❚❚ Pause' : '▶ Start';
    this._startBtn.classList.toggle('running', this._running);
  }

  // Top-left panel showing the player's Stockpile — one entry per known Resource.
  _buildMaterialsPanel() {
    const panel = document.createElement('div');
    panel.className = 'materials-panel';
    document.body.appendChild(panel);
    this._materialsPanel = panel;
    this._updateMaterialsPanel();
  }

  _updateMaterialsPanel() {
    if (!this._materialsPanel) return;
    this._materialsPanel.textContent = Object.values(RESOURCES)
      .map((def) => `${def.glyph} ${this._stockpile[def.id] || 0}`)
      .join('     ');
  }

  // Sync a Unit's sprite + label to its logical {x,y} (feet position), keeping depth = y so
  // it sorts correctly against trees/crystals/other Units.
  _placeUnit(unit) {
    unit.sprite.setPosition(unit.x, unit.y);
    unit.sprite.setDepth(unit.y);
    unit.labelText.setPosition(unit.x, unit.y - TILE - 6);
  }

  // ── assignment persistence ─────────────────────────────────────────────────

  _loadAssignments() {
    try { return JSON.parse(localStorage.getItem(ASSIGN_KEY)) || {}; }
    catch { return {}; }
  }

  _saveAssignments() {
    const map = {};
    for (const u of this.units) if (u.assignedFlowId) map[u.label] = u.assignedFlowId;
    try { localStorage.setItem(ASSIGN_KEY, JSON.stringify(map)); } catch { /* quota/full */ }
  }

  // ── camera ────────────────────────────────────────────────────────────────

  _setupCamera() {
    const cam = this.cameras.main;
    cam.setBounds(0, 0, MAP_W * TILE, MAP_H * TILE);
    cam.setScroll(
      (MAP_W * TILE - cam.width)  * 0.5,
      (MAP_H * TILE - cam.height) * 0.5
    );

    let drag = null;
    // Tracked separately from `drag` so it survives pointerup (which clears `drag`) and is
    // still readable when gameobjectup fires — order between the two isn't guaranteed.
    this._dragMoved = false;

    this.input.on('pointerdown', (p, over) => {
      this._dragMoved = false;
      if (this._pick) {
        if (p.rightButtonDown()) { this._cancelPick(); return; } // right-click cancels
        // In pick mode a click picks and a drag pans — start tracking either way.
        drag = { ox: p.x, oy: p.y, sx: cam.scrollX, sy: cam.scrollY };
        return;
      }
      // Clicking a Unit selects it (handled by gameobjectup) — don't start a camera drag.
      if (over.length) return;
      drag = { ox: p.x, oy: p.y, sx: cam.scrollX, sy: cam.scrollY };
      this.game.canvas.style.cursor = 'grabbing';
    });
    this.input.on('pointermove', p => {
      if (this._pick) {
        const { tx, ty } = this._pointerTile(p);
        this._updatePickHighlight(tx, ty);
      }
      if (!drag) return;
      if (Math.abs(p.x - drag.ox) + Math.abs(p.y - drag.oy) > 3) this._dragMoved = true;
      cam.setScroll(drag.sx - (p.x - drag.ox), drag.sy - (p.y - drag.oy));
    });
    const endDrag = () => {
      // A click (no drag) in pick mode commits the hovered Tile.
      if (this._pick && !this._dragMoved) this._commitPick();
      drag = null;
      this.game.canvas.style.cursor = this._pick ? 'crosshair' : 'grab';
    };
    this.input.on('pointerup', endDrag);
    this.input.on('pointerupoutside', endDrag);

    // Click a Unit → open the assign-flow overlay (ignore while picking or after a drag).
    this.input.on('gameobjectup', (_p, obj) => {
      if (this._pick || this._dragMoved) return;
      const unit = obj.getData && obj.getData('unit');
      if (unit) openAssignOverlay(unit, flowLibrary, (u) => {
        this._refreshUnitLabel(u);
        this._saveAssignments();
        this._startRun(u); // always-live: new Assignment runs at once; re-assign restarts
      });
    });

    this.input.on('wheel', (_p, _objs, _dx, deltaY) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - deltaY * 0.001, 0.25, 8));
    });

    this.game.canvas.style.cursor = 'grab';
  }

  // ── position picking ────────────────────────────────────────────────────────

  _pointerTile(p) {
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    return { tx: Math.floor(wp.x / TILE), ty: Math.floor(wp.y / TILE) };
  }

  // Enter pick mode: highlight the hovered Tile (green if Walkable, red if not). A click
  // on a Walkable Tile commits; right-click/Esc cancels (wired via the camera handlers).
  _beginPositionPick({ onPicked, onCancel }) {
    if (this._pick) this._endPick();
    const gfx = this.add.graphics().setDepth(2e6);
    // window-level so Esc works even though the pick starts from a DOM button (the Phaser
    // canvas may not have keyboard focus yet).
    const escHandler = (e) => { if (e.key === 'Escape') this._cancelPick(); };
    window.addEventListener('keydown', escHandler);
    this._pick = {
      onPicked, onCancel, gfx, tile: null,
      escOff: () => window.removeEventListener('keydown', escHandler),
    };
    const { tx, ty } = this._pointerTile(this.input.activePointer);
    this._updatePickHighlight(tx, ty);
    this.game.canvas.style.cursor = 'crosshair';
  }

  _updatePickHighlight(tx, ty) {
    if (!this._pick) return;
    const ok = this.walkable(tx, ty);
    const g = this._pick.gfx;
    g.clear();
    g.fillStyle(ok ? 0x33dd55 : 0xdd3333, 0.35);
    g.lineStyle(2, ok ? 0x66ff88 : 0xff6666, 0.9);
    g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    g.strokeRect(tx * TILE, ty * TILE, TILE, TILE);
    this._pick.tile = { x: tx, y: ty, ok };
  }

  _commitPick() {
    const t = this._pick && this._pick.tile;
    if (!t || !t.ok) return; // ignore non-Walkable / off-map clicks; stay in pick mode
    const onPicked = this._pick.onPicked;
    this._endPick();
    onPicked && onPicked({ x: t.x, y: t.y });
  }

  _cancelPick() {
    const onCancel = this._pick && this._pick.onCancel;
    this._endPick();
    onCancel && onCancel();
  }

  _endPick() {
    if (!this._pick) return;
    this._pick.gfx.destroy();
    this._pick.escOff();
    this._pick = null;
    this.game.canvas.style.cursor = 'grab';
  }
}
