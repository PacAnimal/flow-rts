import Phaser from 'phaser';
import { Worker } from '../entities/Worker.js';
import { TILE, EXTRUDE } from '../constants.js';
import { flowLibrary } from '../flow/library.js';
import { openAssignOverlay } from '../flow/assign.js';
const MAP_W = 120;
const MAP_H = 90;

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
    this.load.image('worker', '/sprites/worker.png');
    this.load.image('grass',  '/sprites/grass.png');
  }

  create() {
    this._makeTileset();
    const { tiles, isHill, isRamp } = this._generateTerrain();
    this._isHill = isHill;
    this._buildTilemap(tiles);
    this._placeTrees(isHill, isRamp);
    this._spawnUnits();
    this._setupCamera();
  }

  // ── tileset ──────────────────────────────────────────────────────────────

  _makeTileset() {
    const canvas = document.createElement('canvas');
    canvas.width  = TILE * TOTAL_TILES;
    canvas.height = TILE;
    const ctx = canvas.getContext('2d');

    const grassImg = this.textures.get('grass').getSourceImage();
    [T_GRASS_A, T_GRASS_B, T_GRASS_C].forEach(t => {
      ctx.drawImage(grassImg, 0, 0, grassImg.width, grassImg.height, t * TILE, 0, TILE, TILE);
    });

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
    map.createLayer(0, ts, 0, 0);
  }

  // ── trees ─────────────────────────────────────────────────────────────────

  _placeTrees(isHill, isRamp) {
    this._makeTreeTextures();
    const r = mkRNG(999);
    const names = ['tree_a', 'tree_b', 'tree_c'];

    for (let i = 0; i < 80; i++) {
      const cx    = (r() * (MAP_W - 6) + 3) | 0;
      const cy    = (r() * (MAP_H - 6) + 3) | 0;
      const count = (r() * 4 + 2) | 0;

      for (let j = 0; j < count; j++) {
        const tx = cx + ((r() * 7 - 3) | 0);
        const ty = cy + ((r() * 7 - 3) | 0);
        if (tx < 1 || tx >= MAP_W - 1 || ty < 1 || ty >= MAP_H - 1) continue;
        if (isRamp(tx, ty)) continue;

        const onSouthCliff = isHill(tx, ty) && !isHill(tx, ty + 1);
        const onShadow     = !isHill(tx, ty) && isHill(tx, ty - 1);
        if (onSouthCliff || onShadow) continue;
        if (isHill(tx, ty) && r() > 0.3) continue;

        const wx  = tx * TILE + TILE * 0.5 + ((r() * 22 - 11) | 0);
        const wy  = ty * TILE + TILE * 0.42 + ((r() * 14 - 7) | 0);
        const img = this.add.image(wx, wy, names[r() * names.length | 0]);
        img.setOrigin(0.5, 0.88);
        img.setScale(0.8 + r() * 0.35);
        img.setDepth(wy);
      }
    }
  }

  _makeTreeTextures() {
    [
      { name: 'tree_a', w: 54, h: 72, crown: '#286018', mid: '#327824', hi: '#469634' },
      { name: 'tree_b', w: 46, h: 62, crown: '#235816', mid: '#2c6e20', hi: '#3e8630' },
      { name: 'tree_c', w: 50, h: 68, crown: '#2b6620', mid: '#367a2c', hi: '#4a9040' },
    ].forEach(({ name, w, h, crown, mid, hi }) => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const c = canvas.getContext('2d');
      const cx = w / 2, trunkBase = h * 0.75, r = w * 0.36;
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.beginPath(); c.ellipse(cx, h - 5, r * 0.72, r * 0.2, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#5a3c1c';
      c.fillRect(cx - 4, trunkBase - h * 0.22, 8, h * 0.22 + 5);
      c.fillStyle = crown;
      c.beginPath(); c.arc(cx - r * 0.5, trunkBase - r * 0.65, r * 0.58, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(cx + r * 0.5, trunkBase - r * 0.70, r * 0.55, 0, Math.PI * 2); c.fill();
      c.fillStyle = mid;
      c.beginPath(); c.arc(cx, trunkBase - r * 0.9, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = hi;
      c.beginPath(); c.arc(cx - r * 0.2, trunkBase - r * 1.15, r * 0.38, 0, Math.PI * 2); c.fill();
      this.textures.addCanvas(name, canvas);
    });
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
            if (!this._isHill(tx, ty) && !this._isHill(tx, ty - 1)) {
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
  }

  _refreshUnitLabel(unit) {
    const entry = unit.assignedFlowId ? flowLibrary.get(unit.assignedFlowId) : null;
    unit.labelText.setText(entry ? entry.name : '');
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
      // Clicking a Unit selects it (handled by gameobjectup) — don't start a camera drag.
      if (over.length) return;
      drag = { ox: p.x, oy: p.y, sx: cam.scrollX, sy: cam.scrollY };
      this.game.canvas.style.cursor = 'grabbing';
    });
    this.input.on('pointermove', p => {
      if (!drag) return;
      if (Math.abs(p.x - drag.ox) + Math.abs(p.y - drag.oy) > 3) this._dragMoved = true;
      cam.setScroll(drag.sx - (p.x - drag.ox), drag.sy - (p.y - drag.oy));
    });
    const endDrag = () => {
      drag = null;
      this.game.canvas.style.cursor = 'grab';
    };
    this.input.on('pointerup', endDrag);
    this.input.on('pointerupoutside', endDrag);

    // Click a Unit → open the assign-flow overlay (ignore if it was a camera drag).
    this.input.on('gameobjectup', (_p, obj) => {
      if (this._dragMoved) return;
      const unit = obj.getData && obj.getData('unit');
      if (unit) openAssignOverlay(unit, flowLibrary, (u) => {
        this._refreshUnitLabel(u);
        this._saveAssignments();
      });
    });

    this.input.on('wheel', (_p, _objs, _dx, deltaY) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom - deltaY * 0.001, 0.25, 2));
    });

    this.game.canvas.style.cursor = 'grab';
  }
}
