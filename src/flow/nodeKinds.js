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
    // 'destination' Data port reserved in ADR-0002.
    params: [
      { id: 'destination', type: 'tile', label: 'Destination', pickLabel: 'Select Position…' },
    ],
  },

  Gather: {
    kind: 'Gather',
    category: 'action',
    runner: 'unit',
    title: 'Gather Resources',
    // Beside a Deposit, the Worker stands for the Resource's gather time, then takes its yield
    // into Cargo (docs/adr/0008). No Parameters — it gathers from whatever adjacent Deposit it
    // finds; if none is adjacent it is a no-op. Chainable like any Action.
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
