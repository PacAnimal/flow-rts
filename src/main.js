import Phaser from 'phaser';
import { MapScene } from './scenes/MapScene.js';
import { FlowEditor } from './flow/editor.js';
import { flowLibrary } from './flow/library.js';

new Phaser.Game({
  type: Phaser.AUTO,
  backgroundColor: '#0a0806',
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

// Flow editor — a DOM overlay above the Phaser canvas. Toggle with the button or `F`.
const editor = new FlowEditor(flowLibrary).mount();
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    editor.toggle();
  }
});
