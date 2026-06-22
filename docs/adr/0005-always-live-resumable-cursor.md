# Flow execution is always-live, advancing a resumable per-Unit cursor over the live definition

A Unit's assigned Flow executes continuously: the simulation is always running, so
assigning a Flow starts it immediately (its OnStart fires at the moment of assignment) and
re-assigning discards the old Run and starts a fresh one. There is no authoring/running
split and no global play/pause.

Each Unit's Run is a single **cursor** — the node it is currently at — plus that node's
in-progress state. Instantaneous nodes advance the cursor the same tick; a long-running
Action (Move) holds the cursor until it finishes (e.g. arrival), then advances along the
single Exec connection leaving it. Exec outputs already have cardinality 1, so one chain
means one cursor; true parallel chains wait for a future Flow Control fork node. When the
cursor reaches a node with nothing wired to its Exec output, the Run is complete and the
Unit goes idle. The cursor lives only in memory (see ADR-0003: execution state is per-Unit
and separate from the definition); it is not persisted, so reloading restarts every Run.

The cursor reads the **live** shared Flow definition every tick (ADR-0003: edit one Flow,
all Units running it change). Editing downstream nodes is therefore picked up when the Unit
advances into them. If an edit deletes the node the cursor is currently on, that Unit's Run
halts (goes idle); other Units running the same Flow are unaffected and there is no
auto-restart.

Alternatives considered:
- **Explicit play/pause** separating an authoring phase from a running phase. Rejected for
  v1: an always-ticking world is the simpler mental model for an RTS, and "assign and it
  goes" gives the tightest authoring feedback loop. (A play/pause could be layered on later
  without changing the cursor model.)
- **Reactive / event-driven** nodes that subscribe to game events instead of a cursor.
  Rejected as a larger conceptual leap with harder-to-reason-about ordering; the cursor
  matches the Blueprints-style exec model already chosen in ADR-0002.
- **Restart every running Unit on any edit** (instead of halt-if-vanished). Rejected as
  jarring: a small tweak would yank every live Unit back to OnStart mid-task.

Consequences:
- The interpreter is a resumable stepper: per Unit it stores `{ flowId, current node id,
  per-node progress, status }`, ticked every frame.
- "The moment its Flow begins running" (OnStart's definition in CONTEXT.md) resolves to the
  moment of assignment, with no special global-start case.
- A deleted current node is a normal, expected outcome (Run → halted), not an error to guard
  against by other means.
