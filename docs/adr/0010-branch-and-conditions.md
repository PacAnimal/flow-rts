# Branch routes on a Condition; Conditions are world-evaluated enum predicates, not Data ports

The **Branch** Flow Control node has one Exec input and two Exec outputs — **Yes** and **No** —
and routes execution down one of them by evaluating a **Condition**. It is the first node that
makes a choice, turning Flows from fixed scripts into behaviour ("if Cargo full → Deliver, else
→ Gather").

## Multi-output needed no new machinery

The interpreter already follows a named Exec output: an executor returns `done(portId)` and
`tickRun` follows the connection leaving that port (docs/adr/0005). So Branch just declares
`yes` and `no` Exec outputs and returns `done('yes' | 'no')`. Routing to an output with nothing
wired ends the Run (idle), exactly as a normal chain end does. Branch is instant — it evaluates
once when the cursor arrives, routes, and advances the same tick (no waiting/polling; a future
Wait-Until node covers that). An unset Condition evaluates to false → No.

## Conditions are enum predicates evaluated by the world

A Condition is a named boolean test chosen from a fixed catalog (`conditions.js`): `cargo_full`,
`cargo_empty`, `deposit_adjacent`, `at_command_center`, `stockpile_gte`. It is stored as a node
Parameter (`{ condition, ...args }`) — *not* wired through a Data port. The interpreter stays
engine-agnostic (ADR-0006): it calls `world.test(runner, params)` and the world dispatches by
condition id to a predicate over Unit/game state, the same seam Gather and Deliver use. The
catalog is pure metadata (id, label, arg schema) shared with the editor; the *evaluation* lives
in the world.

This deliberately does **not** build the Data-port system that ADR-0002/0004 reserved for typed
values. The alternative — a boolean-producing condition node wired into a Branch Data input —
is fully general and composable, but pulls forward Data ports, Data connections, typed sockets,
and value nodes for a single boolean today. Enum predicates ship the capability now; Data ports
remain the eventual path when conditions need to compose or read wired values. Cost: the catalog
is a closed set that grows by editing code, and a predicate's logic lives in the world rather
than on the canvas.

## Conditions may carry arguments; the editor renders them dynamically

`stockpile_gte` needs an amount (implicitly Crystals — the only Resource today; a Resource
selector waits until a second exists). So the catalog declares each Condition's args, and the
editor renders the Condition dropdown plus *only the selected Condition's* arg inputs,
re-rendering when the Condition changes. Arg-less predicates show just the dropdown. This keeps
the node clean and lets new parameterised Conditions (and later, Actions) reuse the pattern.

## Consequences

- New `conditions.js` catalog (pure data). A new editor param type renders a `<select>` for the
  Condition and dynamic arg rows; switching Condition drops args that don't belong to the new one.
- `world.test(runner, params)` added to the world context; `MapScene` implements the five
  predicates against Cargo, Deposits, the command center, and the Stockpile.
- `Branch` node kind (category `control`), with `yes`/`no` Exec outputs; CONTEXT.md gains a
  **Condition** term and lists Branch under Flow Control.
- Deferred: Data ports / composable conditions, a Resource selector for `stockpile_gte`,
  negation/AND/OR combinators, and the Wait-Until (poll-a-condition) node.
