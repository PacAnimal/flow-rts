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
    /** @type {Array<{id:string, name:string, model:FlowModel, category?:string}>} */
    this.entries = [];
    // Which version of the starter Flows this Library was seeded with (src/flow/templates.js), or
    // null for never. Stored with the Library rather than inferred from it being empty: a player
    // who deletes every starter has made a decision, and re-seeding would undo it on reload.
    this.seeded = null;
    // The player's Markers (CONTEXT.md, docs/adr/0024): named Tiles a Move / Attack-Move resolves by
    // name. Kept here, beside the Flows that reference them, because a Flow saying `Move → "front"`
    // is useless if `front` evaporates on reload. Each record is `{ name, x, y, flowId? }`: where the
    // player last put it by hand, and the Marker-Flow it is assigned. A Marker's Run, and wherever
    // its own Flow has since moved it, are world state in MapScene and are never saved.
    /** @type {Array<{name:string, x:number, y:number, flowId?:string|null}>} */
    this.markers = [];
  }

  create(name, targetKind = 'unit', buildingType = null) {
    const entry = {
      id: nextId(),
      name: name || `Flow ${this.entries.length + 1}`,
      model: new FlowModel(targetKind, buildingType),
    };
    this.entries.push(entry);
    return entry;
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  // Duplicate a Flow into a new, independent Library entry placed right after its source.
  // The copy is never Protected even when the original is, so cloning a Protected Flow is the
  // way to get an editable variant of it. Returns the new entry, or null if `id` is unknown.
  clone(id) {
    const src = this.get(id);
    if (!src) return null;
    // A clone is a variant in the same bucket, so it inherits the source's Category (CONTEXT.md).
    const entry = { id: nextId(), name: `${src.name} copy`, model: src.model.clone() };
    if (src.category) entry.category = src.category;
    this.entries.splice(this.entries.indexOf(src) + 1, 0, entry);
    return entry;
  }

  rename(id, name) {
    const entry = this.get(id);
    if (entry && name.trim()) entry.name = name.trim();
    return entry;
  }

  // Set (or clear) a Flow's Category. Categories are freeform and single-membership (CONTEXT.md):
  // a blank name clears it, leaving the Flow Uncategorized. There is no Category roster — the set
  // of Categories is whatever names are in use, so naming a new one here creates it and a Category
  // ceases to exist once its last Flow drops it.
  setCategory(id, category) {
    const entry = this.get(id);
    if (!entry) return null;
    const name = (category || '').trim();
    if (name) entry.category = name;
    else delete entry.category;
    return entry;
  }

  // The distinct Categories currently in use across Flows, sorted — the suggestion set offered
  // when labelling a Flow. Derived on demand (no stored roster), so it never lists empty Categories.
  categories() {
    const set = new Set();
    for (const e of this.entries) if (e.category) set.add(e.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  // ── Markers (docs/adr/0024) ────────────────────────────────────────────────
  // A Marker's name is its identity — a Move references it by name, like a Signal — so names are
  // unique (case-sensitive, trimmed). There is no rename: renaming would silently re-point or orphan
  // every Flow that names it, so the honest gesture is delete-and-place, which the player sees.

  getMarker(name) {
    return this.markers.find((m) => m.name === name) || null;
  }

  // Add a Marker at a Tile. Returns the record, or null for a blank or already-used name.
  addMarker(name, x, y) {
    const n = (name || '').trim();
    if (!n || this.getMarker(n)) return null;
    const marker = { name: n, x, y, flowId: null };
    this.markers.push(marker);
    return marker;
  }

  removeMarker(name) {
    this.markers = this.markers.filter((m) => m.name !== name);
  }

  // The names a markerName Parameter can suggest: every placed Marker, plus any name a Flow already
  // references but no Marker answers to (so a Flow authored before its Marker still converges on
  // one spelling). Sorted, like categories().
  markerNames() {
    const set = new Set(this.markers.map((m) => m.name));
    for (const e of this.entries)
      for (const n of e.model.nodes)
        if (n.params?.marker) set.add(n.params.marker);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  list() {
    return this.entries;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  toJSON() {
    return {
      ...(this.seeded ? { seeded: this.seeded } : {}),
      markers: this.markers.map((m) => ({ name: m.name, x: m.x, y: m.y, flowId: m.flowId ?? null })),
      entries: this.entries.map((e) => ({
        id: e.id, name: e.name, model: e.model.toJSON(),
        ...(e.protected ? { protected: true } : {}),
        ...(e.category ? { category: e.category } : {}),
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
      // A Library saved before the starters existed has no `seeded` stamp, so it reads back as
      // null and gets them on this load — the intended upgrade path.
      this.seeded = data?.seeded ?? null;
      // No version bump for Categories (CONTEXT.md): a legacy v1 entry simply lacks `category`
      // and reads back as Uncategorized.
      this.entries = (data?.entries ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        model: FlowModel.fromJSON(e.model),
        ...(e.protected ? { protected: true } : {}),
        ...(e.category ? { category: e.category } : {}),
      }));
      bumpSeqFrom(this.entries.map((e) => e.id));
      this.markers = (data?.markers ?? [])
        .filter((m) => m && m.name && Number.isFinite(m.x) && Number.isFinite(m.y))
        .map((m) => ({ name: m.name, x: m.x, y: m.y, flowId: m.flowId ?? null }));
      // Player Unit Flows no longer take a literal Tile on Move / Attack-Move — they name a Marker
      // (docs/adr/0024). A Flow saved before that still carries a picked `destination`, which the
      // editor can no longer show; left in place it would keep steering Units invisibly, so it is
      // dropped here and the node reads as unset (⚠) until a Marker is chosen. Only the Library is
      // migrated: level-authored Enemy Flows (src/scenario.js) never pass through here and keep
      // their injected Tiles.
      for (const e of this.entries)
        for (const n of e.model.nodes)
          if ((n.kind === 'Move' || n.kind === 'AttackMove') && n.params && 'destination' in n.params)
            delete n.params.destination;
    } catch { /* corrupt — start empty */ }
  }
}

// App-wide singleton shared by the editor (which edits a Flow) and the map (where a
// Flow is assigned to a Unit). Restored from localStorage at startup.
export const flowLibrary = new FlowLibrary();
flowLibrary.load();
