// The Scenario (docs/adr/0014): the level-as-data the player plays against — the Waves and the
// win/lose Objective — the counterpart to the Library. Pure data + builders for the Enemy
// Flows; no Phaser, no world state. The world (MapScene) plays the timeline and checks the
// Objective. Enemy Flows are built here as ordinary FlowModels but kept out of the Library
// (docs/adr/0011): they are authored, not editable.

import { FlowModel } from './flow/model.js';

// A Wave: a group of Enemy Units of one type, spawned at `at` seconds (after START) from a named
// spawn point, each born running the Enemy Flow named by `flow` (born-with-a-Flow, ADR-0013).
export const SCENARIO = {
  name: 'Survival',
  // Chojins are the only Enemy for now; Heavy Chojins join the later Waves as the heavy melee
  // threat. Waves are spread across ~10 minutes (roughly 1-2 per minute), escalating in count and
  // Heavy mix toward the end. What actually escalates, though, is the *Flow* each Wave runs
  // (docs/adr/0011 amendment): the first Waves rush the front door, then Raids go after the
  // Deposit field, Flanks come in off the edge they spawned from, and Infiltrations walk straight
  // past the defending line. One Enemy type answered by one Marine ball is not a problem; four
  // Flows arriving at four places is, and that is what the player's own Flows have to cover.
  waves: [
    { at: 20,  count: 3,  unitType: 'chojin',       spawn: 'left',   flow: 'rush'       },
    { at: 50,  count: 4,  unitType: 'chojin',       spawn: 'right',  flow: 'rush'       },
    { at: 90,  count: 5,  unitType: 'chojin',       spawn: 'top',    flow: 'raid'       },
    { at: 130, count: 6,  unitType: 'chojin',       spawn: 'bottom', flow: 'rush'       },
    { at: 170, count: 2,  unitType: 'heavy-chojin', spawn: 'left',   flow: 'rush'       },
    { at: 210, count: 8,  unitType: 'chojin',       spawn: 'right',  flow: 'flank'      },
    { at: 250, count: 3,  unitType: 'heavy-chojin', spawn: 'top',    flow: 'rush'       },
    { at: 300, count: 10, unitType: 'chojin',       spawn: 'bottom', flow: 'raid'       },
    { at: 340, count: 4,  unitType: 'heavy-chojin', spawn: 'left',   flow: 'infiltrate' },
    { at: 385, count: 12, unitType: 'chojin',       spawn: 'right',  flow: 'rush'       },
    { at: 430, count: 5,  unitType: 'heavy-chojin', spawn: 'top',    flow: 'flank'      },
    { at: 470, count: 12, unitType: 'chojin',       spawn: 'bottom', flow: 'raid'       },
    { at: 510, count: 6,  unitType: 'heavy-chojin', spawn: 'left',   flow: 'infiltrate' },
    { at: 550, count: 14, unitType: 'chojin',       spawn: 'right',  flow: 'rush'       },
    { at: 590, count: 8,  unitType: 'heavy-chojin', spawn: 'top',    flow: 'rush'       },
  ],
};

// Critter roam behaviour: OnStart → RoamAttack (self-looping). The back-edge is pushed
// directly into connections to bypass the API's self-connect guard — the runtime handles
// self-loops fine (it resets state on each advance, so the biter picks a new destination).
export function critterFlowModel() {
  const m = new FlowModel();
  const start = m.addNode('OnStart', 40, 40);
  const roam = m.addNode('RoamAttack', 40, 140);
  m.connect({ node: start.id, port: 'out' }, { node: roam.id, port: 'in' });
  m.connections.push({ id: 'conn_roam_loop', from: { node: roam.id, port: 'out' }, to: { node: roam.id, port: 'in' } });
  return m;
}

// Chain a straight line of nodes top-to-bottom and wire each Exec out to the next Exec in — the
// shape every Enemy Flow below has. `spec` is [kind, params] pairs; returns the finished model.
function line(spec) {
  const m = new FlowModel();
  let prev = null;
  spec.forEach(([kind, params], i) => {
    const node = m.addNode(kind, 40, 40 + i * 100);
    for (const [id, value] of Object.entries(params || {})) m.setParam(node.id, id, value);
    if (prev) m.connect({ node: prev.id, port: 'out' }, { node: node.id, port: 'in' });
    prev = node;
  });
  return m;
}

