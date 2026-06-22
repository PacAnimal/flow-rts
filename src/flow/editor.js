// The Flow editor: a hand-built DOM overlay (with an SVG layer for Connections) that
// sits above the Phaser canvas. It renders from the Flow currently selected in the
// Library and writes interactions back into that Flow's model. While the overlay is
// shown it covers the canvas and so captures pointer events, suppressing the map's
// camera-drag with no extra coordination. See CONTEXT.md and docs/adr/0001.

import './editor.css';
import { NODE_KINDS, getNodeKind, getParams } from './nodeKinds.js';
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
      this._renderWires(); // re-measure in case the last render happened while hidden
    }
    this._renderLibrary();
  }

  hide() { this.visible = false; this._applyVisibility(); }

  _applyVisibility() {
    this.root.classList.toggle('hidden', !this.visible);
    this.toggleBtn.classList.toggle('active', this.visible);
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
    const newBtn = el('button', 'lib-new', '+ New Flow');
    newBtn.addEventListener('click', () => this._newFlow());
    libHead.appendChild(newBtn);
    libPanel.appendChild(libHead);
    this.libList = el('div', 'lib-list');
    libPanel.appendChild(this.libList);
    libPanel.appendChild(el('p', 'palette-hint', 'Double-click a name to rename.'));

    // Palette — node kinds to drag onto the canvas.
    const palette = el('div', 'flow-palette');
    palette.appendChild(el('h2', null, 'Nodes'));
    for (const k of Object.values(NODE_KINDS)) {
      const item = el('div', `palette-item category-${k.category}`);
      item.appendChild(el('span', 'palette-title', k.title));
      item.appendChild(el('span', 'palette-tag', k.category));
      item.addEventListener('pointerdown', (e) => this._startPaletteDrag(e, k.kind));
      palette.appendChild(item);
    }
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

  _newFlow() {
    const entry = this.library.create();
    this.library.save();
    this.setFlow(entry.id);
    this._renderLibrary();
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
    this.flowName.textContent = entry.name;
    this._renderAll();
    this._renderLibrary();
  }

  _renderAll() {
    for (const nodeEl of this.nodeEls.values()) nodeEl.remove();
    this.nodeEls.clear();
    this.portEls.clear();
    for (const node of this.model.nodes) this._addNodeEl(node);
    this._renderWires();
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
  }

  // A Parameter row: a label and a button that opens the relevant picker (ADR-0004).
  _buildParamRow(node, param) {
    const row = el('div', 'param-row');
    row.appendChild(el('span', 'param-label', param.label));
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
      if (param.type === 'tile') this._pickTile(node, param, render);
    });
    row.appendChild(btn);
    return row;
  }

  _pickTile(node, param, render) {
    this.hide();
    this.toggleBtn.style.display = 'none'; // don't let the Flow toggle reopen mid-pick
    const reopen = () => { this.toggleBtn.style.display = ''; this.show(); };
    pickPosition({
      current: (node.params && node.params[param.id]) || null,
      prompt: `Click a tile to set ${param.label} — Esc to cancel`,
      onPicked: (tile) => {
        this.model.setParam(node.id, param.id, tile);
        this.library.save();
        render();
        reopen();
      },
      onCancel: reopen,
    });
  }

  _removeNode(id) {
    this.model.removeNode(id);
    const nodeEl = this.nodeEls.get(id);
    if (nodeEl) nodeEl.remove();
    this.nodeEls.delete(id);
    for (const key of [...this.portEls.keys()]) {
      if (key.startsWith(`${id}:`)) this.portEls.delete(key);
    }
    this._renderWires();
    this._renderLibrary(); // node count changed
    this.library.save();
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
      hit.addEventListener('click', () => { this.model.disconnect(c.id); this._renderWires(); this.library.save(); });
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
      const node = this.model.addNode(kind, p.x - 60, p.y - 14);
      this._addNodeEl(node);
      this._renderWires();
      this._renderLibrary();
      this.library.save();
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
      this.library.save(); // persist the moved position
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
      if (!target) return;
      const out = source.dir === 'out' ? source : target.dir === 'out' ? target : null;
      const inn = source.dir === 'in' ? source : target.dir === 'in' ? target : null;
      if (!out || !inn) return;
      const conn = this.model.connect(
        { node: out.node, port: out.port },
        { node: inn.node, port: inn.port },
      );
      if (conn) { this._renderWires(); this.library.save(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
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

function portUnder(clientX, clientY) {
  const target = document.elementFromPoint(clientX, clientY);
  const dot = target && target.closest('.port');
  if (!dot) return null;
  return { node: dot.dataset.node, port: dot.dataset.port, dir: dot.dataset.dir };
}
