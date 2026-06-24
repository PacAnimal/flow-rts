// The Scenario (docs/adr/0014): the level-as-data the player plays against — the Waves and the
// win/lose Objective — the counterpart to the Library. Pure data + a builder for the Enemy
// Flows; no Phaser, no world state. The world (MapScene) plays the timeline and checks the
// Objective. Enemy Flows are built here as ordinary FlowModels but kept out of the Library
// (docs/adr/0011): they are authored, not editable.

import { FlowModel } from './flow/model.js';

// A Wave: a group of Enemy Units of one type, spawned at `at` seconds (after START) from a named
// spawn point. Each spawned Enemy is born running the rush Flow below (born-with-a-Flow, ADR-0013).
export const SCENARIO = {
  name: 'Survival',
  waves: [
    { at: 8,  count: 3,  unitType: 'marine', spawn: 'left'   },
    { at: 25, count: 4,  unitType: 'marine', spawn: 'right'  },
    { at: 45, count: 6,  unitType: 'marine', spawn: 'top'    },
    { at: 70, count: 8,  unitType: 'marine', spawn: 'bottom' },
    { at: 95, count: 12, unitType: 'marine', spawn: 'left'   },
  ],
};

// The Enemy rush behaviour, authored as data: OnStart → Attack-Move toward the player's base.
// Attack-Move engages anything in its aggro radius on the way in (docs/adr/0012), so Enemies
// fight Units they pass and then hammer the Command Center on arrival.
export function enemyFlowModel(targetTile) {
  const m = new FlowModel();
  const start = m.addNode('OnStart', 40, 40);
  const atk = m.addNode('AttackMove', 40, 140);
  m.setParam(atk.id, 'destination', { x: targetTile.x, y: targetTile.y });
  m.connect({ node: start.id, port: 'out' }, { node: atk.id, port: 'in' });
  return m;
}
