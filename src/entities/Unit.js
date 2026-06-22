export class Unit {
  constructor(scene, x, y, textureKey, displaySize) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.sprite = scene.add.image(x, y, textureKey);
    this.sprite.setOrigin(0.5, 1);
    if (displaySize != null) {
      const natural = Math.max(this.sprite.width, this.sprite.height);
      this.sprite.setScale(displaySize / natural);
    }
    this.sprite.setDepth(y);
  }
}
