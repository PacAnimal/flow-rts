// The Flow interpreter: walks a Flow's node graph and advances a Runner's Run. It is
// engine-agnostic — it imports nothing from Phaser and never touches a sprite. Anything a
// node needs to DO in (or ASK of) the game world goes through the injected `world` context,
// which MapScene implements against Phaser. See CONTEXT.md (Run, Frame, Interrupt) and
// docs/adr/0005, 0006, 0019.
//
// A Run is a STACK of Frames (docs/adr/0019). The active (top) Frame lives directly on the Run as
// `{ current, state }` — `current` is the id of the node the cursor sits on, `state` its scratch —
// so the rest of the app reads the running cursor exactly as it always has. Suspended Frames
// beneath it live in `run.stack` (each `{ current, state, interrupt }`, bottom-first), and
// `run.timers` holds a per-Interrupt clock keyed by node id. `status` is 'running' | 'idle' |
// 'halted'. The active Frame reads the LIVE model each tick, so edits take effect as the Runner
// advances; deleting the active node discards that Frame and resumes the one beneath (ADR-0005,
// 0019). An Interrupt (OnTimer) coming due suspends the active Frame — the world halts its
// in-flight movement/combat — and pushes a handler Frame; when that handler's chain ends the Frame
// is popped and the suspended Frame resumes exactly where it froze (freeze-and-continue). A Run
// outlives its base line: it stays armed (running, no active Frame) while any Interrupt can fire.

// Each executor runs one node and reports back: either still RUNNING (wait for next frame,
// keep the cursor here) or DONE with the Exec output port to follow. Keyed by node kind so
// node descriptors (nodeKinds.js) stay pure, serializable schema (docs/adr/0006).
const RUNNING = { status: 'running' };
const done = (out = 'out') => ({ status: 'done', out });

