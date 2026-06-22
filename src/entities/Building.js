import { TILE } from '../constants.js';

export class Building {
  constructor(scene, tx, ty, tileW, tileH, textureKey) {
    this.scene = scene;
    this.tx = tx;
    this.ty = ty;
    this.tileW = tileW;
    this.tileH = tileH;

    const px = (tx + tileW * 0.5) * TILE;
    const py = (ty + tileH) * TILE;

    this.sprite = scene.add.image(px, py, textureKey);
    this.sprite.setOrigin(0.5, 1);
    const natural = Math.max(this.sprite.width, this.sprite.height);
    this.sprite.setScale(tileW * TILE / natural);
    this.sprite.setDepth(py);
  }
}
