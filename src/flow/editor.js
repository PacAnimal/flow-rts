// The Flow editor: a hand-built DOM overlay (with an SVG layer for Connections) that
// sits above the Phaser canvas. It renders from the Flow currently selected in the
// Library and writes interactions back into that Flow's model. While the overlay is
// shown it covers the canvas and so captures pointer events, suppressing the map's
// camera-drag with no extra coordination. See CONTEXT.md and docs/adr/0001.

import './editor.css';
import { createStore } from './store.js';
import { getNodeKind, getParams, getPort, nodeKindsForRunner } from './nodeKinds.js';
import { CONDITIONS, getCondition } from '../conditions.js';
import { UNIT_TYPES } from '../units.js';
import { pickPosition } from './positionPicker.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class FlowEditor {
  constructor(library) {
    this.library = library;
    this.currentId = null;
    this.model = null; // the model of the currently-edited Flow
    this.visible = false;
    this.nodeEls = new Map(); // nodeId -> node element
    this.portEls = new Map(); // `${nodeId}:${portId}` -> port dot element
    this._build();
    // Reactive loop: structural edits go through commit(), which bumps this store; the
    // subscription re-renders. subscribe fires once now (model is null → _render no-ops).
    this.store = createStore({ rev: 0 });
    this.store.subscribe(() => this._render());
  }

  mount(parent = document.body) {
    parent.appendChild(this.toggleBtn);
    parent.appendChild(this.root);
    this._applyVisibility();
    return this;
  }

  toggle() { this.visible ? this.hide() : this.show(); }

  show() {
    this.visible = true;
    // Become visible BEFORE rendering: wire endpoints are measured with
    // getBoundingClientRect, which returns zeros while the editor is display:none —
    // that left restored Connections drawn as degenerate (0,0)→(0,0) paths after reload.
    this._applyVisibility();
    // Ensure there's a Flow to edit.
    if (!this.library.list().length) { this.library.create(); this.library.save(); }
    if (!this.currentId || !this.library.get(this.currentId)) {
      this.setFlow(this.library.list()[0].id);
    } else {
      this._render(); // re-measure now that we're visible (getBoundingClientRect needs layout)
    }
  }

  hide() { this._closeNodeMenu(); this.visible = false; this._applyVisibility(); }

  _applyVisibility() {
    this.root.classList.toggle('hidden', !this.visible);
    this.toggleBtn.classList.toggle('active', this.visible);
    // Suppress map input while the overlay is open. Covering the canvas isn't enough on its own:
    // Phaser also listens on `window` (input.windowEvents), so clicks on the overlay still bubble
    // up and hit-test Units/Buildings behind it. The scene flips this.input.enabled on this event.
    window.dispatchEvent(new CustomEvent('flow-editor-visibility', { detail: { open: this.visible } }));
  }

  // ── DOM scaffolding ────────────────────────────────────────────────────────

  _build() {
    this.toggleBtn = el('button', 'flow-toggle', 'Flow');
    this.toggleBtn.addEventListener('click', () => this.toggle());

    this.root = el('div', 'flow-editor hidden');

    // Library column — the collection of named Flows.
    const libPanel = el('div', 'flow-library');
    const libHead = el('div', 'lib-head');
    libHead.appendChild(el('h2', null, 'Flow Library'));
    // A Flow is typed by Runner kind (docs/adr/0015) — create one or the other explicitly.
    const newUnit = el('button', 'lib-new', '+ Unit');
    newUnit.addEventListener('click', () => this._newFlow('unit'));
    libHead.appendChild(newUnit);
    const newBuilding = el('button', 'lib-new', '+ Building');
    newBuilding.addEventListener('click', () => this._newFlow('building'));
    libHead.appendChild(newBuilding);
    libPanel.appendChild(libHead);
    this.libList = el('div', 'lib-list');
    libPanel.appendChild(this.libList);
    libPanel.appendChild(el('p', 'palette-hint', 'Double-click a name to rename.'));

    // Palette — node kinds to drag onto the canvas. Filtered to the edited Flow's Runner kind
    // (docs/adr/0015), so it is rebuilt by _renderPalette whenever the Flow changes.
    const palette = el('div', 'flow-palette');
    palette.appendChild(el('h2', null, 'Nodes'));
    this.paletteList = el('div', 'palette-list');
    palette.appendChild(this.paletteList);
    palette.appendChild(el('p', 'palette-hint', 'Drag a node onto the canvas. Drag port → port to connect.'));

    // Canvas + wire layer
    this.canvasEl = el('div', 'flow-canvas');
    this.flowName = el('div', 'flow-name');
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('flow-wires');
    this.wireGroup = document.createElementNS(SVG_NS, 'g');
    this.tempPath = document.createElementNS(SVG_NS, 'path');
    this.tempPath.classList.add('wire', 'wire-temp');
    this.svg.appendChild(this.wireGroup);
    this.svg.appendChild(this.tempPath);
    this.canvasEl.appendChild(this.svg);
    this.canvasEl.appendChild(this.flowName);

    this.root.appendChild(libPanel);
    this.root.appendChild(palette);
    this.root.appendChild(this.canvasEl);
  }

  // ── library ──────────────────────────────────────────────────────────────

  _newFlow(targetKind = 'unit') {
    const entry = this.library.create(undefined, targetKind);
    this.library.save();
    this.setFlow(entry.id);
    this._renderLibrary();
  }

  // Rebuild the palette to show only the nodes valid for the current Flow's Runner kind.
  _renderPalette() {
    if (!this.paletteList) return;
    this.paletteList.replaceChildren();
    const targetKind = (this.model && this.model.targetKind) || 'unit';
    for (const k of nodeKindsForRunner(targetKind)) {
      const item = el('div', `palette-item category-${k.category}`);
      item.appendChild(el('span', 'palette-title', k.title));
      item.appendChild(el('span', 'palette-tag', k.category));
      item.addEventListener('pointerdown', (e) => this._startPaletteDrag(e, k.kind));
      this.paletteList.appendChild(item);
    }
  }

  _renderLibrary() {
    this.libList.replaceChildren();
    for (const entry of this.library.list()) {
      const row = el('div', 'lib-item');
      if (entry.id === this.currentId) row.classList.add('active');
      const name = el('span', 'lib-name', entry.name);
      name.title = 'Double-click to rename';
      name.addEventListener('dblclick', () => this._renameFlow(entry.id, name));
      row.appendChild(name);
      row.appendChild(el('span', `lib-kind kind-${entry.model.targetKind}`, entry.model.targetKind));
      if (entry.protected) row.appendChild(el('span', 'lib-protected', 'Protected'));
      const count = entry.model.nodes.length;
      row.appendChild(el('span', 'lib-count', `${count} node${count === 1 ? '' : 's'}`));
      row.addEventListener('click', () => { if (entry.id !== this.currentId) this.setFlow(entry.id); });
      this.libList.appendChild(row);
    }
  }

  _renameFlow(id, nameEl) {
    const entry = this.library.get(id);
    const input = el('input', 'lib-rename');
    input.value = entry.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      this.library.rename(id, input.value);
      this.library.save();
      this._renderLibrary();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = entry.name; input.blur(); }
    });
  }

  // Switch which Flow the canvas edits: clear the canvas DOM and rebuild from the model.
  setFlow(id) {
    const entry = this.library.get(id);
    if (!entry) return;
    this.currentId = id;
    this.model = entry.model;
    this.flowName.textContent = `${entry.name}  ·  ${entry.model.targetKind} flow`;
    this._renderPalette();
    this._render();
  }

  // The single mutation path: apply a change to the model, persist it, then bump the store
  // so the subscription re-renders. Structural edits should go through here only — routing
  // every change through one place means no handler can forget to save or to re-render.
  commit(mutator) {
    mutator(this.model);
    this.library.save();
    this.store.update((s) => ({ rev: s.rev + 1 }));
  }

  // Idempotent render: reconcile the canvas DOM against the model, keyed by node id. Existing
  // nodes stay put (only their position is synced), vanished nodes are torn down, new ones are
  // built. Cheap to call after any change, so it is the only render path.
  _render() {
    if (!this.model) return;
    const present = new Set(this.model.nodes.map((n) => n.id));
    for (const [id, nodeEl] of this.nodeEls) {
      if (present.has(id)) continue;
      nodeEl.remove();
      this.nodeEls.delete(id);
      for (const key of [...this.portEls.keys()]) {
        if (key.startsWith(`${id}:`)) this.portEls.delete(key);
      }
    }
    for (const node of this.model.nodes) {
      let nodeEl = this.nodeEls.get(node.id);
      if (!nodeEl) nodeEl = this._addNodeEl(node);
      nodeEl.style.transform = `translate(${node.x}px, ${node.y}px)`;
    }
    this._renderWires();
    this._renderLibrary();
  }

  // ── geometry helpers ─────────────────────────────────────────────────────

  _canvasPoint(clientX, clientY) {
    const r = this.canvasEl.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  _portCenter(nodeId, portId) {
    const dot = this.portEls.get(`${nodeId}:${portId}`);
    if (!dot) return { x: 0, y: 0 };
    const r = dot.getBoundingClientRect();
    const c = this.canvasEl.getBoundingClientRect();
    return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
  }

  // ── nodes ──────────────────────────────────────────────────────────────────

  _addNodeEl(node) {
    const kind = getNodeKind(node.kind);
    const nodeEl = el('div', `flow-node category-${kind.category}`);
    nodeEl.style.transform = `translate(${node.x}px, ${node.y}px)`;

    const header = el('div', 'node-header');
    header.appendChild(el('span', 'node-title', kind.title));
    const del = el('button', 'node-delete', '✕');
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => { e.stopPropagation(); this._removeNode(node.id); });
    header.appendChild(del);
    header.addEventListener('pointerdown', (e) => this._startNodeDrag(e, node.id));
    nodeEl.appendChild(header);

    const body = el('div', 'node-body');
    const inputs = el('div', 'port-col port-col-in');
    const outputs = el('div', 'port-col port-col-out');
    for (const p of kind.ports) {
      const row = el('div', `port-row port-${p.dir}`);
      const dot = el('div', `port port-${p.type} port-${p.dir}`);
      dot.dataset.node = node.id;
      dot.dataset.port = p.id;
      dot.dataset.dir = p.dir;
      dot.dataset.type = p.type;
      dot.addEventListener('pointerdown', (e) => this._startWireDrag(e, node.id, p.id, p.dir));
      if (p.dir === 'in') { row.appendChild(dot); if (p.label) row.appendChild(el('span', 'port-label', p.label)); inputs.appendChild(row); }
      else { if (p.label) row.appendChild(el('span', 'port-label', p.label)); row.appendChild(dot); outputs.appendChild(row); }
      this.portEls.set(`${node.id}:${p.id}`, dot);
    }
    body.appendChild(inputs);
    body.appendChild(outputs);
    nodeEl.appendChild(body);

    const params = getParams(node.kind);
    if (params.length) {
      const section = el('div', 'node-params');
      for (const param of params) section.appendChild(this._buildParamRow(node, param));
      nodeEl.appendChild(section);
    }

    this.canvasEl.appendChild(nodeEl);
    this.nodeEls.set(node.id, nodeEl);
    return nodeEl;
  }

  // A Parameter row: a label plus an editor chosen by the param's type (ADR-0004). A 'tile'
  // opens the in-world picker; a 'number' is edited inline. Either may be unset.
  _buildParamRow(node, param) {
    if (param.type === 'condition') return this._conditionParam(node, param);
    if (param.type === 'unitType')
      return this._selectParam(node, param, Object.values(UNIT_TYPES).map((u) => ({ value: u.id, label: u.label })));
    if (param.type === 'flowRef')
      return this._selectParam(node, param, this._unitFlowOptions());
    const row = el('div', 'param-row');
    row.appendChild(el('span', 'param-label', param.label));
    row.appendChild(
      param.type === 'number' ? this._numberInput(node, param) : this._tileButton(node, param),
    );
    return row;
  }

  // Library Flows that can be assigned to a produced Unit (Unit-Flows) — for Train's 'assignFlow'.
  _unitFlowOptions() {
    return this.library.list()
      .filter((e) => (e.model.targetKind || 'unit') === 'unit')
      .map((e) => ({ value: e.id, label: e.name }));
  }

  // A generic dropdown Parameter: stores the chosen option's value in node.params (ADR-0004).
  // Used by 'unitType' (what to build) and 'flowRef' (the Flow a Train assigns to its product).
  _selectParam(node, param, options) {
    const row = el('div', 'param-row');
    row.appendChild(el('span', 'param-label', param.label));
    const select = el('select', 'param-select');
    select.appendChild(el('option', null, '—')).value = '';
    for (const o of options) select.appendChild(el('option', null, o.label)).value = o.value;
    select.value = (node.params && node.params[param.id]) || '';
    select.addEventListener('pointerdown', (e) => e.stopPropagation());
    select.addEventListener('change', () =>
      this.commit((m) => m.setParam(node.id, param.id, select.value || null)),
    );
    row.appendChild(select);
    return row;
  }

  // A 'condition' Parameter (docs/adr/0010): a dropdown of Conditions plus the chosen Condition's
  // argument rows, re-rendered when the Condition changes. Args are stored flat in node.params.
  _conditionParam(node, param) {
    const wrap = el('div', 'param-condition');

    const row = el('div', 'param-row');
    row.appendChild(el('span', 'param-label', param.label));
    const select = el('select', 'param-select');
    select.appendChild(el('option', null, '—')).value = '';
    for (const cond of Object.values(CONDITIONS)) {
      select.appendChild(el('option', null, cond.label)).value = cond.id;
    }
    select.value = (node.params && node.params.condition) || '';
    select.addEventListener('pointerdown', (e) => e.stopPropagation());

    const argsBox = el('div', 'param-args');
    const renderArgs = () => {
      argsBox.replaceChildren();
      const cond = getCondition((node.params && node.params.condition) || '');
      if (cond) for (const arg of cond.args) argsBox.appendChild(this._buildParamRow(node, arg));
    };

    select.addEventListener('change', () => {
      this.commit(() => this._setCondition(node, select.value || null));
      renderArgs();
    });

    row.appendChild(select);
    wrap.appendChild(row);
    wrap.appendChild(argsBox);
    renderArgs();
    return wrap;
  }

  // Set a Branch's Condition, dropping any argument Parameters that don't belong to the new one
  // so node.params stays clean across Condition switches.
  _setCondition(node, id) {
    const keep = id && getCondition(id) ? getCondition(id).args.map((a) => a.id) : [];
    for (const cond of Object.values(CONDITIONS))
      for (const arg of cond.args)
        if (!keep.includes(arg.id)) this.model.setParam(node.id, arg.id, null);
    this.model.setParam(node.id, 'condition', id);
  }

  // A 'tile' Parameter: a button showing the current value that opens the position picker.
  _tileButton(node, param) {
    const btn = el('button', 'param-pick');
    const render = () => {
      const value = node.params && node.params[param.id];
      btn.textContent = paramText(param, value);
      btn.classList.toggle('set', value != null);
    };
    render();
    // Don't let the press start a node-drag.
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._pickTile(node, param, render);
    });
    return btn;
  }

  // A 'number' Parameter: an inline numeric input. Empty clears it (unset); a valid number is
  // stored via setParam (which drops null), persisted on change/blur.
  _numberInput(node, param) {
    const input = el('input', 'param-input');
    input.type = 'number';
    if (param.min != null) input.min = param.min;
    if (param.step != null) input.step = param.step;
    const current = node.params && node.params[param.id];
    input.value = current == null ? '' : current;
    input.placeholder = param.pickLabel || '—';
    // Don't let pointer/keys on the input start a node-drag or trigger editor shortcuts.
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const persist = () => {
      const raw = input.value.trim();
      const num = raw === '' ? null : Number(raw);
      this.commit((m) => m.setParam(node.id, param.id, Number.isFinite(num) ? num : null));
    };
    input.addEventListener('change', persist);
    return input;
  }

  _pickTile(node, param, render) {
    this.hide();
    this.toggleBtn.style.display = 'none'; // don't let the Flow toggle reopen mid-pick
    const reopen = () => { this.toggleBtn.style.display = ''; this.show(); };
    pickPosition({
      current: (node.params && node.params[param.id]) || null,
      prompt: `Click a tile to set ${param.label} — Esc to cancel`,
      onPicked: (tile) => {
        this.commit((m) => m.setParam(node.id, param.id, tile));
        render();
        reopen();
      },
      onCancel: reopen,
    });
  }

  _removeNode(id) {
    this.commit((m) => m.removeNode(id));
  }

  // ── wires ────────────────────────────────────────────────────────────────

  _renderWires() {
    this.wireGroup.replaceChildren();
    for (const c of this.model.connections) {
      const a = this._portCenter(c.from.node, c.from.port);
      const b = this._portCenter(c.to.node, c.to.port);
      const d = wirePath(a, b);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.classList.add('wire');
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', d);
      hit.classList.add('wire-hit');
      hit.addEventListener('click', () => this.commit((m) => m.disconnect(c.id)));
      // hit path first so the `.wire-hit:hover + .wire` highlight works.
      this.wireGroup.appendChild(hit);
      this.wireGroup.appendChild(path);
    }
  }

  // ── interactions ───────────────────────────────────────────────────────────

  _startPaletteDrag(e, kind) {
    e.preventDefault();
    const ghost = el('div', `flow-node category-${getNodeKind(kind).category} flow-ghost`);
    ghost.appendChild(el('div', 'node-header', getNodeKind(kind).title));
    document.body.appendChild(ghost);
    const place = (ev) => {
      ghost.style.left = `${ev.clientX - 60}px`;
      ghost.style.top = `${ev.clientY - 14}px`;
    };
    place(e);
    const move = (ev) => place(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      const c = this.canvasEl.getBoundingClientRect();
      const inside = ev.clientX >= c.left && ev.clientX <= c.right && ev.clientY >= c.top && ev.clientY <= c.bottom;
      if (!inside || !this.model) return;
      const p = this._canvasPoint(ev.clientX, ev.clientY);
      this.commit((m) => m.addNode(kind, p.x - 60, p.y - 14));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _startNodeDrag(e, nodeId) {
    e.preventDefault();
    const node = this.model.getNode(nodeId);
    const start = this._canvasPoint(e.clientX, e.clientY);
    const origin = { dx: start.x - node.x, dy: start.y - node.y };
    const nodeEl = this.nodeEls.get(nodeId);
    nodeEl.classList.add('dragging');
    const move = (ev) => {
      const p = this._canvasPoint(ev.clientX, ev.clientY);
      const x = p.x - origin.dx;
      const y = p.y - origin.dy;
      this.model.moveNode(nodeId, x, y);
      nodeEl.style.transform = `translate(${x}px, ${y}px)`;
      this._renderWires();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      nodeEl.classList.remove('dragging');
      // The drag mutated the model live for smoothness; commit just persists + reconciles.
      this.commit(() => {});
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  _startWireDrag(e, nodeId, portId, dir) {
    e.preventDefault();
    e.stopPropagation();
    const source = { node: nodeId, port: portId, dir };
    const sourceCenter = this._portCenter(nodeId, portId);
    this.tempPath.classList.add('active');
    const move = (ev) => {
      const p = this._canvasPoint(ev.clientX, ev.clientY);
      this.tempPath.setAttribute('d', wirePath(sourceCenter, p));
    };
    move(e);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.tempPath.classList.remove('active');
      this.tempPath.removeAttribute('d');
      const target = portUnder(ev.clientX, ev.clientY);
      if (!target) {
        // Released on the empty Canvas. Dragging from an Exec output offers the node menu:
        // create-and-connect, splicing into any existing downstream wire. Inputs don't trigger it.
        const sourcePort = getPort(this.model.getNode(source.node)?.kind, source.port);
        if (source.dir === 'out' && sourcePort?.type === 'exec' && this._isInsideCanvas(ev.clientX, ev.clientY)) {
          this._openNodeMenu(ev.clientX, ev.clientY, this._canvasPoint(ev.clientX, ev.clientY), source, this._downstreamOf(source));
        }
        return;
      }
      const out = source.dir === 'out' ? source : target.dir === 'out' ? target : null;
      const inn = source.dir === 'in' ? source : target.dir === 'in' ? target : null;
      if (!out || !inn) return;
      // connect() returns null for an invalid pairing — committing then is a harmless no-op.
      this.commit((m) =>
        m.connect({ node: out.node, port: out.port }, { node: inn.node, port: inn.port }),
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ── node menu (drag an Exec output onto empty Canvas) ───────────────────────

  _isInsideCanvas(clientX, clientY) {
    const c = this.canvasEl.getBoundingClientRect();
    return clientX >= c.left && clientX <= c.right && clientY >= c.top && clientY <= c.bottom;
  }

  // The node an Exec output currently feeds, if any (out=1, so at most one). Captured before a
  // splice rewires the output, so the new node can re-attach the tail to the same input port.
  _downstreamOf(source) {
    const c = this.model.connections.find(
      (x) => x.from.node === source.node && x.from.port === source.port,
    );
    return c ? { node: c.to.node, port: c.to.port } : null;
  }

  // Popup of node kinds valid for this Flow that can receive an Exec connection. Picking one
  // creates it at the drop point and splices it after `source` (see _spliceNode). Typeahead
  // filter is auto-focused; Enter picks a sole match; Esc / click-outside cancels.
  _openNodeMenu(clientX, clientY, drop, source, downstream) {
    this._closeNodeMenu();
    const menu = el('div', 'flow-node-menu');
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const filter = el('input', 'node-menu-filter');
    filter.type = 'text';
    filter.placeholder = 'Add node…';
    menu.appendChild(filter);

    const list = el('div', 'node-menu-list');
    menu.appendChild(list);

    // Only kinds that can receive the Exec connection — i.e. have an Exec input (excludes Events).
    const kinds = nodeKindsForRunner(this.model.targetKind).filter((k) => firstExecPort(k, 'in'));
    const pick = (kind) => { this._spliceNode(kind, drop, source, downstream); this._closeNodeMenu(); };
    const items = kinds.map((k) => {
      const item = el('div', `palette-item node-menu-item category-${k.category}`);
      item.appendChild(el('span', 'palette-title', k.title));
      item.appendChild(el('span', 'palette-tag', k.category));
      item.addEventListener('click', () => pick(k.kind));
      list.appendChild(item);
      return { k, item };
    });

    const applyFilter = () => {
      const q = filter.value.trim().toLowerCase();
      for (const { k, item } of items) item.style.display = !q || k.title.toLowerCase().includes(q) ? '' : 'none';
    };
    filter.addEventListener('input', applyFilter);
    filter.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep typing local to the menu
      if (e.key === 'Escape') { this._closeNodeMenu(); return; }
      if (e.key === 'Enter') {
        const shown = items.filter(({ item }) => item.style.display !== 'none');
        if (shown.length === 1) pick(shown[0].k.kind);
      }
    });

    const onDocPointerDown = (e) => { if (!menu.contains(e.target)) this._closeNodeMenu(); };
    this._nodeMenu = { el: menu, onDocPointerDown };
    document.body.appendChild(menu);
    // Clamp into the viewport now that it has a measured size.
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    document.addEventListener('pointerdown', onDocPointerDown);
    filter.focus();
  }

  _closeNodeMenu() {
    if (!this._nodeMenu) return;
    document.removeEventListener('pointerdown', this._nodeMenu.onDocPointerDown);
    this._nodeMenu.el.remove();
    this._nodeMenu = null;
  }

  // Create `kind` at the drop point and wire it after `source` in one commit. Connecting the
  // source's Exec output replaces its old wire (out=1); if that wire had a `downstream` target
  // and the new node has an Exec output, re-attach the tail so the node is spliced into the chain.
  _spliceNode(kind, drop, source, downstream) {
    this.commit((m) => {
      const node = m.addNode(kind, drop.x - 60, drop.y - 14);
      const inPort = firstExecPort(getNodeKind(kind), 'in');
      if (inPort) m.connect({ node: source.node, port: source.port }, { node: node.id, port: inPort.id });
      const outPort = firstExecPort(getNodeKind(kind), 'out');
      if (downstream && outPort) {
        m.connect({ node: node.id, port: outPort.id }, { node: downstream.node, port: downstream.port });
      }
    });
  }
}

// ── small helpers ──────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function paramText(param, value) {
  if (value == null) return param.pickLabel || 'Set…';
  if (param.type === 'tile') return `(${value.x}, ${value.y})`;
  return String(value);
}

function wirePath(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function firstExecPort(kindDef, dir) {
  return kindDef.ports.find((p) => p.dir === dir && p.type === 'exec') || null;
}

function portUnder(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  const dot = target && target.closest('.port');
  if (!dot) return null;
  return { node: dot.dataset.node, port: dot.dataset.port, dir: dot.dataset.dir };
}
