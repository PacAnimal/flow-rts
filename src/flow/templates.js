// Starter Flows: a handful of worked examples seeded into the Library the first time the game is
// opened, so a new author lands on working Flows instead of an empty Canvas. They are ordinary
// Library entries — editable, deletable, cloneable, not Protected like the critter's Biter Roam
// (ADR-0011) — because the point is to be taken apart and changed, not preserved.
//
// They exist to teach the three idioms nothing else in the game announces:
//   • a loop is a Connection wired BACKWARD, not a node kind, and it must contain a node that
//     waits or it spins and ends the Run (CONTEXT.md Flow Control);
//   • an Interrupt is how a Flow reacts without the main line polling for it (docs/adr/0019);
//   • a Branch gates that loop on a Condition, which is how production caps itself (docs/adr/0010).
//
// Pure and engine-free: this builds FlowModels and nothing else. Seeding is a one-time Library
// operation (see seedStarterFlows), not something the world runs.

import { FlowModel } from './model.js';

// Bumping this re-seeds for everyone, so only do it when the starters are worth re-delivering —
// an existing player's Library already records the version it was seeded at and is left alone.
const SEED_VERSION = 'v1';

// Starters land in their own Category so they group into one collapsible section of the Library
// and stay out of the way of the player's own Flows (CONTEXT.md Category).
const CATEGORY = 'Starters';

// Lay a node out and set its Parameters in one call — every builder below is mostly positioning.
function add(m, kind, x, y, params) {
  const node = m.addNode(kind, x, y);
  for (const [id, value] of Object.entries(params || {})) m.setParam(node.id, id, value);
  return node;
}

const wire = (m, from, outPort, to) =>
  m.connect({ node: from.id, port: outPort }, { node: to.id, port: 'in' });