// The Enemy Flows, authored as data (docs/adr/0011) and keyed by the name a Wave gives in `flow`.
// Each `build` is handed the destination Tiles the world resolved for this Wave — `base` (beside
// the Command Center), `economy` (beside the Deposit field the player is most likely working), and
// `flank` (a staging Tile a quarter-turn around the base from the spawn edge). They may be null
// when the world has nothing to offer (an exhausted field, no Command Center), so every builder
// falls back to `base`: an Enemy Flow must always have somewhere to go.
//
// Every Flow ends on a Hold at the base. Attack-Move completes once it has arrived AND is not
// engaged (docs/adr/0012), so an Enemy that reaches the base with nothing yet in its attack range
// would otherwise run its line out and stand there inert for the rest of the match. The trailing
// Hold is the standing fight: it keeps attacking whatever comes into range until it is killed.
//
// `label` is the one word the briefing tags the Wave with; `describe` is the sentence behind it.
// Keeping these here rather than in the HUD means the Scenario stays the single description of the
// challenge — the world only renders it, exactly as it only plays the timeline (docs/adr/0014).
export const ENEMY_FLOWS = {
  // The original behaviour: straight at the Command Center, engaging whatever comes inside the
  // aggro radius on the way (docs/adr/0012). The honest frontal attack every other Flow deviates
  // from — and still the right answer for the Waves meant to be met head-on.
  rush: {
    id: 'rush',
    label: 'rush',
    describe: 'Straight at the Command Center, fighting whatever it meets on the way.',
    build: ({ base }) => line([
      ['OnStart'],
      ['AttackMove', { destination: base }],
      ['Hold', {}],
    ]),
  },

  // Goes for the Deposit field first, stands in it long enough to kill the Workers gathering
  // there, then turns on the base. Attacks the player's *economy* rather than their Health bar, so
  // a defence parked entirely at the front door wins the fight and still loses the gather rate.
  // The counter is a Flow that notices — OnDamaged → Retreat on the Workers, a Signal raised to
  // pull the army off the door — which is exactly the coordination the node set was built for.
  raid: {
    id: 'raid',
    label: 'raid',
    describe: 'Works the Deposit field first, killing Workers, before turning on the base.',
    build: ({ base, economy }) => line([
      ['OnStart'],
      ['AttackMove', { destination: economy || base }],
      ['Hold', { duration: 25 }],
      ['AttackMove', { destination: base }],
      ['Hold', {}],
    ]),
  },

  // Skirts a quarter-turn around the base before attacking in, so it arrives from an edge the
  // briefing did not name. The first leg is a plain Move, which drops the combat stance every tick
  // (docs/adr/0012) — the group does not stop to fight its way around, it just goes. Punishes one
  // static line: the answer is spread (docs/adr/0020) or a Signal that redeploys on contact. The
  // staging Move is itself spread, so a dozen Chojins form up across the staging ground instead of
  // stacking on one Tile — the Claim is faction-blind, so the Enemy uses it exactly as a player
  // Flow would.
  flank: {
    id: 'flank',
    label: 'flank',
    describe: 'Loops around the base and attacks from a different edge than it spawned on.',
    build: ({ base, flank }) => line([
      ['OnStart'],
      ['Move', { destination: flank || base, spread: true }],
      ['AttackMove', { destination: base }],
      ['Hold', {}],
    ]),
  },

  // Walks through the defending line without stopping and only fights once it is standing on the
  // Command Center. Move engages nothing at all (docs/adr/0012), so aggro cannot hold these in
  // place — they take the hits and keep walking, arriving hurt but arriving. Punishes any plan
  // that assumes a line *catches* what it is shooting at; the counter is raw damage at the base,
  // or a Hold posted on the base itself rather than out on the approach.
  infiltrate: {
    id: 'infiltrate',
    label: 'infiltrate',
    describe: 'Walks past the defending line without engaging, then fights at the Command Center.',
    build: ({ base }) => line([
      ['OnStart'],
      ['Move', { destination: base }],
      ['Hold', {}],
    ]),
  },
};

export function getEnemyFlow(id) {
  return ENEMY_FLOWS[id] || ENEMY_FLOWS.rush;
}

// Build the FlowModel a Wave's Enemies are born running. `tiles` carries the world-resolved
// destinations described on ENEMY_FLOWS; an unknown name falls back to the rush, so a Wave with a
// typo'd `flow` still attacks rather than standing still.
export function enemyFlowModel(flowName, tiles) {
  return getEnemyFlow(flowName).build(tiles || {});
}
