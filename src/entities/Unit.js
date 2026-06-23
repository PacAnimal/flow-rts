import { TILE, UNIT_SPEED } from '../constants.js';

// directions in clockwise order, matching angle buckets
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Unit {
  constructor(scene, x, y, texturePrefix, displaySize, speedTilesPerSec = UNIT_SPEED) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this._texturePrefix = texturePrefix;
    this._displaySize = displaySize;
    this.speed = speedTilesPerSec * TILE;
    this._dir = 'S';

    this.sprite = scene.add.image(x, y, `${texturePrefix}_S`);
    this.sprite.setOrigin(0.5, 1);
    this._applyScale();
    this.sprite.setDepth(y);
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
