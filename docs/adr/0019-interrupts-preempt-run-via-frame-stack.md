# Interrupts preempt a Run via a stack of Frames

ADR-0005 fixed a Run as a *single* resumable cursor and explicitly rejected an
event-driven model. We now want mid-Run reactive behaviour — a Runner doing one thing,
then being preempted to do another and returning to where it left off (timers today;
later "on health low", "on enemy near"). Rather than the rejected fully-reactive model,
we extend the cursor model: a **Run becomes a stack of Frames**, the existing cursor
being the bottom (the **base Frame**, rooted at OnStart). An **Interrupt** is an Event
that can fire *during* a Run; firing **suspends** the top Frame and pushes a handler Frame
rooted at the Interrupt node, the handler chain runs to its end, then it is **popped** and
the Frame beneath **resumes** exactly where it was. OnTimer (fires after `delay`, optional
`repeat`) is the first Interrupt.

## Decision details

- **Frames are freeze-and-continue.** A suspended Frame keeps its scratch state untouched;
  on resume the executor picks up mid-node (Move keeps heading to its target, Gather keeps
  its Claim and harvest timer, Train keeps its build timer). Only the top Frame advances.
- **Suspend halts world-intent.** On every push the world stops the suspended Frame's
  in-flight movement and clears its combat intent (a `world.suspendRunner`-style call), so
  "interrupt" behaves as the name promises — the Runner goes still until the handler moves
  it. Resume "just works" because the executors re-assert movement/combat intent every tick.
- **Unconditional LIFO preemption.** Any Interrupt that fires preempts whatever is on top,
  base Frame or another handler alike — no priorities, no non-preemptible handlers. A
  stack-depth cap guards runaway stacking (as `maxSteps` guards instant cycles).
- **Per-frame order of operations:** each tick (1) advance every Interrupt's clock and
  collect those due, (2) push a handler Frame for each (suspending + halting world-intent),
  (3) tick the top Frame. So a just-fired handler runs the same frame. Simultaneous firings
  are pushed in `model.nodes` order for determinism.
- **Timer state lives per-Run, keyed by node id** (outside Frame scratch, which is wiped on
  advance and absent while the node is off the stack). A repeating Interrupt's clock is
  **paused while its own handler is on the stack** and resets on pop — so "every N seconds"
  means N seconds *between handlings*, with no self-stacking pile-up or instant re-fire.
  Clocks live inside `tickRun`, so the global PAUSE gate (ADR-0005 amendment) freezes them
  for free.
- **OnStart is optional; a Run outlives its base line.** A purely reactive Flow (only
  Interrupts) is valid. The Run stays alive and keeps polling Interrupts as long as any can
  still fire, even after the base line ends. **idle** now means "no live Frames *and* nothing
  left to fire" (every Interrupt a spent one-shot, or none); a repeating Interrupt makes a
  Run never idle while assigned. An Interrupt with nothing wired to its Exec out is inert.
- **Deletion is handled lazily, per Frame.** Only the active (top) Frame reads the live
  model. If its node vanishes, discard just that Frame and resume the one below (popping
  further if it too is gone) — a deleted handler node abandons the handler and resumes the
  main line, rather than nuking the Run. The Run reaches **halted** only when the stack
  drains this way with nothing left to fire; the single-Frame case reduces to ADR-0005's
  original "delete current node → halt".

## Considered alternatives

- **True parallel chains** (multiple cursors advancing concurrently). Rejected: a single
  physical Runner can only move/fight one way at a time, so cooperative preemption (one
  active Frame) models the domain better and avoids reconciling conflicting world-intent.
- **Priorities / non-preemptible handlers.** Rejected for v1 as unneeded complexity
  (priority Parameter, tie-breaking, starvation reasoning) for a need not yet expressed.
- **Passive suspend** (leave old movement/combat running until the handler issues new
  intent). Rejected: a handler that doesn't move would leave the Runner coasting on the old
  action, contradicting "interrupt".
- **Restart the node on resume** (wipe scratch). Rejected: breaks freeze-and-continue —
  Wait would restart its whole duration, Gather would re-claim, etc.
- **The fully event-driven model** ADR-0005 already rejected. Still rejected as the base;
  Interrupts give the reactive capability while keeping the resumable-cursor core intact.
