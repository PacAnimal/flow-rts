import { TILE } from '../constants.js';
import { attachHealth, drawHealthBar } from './runner.js';
import { getBuildingType, FACTION } from '../units.js';

export class Building {
  constructor(scene, tx, ty, tileW, tileH, textureKey, faction = FACTION.PLAYER) {
    this.scene = scene;
    this.tx = tx;
    this.ty = ty;
    this.tileW = tileW;
    this.tileH = tileH;
    this.type = textureKey; // texture key doubles as the building-type key

    const px = (tx + tileW * 0.5) * TILE;
    const py = (ty + tileH) * TILE;
    this._cx = px;
    this._top = py - tileH * TILE;

    this.sprite = scene.add.image(px, py, textureKey);
    this.sprite.setOrigin(0.5, 1);
    const natural = Math.max(this.sprite.width, this.sprite.height);
    this.sprite.setScale(tileW * TILE / natural);
    this.sprite.setDepth(py);

    // soft dark glow tracing the building's actual silhouette (preFX = WebGL only)
    if (this.sprite.preFX) {
      this.sprite.preFX.addGlow(0x080808, 3, 0, false, 0.05, 8);
    }

    // Buildings are Runners too (CONTEXT.md): Faction + Health, destructible from the start.
    const def = getBuildingType(textureKey);
    attachHealth(this, def ? def.maxHealth : 1000, faction);
  }

  // Buildings don't move, so the bar is redrawn only when Health changes.
  syncHealthBar() {
    drawHealthBar(this, this._cx, this.sprite.y - this.sprite.displayHeight - 8, this.tileW * TILE * 0.7);
  }
}
