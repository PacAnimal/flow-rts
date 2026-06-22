# Resources, Deposits, and gathering

Workers can gather. The model has three concepts (see CONTEXT.md): a **Resource** (a material
*type* — Crystals today), a **Deposit** (a source of one Resource sitting on a Tile), and
**Cargo** (the amount a Unit carries). A new **Gather Resources** Action node drives it: when a
Worker beside a Deposit executes it, the Worker stands for the Resource's gather time and then
takes its yield into Cargo.

Several choices here are surprising or hard to reverse, so they are recorded together.

## Deposits block their Tile — walkability now means terrain *and* occupancy

A Deposit makes its Tile impassable: no Unit can stand on or path through it. So "beside a
resource" is literal — a Worker must stand on an adjacent Tile to gather. `MapScene.walkable`
now returns false for a Deposit-occupied Tile as well as for unwalkable terrain, and because
pathfinding routes through that one predicate, Units automatically path *around* Deposits with
no change to the pathfinder. When a Deposit is gathered empty it is removed and its Tile
becomes Walkable again; freeing a Tile never invalidates an in-flight Path (it only adds
options), so cached Paths need no recompute.

The alternative — Deposits stay Walkable and "beside" is a gather-range check — was rejected:
it lets Workers stand on top of crystals and makes adjacency fuzzy. Blocking the Tile matches
SC2 mineral patches and keeps "beside" physical. The cost is that `walkable` is no longer pure
terrain; the glossary's **Walkable** entry now calls out the occupancy dimension explicitly.

## Rates live on the Resource type; Deposits are finite and deplete

Gather time, yield-per-gather, and a Deposit's starting amount are properties of the Resource
type (a small pure data table, `resources.js`), not Parameters on the Gather node. So the node
is parameterless and adapts to whatever the adjacent Deposit holds — adding Gas later is just a
new table entry. Each gather transfers `min(yield, remaining)` and reduces the Deposit; at zero
the Deposit (and its sprite) is removed and the Tile freed. Repeated gathering needs chained
Gather nodes or a future loop — one Gather node is one timed cycle.

Rejected: Parameters on the node (decouples gather speed from resource identity, must be re-set
on every node); inexhaustible Deposits (simpler, but we wanted the depletion loop now).

## Cargo is a single slot bounded by a per-Unit carry capacity

A Unit's Cargo is one `{type, amount}` slot, capped by a per-Unit `carryCapacity` that defaults
to one gather's worth (10, a single crystal gather) and is intended to be raised by upgrades
later. A gather adds `min(yield, deposit remaining, capacity − held)`; a Worker that is already
full no-ops (no stand-time, no depletion). A Unit carries one Resource type at a time; mixing
types is a future concern (only Crystals exist).

*Amended from the original decision, which left Cargo uncapped and deferred capacity. Capacity
landed earlier than drop-off: without a base to empty into, a full Worker simply stops gathering
(it stays full), but the limit is what makes "one trip carries one load" meaningful and sets up
the haul-to-base loop. Drop-off and a player-wide Resource tally remain deferred.*

## Gather is adjacent-only and timed in the interpreter; resource data stays in the world

The Gather node does **not** pathfind — if no Deposit is adjacent it is a no-op that completes
immediately, so authors compose `Move (beside) → Gather`. This keeps the node simple and avoids
duplicating Move's "which Deposit / how far" policy.

Following ADR-0006, the interpreter stays engine- and resource-agnostic. The Gather executor
times the cycle with the per-node Run `state` (the same mechanism as Wait, so it resets cleanly
on re-assignment) and reaches the game through two world primitives: `adjacentDeposit(runner)`
(returns an opaque Deposit handle plus its gather time, or null) and `collect(runner, handle)`
(transfer + deplete + remove-if-empty). All Resource definitions and Deposit state live on the
world side; the runtime only knows "how long to wait" and "do the collect."

## Consequences

- `MapScene` owns Deposits and a Tile→Deposit lookup; crystal placement registers one Deposit
  (and one sprite) per Tile, and `_spawnUnits` avoids Deposit Tiles.
- A no-animation stub marks where the gather animation will go; a minimal Cargo readout is
  appended to the Unit label so gathering is observable.
- New pure data module `resources.js`; new world primitives; `Gather` node kind (Action).
- Deferred: capacity upgrades, base/drop-off and a player-wide Resource tally, mixed-type Cargo,
  gather animation, and depletion-driven repathing niceties.
