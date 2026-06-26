# Move can spread Runners across distinct destination Tiles via a Tile Claim

Several Runners running one shared Flow (ADR-0003) all read the same `Move.destination` Tile, so a
generic "patrol here" Flow sent the whole squad to one Tile: forgiving arrival (ADR-0017) and the
movement system's separation eventually un-stacked them, but they still clumped into a tight blob and
re-converged at every waypoint of a loop — visually poor and not the spread an author wants from a
patrol. We let the **world** distribute them, so the player still authors one Flow and the Runners
fan out automatically — the same spirit as ADR-0017's self-distributing Gather, now retargeted from
"beside a Deposit" to "near a destination."

A `Move` gains an opt-in **`spread`** boolean Parameter (default off, so today's clump-on-the-Tile
behaviour is unchanged). When set, on its first tick the Runner **claims** the nearest free Tile near
the destination — a Walkable, unoccupied, unclaimed Tile found by searching outward from the
destination within a small radius — walks there instead of to the shared Tile, and holds the Claim
while it travels and while it stands arrived on the Tile. Distinct claimed Tiles ⇒ distinct goals ⇒
no contention, exactly as distinct standing Tiles do for gathering. This reuses the ADR-0017 claim
machinery almost wholesale; the one novelty is that we now claim a **bare Tile**, where the gather and
build claims reserve a *Deposit* or a *Site* and the standing Tile merely falls out.

The Claim lives in the world, never in the interpreter: `runtime.js` stays engine-free (ADR-0006) and
reaches claiming only through `world` primitives that return opaque handles. A Claim is momentary
world state, not part of a Run, and is not saved (ADR-0017).

## Two deliberate divergences from the gather/build claim

- **Hold while standing, not "while acting."** The gather claim frees the moment a Worker's Cargo
  fills and it leaves. A spread Tile is instead held from Move-start, through travel, **and while the
  Runner stands arrived on it**, freeing only when the Runner's goal next changes (a new
  Move/Attack-Move), it is re-assigned, or it is destroyed. This is what keeps a *second* group (or a
  patrol's next lap) from claiming a Tile someone is already standing on — the spread stays clean over
  time, not just on the first approach. A permanent guard holds its Tile forever, which is accurate,
  not a leak.
- **Fall back, never block.** The gather/build claims make a Worker *wait in place* when every slot is
  taken (ADR-0017/0018). A spread-Move must not: a Move that never completes because the area is full
  would silently stall a patrol Flow with no obvious cause. So when no free Tile is found within the
  radius, the Move degrades to its default — head to the destination with forgiving arrival and let
  separation sort it out — and completes normally. Overflow Runners pack in at the edge, no worse than
  today.

## Considered alternatives

- **Implicit spread on every Move** (no Parameter). Zero authoring, but silently changes where every
  Move lands and removes the author's ability to say "all of you, this exact Tile." Rejected in favour
  of an opt-in: the clump is occasionally wanted (a choke, a single rally), and an explicit knob is
  honest about the behaviour change.
- **Deterministic per-Runner offset, no Claim.** Map each Runner to a fixed slot in a ring/grid by a
  stable index. Lightest, but two Runners can compute the same Tile (index collisions, or two Flows
  aimed at one spot) with only separation to save them — a weaker guarantee than a reservation, and it
  needs a "stable index" source the model doesn't naturally have. Rejected; the Claim already exists
  and gives a hard guarantee.
- **Just widen forgiving arrival.** `spread` only enlarges the arrival radius so separation spreads a
  looser blob. Near-zero code but still a blob, not the tidy distinct Tiles a patrol wants. Rejected.
- **Release the Claim on arrival.** Lighter, frees Tiles fast, but reintroduces the bug for the next
  wave of arrivals (they can target an occupied Tile). Rejected — see "hold while standing" above.
- **Block and wait when full** (gather-style). Consistent with ADR-0017/0018 but risks a permanently
  stalled patrol. Rejected — see "fall back, never block" above.

## Consequences

- `Move`'s descriptor (nodeKinds.js) gains a `spread` boolean Parameter; its executor passes it to a
  world primitive that claims/clears a destination Tile, keeping the interpreter engine-agnostic
  (ADR-0006). The executor and descriptor comments must state the two behaviours an author must
  understand: a spread Move moves the Runner to a Tile *near* the destination, and it never blocks.
- New world primitives (e.g. `claimTile`/`releaseTile`, or a generalisation of `claimDeposit`) and
  per-Runner + per-Tile claim state that MapScene must clear on Runner death, re-assignment, and at
  the start of the next Move, or a Tile leaks as permanently claimed.
- **CONTEXT.md `Claim` is generalised** from "a Worker's hold on a Deposit/build slot" to "a Runner's
  hold on a spot — Deposit, build slot, or destination Tile." The headline is no longer Worker-only,
  and a Claim can now reserve a bare Tile.
- The spread radius is a tuning knob; default ~4 Tiles (the gather claim uses 5).
- Deferred: spread on **Attack-Move** (it carries a `destination` too), and the combat
  **surround-slots** behaviour (many attackers on one Enemy, each on a distinct ring Tile within
  range) — both ride this same Tile-claim mechanism and can layer in without disturbing it. Combat
  target *spreading* across Enemies (a per-target attacker cap) remains rejected, consistent with
  ADR-0012 deferring focus-fire / target priority.
