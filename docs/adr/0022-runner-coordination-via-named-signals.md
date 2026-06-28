# Runner coordination via named Signals (a Faction blackboard)

The game's goal is to author every Flow *before* the match and let it play hands-off. For that,
Runners must coordinate — a Worker that is attacked should be able to make the Marines defend — but
the shared-definition model (ADR-0003) forbids a Flow from naming a specific Runner: a Flow is a
definition many Runners share, so "tell *that* Marine to come" has no referent. Polling shared world
state (the Stockpile, unit counts — the conditions added alongside this ADR) gets us part way, but
there is no channel for one Runner to *announce* something to the rest of its side.

We introduce **Signals**: a set of named booleans, scoped per Faction, that any Runner can raise,
lower, and read. It is a blackboard, not a message queue — a Runner writes a named latch and others
observe it; no Runner addresses another. Three nodes work it, mirroring the read / write / react
triad the timer and damage Interrupts already gave us:

- **SetSignal** (Action, `any`) — raise or lower a named Signal. Params: `name`, `value` (boolean,
  default raise).
- **OnSignal** (Event / Interrupt, `any`) — fires on the Signal's **rising edge**. Param: `name`.
- **signal_raised** (Condition) — true while the named Signal is raised. Arg: `name`.

## Decision details

- **Edge *and* level.** `OnSignal` reacts the instant a Signal is raised (the reflex — preempts the
  Run via the Frame stack, ADR-0019); `signal_raised` reads its standing value for a `Branch` to gate
  on (the poll). Both are needed: "drop everything and defend the moment the alarm sounds" is an
  edge; "while the alarm stands, hold the line" is a level.
- **Rising-edge via a raise-sequence counter**, reusing the exact mechanism OnDamaged uses for its
  Damage tally. Each Signal carries a monotonic `seq` bumped *only* on a lowered→raised transition.
  `OnSignal`'s per-Run timer remembers the `seq` it last reacted to; it arms at the current value on
  first sight (so a Signal already raised before the Run armed does not fire it) and fires when the
  value advances. Re-raising an already-raised Signal is a no-op (no double-fire); lower-then-raise
  fires again.
- **No synchronous cascade.** `SetSignal` only mutates world state and advances; it never fires an
  Interrupt itself. `OnSignal` fires from the per-tick interrupt sweep (step 1 of `tickRun`,
  ADR-0019), which runs *before* the active Frame steps. So a Signal raised this tick is observed by
  another Runner's `OnSignal` no earlier than the next tick — at most one fire per Signal per tick,
  no instant loop. The existing `maxSteps`/stack-depth guards still hold.
- **One-frame, order-dependent latency (accepted).** Runners tick in `_runners()` order. A Signal
  raised by a Runner ticked earlier this frame is visible — both to `signal_raised` and to a
  not-yet-ticked Runner's `OnSignal` — within the same frame; one raised by a later Runner is seen
  next frame. This is the same per-frame sequencing the movement and combat passes already live with,
  and is deterministic. We do not buffer Signals to a frame boundary.
- **Scoped per Faction.** State is a `Faction → (name → { raised, seq })` map. Player and Enemy Flows
  share the interpreter (ADR-0011) but never read each other's Signals, so a data-authored Enemy
  Flow and the player's Library can both use a Signal named `defend` without collision.
- **Freeform names with Library-harvested autocomplete.** A Signal name is freeform, like a Category
  (CONTEXT.md): there is no managed roster — the set in play is the distinct names currently used
  across Flows. A new `signalName` Parameter type renders a text input backed by a `<datalist>` of
  names already used across the Library, so coordinating Flows converge on one spelling without a
  central registry, while a brand-new name is still just typed in.
- **World state, not Run state.** Signals live in the `world` (ADR-0006), so `runtime.js` stays
  engine-free and Phaser-free — it reaches them only through `setSignal` / `signalRaised` /
  `signalSeq`. Like the Stockpile and Claims they are momentary world state: never saved, reset when
  the level (re)starts.

## Alternatives rejected

- **Direct Runner references** ("send *this* Marine home") — breaks ADR-0003: a shared Flow has no
  handle to a specific Runner, and wiring one in would make Flows non-shareable.
- **Typed message payloads / a queue** — scope creep. Booleans cover the coordination cases we have;
  a value-carrying Signal is better served later by the reserved Data ports (ADR-0002) than by a
  bespoke messaging system now.
- **Global (non-Faction) Signals** — would leak between Player and Enemy, and a future neutral side,
  with no upside; Faction scoping is free given every Runner already has a Faction.
- **Buffering all writes to a frame boundary** to erase the order-dependent latency — adds a
  double-buffer and a flush phase for a one-frame effect the rest of the sim does not bother to hide.

## Consequences

- A `_signals` map in MapScene (init in `create()`, cleared on restart) beside `_stockpile`, and
  three new `world` primitives (`setSignal`, `signalRaised`, `signalSeq`) keyed by the Runner's
  Faction.
- A new SetSignal node kind (descriptor + executor), an OnSignal Interrupt (descriptor + an
  `INTERRUPTS` predicate reading `world.signalSeq`, shaped like OnDamaged), and a `signal_raised`
  Condition evaluated in `_testCondition`.
- A new `signalName` Parameter type in the editor: a free-text input with a datalist harvested from
  the Library's existing Signal names (the first Parameter type that is neither a fixed dropdown nor
  a numeric/tile input).
- Deferred: a Signals readout in the debug panel for authoring visibility; value-carrying Signals via
  Data ports; auto-lowering / expiring Signals (today a raised Signal stays raised until something
  lowers it).
