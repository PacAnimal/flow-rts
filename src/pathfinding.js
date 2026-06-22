// Pure, engine-agnostic terrain pathfinding (docs/adr/0007). A* over a Walkable Tile grid
// plus string-pull smoothing. No Phaser, no Unit knowledge — callers pass an `isWalkable(x,y)`
// predicate and grid bounds, and get back a list of Tile waypoints (or null if unreachable).
// Tile coords are integers; a Tile's geometric centre is (x + 0.5, y + 0.5) in Tile units,
// which is what the line-of-sight test samples against.

const SQRT2 = Math.SQRT2;

// 8 neighbours: [dx, dy, stepCost]. Diagonals cost √2 and require both orthogonal cells clear
// (no corner-cutting through an unwalkable Tile).
const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

// Octile distance — the exact cost of the cheapest obstacle-free 8-direction route.
function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
}

// A* from `start` to `goal` (both {x,y} Tiles). Returns the Tile path inclusive of both ends,
// or null if the goal is unwalkable or no route exists. `w`/`h` are grid dimensions.
export function findPath(start, goal, isWalkable, w, h) {
  if (!isWalkable(goal.x, goal.y) || !isWalkable(start.x, start.y)) return null;
  const idx = (x, y) => y * w + x;
  const startI = idx(start.x, start.y);
  const goalI = idx(goal.x, goal.y);
  if (startI === goalI) return [{ x: start.x, y: start.y }];

  const came = new Map();
  const g = new Map([[startI, 0]]);
  const open = new MinHeap();
  open.push(startI, heuristic(start.x, start.y, goal.x, goal.y));
  const closed = new Set();

  while (open.size) {
    const cur = open.pop();
    if (cur === goalI) return reconstruct(came, cur, w);
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % w, cy = (cur / w) | 0;
    const cg = g.get(cur);

    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!isWalkable(nx, ny)) continue;
      // no corner-cutting: a diagonal needs both shared-edge cells walkable
      if (dx && dy && (!isWalkable(cx + dx, cy) || !isWalkable(cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      if (closed.has(ni)) continue;
      const ng = cg + cost;
      if (ng < (g.get(ni) ?? Infinity)) {
        came.set(ni, cur);
        g.set(ni, ng);
        open.push(ni, ng + heuristic(nx, ny, goal.x, goal.y));
      }
    }
  }
  return null;
}

function reconstruct(came, cur, w) {
  const path = [];
  while (cur != null) {
    path.push({ x: cur % w, y: (cur / w) | 0 });
    cur = came.get(cur);
  }
  return path.reverse();
}

// String-pull: keep a waypoint only where the route must bend. Walking from an anchor, extend
// as long as the anchor has clear line-of-sight to the next Tile; when it breaks, the previous
// Tile becomes the new anchor. Turns a grid path into a few any-angle segments (docs/adr/0007).
export function smoothPath(path, isWalkable) {
  if (path.length <= 2) return path.slice();
  const out = [path[0]];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    if (!lineClear(path[anchor], path[i], isWalkable)) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

// Is every Tile crossed by the segment between two Tile centres Walkable? Sampled finely —
// good enough for shortcutting a path that A* already proved obstacle-free.
function lineClear(a, b, isWalkable) {
  const ax = a.x + 0.5, ay = a.y + 0.5, bx = b.x + 0.5, by = b.y + 0.5;
  const steps = Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))) * 4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(ax + (bx - ax) * t);
    const y = Math.floor(ay + (by - ay) * t);
    if (!isWalkable(x, y)) return false;
  }
  return true;
}

// Minimal binary min-heap keyed by priority; stores integer tile indices.
class MinHeap {
  constructor() { this.items = []; this.prio = []; }
  get size() { return this.items.length; }
  push(item, prio) {
    this.items.push(item); this.prio.push(prio);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.length - 1;
    this._swap(0, last);
    this.items.pop(); this.prio.pop();
    let i = 0; const n = this.items.length;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let s = i;
      if (l < n && this.prio[l] < this.prio[s]) s = l;
      if (r < n && this.prio[r] < this.prio[s]) s = r;
      if (s === i) break;
      this._swap(i, s); i = s;
    }
    return top;
  }
  _swap(i, j) {
    [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    [this.prio[i], this.prio[j]] = [this.prio[j], this.prio[i]];
  }
}
