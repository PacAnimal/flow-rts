import Phaser from 'phaser';
import { Worker } from '../entities/Worker.js';
import { Marine } from '../entities/Marine.js';
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
    const UNIT_TYPES = ['worker', 'marine'];
    const UNIT_DIRS  = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'dead'];
    for (const type of UNIT_TYPES)
      for (const d of UNIT_DIRS) this.load.image(`${type}_${d}`, `/sprites/${type}_${d}.png`);
    for (const key of DECORATIONS.tree.sprites) this.load.image(key, `/sprites/${key}.png`);
    for (const key of DECORATIONS.obstacle.sprites) this.load.image(key, `/sprites/decor2/${key}.png`);
    for (const key of DECORATIONS.groundDecor.sprites) this.load.image(key, `/sprites/decor2/${key}.png`);
    for (const key of RESOURCES.crystals.sprites) this.load.image(key, `/sprites/${key}.png`);
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
    this._drawProceduralGround();
    const groundOnly = new URLSearchParams(window.location.search).has('groundOnly');
    if (!groundOnly) this._buildTilemap(tiles);
    if (!groundOnly) this._spawnBuildings();   // reserve command-center footprint + start clearance first
    if (!groundOnly) this._placeCrystals();    // clustered crystal Deposits (docs/adr/0009)
    if (!groundOnly) this._placeDecorations(); // trees — scattered, no overlap (docs/adr/0009)
    if (!groundOnly) this._spawnUnits();
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

    // grass tiles (0-2) are transparent — procedural ground shows through

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

  // ── procedural ground ────────────────────────────────────────────────────────

  // GPU fragment shader covering the full map in world space.
  // Camera scroll/zoom are applied automatically by Phaser's projection matrix.
  //
  // Techniques:
  //   Hash:    Dave Hoskins float hash (no sin)
  //   Warp:    IQ double domain warping for organic shapes
  //   Voronoi: IQ two-pass perpendicular bisector (uniform crevice width)
  //   Normal:  finite differences (3 height samples)
  //   Layers:  large brown rocks → grey sand fill → grey pebbles (3 scales)
  _drawProceduralGround() {
    const fragSrc = `
precision highp float;
varying vec2 fragCoord;
uniform vec2 resolution;

float h12(vec2 p){
  vec3 q=fract(vec3(p.xyx)*0.1031);q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
vec2 h22(vec2 p){
  vec3 q=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));q+=dot(q,q.yzx+33.33);
  return fract((q.xx+q.yz)*q.zy);
}
float vn(vec2 p){
  vec2 i=floor(p);vec2 f=fract(p);
  vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(h12(i),h12(i+vec2(1,0)),u.x),
             mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<4;i++){v+=a*vn(p);p*=2.0;a*=0.5;}
  return v/0.9375;
}
// 3-octave cheap fbm for large-scale fields (biomes, macro, lava zones)
float fbmL(vec2 p){
  float v=0.0,a=0.5;
  for(int i=0;i<3;i++){v+=a*vn(p);p*=2.0;a*=0.5;}
  return v/0.875;
}
float voronoiEdge(vec2 x,out float cellId){
  vec2 p=floor(x);vec2 f=fract(x);
  vec2 mr=vec2(0);vec2 mb=vec2(0);float minD=9.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 b=vec2(float(i),float(j));
    vec2 r=b+h22(p+b)-f;
    float d=dot(r,r);
    if(d<minD){minD=d;mr=r;mb=b;}
  }
  cellId=h12(p+mb);
  float edgeD=9.0;
  for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){
    vec2 b=mb+vec2(float(i),float(j));
    vec2 r=b+h22(p+b)-f;
    vec2 dv=r-mr;
    if(dot(dv,dv)>0.0001)
      edgeD=min(edgeD,dot(0.5*(mr+r),normalize(dv)));
  }
  return edgeD;
}

void main(void){
  vec2 world=vec2(fragCoord.x, resolution.y-fragCoord.y);
  vec2 p=world/6.0;

  // macro elevation — large regional brightness variation
  float macro=fbmL(p*0.10+vec2(4.5,1.2));

  // terrain biomes: rocky (default), dusty flat sheets, charred gashes
  float dustN=fbmL(p*0.038+vec2(2.2,5.8));
  float charN=fbmL(p*0.072+vec2(8.4,3.1));
  float wDusty=smoothstep(0.38,0.62,dustN);
  float wCharred=smoothstep(0.65,0.82,charN)*(1.0-wDusty);
  float wRocky=max(0.0,1.0-wDusty-wCharred);

  // lava hot zones: large rare spatial clusters, only in rocky biome
  float lavaTend=fbmL(p*0.025+vec2(7.1,3.4));
  float lavaZone=smoothstep(0.72,0.86,lavaTend)*wRocky;

  // domain warp for organic crack shapes
  vec2 q=vec2(fbm(p),fbm(p+vec2(5.2,1.3)));
  vec2 wp=p+0.50*q;
  vec2 rv=vec2(fbm(wp*1.9+vec2(1.7,9.2)),fbm(wp*1.9+vec2(8.3,2.8)));
  wp+=0.22*rv;

  // primary cracks — width varies by biome and macro
  float c1;
  float e1=voronoiEdge(wp*0.38,c1);
  float crackW=mix(0.05+0.14*(1.0-macro),0.050,wDusty);
  crackW=mix(crackW,0.038,wCharred);
  float crackMask=1.0-smoothstep(0.0,crackW,e1);
  float ao=0.60+0.40*smoothstep(0.0,crackW*2.5,e1);

  // secondary cracks — dense in charred terrain, sparse in dust
  float c2;
  float e2=voronoiEdge(wp*1.3+vec2(5.3,2.7),c2);
  float fineCrack=1.0-smoothstep(0.0,0.055,e2);
  float fineCrackStr=0.35*wRocky+0.18*wDusty+0.68*wCharred;

  // bump normals: tall lumpy rock, flat dust sheets, medium char
  float bumpAmp=(6.0+10.0*macro)*wRocky+1.5*wDusty+3.5*wCharred;
  float g0=fbm(wp*2.0+vec2(1.1,0.7));
  float ep=0.34;
  float gnx=fbm(wp*2.0+vec2(1.1+ep,0.7))-g0;
  float gny=fbm(wp*2.0+vec2(1.1,0.7+ep))-g0;
  vec3 N=normalize(vec3(gnx*bumpAmp,gny*bumpAmp,1.0));

  float grain=fbm(wp*6.0+vec2(3.3,7.1));
  float finegrain=fbm(wp*13.0+vec2(6.6,2.4));
  float noise=grain*0.60+finegrain*0.40;

  vec3 L1=normalize(vec3(0.70,0.0,0.71));
  vec3 L2=normalize(vec3(0.0,0.70,0.71));
  float diff=max(max(0.0,dot(N,L1)),max(0.0,dot(N,L2)));

  float rv2=h12(floor(wp*0.38)+vec2(3.1,7.9));
  float cv=c1*0.010;

  // biome surface colors
  vec3 rockBase=vec3(0.330+cv*0.4,0.278+cv*0.32,0.228+cv*0.26)*(0.88+0.24*rv2);
  vec3 rockCrev=vec3(0.110+cv*0.18,0.078+cv*0.13,0.055+cv*0.10);
  vec3 dustBase=vec3(0.380+cv*0.25,0.365+cv*0.22,0.342+cv*0.18)*(0.90+0.18*rv2);
  vec3 dustCrev=vec3(0.130,0.122,0.108);
  vec3 charBase=vec3(0.188+cv*0.18,0.168+cv*0.15,0.155+cv*0.12)*(0.85+0.28*rv2);
  vec3 charCrev=vec3(0.078,0.060,0.050);

  vec3 rockCol=wRocky*rockBase+wDusty*dustBase+wCharred*charBase;
  // crevice color gets grain modulation for textured crack appearance
  vec3 crevCol=(wRocky*rockCrev+wDusty*dustCrev+wCharred*charCrev)*(0.60+0.80*grain);
  float surfNoiseStr=0.42*wRocky+0.20*wDusty+0.50*wCharred;

  vec3 col=mix(rockCol,crevCol,crackMask);
  col*=ao;
  col*=(1.0-fineCrack*fineCrackStr);
  col*=(1.0-surfNoiseStr+2.0*surfNoiseStr*noise);
  col*=(0.46+0.54*diff);
  col*=(0.55+0.68*macro);

  // lava: additive emissive inside crack channels, tiny heat aura just outside
  // lavaActive clusters within hot zones (not uniform per-cell probability)
  float lavaSeed=h12(floor(wp*0.38)+vec2(9.3,2.8));
  float lavaActive=step(0.70,lavaSeed)*lavaZone;
  float lavaHeat=crackMask*crackMask;
  float lavaAura=max(0.0,1.0-e1/0.18)*(1.0-crackMask)*0.15;
  col+=vec3(1.20,0.62,0.02)*lavaHeat*lavaActive;
  col+=vec3(0.70,0.08,0.00)*lavaAura*lavaActive;

  col=max(col,vec3(0.032,0.022,0.016));
  gl_FragColor=vec4(col,1.0);
}
`;

    const base = new Phaser.Display.BaseShader('_gnd_shader', fragSrc, undefined, {});
    this.cache.shader.add('_gnd_shader', base);

    // world-space object: camera scroll/zoom move it naturally like any other sprite
    this._groundShader = this.add.shader('_gnd_shader', 0, 0, MAP_W * TILE, MAP_H * TILE)
      .setOrigin(0, 0)
      .setDepth(-200);
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
        RESOURCES.crystals.sprites[(r() * RESOURCES.crystals.sprites.length) | 0]);
      img.setOrigin(0.5, 0.5);
      img.setScale(TILE * (1.5 + r() * 1.0) / Math.max(img.width, img.height));
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
    const tx = cx - 3, ty = cy - 3;
    this._commandCenter = place(CommandCenter, tx, ty, 6, 6);

    // barracks 2 tiles to the right of command center
    this._barracks = place(Barracks, tx + 8, ty, 6, 6);

    // factory 2 tiles to the left of command center
    this._factory = place(Factory, tx - 8, ty, 6, 6);
  }

  // ── units ─────────────────────────────────────────────────────────────────

  _spawnUnits() {
    this.units = [];
    this._assignments = this._loadAssignments(); // { [unit.label]: flowId }
    const cc  = this._commandCenter;
    const bar = this._barracks;
    // workers below the command center facing it; marines to the right of the barracks facing it
    const unitSpawns = [
      { tx: cc.tx - 1,                    ty: cc.ty + cc.tileH + 3,   label: 'Worker 1', Cls: Worker, dir: 'S'  },
      { tx: cc.tx + (cc.tileW / 2 | 0),   ty: cc.ty + cc.tileH + 3,   label: 'Worker 2', Cls: Worker, dir: 'SE' },
      { tx: cc.tx + cc.tileW + 1,         ty: cc.ty + cc.tileH + 3,   label: 'Worker 3', Cls: Worker, dir: 'NW' },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty,                  label: 'Marine 1', Cls: Marine, dir: 'W'  },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty + (bar.tileH / 2 | 0), label: 'Marine 2', Cls: Marine, dir: 'SW' },
      { tx: bar.tx + bar.tileW + 2,       ty: bar.ty + bar.tileH,      label: 'Marine 3', Cls: Marine, dir: 'NW' },
    ];
    for (const { tx: targetX, ty: targetY, label, Cls, dir } of unitSpawns) {
      for (let r = 0; r <= 10; r++) {
        let placed = false;
        for (let dy = -r; dy <= r && !placed; dy++) {
          for (let dx = -r; dx <= r && !placed; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const tx = targetX + dx, ty = targetY + dy;
            if (this.walkable(tx, ty) && !this._isHill(tx, ty - 1)) {
              const unit = new Cls(this, tx * TILE + TILE * 0.5, ty * TILE + TILE);
              this._registerUnit(unit, label);
              unit.setDirection(dir);
              placed = true;
            }
          }
        }
        if (placed) break;
      }
    }
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
    if (unit._vel) unit.updateDirection(unit._vel.x, unit._vel.y);
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
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - deltaY * 0.001, 0.25, 2));
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
