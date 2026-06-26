import { TILE } from '../constants.js';
import { attachHealth, drawHealthBar } from './runner.js';
import { FACTION } from '../units.js';

// A Construction Site (CONTEXT.md, docs/adr/0018): a placed-but-unfinished Building. It is its own
// thing — not a Building and not a Runner (it holds no Flow and runs nothing) — but it occupies and
// blocks its Footprint and carries Health, so an Enemy can raze it. Rendered as the target
// Building's sprite, transparent at first and fading solid as Workers complete it. When its build
// work is done the world (MapScene._completeSite) swaps it for a real Building of that type.
export class ConstructionSite {
  constructor(scene, tx, ty, def, faction = FACTION.PLAYER) {
    this.scene = scene;
    this.tx = tx;
    this.ty = ty;
    this.type = def.id;
    this.tileW = def.tileW;
    this.tileH = def.tileH;

    const px = (tx + this.tileW * 0.5) * TILE;
    const py = (ty + this.tileH) * TILE;
    this._cx = px;

    // The finished Building's sprite, shown faded — the placeholder until art exists (docs/adr/0018).
    this.sprite = scene.add.image(px, py, def.id);
    this.sprite.setOrigin(0.5, 1);
    this.sprite.setScale(this.tileW * TILE / Math.max(this.sprite.width, this.sprite.height));
    this.sprite.setDepth(py);
    this.sprite.setAlpha(0.4); // 60% transparent at placement; fades to solid as it completes

    // Destructible without being a Runner — Health belongs to destructible map things now (CONTEXT.md).
    attachHealth(this, def.maxHealth, faction);

    // Construction bookkeeping (docs/adr/0018): build work accrues at (arrived builders × dt) and
    // completes at buildDuration (the solo-Worker time). `builders` is the live Claim set, ≤4.
    this.buildProgress = 0;
    this.buildDuration = def.buildTime * 1000;
    this.builders = new Set();
    this.assignFlowId = null;
  }

  get progressFrac() {
    return Math.max(0, Math.min(1, this.buildProgress / this.buildDuration));
  }

  // Fade from 60% transparent toward fully solid as the build nears completion (docs/adr/0018).
  syncVisual() {
    this.sprite.setAlpha(0.4 + 0.6 * this.progressFrac);
  }

  syncHealthBar() {
    drawHealthBar(this, this._cx, this.sprite.y - this.sprite.displayHeight - 8, this.tileW * TILE * 0.7);
  }
}
