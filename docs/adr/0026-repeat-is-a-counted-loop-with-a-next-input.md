# Repeat is a counted loop, with an explicit Next input

A loop is a back-edge gated by a Branch (CONTEXT.md Flow Control), so "do this three times" had
no spelling short of copying the body three times. ADR-0014 named that absence (no counted loop,
no variables) as the reason Waves are Scenario data rather than an Enemy spawner Flow. We add
**Repeat**: a Flow Control node with a `count` Parameter that sends the cursor round its body that
many times, then out.

## Decision details

- **Two inputs: `in` starts afresh, `Next` counts a pass.** Repeat has a plain Exec input, a
  second input labelled **Next**, and two outputs, **Repeat** (into the body) and **Done**. The
  body's last node wires back into Next. Arriving by `in` sets the count to one pass; arriving by
  Next adds one; after `count` passes the cursor leaves by Done and the count is forgotten.

  We first tried a single input, telling "another pass" from "a fresh start" by whether the
  cursor came from a node inside the loop body (anything reachable from the Repeat output that
  leads back to the Repeat). That fails on the case it most needs to handle. A body that breaks
  out early through a Branch and later comes round to the Repeat by an outer path puts that outer
  path in the "body" too, so the next use would inherit a stale count. The graph alone cannot
  say which wire is the loop. The player can, by choosing the port. The editor warns when a
  Repeat's body never reaches Next, which is the shape of a back-edge dropped on the plain input:
  it would restart the count every pass and loop forever.

  This keeps the CONTEXT.md idiom intact: a loop is still a back-edge, not a container node. Repeat
  only counts the laps of a back-edge.

- **The count lives in the Frame, not in node scratch or `run.timers`.** Node scratch is wiped every
  time the cursor enters a node, which is every lap. `run.timers` (per-Run, keyed by node id) was
  the backlog's suggestion, and it is the precedent for state that survives re-entry. But with Call
  Flow (ADR-0025) a Run can walk several Flows, and node ids are not unique across Flows. Each Frame
  therefore carries its own `counts`, keyed by node id within the one Flow that Frame walks, and
  suspended and resumed with it like its scratch. A Repeat inside a called Flow starts fresh on each
  call. A Repeat in an Interrupt handler starts fresh on each firing. A base line suspended mid-loop
  resumes with its count intact (freeze-and-continue, ADR-0019).

- **Instant, and allowed to be all-instant.** Repeat only counts and never parks, like Branch. An
  all-instant back-edge normally spins and ends the Run, via `tickRun`'s `maxSteps` guard. A counted
  loop is finite, so each Repeat pass extends that tick's step budget by one more trip round the
  body. "Repeat 5 → Build" places five Sites in one tick. Two caps keep this safe. `count` is
  clamped to 100 (`MAX_REPEAT`). At most 1000 Repeat passes may extend the budget in one tick, so
  an *uncounted* all-instant back-edge wrapped around a Repeat still spins out and ends the Run.

- **Unset or zero goes straight to Done** (ADR-0004), and the editor flags it as unset.

## Considered alternatives

- **Variables plus a Branch Condition comparing them.** More general, and ADR-0014 asked for both.
  Rejected for now: variables need a scope, a type and naming discipline of their own, and almost
  every counted loop a player wants is "N times". Repeat does not rule variables out later.
- **A container node that holds its body.** Rejected: the editor has no nesting, and it would make
  the loop something other than a back-edge.
- **A `break` input.** Unneeded. A Branch wired anywhere outside the loop leaves it, and the
  explicit `in` / Next split means leaving leaves nothing stale.

## Consequences

- New: the `Repeat` node kind; `counts` on the Run's active Frame and on each stacked Frame.
  Executors receive a sixth argument, `{ port, counts }`, giving the input port the cursor entered
  by and the Frame's counters. Every other executor ignores it.
- ADR-0014's "purist" option, a Scenario authored as an Enemy spawner Flow, is now expressible
  as `Repeat N → Train`. Waves stay data; this only removes one of the two stated obstacles.
- The editor's static spin-rule check (BACKLOG) must treat a cycle through a Repeat's Next as
  bounded, not as a spin.
