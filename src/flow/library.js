// The Library: the player's collection of named Flows. It is the source from which
// Flows are assigned to Units (see CONTEXT.md). Each entry pairs a display name with a
// FlowModel. A Flow is a shared definition (docs/adr/0003): a Unit's Assignment points
// at a library entry by id, so editing that Flow changes every Unit running it.
// In-memory only for now, but the shape is JSON-ready for later persistence.

import { FlowModel } from './model.js';

let _seq = 0;
const nextId = () => `flow_${++_seq}`;

export class FlowLibrary {
  constructor() {
    /** @type {Array<{id:string, name:string, model:FlowModel}>} */
    this.entries = [];
  }

  create(name) {
    const entry = {
      id: nextId(),
      name: name || `Flow ${this.entries.length + 1}`,
      model: new FlowModel(),
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
}

// App-wide singleton shared by the editor (which edits a Flow) and the map (where a
// Flow is assigned to a Unit).
export const flowLibrary = new FlowLibrary();
