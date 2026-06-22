import Phaser from 'phaser';

const TILE = 64;
const MAP_W = 120;
const MAP_H = 90;

// tileset tile indices (laid out horizontally in one canvas strip)
const T_GRASS_A = 0;
const T_GRASS_B = 1;
const T_GRASS_C = 2;
const T_HILL_A  = 3;
const T_HILL_B  = 4;
const T_CLIFF_A = 5;
const T_CLIFF_B = 6;
const T_SHADOW  = 7;
const TILE_TYPES = 8;

// xorshift32 seeded rng — returns a generator function
function mkRNG(seed) {
  let s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
  return () => {
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return (s = (s >>> 0) || 1) / 0x100000000;
  };
}

export class MapScene extends Phaser.Scene {
  constructor() { super('MapScene'); }

  create() {
    this._makeTileset();
    const { tiles, isHill } = this._generateTerrain();
    this._buildTilemap(tiles);
    this._placeTrees(isHill);
    this._setupCamera();
  }

  // ── tileset ──────────────────────────────────────────────────────────────

  _makeTileset() {
    const canvas = document.createElement('canvas');
    canvas.width  = TILE * TILE_TYPES;
    canvas.height = TILE;
    const ctx = canvas.getContext('2d');

    this._drawGrassTiles(ctx);
    this._drawHillTopTiles(ctx);
    this._drawCliffTiles(ctx);
    this._drawShadowTile(ctx);

    this.textures.addCanvas('tileset', canvas);
  }

