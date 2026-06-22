import Phaser from 'phaser';
import { MapScene } from './scenes/MapScene.js';

new Phaser.Game({
  type: Phaser.AUTO,
  backgroundColor: '#2e6620',
  scene: [MapScene],
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: false,
    roundPixels: true,
  },
});
