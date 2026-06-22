// The Flow model: a plain, serializable description of one Flow's nodes and
// connections. This is the single source of truth — the editor DOM renders from it.
// Shape is JSON-ready so save/load and (later) execution drop in trivially.
// See CONTEXT.md and docs/adr/0001.

import { getNodeKind, getPort } from './nodeKinds.js';

let _seq = 0;
const nextId = (prefix) => `${prefix}_${++_seq}`;

// After restoring ids like `node_7` / `conn_3`, advance the counter past the highest
// numeric suffix so freshly-created nodes/connections never collide with restored ones.
function bumpSeqFrom(ids) {
  for (const id of ids) {
    const n = parseInt(String(id).split('_').pop(), 10);
    if (Number.isFinite(n) && n > _seq) _seq = n;
  }
}

export class FlowModel {
  constructor() {
    /** @type {Array<{id:string, kind:string, x:number, y:number}>} */
    this.nodes = [];
    /** @type {Array<{id:string, from:{node:string,port:string}, to:{node:string,port:string}}>} */
    this.connections = [];
  }

  addNode(kind, x, y) {
    getNodeKind(kind); // validates the kind exists
    // `params` holds this node's configured Parameter literals, keyed by param id (ADR-0004).
    const node = { id: nextId('node'), kind, x: Math.round(x), y: Math.round(y), params: {} };
    this.nodes.push(node);
    return node;
  }

  setParam(nodeId, paramId, value) {
    const node = this.getNode(nodeId);
    if (!node) return;
    if (!node.params) node.params = {};
    if (value == null) delete node.params[paramId];
    else node.params[paramId] = value;
  }

  getNode(id) {
    return this.nodes.find((n) => n.id === id) || null;
  }

  moveNode(id, x, y) {
    const node = this.getNode(id);
    if (node) {
      node.x = Math.round(x);
      node.y = Math.round(y);
    }
  }

  removeNode(id) {
    this.nodes = this.nodes.filter((n) => n.id !== id);
    this.connections = this.connections.filter(
      (c) => c.from.node !== id && c.to.node !== id,
    );
  }

  // Why a connection is or isn't allowed. Returns null if valid, else a reason string.
  // Rules: exec→exec only, output→input only, no self-connection, no duplicates.
  connectionError(from, to) {
    if (from.node === to.node) return 'A node cannot connect to itself.';
    const fromPort = getPort(this.getNode(from.node)?.kind, from.port);
    const toPort = getPort(this.getNode(to.node)?.kind, to.port);
    if (!fromPort || !toPort) return 'Unknown port.';
    if (fromPort.dir !== 'out' || toPort.dir !== 'in')
      return 'Connect an output port to an input port.';
    if (fromPort.type !== toPort.type)
      return `Cannot connect ${fromPort.type} to ${toPort.type}.`;
    const dup = this.connections.some(
      (c) =>
        c.from.node === from.node && c.from.port === from.port &&
        c.to.node === to.node && c.to.port === to.port,
    );
    if (dup) return 'That connection already exists.';
    return null;
  }

  // Create an Exec connection. Enforces cardinality: an exec OUTPUT holds at most one
  // connection (re-connecting replaces the old one); an exec INPUT accepts many.
  // Returns the new connection, or null if invalid.
  connect(from, to) {
    if (this.connectionError(from, to)) return null;
    // out=1: drop any existing connection leaving this output port.
    this.connections = this.connections.filter(
      (c) => !(c.from.node === from.node && c.from.port === from.port),
    );
    const conn = { id: nextId('conn'), from: { ...from }, to: { ...to } };
    this.connections.push(conn);
    return conn;
  }

  disconnect(id) {
    this.connections = this.connections.filter((c) => c.id !== id);
  }

  toJSON() {
    return {
      nodes: this.nodes.map((n) => ({ ...n })),
      connections: this.connections.map((c) => ({
        id: c.id,
        from: { ...c.from },
        to: { ...c.to },
      })),
    };
  }

  static fromJSON(data) {
    const m = new FlowModel();
    m.nodes = (data?.nodes ?? []).map((n) => ({
      id: n.id, kind: n.kind, x: n.x, y: n.y,
      params: n.params ? { ...n.params } : {},
    }));
    m.connections = (data?.connections ?? []).map((c) => ({
      id: c.id,
      from: { node: c.from.node, port: c.from.port },
      to: { node: c.to.node, port: c.to.port },
    }));
    bumpSeqFrom([
      ...m.nodes.map((n) => n.id),
      ...m.connections.map((c) => c.id),
    ]);
    return m;
  }
}
