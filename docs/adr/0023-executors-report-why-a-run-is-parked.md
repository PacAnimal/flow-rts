# Executors report *why* a Run is parked

The player authors a Flow, presses START, and watches it play (ADR-0005). When it misbehaves there
is nothing to debug with. The docked inspector highlights the node a Runner's cursor sits on, but a
parked cursor is the *same picture* whether the Runner is working or stuck: a Worker on **Gather**
looks identical while it walks to a Deposit, while it harvests, and while it waits because every
Deposit in reach is already **Claimed** (ADR-0017) — and a Barracks on **Train** looks identical
while it builds and while it blocks on a Stockpile that will never fill. The author sees "nothing is
happening" and has no way to learn which of a dozen causes it is.

A RUNNING result may therefore carry a **reason**: one short phrase saying why the cursor is parked
*this tick*. `tickRun` copies it onto `run.reason`; the inspector shows it after the node title.

## Decision details

- **The reason lives on the result, not on the Runner.** `running(reason)` replaces the bare
  `RUNNING` singleton (which survives as the no-reason case, so an executor that has nothing to say
  costs nothing). The interpreter stays a pure stepper: it does not interpret the string, it
  forwards it.

- **`run.reason` is the *active* Frame's reason** (ADR-0019), refreshed every tick the cursor stays
  put and cleared the moment it moves on, a handler Frame is pushed, or the Frame ends. A suspended
  Frame's reason is not preserved: resuming re-executes its node, which re-states it. This mirrors
  how the world's movement/combat intent is re-asserted rather than remembered.

- **Two sources, one channel.** Reasons an executor can see for itself — walking, counting down —
  are literals in `runtime.js`. Reasons only the world knows — *which* Resource the Stockpile is
  short of, whether every Deposit in reach is Claimed or there is simply none in reach — are
  written by the world into the node's scratch `state` and read back out by the executor, which
  returns `running(state.reason)`. This needs **no new `world` primitive**: `train` and `research`
  were already handed the scratch for funding and timing, and `claimDeposit` / `claimBuildSlot` /
  `construct` now take it too. ADR-0006 is untouched — the strings cross the seam as plain data in a
  bag the interpreter owns, and the interpreter still imports nothing from Phaser.

- **Reason strings are prose for a human, not an enum.** Nothing branches on them; they are never
  persisted, matched, or exposed to Flows. "every Deposit in reach is claimed by another Worker"
  earns its length by naming the *mechanism* (Claim, ADR-0017) so the player learns the model while
  debugging. They use CONTEXT.md's vocabulary for the same reason.

- **One new read-only sense:** `world.engaged(unit)` reports whether the CombatSystem has the Unit
  trading blows (ADR-0012), so Hold / Attack-Move / Roam can say "engaging an Enemy" rather than
  describing a Unit standing still. It is optional-chained at the call site, like `roamDest` and
  `damageCount`, so a partial world (the headless checks) still runs.

- **Rally-reach filters run first.** `_claimDeposit` and `_claimBuildSlot` reordered their filters
  so the distance test precedes the claimed/full/capacity tests. The result set is identical — they
  are independent filters — but "in reach" becomes a fact the rejection can be reported *against*,
  which is what separates "you rallied these Workers too far from the patch" from "the patch is
  busy."

## Alternatives rejected

- **A status enum on the Run** (`waiting-for-claim`, `waiting-for-funds`, …) — every new blocking
  condition would have to be named centrally and kept in sync with both the executor and the world,
  for a value only ever rendered as text.
- **New `world` query primitives** (`whyNoDeposit(unit)`) — a second call re-deriving what the claim
  attempt just computed, and a wider seam for no gain.
- **Logging reasons to the console** — `_log` already traces node changes there, but a reason
  changes several times per Gather cycle per Worker; at ×4 speed with a full crew it is unreadable.
  The inspector asks a question about one Runner and gets one answer.
- **Surfacing the reason on the map** (a badge over a stalled Runner) — genuinely wanted, but it is
  an alert-policy decision (what counts as stalled, for how long) layered *on* this contract rather
  than part of it. Deferred.

## Consequences

- `runtime.js` gains `running(reason)` beside `RUNNING`/`done`, and `run.reason` joins the Run shape
  (`startRun` seeds it; `tickRun`, `pushHandler` and `endActive` maintain it). Every blocking
  executor now names its wait.
- Four `world` primitives change signature to receive the node scratch (`claimDeposit`,
  `claimBuildSlot`, `construct`) or are added (`engaged`); `_train` / `_research` / `_claimDeposit` /
  `_claimBuildSlot` / `_construct` write reasons, and a `_shortfall(cost)` helper renders the
  missing Stockpile as "30 alloys, 10 sludge".
- `MapScene._runDetail` renders `▶ <node title> — <reason>  <elapsed / duration>`, so the inspector
  carries both why it is parked and how far along it is.
- No CONTEXT.md term is added: a reason is a status detail of a Run, not a domain concept.
- Deferred: stalled-Runner badges on the map, a reason on the *suspended* Frames of a Run's stack,
  and reasons for the instant nodes (a Branch that routed No never parks, so it has nowhere to
  report from).
