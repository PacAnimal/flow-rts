// The Flow interpreter: walks a Flow's node graph and advances a Unit's Run. It is
// engine-agnostic — it imports nothing from Phaser and never touches a sprite. Anything a
// node needs to DO in (or ASK of) the game world goes through the injected `world` context,
// which MapScene implements against Phaser. See CONTEXT.md (Run) and docs/adr/0005, 0006.
//
// A Run is `{ flowId, current, status }`: `current` is the id of the node the cursor sits on
// and `status` is 'running' | 'idle' | 'halted'. The cursor reads the LIVE model each tick,
// so edits to the shared Flow definition take effect as the Unit advances; if the current
// node is deleted, the Run halts. A Run carries a scratch `state` object for the node the
// cursor currently sits on (reset each time it advances) — Move is stateless and ignores it,
// but Wait accumulates elapsed time there.

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
  Move: (node, runner, world) => {
    const dest = node.params?.destination;
    if (!dest) return done();
    // Loose arrival: many Units share one rally/delivery Tile, so "near enough" beats shoving
    // over the exact Tile (docs/adr/0017).
    return world.moveToward(runner, dest, true) ? done() : RUNNING;
  },

  // Gather from a Deposit (docs/adr/0008, 0017). A gathering Worker CLAIMS the nearest unclaimed
  // Deposit within reach of where it was rallied, so several Workers running one shared Flow spread
  // across the cluster instead of crowding one Deposit. First tick: claim one (an opaque handle + a
  // free Tile beside it + its gather time); null ⇒ all in reach are claimed, so hold the cursor and
  // wait in place until one frees. Then walk the last Tiles to that standing Tile (snug arrival, no
  // contention — distinct Workers head for distinct Tiles), stand for the Resource's gather time,
  // and collect — which frees the Claim once Cargo fills (docs/adr/0017). `claim`/`elapsed` live in
  // the per-node scratch state, so re-assigning mid-gather resets cleanly (the world frees the
  // Claim). With no Deposit ever in reach (field exhausted, or rallied too far) the Worker waits.
  Gather: (node, runner, world, dt, state) => {
    if (!state.claim) {
      state.claim = world.claimDeposit(runner);
      if (!state.claim) return RUNNING; // nothing free in reach — wait in place
    }
    if (!state.arrived) {
      if (!world.moveToward(runner, state.claim.dest)) return RUNNING; // approach the Deposit
      state.arrived = true;
      state.duration = state.claim.gatherTime * 1000; // start the harvest timer + progress bar
    }
    state.elapsed = (state.elapsed || 0) + dt;
    if (state.elapsed < state.duration) return RUNNING;
    world.collect(runner, state.claim.handle);
    return done();
  },

  // Deliver Cargo to the player's Stockpile beside a Command Center (docs/adr/0008). On the first
  // tick the world reports how long the hand-off takes (0 when not adjacent or carrying nothing ⇒
  // instant no-op). Then hold the cursor for that long and have the world transfer the Cargo.
  // `duration`/`elapsed` mirror Gather, so the same progress bar covers both.
  Deliver: (node, runner, world, dt, state) => {
    if (state.duration === undefined) state.duration = world.deliverTime(runner);
    if (!state.duration) return done(); // nothing to deliver — advance immediately
    state.elapsed = (state.elapsed || 0) + dt;
    if (state.elapsed < state.duration) return RUNNING;
    world.deliver(runner);
    return done();
  },

  // Attack-Move toward the destination Tile, engaging Enemies in the aggro radius on the way
  // (docs/adr/0012). The world owns targeting/movement; the executor sets the intent and holds
  // the cursor until arrival (and not mid-fight). Unset destination ⇒ no-op, advance.
  AttackMove: (node, runner, world) => {
    const dest = node.params?.destination;
    if (!dest) return done();
    world.attackMove(runner, dest);
    return world.attackMoveArrived(runner) ? done() : RUNNING;
  },

  // Hold position and attack the nearest Enemy in range (docs/adr/0012). With no duration it is a
  // standing guard — holds the cursor indefinitely. With a duration it fights in place for that
  // long (timed in the per-node scratch state, like Wait) and then advances, so defence composes.
  Hold: (node, runner, world, dt, state) => {
    world.hold(runner);
    const seconds = node.params?.duration;
    if (!seconds || seconds <= 0) return RUNNING; // hold forever (default)
    state.elapsed = (state.elapsed || 0) + dt;
    return state.elapsed >= seconds * 1000 ? done() : RUNNING;
  },

  // Produce a Unit from a Building (docs/adr/0013). The world blocks until the Stockpile affords
  // the cost, then waits the build time and spawns; it returns true only once the Unit is out.
  // Funding/timing live in the per-node scratch state, so re-assignment resets cleanly.
  Train: (node, runner, world, dt, state) =>
    world.train(runner, node.params || {}, state, dt) ? done() : RUNNING,

  // Pick a random nearby walkable tile, attack-move there (engaging anything en route), and
  // complete on arrival so callers can loop or chain. Always waits at least one frame before
  // checking arrival so the movement system has time to set mv.arrived = false.
  RoamAttack: (node, runner, world, dt, state) => {
    if (!state.roaming) {
      state.roaming = true;
      const dest = world.roamDest ? world.roamDest(runner) : null;
      if (dest) world.attackMove(runner, dest);
      return RUNNING;
    }
    return world.attackMoveArrived(runner) ? done() : RUNNING;
  },

  // Hold the cursor for `duration` seconds, accumulating elapsed time in the node's scratch
  // state. Unset or non-positive duration is a no-op (ADR-0004) — advance immediately.
  Wait: (node, runner, world, dt, state) => {
    const seconds = node.params?.duration;
    if (!seconds || seconds <= 0) return done();
    state.elapsed = (state.elapsed || 0) + dt;
    return state.elapsed >= seconds * 1000 ? done() : RUNNING;
  },

  // Evaluate the node's Condition and route to the 'yes' or 'no' Exec output (docs/adr/0010).
  // Instant; the world owns evaluation. An unset/false Condition routes 'no'.
  Branch: (node, runner, world) => done(world.test(runner, node.params || {}) ? 'yes' : 'no'),
};

// Begin a Run at the Flow's OnStart Event. With a single cursor we take the first OnStart;
// a Flow with none starts idle (nothing to run). See docs/adr/0005.
export function startRun(flowId, model) {
  const onStart = model.nodes.find((n) => n.kind === 'OnStart');
  return onStart
    ? { flowId, current: onStart.id, status: 'running', state: {} }
    : { flowId, current: null, status: 'idle', state: {} };
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
    const res = exec(node, runner, world, dt, run.state);
    if (res.status === 'running') break; // park the cursor; resume next frame

    const conn = model.connections.find(
      (c) => c.from.node === node.id && c.from.port === res.out,
    );
    if (!conn) { run.status = 'idle'; break; } // end of chain — Run complete
    run.current = conn.to.node;
    run.state = {}; // fresh scratch for the node just entered
    if (++steps > maxSteps) { run.status = 'idle'; break; }
  }
  return run;
}
