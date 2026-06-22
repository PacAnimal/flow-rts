// Schema/descriptor for each Node kind. A descriptor declares the node's category,
// display title, and its Ports. Ports carry a `type` ('exec' | 'data') and a `dir`
// ('in' | 'out'); only 'exec' ports are used today, but the schema is shaped so a
// kind can declare 'data' ports later without touching the model or editor.
// See CONTEXT.md and docs/adr/0002.

export const NODE_KINDS = {
  OnStart: {
    kind: 'OnStart',
    category: 'event',
    title: 'On Start',
    // Fires once per Unit when its Flow begins running (see CONTEXT.md). Entry point:
    // an Event has an Exec output and no Exec input.
    ports: [
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  Move: {
    kind: 'Move',
    category: 'action',
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
    title: 'Deliver Resources',
    // Beside a Command Center, the Worker hands its Cargo to the player's Stockpile and empties
    // its Cargo (docs/adr/0008). No Parameters; if not beside a Command Center (or carrying
    // nothing) it is a no-op. Chainable like any Action.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
    ],
  },

  Wait: {
    kind: 'Wait',
    category: 'control',
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
