// The Flow interpreter: walks a Flow's node graph and advances a Unit's Run. It is
// engine-agnostic — it imports nothing from Phaser and never touches a sprite. Anything a
// node needs to DO in (or ASK of) the game world goes through the injected `world` context,
// which MapScene implements against Phaser. See CONTEXT.md (Run) and docs/adr/0005, 0006.
//
// A Run is `{ flowId, current, status }`: `current` is the id of the node the cursor sits on
// and `status` is 'running' | 'idle' | 'halted'. The cursor reads the LIVE model each tick,
// so edits to the shared Flow definition take effect as the Unit advances; if the current
// node is deleted, the Run halts. Runs hold no per-node state today (Move is stateless — it
// glides from wherever the Unit currently is), but `tickRun` passes a `runner` so executors
// can keep some later if needed.

// Each executor runs one node and reports back: either still RUNNING (wait for next frame,
// keep the cursor here) or DONE with the Exec output port to follow. Keyed by node kind so
// node descriptors (nodeKinds.js) stay pure, serializable schema (docs/adr/0006).
const RUNNING = { status: 'running' };
const done = (out = 'out') => ({ status: 'done', out });

const EXECUTORS = {
  // Events have no effect — they are entry points. Fire and advance.
  OnStart: () => done(),

  // Glide toward the destination Tile; hold the cursor until arrival. An unset destination
  // is a valid authoring state (ADR-0004) — treat it as a no-op and advance immediately.
  Move: (node, runner, world, dt) => {
    const dest = node.params?.destination;
    if (!dest) return done();
    return world.moveToward(runner, dest, dt) ? done() : RUNNING;
  },
};

// Begin a Run at the Flow's OnStart Event. With a single cursor we take the first OnStart;
// a Flow with none starts idle (nothing to run). See docs/adr/0005.
export function startRun(flowId, model) {
  const onStart = model.nodes.find((n) => n.kind === 'OnStart');
  return onStart
    ? { flowId, current: onStart.id, status: 'running' }
    : { flowId, current: null, status: 'idle' };
}

// Advance `run` for one frame. Instantaneous nodes chain within the same tick; a node that
// returns RUNNING (Move in flight) stops the tick with the cursor parked on it. Reaching a
// node with nothing wired to the followed Exec output completes the Run (idle). A missing
// current node — deleted by a live edit — halts the Run. `maxSteps` guards against a future
// instant-only cycle spinning forever in one frame.
export function tickRun(run, runner, model, world, dt) {
  if (!run || run.status !== 'running') return run;

  let steps = 0;
  const maxSteps = model.nodes.length + 1;
  while (run.status === 'running') {
    const node = model.getNode(run.current);
    if (!node) { run.status = 'halted'; break; } // current node vanished under us

    const exec = EXECUTORS[node.kind] || done; // unknown/effectless kind: pass through
    const res = exec(node, runner, world, dt);
    if (res.status === 'running') break; // park the cursor; resume next frame

    const conn = model.connections.find(
      (c) => c.from.node === node.id && c.from.port === res.out,
    );
    if (!conn) { run.status = 'idle'; break; } // end of chain — Run complete
    run.current = conn.to.node;
    if (++steps > maxSteps) { run.status = 'idle'; break; }
  }
  return run;
}
