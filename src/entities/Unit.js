import { TILE, UNIT_SPEED } from '../constants.js';

// directions in clockwise order, matching angle buckets
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

import { attachHealth } from './runner.js';
import { getUnitType, FACTION } from '../units.js';

export class Unit {
  constructor(scene, x, y, texturePrefix, displaySize, faction = FACTION.PLAYER, speedTilesPerSec = UNIT_SPEED) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this._texturePrefix = texturePrefix;
    this._displaySize = displaySize;
    this.speed = speedTilesPerSec * TILE;
    this._dir = 'S';

    // Unit type (CONTEXT.md): the texture prefix doubles as the type key into the data table.
    this.type = texturePrefix;
    const def = getUnitType(texturePrefix);
    this.carryCapacity = def ? def.carryCapacity : 0;

    this._shadow = scene.add.image(x, y, 'unit_shadow').setDepth(1).setOrigin(0.5, 0.5);
    this._shadowAlpha = 1.0;
    this._shadowW     = 2.0;  // ellipse width as fraction of displaySize
    this._shadowH     = 0.55; // ellipse height as fraction of displaySize
    this._shadowYOff  = 0;    // extra y offset (reapers use this to show hover gap)

    this.sprite = scene.add.image(x, y, `${texturePrefix}_S`);
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
    const idx = Math.round(deg / 45) % 8;
    this.setDirection(DIRS[idx]);
  }

  setDirection(dir) {
    if (dir === this._dir) return;
    this._dir = dir;
    this.sprite.setTexture(`${this._texturePrefix}_${dir}`);
    this._applyScale();
  }
}