// The starters, in build order: the Unit Flows come first so the Building Flows below can name
// them in their Train node's `assignFlow` — a trained Unit is born already running one (ADR-0013),
// which is what makes this set playable the moment it is assigned rather than a pile of parts.
export const STARTER_FLOWS = [
  {
    key: 'gather',
    name: 'Gather Loop',
    targetKind: 'unit',
    // The economy spine, and the smallest honest example of a loop: Deliver's Exec output runs
    // BACKWARD to Gather. The cycle is legal because both nodes hold the cursor (Gather for the
    // Resource's gather time, Deliver for the hand-off) — an all-instant back-edge would spin.
    // Needs no Parameters at all: Gather claims whatever Deposit is in reach of where the Worker
    // was sent (docs/adr/0017), so one Flow spreads a whole crew across a patch.
    build: () => {
      const m = new FlowModel('unit');
      const start = add(m, 'OnStart', 60, 40);
      const gather = add(m, 'Gather', 60, 160);
      const deliver = add(m, 'Deliver', 60, 300);
      wire(m, start, 'out', gather);
      wire(m, gather, 'out', deliver);
      wire(m, deliver, 'out', gather); // the back-edge: this is what a loop IS
      return m;
    },
  },

  {
    key: 'guard',
    name: 'Stand Guard',
    targetKind: 'unit',
    // A standing guard with a survival reflex, and the smallest honest example of an Interrupt.
    // The base line is one node: Hold, which parks the cursor forever and fights anything that
    // comes into range. Everything else hangs off On Damaged, which preempts that Frame, runs its
    // own chain, and lets the suspended Frame resume (docs/adr/0019) — so a Unit that retreats
    // goes back to guarding, from wherever it ended up, with nothing wired to say so.
    build: () => {
      const m = new FlowModel('unit');
      const start = add(m, 'OnStart', 60, 40);
      const hold = add(m, 'Hold', 60, 160);
      const hurt = add(m, 'OnDamaged', 420, 40);
      const check = add(m, 'Branch', 420, 160, { condition: 'self_health_below', percent: 40 });
      const retreat = add(m, 'Retreat', 420, 320);
      wire(m, start, 'out', hold);
      wire(m, hurt, 'out', check);
      wire(m, check, 'yes', retreat); // hurt badly ⇒ fall back; 'no' is unwired, so shrug it off
      return m;
    },
  },

  {
    key: 'rally',
    name: 'Rally and Hold',
    targetKind: 'unit',
    // A picket line. The one starter with something left to do: it heads for the Marker `rally`
    // (docs/adr/0024), which the player has to place — until then the Run parks on Move and says
    // so, which is itself the lesson that a Flow names a place and the map supplies it. Drag the
    // Marker mid-match and the whole line re-forms there. `spread` is already on: each Runner
    // claims a distinct Tile near the Marker instead of a dozen Units shoving over one (ADR-0020).
    build: () => {
      const m = new FlowModel('unit');
      const start = add(m, 'OnStart', 60, 40);
      const move = add(m, 'Move', 60, 160, { marker: 'rally', spread: true });
      const hold = add(m, 'Hold', 60, 300);
      wire(m, start, 'out', move);
      wire(m, move, 'out', hold);
      return m;
    },
  },

  {
    key: 'train-workers',
    name: 'Train Workers to 6',
    targetKind: 'building',
    buildingType: 'command_center',
    // Production that caps itself — a Branch gating a loop, which is how a Building decides when to
    // stop without a human watching. Under the cap it Trains (blocking on the Stockpile, then the
    // build time) and loops back to re-check; at the cap it Waits five seconds and re-checks, so
    // losing a Worker restarts production on its own. BOTH cycles contain a node that waits, which
    // is what keeps them legal. New Workers are born running Gather Loop.
    build: (ids) => {
      const m = new FlowModel('building', 'command_center');
      const start = add(m, 'OnStart', 60, 40);
      const enough = add(m, 'Branch', 60, 160, { condition: 'unit_count', unitKind: 'worker', amount: 6 });
      const train = add(m, 'Train', 60, 360, { unitType: 'worker', assignFlow: ids.gather });
      const idle = add(m, 'Wait', 400, 360, { duration: 5 });
      wire(m, start, 'out', enough);
      wire(m, enough, 'no', train);   // below the cap ⇒ make another
      wire(m, train, 'out', enough);  // back-edge: re-check after each one
      wire(m, enough, 'yes', idle);   // at the cap ⇒ idle, then re-check (a Worker may die)
      wire(m, idle, 'out', enough);
      return m;
    },
  },

  {
    key: 'train-marines',
    name: 'Train Marines to 8',
    targetKind: 'building',
    buildingType: 'barracks',
    // The same capped-production shape on the Barracks, to show the pattern is not special to
    // Workers. New Marines are born running Stand Guard, so they defend the base they spawn at
    // without being told — assign this to a Barracks and an army appears and holds.
    build: (ids) => {
      const m = new FlowModel('building', 'barracks');
      const start = add(m, 'OnStart', 60, 40);
      const enough = add(m, 'Branch', 60, 160, { condition: 'unit_count', unitKind: 'marine', amount: 8 });
      const train = add(m, 'Train', 60, 360, { unitType: 'marine', assignFlow: ids.guard });
      const idle = add(m, 'Wait', 400, 360, { duration: 5 });
      wire(m, start, 'out', enough);
      wire(m, enough, 'no', train);
      wire(m, train, 'out', enough);
      wire(m, enough, 'yes', idle);
      wire(m, idle, 'out', enough);
      return m;
    },
  },
];

// Seed the starters into a Library that has never had them. Returns how many were added (0 when
// this Library was already seeded), so the caller can log it.
//
// Seeding is keyed on a version stamp stored with the Library, NOT on the Library being empty: a
// player who deletes every starter has made a decision, and an empty-Library check would undo it
// on the next reload. Each entry's id is handed to the builders that follow, so a Train node can
// name the Flow its product is born running.
export function seedStarterFlows(library) {
  if (!library || library.seeded === SEED_VERSION) return 0;
  const ids = {};
  for (const t of STARTER_FLOWS) {
    const entry = library.create(t.name, t.targetKind, t.buildingType || null);
    entry.model = t.build(ids);
    entry.category = CATEGORY;
    ids[t.key] = entry.id;
  }
  library.seeded = SEED_VERSION;
  library.save();
  return STARTER_FLOWS.length;
}