  _drawGrassTiles(ctx) {
    [
      [T_GRASS_A, '#4a8c40', '#3a7030'],
      [T_GRASS_B, '#4d9043', '#3e7533'],
      [T_GRASS_C, '#478840', '#386c2e'],
    ].forEach(([t, base, dark]) => {
      const ox = t * TILE;
      ctx.fillStyle = base;
      ctx.fillRect(ox, 0, TILE, TILE);

      // noise dots
      const g = mkRNG(ox * 31 + 1);
      ctx.fillStyle = dark;
      for (let i = 0; i < 22; i++) ctx.fillRect((ox + g() * TILE) | 0, (g() * TILE) | 0, 2, 2);

      // grass blade hints
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const bx = (ox + 6 + g() * (TILE - 12)) | 0;
        const by = (6 + g() * (TILE - 12)) | 0;
        ctx.beginPath();
        ctx.moveTo(bx, by + 5);
        ctx.quadraticCurveTo(bx + 2, by + 2, bx, by);
        ctx.stroke();
      }
    });
  }

  _drawHillTopTiles(ctx) {
    [
      [T_HILL_A, '#6aba45', '#80ce52', '#58a038'],
      [T_HILL_B, '#68b440', '#7ccc4e', '#56983a'],
    ].forEach(([t, base, light, dark]) => {
      const ox = t * TILE;
      ctx.fillStyle = base;
      ctx.fillRect(ox, 0, TILE, TILE);
      const g = mkRNG(ox * 17 + 3);
      ctx.fillStyle = light;
      for (let i = 0; i < 12; i++) ctx.fillRect((ox + g() * TILE) | 0, (g() * TILE) | 0, 2, 2);
      ctx.fillStyle = dark;
      for (let i = 0; i < 8; i++) ctx.fillRect((ox + g() * TILE) | 0, (g() * TILE) | 0, 2, 2);
    });
  }

  _drawCliffTiles(ctx) {
    [
      [T_CLIFF_A, '#6aba45', '#806030', '#48381a'],
      [T_CLIFF_B, '#68b440', '#7a5c28', '#4a3a1c'],
    ].forEach(([t, grass, cliff, shadow]) => {
      const ox = t * TILE;
      const splitY  = (TILE * 0.54) | 0; // where cliff face begins
      const cliffEnd = (TILE * 0.84) | 0; // where deep shadow begins

      // hilltop green
      ctx.fillStyle = grass;
      ctx.fillRect(ox, 0, TILE, splitY);

      // bright crest line
      ctx.fillStyle = '#b0f070';
      ctx.fillRect(ox, splitY - 2, TILE, 2);

      // cliff face
      ctx.fillStyle = cliff;
      ctx.fillRect(ox, splitY, TILE, cliffEnd - splitY);

      // vertical rock striations
      const g = mkRNG(ox * 13 + 5);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let i = 0; i < 8; i++) ctx.fillRect((ox + g() * TILE) | 0, splitY, 2, cliffEnd - splitY);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      for (let i = 0; i < 4; i++) ctx.fillRect((ox + g() * TILE) | 0, splitY, 1, cliffEnd - splitY);

      // cliff base / deep shadow strip
      ctx.fillStyle = shadow;
      ctx.fillRect(ox, cliffEnd, TILE, TILE - cliffEnd);
    });
  }

  _drawShadowTile(ctx) {
    const ox = T_SHADOW * TILE;
    ctx.fillStyle = '#4a8c40';
    ctx.fillRect(ox, 0, TILE, TILE);
    // shadow gradient covers top 45% of tile
    const grad = ctx.createLinearGradient(ox, 0, ox, TILE * 0.45);
    grad.addColorStop(0, 'rgba(0,0,0,0.52)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(ox, 0, TILE, (TILE * 0.45) | 0);
  }

  // ── terrain generation ────────────────────────────────────────────────────

  _generateTerrain() {
    const buf = new Uint8Array(MAP_W * MAP_H);
    const r = mkRNG(42);

    // place randomised elliptical hill blobs
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

    const isHill = (x, y) =>
      x >= 0 && x < MAP_W && y >= 0 && y < MAP_H && buf[y * MAP_W + x] === 1;

    const tiles = Array.from({ length: MAP_H }, (_, y) =>
      Array.from({ length: MAP_W }, (_, x) => {
        const v = (x * 7 + y * 13) % 2;
        if (isHill(x, y)) {
          // cliff = hill cell whose south neighbour is not hill
          return isHill(x, y + 1) ? (v ? T_HILL_B : T_HILL_A) : (v ? T_CLIFF_B : T_CLIFF_A);
        }
        if (isHill(x, y - 1)) return T_SHADOW;
        // grass variants via cheap hash
        return (x * 3 + y * 11) % 3; // 0/1/2 = GRASS_A/B/C
      })
    );

    return { tiles, isHill };
  }

  // ── tilemap ───────────────────────────────────────────────────────────────

  _buildTilemap(tiles) {
    const map = this.make.tilemap({ data: tiles, tileWidth: TILE, tileHeight: TILE });
    const ts  = map.addTilesetImage('tileset', 'tileset', TILE, TILE, 0, 0);
    map.createLayer(0, ts, 0, 0);
  }

  // ── trees ─────────────────────────────────────────────────────────────────

  _placeTrees(isHill) {
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

        const onCliff  = isHill(tx, ty) && !isHill(tx, ty + 1);
        const onShadow = !isHill(tx, ty) && isHill(tx, ty - 1);
        if (onCliff || onShadow) continue;
        if (isHill(tx, ty) && r() > 0.3) continue; // sparser on hilltops

        const wx = tx * TILE + TILE * 0.5 + ((r() * 22 - 11) | 0);
        const wy = ty * TILE + TILE * 0.42 + ((r() * 14 - 7) | 0);
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
      const cx = w / 2;
      const trunkBase = h * 0.75;
      const r = w * 0.36;

      // ground shadow ellipse
      c.fillStyle = 'rgba(0,0,0,0.22)';
      c.beginPath(); c.ellipse(cx, h - 5, r * 0.72, r * 0.2, 0, 0, Math.PI * 2); c.fill();

      // trunk
      c.fillStyle = '#5a3c1c';
      c.fillRect(cx - 4, trunkBase - h * 0.22, 8, h * 0.22 + 5);

      // back crown blobs (darker)
      c.fillStyle = crown;
      c.beginPath(); c.arc(cx - r * 0.5, trunkBase - r * 0.65, r * 0.58, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.arc(cx + r * 0.5, trunkBase - r * 0.70, r * 0.55, 0, Math.PI * 2); c.fill();

      // main crown
      c.fillStyle = mid;
      c.beginPath(); c.arc(cx, trunkBase - r * 0.9, r, 0, Math.PI * 2); c.fill();

      // top highlight
      c.fillStyle = hi;
      c.beginPath(); c.arc(cx - r * 0.2, trunkBase - r * 1.15, r * 0.38, 0, Math.PI * 2); c.fill();

      this.textures.addCanvas(name, canvas);
    });
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

    this.input.on('pointerdown', p => {
      drag = { ox: p.x, oy: p.y, sx: cam.scrollX, sy: cam.scrollY };
      this.game.canvas.style.cursor = 'grabbing';
    });

    this.input.on('pointermove', p => {
      if (!drag) return;
      cam.setScroll(drag.sx - (p.x - drag.ox), drag.sy - (p.y - drag.oy));
    });

    const endDrag = () => {
      drag = null;
      this.game.canvas.style.cursor = 'grab';
    };

    this.input.on('pointerup', endDrag);
    this.input.on('pointerupoutside', endDrag);

    this.game.canvas.style.cursor = 'grab';
  }
}