const EXECUTORS = {
  // Events have no effect — they are entry points. Fire and advance into whatever they wire to.
  // OnStart roots the base Frame; OnTimer roots a pushed interrupt-handler Frame (docs/adr/0019).
  OnStart: () => done(),
  OnTimer: () => done(),

  // Glide toward the destination Tile; hold the cursor until arrival. An unset destination
  // is a valid authoring state (ADR-0004) — treat it as a no-op and advance immediately.
  Move: (node, runner, world) => {
    const dest = node.params?.destination;
    if (!dest) return done();
    // With `spread` set, fan out instead of stacking (docs/adr/0020): head to a distinct Tile
    // claimed near the destination, so several Runners sharing one Flow settle on separate Tiles.
    // The world holds the Claim (freed when the Runner next moves, is re-assigned, or dies) and
    // falls back to the destination when no Tile is free — so this stays a stateless re-issue like
    // a plain Move, never blocks, and a full area is no worse than today's clump.
    const goal = node.params?.spread ? world.claimMoveTile(runner, dest) : dest;
    // Loose arrival: many Units share one rally/delivery Tile, so "near enough" beats shoving
    // over the exact Tile (docs/adr/0017).
    return world.moveToward(runner, goal, true) ? done() : RUNNING;
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

  // Fall back to the nearest friendly Command Center (docs/adr/0012). The world resolves a standing
  // Tile beside it from live state; null ⇒ no base to retreat to, so no-op and advance. Cache the
  // Tile in scratch (a Building can't move, so the goal is stable) and glide there with loose arrival
  // so several retreaters settle around the base rather than stacking. Re-assigning resets the cache.
  Retreat: (node, runner, world, dt, state) => {
    if (state.dest === undefined) state.dest = world.retreatDest(runner);
    if (!state.dest) return done();
    return world.moveToward(runner, state.dest, true) ? done() : RUNNING;
  },

  // Produce a Unit from a Building (docs/adr/0013). The world blocks until the Stockpile affords
  // the cost, then waits the build time and spawns; it returns true only once the Unit is out.
  // Funding/timing live in the per-node scratch state, so re-assignment resets cleanly.
  Train: (node, runner, world, dt, state) =>
    world.train(runner, node.params || {}, state, dt) ? done() : RUNNING,

  // Research an Upgrade from a Building (docs/adr/0021), mirroring Train. The world blocks until the
  // Stockpile affords the Upgrade (or another Building researching it finishes), waits the research
  // time, then unlocks it player-wide; it returns true once the Upgrade is available (or instantly
  // when already unlocked / nothing selected). Funding/timing live in the per-node scratch state.
  Research: (node, runner, world, dt, state) =>
    world.research(runner, node.params || {}, state, dt) ? done() : RUNNING,

  // Place a Construction Site of the chosen building type at the chosen Footprint, then advance
  // (docs/adr/0018). The world spends + places when it can; an unaffordable or blocked placement is
  // a no-op. Either way Build completes immediately — the Command Center isn't tied up; Workers
  // (Construct) do the building. Unset params ⇒ the world no-ops too.
  Build: (node, runner, world) => {
    world.build(runner, node.params || {});
    return done();
  },

  // Add build work to a nearby Construction Site (docs/adr/0018), mirroring Gather (docs/adr/0017).
  // Claim one of the Site's ≤4 build slots within rally reach (null ⇒ none free in reach, so hold
  // the cursor and wait in place); walk to the standing Tile beside the Footprint; then contribute
  // each tick. The world returns true once the Site completes or is destroyed, which frees the slot
  // and advances the Worker. `slot`/`arrived` live in the per-node scratch so re-assigning resets.
  Construct: (node, runner, world, dt, state) => {
    if (!state.slot) {
      state.slot = world.claimBuildSlot(runner);
      if (!state.slot) return RUNNING; // nothing in reach needs builders — wait in place
    }
    if (!state.arrived) {
      // Loose arrival: up to four Workers crowd one Site, so "near enough to build" beats fighting
      // over one exact Tile (docs/adr/0017, 0018).
      if (!world.moveToward(runner, state.slot.dest, true)) return RUNNING; // approach the Site
      state.arrived = true;
    }
    return world.construct(runner, state.slot.handle, dt) ? done() : RUNNING;
  },

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

  // Raise or lower a Faction Signal (docs/adr/0022), then advance — instant. The world owns the
  // shared latch (and bumps the rising-edge counter OnSignal watches); an unset name no-ops there.
  // `value` defaults to raise (true) when the param is unset, matching the descriptor default.
  SetSignal: (node, runner, world) => {
    world.setSignal(runner, node.params?.name, node.params?.value !== false);
    return done();
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

// Interrupt predicates (docs/adr/0019), keyed by node kind like EXECUTORS. Each gets its own
// per-Run scratch `t` (seeded `{ elapsed, fired }`, but a predicate may stash more) plus the
// `runner` and `world` so an Interrupt can be keyed to world state, not just elapsed time. It
// reports whether the Interrupt is due THIS frame. The firing loop owns the cross-cutting rules —
// pausing the clock while the Interrupt's own handler is live, ignoring an unwired Interrupt,
// resetting `elapsed`/`fired` on fire — so a predicate only decides whether to fire now.
const INTERRUPTS = {
  // OnTimer fires once `delay` seconds have elapsed; with `repeat` off (default on) it fires once.
  OnTimer: (node, t, dt) => {
    const repeat = node.params?.repeat !== false; // default: repeating
    if (!repeat && t.fired) return false;         // spent one-shot
    const delayMs = (node.params?.delay || 0) * 1000;
    if (delayMs <= 0) return false;               // unset/zero delay is inert (ADR-0004)
    t.elapsed += dt;
    return t.elapsed >= delayMs;
  },

  // OnDamaged fires whenever the Runner's running tally of Damage events advances. The world keeps a
  // monotonic counter per Runner; `t.seen` remembers the count this Run has already reacted to. First
  // sight just arms at the current value (so pre-existing Damage doesn't fire it); thereafter any new
  // hit fires. While its own handler is live the firing loop pauses it, so blows landing mid-retreat
  // accumulate and re-fire once the handler pops — keeping a Runner reacting under sustained fire.
  OnDamaged: (node, t, dt, runner, world) => {
    const seq = world.damageCount ? world.damageCount(runner) : 0;
    if (t.seen === undefined) { t.seen = seq; return false; }
    if (seq <= t.seen) return false;
    t.seen = seq;
    return true;
  },

  // OnWaveIncoming fires once when the next Scenario Wave is within `lead` seconds (docs/adr/0014).
  // `t.armed` latches across the window so it fires on entry, not every frame; it clears once the
  // window reopens (the clock jumps to a Wave still further out after one spawns), re-arming for the
  // next. Unset/zero `lead` is inert (ADR-0004). With no Waves left the world reports Infinity.
  OnWaveIncoming: (node, t, dt, runner, world) => {
    const lead = node.params?.lead || 0;
    if (lead <= 0) return false;
    const until = world.secondsUntilNextWave ? world.secondsUntilNextWave() : Infinity;
    if (until > lead) { t.armed = false; return false; }
    if (t.armed) return false;
    t.armed = true;
    return true;
  },

  // OnSignal fires on a Faction Signal's rising edge (docs/adr/0022), watching the world's monotonic
  // raise-count exactly as OnDamaged watches the Damage tally: arm at the current count on first
  // sight (so a Signal already raised before this Run armed doesn't fire it), then fire whenever it
  // advances. An unset `name` reads count 0 forever — inert (ADR-0004).
  OnSignal: (node, t, dt, runner, world) => {
    const name = node.params?.name;
    if (!name) return false;
    const seq = world.signalSeq ? world.signalSeq(runner, name) : 0;
    if (t.seen === undefined) { t.seen = seq; return false; }
    if (seq <= t.seen) return false;
    t.seen = seq;
    return true;
  },

  // OnSignalLowered is the falling-edge twin (docs/adr/0022): same shape as OnSignal, but watching
  // the world's lowered-count so it fires when a Signal is lowered (the all-clear) rather than raised.
  OnSignalLowered: (node, t, dt, runner, world) => {
    const name = node.params?.name;
    if (!name) return false;
    const seq = world.signalLoweredSeq ? world.signalLoweredSeq(runner, name) : 0;
    if (t.seen === undefined) { t.seen = seq; return false; }
    if (seq <= t.seen) return false;
    t.seen = seq;
    return true;
  },
};

// Cap on stacked handler Frames: a safety valve against two fast Interrupts piling up faster than
// their handlers pop (docs/adr/0019), mirroring tickRun's maxSteps guard on instant cycles.
const MAX_STACK_DEPTH = 32;

// An Interrupt only fires if its Exec output leads somewhere; an unwired Interrupt is inert
// (docs/adr/0019) — firing it would suspend-and-resume the Runner for no behaviour.
const hasHandler = (model, node) => model.connections.some((c) => c.from.node === node.id);

// The Interrupt node ids whose handler Frame is currently live (the active Frame plus any suspended
// one). Their clocks are PAUSED — "every N seconds" counts time NOT spent handling that Interrupt,
// so a handler outlasting its own period neither self-stacks nor instantly re-fires.
function liveInterruptIds(run) {
  const ids = new Set();
  if (run.activeInterrupt) ids.add(run.activeInterrupt);
  for (const f of run.stack) if (f.interrupt) ids.add(f.interrupt);
  return ids;
}

// Could any Interrupt still fire? A repeating one always can; a one-shot only until it has fired.
// Decides whether a Run with an empty stack stays armed (running) or is genuinely finished.
function anyArmable(run, model) {
  return model.nodes.some((n) => {
    if (!INTERRUPTS[n.kind] || !hasHandler(model, n)) return false;
    if (n.params?.repeat !== false) return true; // repeating
    return !run.timers[n.id]?.fired;             // one-shot not yet spent
  });
}

// Suspend the active Frame onto the stack and make `node` (an Interrupt) the new active Frame. The
// world halts the suspended Frame's in-flight movement/combat intent (docs/adr/0019): the Runner
// goes still until the handler moves it, and resume re-asserts intent because executors re-issue it
// every tick. With no active Frame (an armed, base-line-finished Run) there is nothing to suspend.
function pushHandler(run, node, runner, world) {
  if (run.current != null) {
    run.stack.push({ current: run.current, state: run.state, interrupt: run.activeInterrupt });
  }
  world.suspendRunner?.(runner);
  run.current = node.id;
  run.state = {};
  run.activeInterrupt = node.id;
}

// Resume the Frame beneath the active one, restoring its frozen cursor + scratch (freeze-and-
// continue). Returns false when the stack is empty (nothing to resume).
function popFrame(run) {
  const f = run.stack.pop();
  if (!f) return false;
  run.current = f.current;
  run.state = f.state;
  run.activeInterrupt = f.interrupt;
  return true;
}

// Advance every Interrupt's clock and push a handler Frame for each that comes due, in model order
// so simultaneous firings stack deterministically (docs/adr/0019). Runs before the active Frame is
// stepped, so a freshly-fired handler executes the same tick.
function fireDueInterrupts(run, runner, model, world, dt) {
  const live = liveInterruptIds(run);
  for (const node of model.nodes) {
    const pred = INTERRUPTS[node.kind];
    if (!pred) continue;
    const t = run.timers[node.id] || (run.timers[node.id] = { elapsed: 0, fired: false });
    if (live.has(node.id)) continue;        // clock paused while its own handler is live
    if (!hasHandler(model, node)) continue; // unwired Interrupt is inert
    if (!pred(node, t, dt, runner, world)) continue;
    t.elapsed = 0;
    t.fired = true;
    if (run.stack.length >= MAX_STACK_DEPTH) continue; // safety valve: drop the fire, retry later
    pushHandler(run, node, runner, world);
  }
}

// End the active Frame when its chain runs out or its node was deleted with nothing beneath. The
// Run does not die while an Interrupt can still fire — it goes ARMED (running, no active Frame),
// waiting to service the next one (docs/adr/0019). Otherwise it is idle (finished normally) or
// halted (a live node was deleted) — the distinction the inspector surfaces.
function endActive(run, model, byDeletion) {
  run.current = null;
  run.state = {};
  run.activeInterrupt = null;
  if (anyArmable(run, model)) run.status = 'running';
  else run.status = byDeletion ? 'halted' : 'idle';
}

// Begin a Run. The base Frame starts at the Flow's first OnStart (docs/adr/0005); OnStart is now
// optional (docs/adr/0019) — a purely reactive Flow starts with no active Frame but stays armed if
// any Interrupt can fire. A Flow with neither an OnStart nor an armable Interrupt is idle at once.
export function startRun(flowId, model) {
  const onStart = model.nodes.find((n) => n.kind === 'OnStart');
  const run = {
    flowId,
    current: onStart ? onStart.id : null,
    state: {},
    status: 'running',
    stack: [],
    timers: {},
    activeInterrupt: null,
  };
  if (!onStart && !anyArmable(run, model)) run.status = 'idle';
  return run;
}

// Advance `run` one frame (docs/adr/0005, 0019). First fire any due Interrupts (which may push
// handler Frames), then step the active Frame: instantaneous nodes chain within the tick; a node
// that returns RUNNING parks the cursor; reaching a node with nothing wired ends the active Frame,
// popping to the suspended Frame beneath (resume) or ending the Run; a deleted active node discards
// its Frame the same way. `maxSteps` guards an instant-only cycle from spinning forever in a tick.
export function tickRun(run, runner, model, world, dt) {
  if (!run || run.status !== 'running') return run;

  fireDueInterrupts(run, runner, model, world, dt);

  let steps = 0;
  const maxSteps = model.nodes.length + run.stack.length + 2;
  while (run.status === 'running' && run.current != null) {
    const node = model.getNode(run.current);
    if (!node) {                            // active node vanished under a live edit (ADR-0005)
      if (!popFrame(run)) { endActive(run, model, true); break; }
      continue;                             // resume the Frame beneath and keep stepping
    }

    const exec = EXECUTORS[node.kind] || done; // unknown/effectless kind: pass through
    const res = exec(node, runner, world, dt, run.state);
    if (res.status === 'running') break;    // park the cursor; resume next frame

    const conn = model.connections.find(
      (c) => c.from.node === node.id && c.from.port === res.out,
    );
    if (!conn) {                            // end of this Frame's chain
      if (!popFrame(run)) { endActive(run, model, false); break; }
      continue;                             // resumed Frame continues this tick
    }
    run.current = conn.to.node;
    run.state = {}; // fresh scratch for the node just entered
    if (++steps > maxSteps) { run.status = 'idle'; break; }
  }
  return run;
}
