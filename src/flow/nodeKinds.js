// Schema/descriptor for each Node kind. A descriptor declares the node's category,
// display title, the Runner kind it applies to, and its Ports. Ports carry a `type`
// ('exec' | 'data') and a `dir` ('in' | 'out'); only 'exec' ports are used today, but the
// schema is shaped so a kind can declare 'data' ports later without touching the model or
// editor. See CONTEXT.md and docs/adr/0002.
//
// `runner` is which Runner kind a node applies to (docs/adr/0015): 'any' (Events / Flow
// Control, valid on every Flow), 'unit' (Unit Actions), or 'building' (Building Actions). The
// editor palette shows a node only when it matches the edited Flow's targetKind.

export const NODE_KINDS = {
  OnStart: {
    kind: 'OnStart',
    category: 'event',
    runner: 'any',
    title: 'On Start',
    // Fires once per Runner when its Flow begins running (see CONTEXT.md). Entry point:
    // an Event has an Exec output and no Exec input.
    ports: [
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  OnTimer: {
    kind: 'OnTimer',
    category: 'event',
    runner: 'any',
    title: 'On Timer',
    // An Interrupt Event (docs/adr/0019): once the Run has gone `delay` seconds it fires, suspending
    // whatever the Run is doing, running this chain, then resuming where it left off. With `repeat`
    // on (default) it fires every `delay` seconds — its clock pauses while its own handler runs, so
    // the period counts time *between* handlings. Like every Event: an Exec out, no Exec in.
    ports: [
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    params: [
      { id: 'delay', type: 'number', label: 'Seconds', min: 0, step: 0.5 },
      { id: 'repeat', type: 'boolean', label: 'Repeat', default: true },
    ],
  },

  OnDamaged: {
    kind: 'OnDamaged',
    category: 'event',
    runner: 'any',
    title: 'On Damaged',
    // An Interrupt Event (docs/adr/0019) that fires when this Runner takes Damage: it suspends
    // whatever the Run is doing, runs this chain, then resumes. The survival reflex — wire it to
    // Retreat (a Worker flees when hit) or Hold/AttackMove (a Marine fights back, then returns to
    // its post). Always repeating: it re-arms after each handling, so renewed fire keeps a Runner
    // reacting under sustained attack. Like every Event: an Exec out, no Exec in.
    ports: [
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  OnWaveIncoming: {
    kind: 'OnWaveIncoming',
    category: 'event',
    runner: 'any',
    title: 'On Wave Incoming',
    // An Interrupt Event (docs/adr/0019) keyed to the Scenario's Wave clock (docs/adr/0014): it
    // fires once when the next Wave is `lead` seconds away, suspending the Run to handle it, then
    // resumes. The macro half of hands-off survival — gather/build during the lull, then on this
    // Interrupt rally to a defensive line before the Enemies arrive. Re-arms for each subsequent
    // Wave. An unset/zero `lead` is inert (ADR-0004), like OnTimer's `delay`.
    ports: [
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    params: [
      { id: 'lead', type: 'number', label: 'Lead seconds', min: 0, step: 1 },
    ],
  },

  Move: {
    kind: 'Move',
    category: 'action',
    runner: 'unit',
    title: 'Move',
    // An Action is chainable: Exec in to run it, Exec out to run the next node.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    // Parameters: literals configured on the node (ADR-0004). 'destination' is a Tile,
    // picked on the map via "Select Position"; it is the inline default of the future
    // 'destination' Data port reserved in ADR-0002. 'spread' (docs/adr/0020) makes several
    // Runners sharing one Flow fan out: each claims a distinct Tile near the destination
    // instead of all stacking on the one Tile — for patrol/rally lines. Off ⇒ all head to
    // the exact destination (today's behaviour); a full area falls back to it, never blocks.
    params: [
      { id: 'destination', type: 'tile', label: 'Destination', pickLabel: 'Select Position…' },
      { id: 'spread', type: 'boolean', label: 'Spread out', default: false },
    ],
  },

  Gather: {
    kind: 'Gather',
    category: 'action',
    runner: 'unit',
    title: 'Gather Resources',
    // Claims the nearest unclaimed Deposit near where the Worker was rallied, walks the last Tiles
    // to a free Tile beside it, stands for the Resource's gather time, and takes its yield into
    // Cargo (docs/adr/0008, 0017). No Parameters — it adapts to whatever Deposit is in reach. One
    // Worker per Deposit, so several Workers on one Flow spread across a cluster. If every Deposit
    // in reach is already claimed it WAITS in place (holds the cursor) until one frees; with no
    // Deposit ever in reach (field empty, or rallied too far) it waits indefinitely. Chainable.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  Deliver: {
    kind: 'Deliver',
    category: 'action',
    runner: 'unit',
    title: 'Deliver Resources',
    // Beside a Command Center, the Worker hands its Cargo to the player's Stockpile and empties
    // its Cargo (docs/adr/0008). No Parameters; if not beside a Command Center (or carrying
    // nothing) it is a no-op. Chainable like any Action.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  AttackMove: {
    kind: 'AttackMove',
    category: 'action',
    runner: 'unit',
    title: 'Attack-Move',
    // Move toward the destination Tile; engage any Enemy that enters the aggro radius en route,
    // then resume. Completes on arrival (docs/adr/0012). Chainable like any Action.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    params: [
      { id: 'destination', type: 'tile', label: 'Destination', pickLabel: 'Select Position…' },
    ],
  },

  Hold: {
    kind: 'Hold',
    category: 'action',
    runner: 'unit',
    title: 'Hold Position',
    // Stand and attack the nearest Enemy in range (docs/adr/0012). With no duration it holds the
    // cursor indefinitely — a standing guard. With a duration it fights in place for that long,
    // then advances, so defence can be composed (e.g. Hold(3s) → Move home).
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    // 'duration' is optional (ADR-0004): unset/0 ⇒ hold forever; >0 ⇒ hold that many seconds.
    params: [
      { id: 'duration', type: 'number', label: 'Seconds (0 = forever)', min: 0, step: 0.5 },
    ],
  },

  Retreat: {
    kind: 'Retreat',
    category: 'action',
    runner: 'unit',
    title: 'Retreat',
    // Fall back to the nearest friendly Command Center and stand beside it, dropping any combat
    // stance on the way (docs/adr/0012). Unlike Move it needs no destination Parameter — it resolves
    // one from live world state, so a single Flow shared by many Units routes each to its own base.
    // The active half of the survival reflex (pair with OnDamaged or a self_health_below Branch).
    // Completes on arrival; with no friendly Command Center it is a no-op that advances.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  Train: {
    kind: 'Train',
    category: 'action',
    runner: 'building',
    title: 'Train Unit',
    // A Building produces a Unit (docs/adr/0013): blocks until the Stockpile affords the cost,
    // deducts it, waits the build time, spawns beside the footprint, and assigns the chosen Flow
    // to the new Unit. Chainable; loop it with a back-edge to produce continuously.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    // 'unitType' picks what to build; 'assignFlow' is the Unit-Flow the product is born running.
    params: [
      { id: 'unitType', type: 'unitType', label: 'Unit' },
      { id: 'assignFlow', type: 'flowRef', label: 'Assign Flow' },
    ],
  },

  Research: {
    kind: 'Research',
    category: 'action',
    runner: 'building',
    title: 'Research Upgrade',
    // A Building unlocks an Upgrade (docs/adr/0021), mirroring Train: it blocks until the Stockpile
    // affords the Upgrade's cost, deducts it, waits the research time, then marks it unlocked
    // player-wide (retroactively buffing every matching Unit). Re-entering an already-unlocked
    // Upgrade is a no-op that advances, so "Research → Train → loop" flows past it once done.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    // 'upgradeType' picks what to research — a dropdown constrained to Upgrades targeting a Unit this
    // Building produces (docs/adr/0016), rendered like Train's 'unitType'. Cost/time live in the
    // Upgrade data table, not as Parameters (docs/adr/0013, 0021).
    params: [
      { id: 'upgradeType', type: 'upgradeType', label: 'Upgrade' },
    ],
  },

  Build: {
    kind: 'Build',
    category: 'action',
    runner: 'building',
    title: 'Build',
    // The Command Center's flagship Action (docs/adr/0018): places a Construction Site of the
    // chosen building type at a chosen Footprint, then completes — Workers (Construct) raise it.
    // Gated by the 'builder' building capability so it appears only in builder Building Flows
    // (the Command Center), not Barracks/Factory. Unlike Train, an unaffordable or blocked Build
    // is a no-op that advances rather than blocking the cursor (docs/adr/0018).
    buildingCapability: 'builder',
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    // 'buildingType' is what to place; 'destination' is the Footprint's top-left anchor Tile
    // (picked with a footprint preview); 'assignFlow' is an optional Building-Flow of the built
    // type the finished Building is born running — Train's born-with-a-Flow, for Buildings.
    params: [
      { id: 'buildingType', type: 'buildingType', label: 'Building' },
      { id: 'destination', type: 'tile', label: 'Location', pickLabel: 'Select Position…' },
      { id: 'assignFlow', type: 'buildingFlowRef', label: 'Assign Flow' },
    ],
  },

  Construct: {
    kind: 'Construct',
    category: 'action',
    runner: 'unit',
    title: 'Construct',
    // A Worker raises a nearby Construction Site (docs/adr/0018, 0017). No Parameters — it claims
    // one of the Site's ≤4 build slots within reach of where it was rallied, like Gather claims a
    // Deposit, walks beside the Footprint, and adds build work. More Workers finish a Site faster
    // (up to four). Waits in place if no Site in reach needs builders; completes when the Site
    // finishes or is destroyed. Chainable.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  Wait: {
    kind: 'Wait',
    category: 'control',
    runner: 'any',
    title: 'Wait',
    // The first Flow Control node (CONTEXT.md): holds execution for a duration, then
    // continues. Chainable like an Action — Exec in, Exec out.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
    // 'duration' is a number Parameter, in seconds (ADR-0004). Unset/0 → no wait.
    params: [
      { id: 'duration', type: 'number', label: 'Seconds', min: 0, step: 0.5 },
    ],
  },

  RoamAttack: {
    kind: 'RoamAttack',
    category: 'action',
    runner: 'unit',
    title: 'Roam and Attack',
    // Pick a random tile within sight, attack-move there engaging anything on the way, then
    // complete so the caller can loop or chain. Designed as the critter behaviour node.
    protected: true,
    ports: [
      { id: 'in',  dir: 'in',  type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  Branch: {
    kind: 'Branch',
    category: 'control',
    runner: 'any',
    title: 'Branch',
    // Routes to one of two Exec outputs by evaluating a Condition (docs/adr/0010). Evaluates
    // instantly when reached; an unset Condition is false (No). Yes/No outputs render top-down.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'yes', dir: 'out', type: 'exec', label: 'Yes' },
      { id: 'no', dir: 'out', type: 'exec', label: 'No' },
    ],
    // The Condition (+ any of its args) is stored as a Parameter. The 'condition' param type
    // renders a dropdown from the Condition catalog plus the chosen Condition's arg rows.
    params: [
      { id: 'condition', type: 'condition', label: 'Condition' },
    ],
  },
};

export function getNodeKind(kind) {
  const k = NODE_KINDS[kind];
  if (!k) throw new Error(`Unknown node kind: ${kind}`);
  return k;
}

export function getPort(kind, portId) {
  return getNodeKind(kind).ports.find((p) => p.id === portId) || null;
}

export function getParams(kind) {
  return getNodeKind(kind).params || [];
}

// Node kinds whose `runner` scope matches a Flow's targetKind: always the 'any' nodes, plus the
// Actions for that kind (docs/adr/0015). Drives the editor palette.
export function nodeKindsForRunner(targetKind) {
  return Object.values(NODE_KINDS).filter((k) => k.runner === 'any' || k.runner === targetKind);
}
