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
    // A 'destination' data input will be added here later (ADR-0002) — not yet.
    ports: [
      { id: 'in', dir: 'in', type: 'exec', label: '' },
      { id: 'out', dir: 'out', type: 'exec', label: '' },
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
