import { TILE, UNIT_SPEED } from '../constants.js';

// directions in clockwise order, matching angle buckets
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

import { attachHealth, drawHealthBar } from './runner.js';
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

  // Reposition the health bar above the sprite; called each frame as the Unit moves.
  syncHealthBar() {
    drawHealthBar(this, this.x, this.y - this._displaySize - 6, this._displaySize * 0.8);
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
