// Unit assignment overlay: a small modal, opened by clicking a Unit on the map, that
// lists the Library's Flows and assigns the chosen one to that Unit. Per docs/adr/0003 a
// Flow is a shared definition, so the Unit's Assignment holds the Flow's id by reference
// (unit.assignedFlowId) — not a copy. A Unit runs at most one Flow, so picking one
// replaces the previous Assignment; 'None' clears it. No execution happens yet.

import './editor.css';
import { getBuildingType } from '../units.js';

let overlay = null;
let panel = null;

function ensureDom() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.className = 'assign-overlay hidden';
  panel = document.createElement('div');
  panel.className = 'assign-panel';
  overlay.appendChild(panel);
  // Click on the backdrop (outside the panel) closes without changing anything.
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
}

// Phaser binds pointer listeners at the window level (docs/adr/0001), so while this modal is
// open a click on a flow row would otherwise fall through to the Runner sprite behind it and
// re-open the overlay for whatever Unit sat under the cursor. Mirror the Flow editor: announce
// open/close so MapScene can disable map input for the overlay's lifetime.
function setVisible(open) {
  window.dispatchEvent(new CustomEvent('assign-overlay-visibility', { detail: { open } }));
}

function close() {
  if (overlay) overlay.classList.add('hidden');
  setVisible(false);
}

// Open the assign overlay for a `runner` (Unit or Building). Only Flows whose targetKind matches
// `targetKind` are offered (docs/adr/0015); for Buildings, `buildingType` further restricts to
// Flows authored for that building (docs/adr/0016). `onAssigned(runner)` is called after a change
// so the caller can refresh any on-map label. `runner.label` (optional) is shown as the title.
export function openAssignOverlay(unit, library, targetKind, onAssigned, buildingType = null) {
  ensureDom();
  panel.replaceChildren();

  const head = document.createElement('h2');
  head.textContent = `Assign Flow${unit.label ? ` — ${unit.label}` : ''}`;
  panel.appendChild(head);

  const list = document.createElement('div');
  list.className = 'assign-list';

  const addRow = (id, name, isClear) => {
    const row = document.createElement('button');
    row.className = 'assign-item';
    if (isClear) row.classList.add('assign-none');
    if (unit.assignedFlowId === id) row.classList.add('active');
    row.textContent = name;
    row.addEventListener('click', () => {
      unit.assignedFlowId = id;
      onAssigned && onAssigned(unit);
      close();
    });
    list.appendChild(row);
  };

  addRow(null, 'None (clear)', true);
  // A Building-Flow cannot be assigned to a Unit and vice versa (docs/adr/0015); a Building only
  // sees Flows authored for its building type (docs/adr/0016). Legacy Flows default to 'unit'.
  const flows = library.list().filter((e) => {
    if ((e.model.targetKind || 'unit') !== targetKind) return false;
    return targetKind !== 'building' || e.model.buildingType === buildingType;
  });
  const kindLabel = targetKind === 'building'
    ? (getBuildingType(buildingType)?.label || 'building')
    : 'unit';
  if (flows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'assign-empty';
    empty.textContent = `No ${kindLabel} Flows yet. Open the Flow editor (F) to create one.`;
    list.appendChild(empty);
  } else {
    for (const entry of flows) addRow(entry.id, entry.protected ? `${entry.name}  [Protected]` : entry.name);
  }

  panel.appendChild(list);
  overlay.classList.remove('hidden');
  setVisible(true);
}
