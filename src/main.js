import Phaser from 'phaser';
import { MapScene } from './scenes/MapScene.js';
import { FlowEditor } from './flow/editor.js';
import { flowLibrary } from './flow/library.js';
import { seedStarterFlows } from './flow/templates.js';

const game = new Phaser.Game({
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

// Seed the starter Flows on a Library that has never had them (src/flow/templates.js), before the
// editor mounts so its first render opens onto a working Flow rather than a blank Canvas.
const seeded = seedStarterFlows(flowLibrary);
if (seeded) console.log(`Seeded ${seeded} starter Flows into the Library`);

// Flow editor — a DOM overlay above the Phaser canvas. Toggle with the button or `F`.
const editor = new FlowEditor(flowLibrary).mount();
// Share the editor with the scene (via the global registry) so debug-mode can drive it as a
// live read-only inspector of a clicked Runner's Flow. The scene reads it with registry.get.
game.registry.set('flowEditor', editor);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    editor.toggle();
  }
});
