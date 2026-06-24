// The Library: the player's collection of named Flows. It is the source from which
// Flows are assigned to Units (see CONTEXT.md). Each entry pairs a display name with a
// FlowModel. A Flow is a shared definition (docs/adr/0003): a Unit's Assignment points
// at a library entry by id, so editing that Flow changes every Unit running it.
// Persisted to localStorage (see save/load below) so the player's Flows survive reloads.

import { FlowModel } from './model.js';

const STORAGE_KEY = 'flow-rts.library.v1';

let _seq = 0;
const nextId = () => `flow_${++_seq}`;

function bumpSeqFrom(ids) {
  for (const id of ids) {
    const n = parseInt(String(id).split('_').pop(), 10);
    if (Number.isFinite(n) && n > _seq) _seq = n;
  }
}

const hasStorage = typeof localStorage !== 'undefined';

export class FlowLibrary {
  constructor() {
    /** @type {Array<{id:string, name:string, model:FlowModel}>} */
    this.entries = [];
  }

  create(name, targetKind = 'unit') {
    const entry = {
      id: nextId(),
      name: name || `Flow ${this.entries.length + 1}`,
      model: new FlowModel(targetKind),
    };
    this.entries.push(entry);
    return entry;
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  rename(id, name) {
    const entry = this.get(id);
    if (entry && name.trim()) entry.name = name.trim();
    return entry;
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  list() {
    return this.entries;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  toJSON() {
    return {
      entries: this.entries.map((e) => ({
        id: e.id, name: e.name, model: e.model.toJSON(),
        ...(e.protected ? { protected: true } : {}),
      })),
    };
  }

  save() {
    if (!hasStorage) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON())); } catch { /* quota/full */ }
  }

  load() {
    if (!hasStorage) return;
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      this.entries = (data?.entries ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        model: FlowModel.fromJSON(e.model),
        ...(e.protected ? { protected: true } : {}),
      }));
      bumpSeqFrom(this.entries.map((e) => e.id));
    } catch { /* corrupt — start empty */ }
  }
}

// App-wide singleton shared by the editor (which edits a Flow) and the map (where a
// Flow is assigned to a Unit). Restored from localStorage at startup.
export const flowLibrary = new FlowLibrary();
flowLibrary.load();
