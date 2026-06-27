import { TILE, UNIT_SPEED } from '../constants.js';

// 8-direction: clockwise from N, one texture per direction
const DIRS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// 16-direction: clockwise from N, frames in row-major sprite sheet order
const DIRS16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
// frame index lookup matching the sheet layout (S=0 SSE=1 SE=2 … row-major)
const FRAME16 = {S:0,SSE:1,SE:2,ESE:3,E:4,ENE:5,NE:6,NNE:7,N:8,NNW:9,NW:10,WNW:11,W:12,WSW:13,SW:14,SSW:15};

import { attachHealth } from './runner.js';
import { getUnitType, FACTION } from '../units.js';

export class Unit {
  constructor(scene, x, y, texturePrefix, displaySize, faction = FACTION.PLAYER, speedTilesPerSec = UNIT_SPEED, dirCount = 8) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this._texturePrefix = texturePrefix;
    this._displaySize = displaySize;
    this.speed = speedTilesPerSec * TILE;
    this._dirCount = dirCount;
    this._dir = 'S';

    // Unit type (CONTEXT.md): the texture prefix doubles as the type key into the data table.
    this.type = texturePrefix;
    // Read *effective* stats so a Unit trained after a research is born upgraded (docs/adr/0021);
    // the seam falls back to the base table for Enemies and before the registry exists. The
    // live-read combat stats (damage/range) go through the same seam each tick; maxHealth and
    // carryCapacity are stored here and bumped on existing Units when a research completes.
    const def = scene._effectiveStats ? scene._effectiveStats(texturePrefix, faction) : getUnitType(texturePrefix);
    this.carryCapacity = def ? def.carryCapacity : 0;

    this._shadow = scene.add.image(x, y, 'unit_shadow').setDepth(1).setOrigin(0.5, 0.5);
    this._shadowAlpha = 1.0;
    this._shadowW     = 2.0;  // ellipse width as fraction of displaySize
    this._shadowH     = 0.55; // ellipse height as fraction of displaySize
    this._shadowYOff  = 0;    // extra y offset (reapers use this to show hover gap)

    this.sprite = dirCount === 16
      ? scene.add.image(x, y, texturePrefix, FRAME16['S'])
      : scene.add.image(x, y, `${texturePrefix}_S`);
    this.sprite.setOrigin(0.5, 1);
    this._applyScale();
    this.sprite.setDepth(y);

    // thin dark silhouette glow — 1px edge, feathers over ~2px (preFX = WebGL only)
    if (this.sprite.preFX) {
      this.sprite.preFX.addGlow(0x080808, 1.5, 0, false, 0.15, 4);
    }

    // Runner state: Faction + Health (CONTEXT.md).
    attachHealth(this, def ? def.maxHealth : 1, faction);
  }

  syncShadow() {
    const w = this._displaySize * this._shadowW;
    const h = this._displaySize * this._shadowH;
    this._shadow.setPosition(this.x, this.y - 2 + this._shadowYOff);
    this._shadow.setDisplaySize(w, h);
    this._shadow.setAlpha(this._shadowAlpha);
  }

  _applyScale() {
    if (this._displaySize == null) return;
    const natural = Math.max(this.sprite.width, this.sprite.height);
    this.sprite.setScale(this._displaySize / natural);
  }

  // update facing based on velocity vector (vx, vy); no-op when nearly stopped
  updateDirection(vx, vy) {
    const spd = Math.hypot(vx, vy);
    if (spd < 5) return;
    this._faceVector(vx, vy);
  }

  // Turn to face a world point (e.g. the Deposit being gathered or the Command Center being
  // delivered to). Stationary while gathering/delivering, so this sticks until the Unit moves.
  facePoint(px, py) {
    const vx = px - this.x, vy = py - this.y;
    if (Math.hypot(vx, vy) < 1e-3) return; // already on top of it — keep current facing
    this._faceVector(vx, vy);
  }

  _faceVector(vx, vy) {
    const angle = Math.atan2(vy, vx); // -π to π, 0=east
    // convert to 0=north clockwise: add 90° offset then normalise
    const deg = ((angle * 180 / Math.PI) + 90 + 360) % 360;
    if (this._dirCount === 16) {
      this.setDirection(DIRS16[Math.round(deg / 22.5) % 16]);
    } else {
      this.setDirection(DIRS8[Math.round(deg / 45) % 8]);
    }
  }

  setDirection(dir) {
    if (dir === this._dir) return;
    this._dir = dir;
    if (this._dirCount === 16) {
      this.sprite.setFrame(FRAME16[dir]);
    } else {
      this.sprite.setTexture(`${this._texturePrefix}_${dir}`);
    }
    this._applyScale();
  }
}
