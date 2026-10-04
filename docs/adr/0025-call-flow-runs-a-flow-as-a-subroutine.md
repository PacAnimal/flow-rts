# Call Flow runs a Flow as a subroutine, in a Frame of its own

Every Flow so far has been self-contained. A player who wants the same "gather, deliver, repeat"
spine in a Worker's economy Flow and in its flee-and-return Flow has to author it twice and keep
the copies in step by hand. Categories organised the Library; nothing let one Flow *use* another.

We add **Call Flow**, a Flow Control node with one Parameter, the Flow to call. Reaching it runs
that Flow from its OnStart on the same Runner, and when the called Flow's chain ends the cursor
comes back and continues past the Call. ADR-0019 already made a Run a stack of Frames with
freeze-and-continue resume, which is a call stack. A call is one more reason to push a Frame.

## Decision details

- **A call pushes a Frame; returning is the pop that already exists.** The Call executor's first
  visit asks the interpreter to push. The interpreter writes `calling` into the Call node's scratch,
  suspends that Frame exactly as an Interrupt would, and makes the called Flow's OnStart the active
  Frame. When that chain ends, the ordinary pop restores the caller with its scratch intact, and the
  Call's second visit sees `calling` and completes. No return stack, return address or new Run
  status was needed.

- **A Frame now records which Flow it walks.** The active Frame carries `frameFlowId` beside
  `current` and `state`, and each suspended Frame carries `flowId`. `run.flowId` stays the
  *assigned* Flow. Anything that reads a node off the cursor (inspector, progress bars, log) now
  resolves it from `frameFlowId`. The interpreter resolves a called Flow's live model through a new
  world primitive, `resolveFlow`. It is the same lookup MapScene uses for the Run's own Flow, so the
  called Flow is the live definition (ADR-0003, 0005): edit it and every Runner currently inside it
  sees the change.

- **Only the assigned Flow's Interrupts are armed.** A called Flow's OnTimer / OnDamaged / … do not
  fire. Arming them would mean Interrupts appearing and disappearing as calls come and go, and two
  Flows could hold Interrupt clocks with the same node id. The reflex belongs to the Runner's own
  Flow, which can *call* a shared reaction: `OnDamaged → Call "Fall back"`. Interrupts still preempt
  a called Frame and resume it, unchanged. A handler Frame always walks the assigned Flow. A called
  Frame inherits its caller's `activeInterrupt`, so a handler's clock stays paused while anything it
  called is still running.

- **Recursion is refused, not bounded.** A Flow cannot call a Flow it is already nested inside: the
  active Frame's own Flow, or the Flow of any Frame beneath that is parked on a Call. The check
  stops at the first Frame that an Interrupt suspended, so a handler may call a Flow the
  interrupted line happens to be inside. The refused Call parks with a reason (ADR-0023):
  `"Gather" is already running here — a Flow cannot call itself`. The Flow picker also leaves the
  edited Flow out, which catches the direct case at authoring time.

  We considered allowing recursion up to `MAX_STACK_DEPTH`, as the backlog first suggested. We
  rejected it because the most natural recursive Flow a player writes is
  `Gather → Deliver → Call (this Flow)`, a loop spelled as a tail call. That would grow the stack
  by one Frame per lap and stall after 32 laps, with nothing on screen saying why. A loop is a
  back-edge (CONTEXT.md). Refusing recursion makes the mistake visible on the first lap. The depth
  cap still applies to calls, as a backstop for Interrupts stacked on top of a call chain.

- **Only a Flow of the same Runner kind can be called.** A called Flow's Actions run on the
  caller's Runner, so a Unit-Flow cannot call a Building-Flow (a Unit cannot Train), and a
  Building-Flow can only call one of the same building type (ADR-0015, 0016). The picker
  enforces this. Call Flow is `runner: 'any'`, so Markers can share Marker-Flows too.

- **Nothing to call means carry on.** An unset Parameter is a no-op (ADR-0004). A Flow that has
  been deleted, or has no OnStart, also completes the Call at once, because there is nothing
  that could ever run. The editor flags both cases on the node. A called Flow deleted mid-call is
  handled like a deleted node (ADR-0019): its Frame is discarded and the caller continues past the
  Call.

- **The inspector follows the cursor into a called Flow.** The docked inspector shows the Flow the
  cursor is in, and its title says so (`Worker 3 · player › in "Gather cycle"`). It swaps back when
  the call returns. Keeping it on the assigned Flow with only the Call node lit would hide the
  thing the player most wants to see: what the Runner is doing right now.

## Considered alternatives

- **Inline expansion** (copy the called Flow's nodes in at assignment time). Rejected: it breaks
  the shared-definition rule (ADR-0003), because editing the called Flow would not reach Runners
  already running it, and the inspector would show nodes that exist in no Flow.
- **Arm the called Flow's Interrupts while it is on the stack.** Rejected for v1, for the
  reasons above. It can come back as its own decision if a "module with its own reflexes" turns
  out to be wanted.
- **Arguments / return values.** None. There are no Data ports yet (ADR-0002), and a Parameter
  per call site would need a binding model of its own. A called Flow reads the world, Signals and
  Markers like any other Flow.

## Consequences

- New: the `CallFlow` node kind and its `callFlowRef` Parameter type; `frameFlowId` on the Run and
  `flowId` on each stacked Frame; world primitives `resolveFlow(flowId)` and `flowName(flowId)`.
  Executors may now return a third result, `call(flowId)`, which only `tickRun` acts on.
- A called Flow can be assigned directly as well. Nothing marks a Flow as "callable only".
- Deleting a Flow does not rewrite the Flows that call it, as with Train's `assignFlow`. The
  Call becomes a flagged no-op.
- The Gather-resume bug (BACKLOG) applies inside called Flows exactly as it does in the
  assigned one. Calls neither fix it nor make it worse.
