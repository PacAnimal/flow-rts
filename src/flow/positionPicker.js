// Reusable position-pick service. Bridges the DOM flow editor and the Phaser map: the
// editor asks for a Tile to be picked; the map (which registers itself as the provider)
// runs the in-world picking and reports the chosen Tile back. This module owns only the
// shared DOM chrome (instruction banner + faint click-through dim layer); the actual
// hovered-Tile highlight and click/cancel logic live in the scene. See docs/adr/0004.

import './editor.css';

let provider = null;
let bannerEl = null;

// The scene calls this to offer in-world picking: fn({ current, onPicked, onCancel }).
export function registerPositionPicker(fn) {
  provider = fn;
}

function showBanner(text) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    bannerEl.className = 'pick-banner hidden';
    document.body.appendChild(bannerEl);
  }
  bannerEl.textContent = text;
  bannerEl.classList.remove('hidden');
}

function hideBanner() {
  if (bannerEl) bannerEl.classList.add('hidden');
}

// Ask the player to pick a Tile on the map. `current` (optional {x,y}) is the existing
// value. `onPicked({x,y})` / `onCancel()` are called exactly once.
export function pickPosition({ current = null, prompt = 'Click a tile to set the position — Esc to cancel', onPicked, onCancel } = {}) {
  showBanner(prompt);
  let done = false;
  const finishPicked = (tile) => { if (done) return; done = true; hideBanner(); onPicked && onPicked(tile); };
  const finishCancel = () => { if (done) return; done = true; hideBanner(); onCancel && onCancel(); };

  if (!provider) { finishCancel(); return; }
  provider({ current, onPicked: finishPicked, onCancel: finishCancel });
}
