# Workers claim Deposits to self-distribute when gathering

Several Workers running one shared Flow (ADR-0003) all read the same `Move.destination` Tile, so a
"gather here" loop sent them to one Tile and one Deposit: they shoved over the same standing Tile
(the movement system's 700ms stuck-settle made it *eventually* resolve but look bad — ADR-0007) and
double-harvested one Deposit while neighbours sat idle. We make the **world** distribute them, so the
player still authors one Flow and the Workers spread automatically (the same spirit as ADR-0008's
parameterless, self-adapting Gather).

Two cooperating mechanisms:

- **Claim (gather side).** A Worker reserves a single Deposit while harvesting it; at most one Worker
  per Deposit (CONTEXT.md *Claim*). `Gather` is no longer a one-shot "harvest if already adjacent"
  no-op — on its first tick it claims the nearest *unclaimed* Deposit within a radius of where the
  Worker was rallied, walks the Worker to a free adjacent standing Tile, then runs the timed harvest.
  Distinct Deposits ⇒ distinct standing Tiles ⇒ no contention. The Claim releases when Cargo fills
  and the Worker leaves to deliver (and on re-assignment, destruction, or the Deposit emptying), so it
  frees for the next Worker. If every Deposit in radius is claimed, `Gather` **holds the cursor** and
  the Worker waits in place until one frees — it never wanders off to a far field, and never shares.

- **Forgiving arrival (both ends).** `Move` now completes within a small radius (~1 Tile) of its
  destination instead of dead-on the Tile. This de-clumps the rally (before `Gather` disperses them)
  and the Command Center (where many Workers deliver from different perimeter Tiles, accepted by
  `Deliver`'s existing range), with no second claim system on the deliver side.

The Claim lives in the world, never in the interpreter: `runtime.js` stays engine-free (ADR-0006) and
reaches claiming only through `world` primitives that return opaque handles, exactly like
`adjacentDeposit`. A Claim is momentary world state, not part of a Run, and is not saved (CONTEXT.md).

## Considered alternatives

- **Share a Deposit / claim the standing Tile instead.** Packs more Workers onto a small cluster but
  re-introduces bunching near depletion and gives less visual spread. Rejected — distribution was the
  goal.
- **Blocked Worker runs the loop empty (Gather no-ops and advances).** Simplest, but the Worker paces
  rally→CC→rally carrying nothing — visually worse than the original shoving. Rejected in favour of
  waiting in place.
- **Hold the Claim across the whole loop (own a Deposit until depleted).** Then a waiting Worker never
  gets a turn (depletion removes the slot, not frees it), breaking turn-taking. Rejected.
- **Claim globally / wander to free crystals elsewhere when the rallied field is full.** Maximises
  throughput but ignores the player's "gather *here*" intent. Rejected — the rally is treated as a
  real instruction; idling beats wandering.

## Consequences

- `Gather` gains two new behaviours an author must understand: it can **move** the Worker the last few
  Tiles, and it can **block indefinitely** when no Deposit is claimable (including when the field is
  empty, or when the rally was placed too far from any Deposit). The node descriptor (nodeKinds.js)
  and its executor comment must say so.
- New world primitives (e.g. `claimDeposit`/`releaseClaim`) and per-Worker + per-Deposit claim state
  that MapScene must clear on Deposit removal, Worker death, and re-assignment, or a Deposit leaks as
  permanently claimed.
- The claim radius and the `Move` arrival radius are tuning knobs; defaults ~5 Tiles and ~1 Tile.
- Capacity equals one gather's yield today (10), so a Claim is held for a single harvest (~one
  gatherTime) then released — Workers may re-claim a different Deposit each trip. Acceptable; raising
  carry capacity later lengthens the hold without changing the model.
