# Train: Buildings produce Units by blocking on the Stockpile and assigning a Flow to the product

Buildings run Flows (ADR-0011/CONTEXT.md Runner) and their flagship action is production. The
**Train** node is a Building-scoped Action: when a Building's Run reaches it, it produces one
Unit on a free Tile beside the Building's Footprint. Train is the first node to spend the
**Stockpile** and the first realisation of the **Assign Flow** capability CONTEXT.md reserved.

## What Train does

1. **Picks a unit type** from a Parameter — a unit-type dropdown rendered the way Branch renders
   its Condition dropdown (ADR-0010's dynamic-param pattern). The Building constrains the menu
   (Barracks → Marine, Factory → vehicles).
2. **Blocks until the Stockpile can afford the cost**, then deducts it. Cost lives in the
   unit-type data table (like combat stats, ADR-0012, and gather rates, ADR-0008) — not a
   Parameter. While unaffordable the Building's cursor parks on Train (status RUNNING), so
   production **self-throttles to income** with no Branch needed.
3. **Waits the build time** (also from the unit-type table), then spawns the Unit beside the
   Building.
4. **Assigns a Flow to the new Unit** from a second Parameter — a Library-Flow dropdown — so the
   Unit is *born running* that Flow. This is the reserved Assign Flow node, first used here.

## Why blocking, not no-op-and-gate

The other "subject in the world" Actions (Gather without a Deposit, Deliver when empty) no-op
and advance, which would suggest gating Train with `Branch`/`stockpile_gte`. We chose **blocking**
instead: parking the cursor until funds arrive makes the common "build continuously, as fast as
income allows" loop a single node, and removes the need to hardcode the cost twice (once in the
table, once in a Branch's amount). The cost is that Train becomes the first node that *waits on
world state* rather than a fixed duration — a poll, conceptually the specialised ancestor of the
deferred Wait-Until node (ADR-0010).

## Why born-with-a-Flow

The game's premise is "script everything up front," so a Unit that spawns idle and waits for a
manual Assignment breaks the fantasy. Carrying the assigned Flow as a Train Parameter means a
Barracks Flow reads "build a Marine, hand it Defend" — automation end to end. It also gives the
reserved Assign Flow node a concrete first home (hand a Flow *by reference*, per ADR-0003, not a
copy).

## Consequences

- Production spends the Stockpile (un-defers ADR-0008's amendment). Cost and build time join the
  unit-type data table.
- New Parameter types: a unit-type selector and a Library-Flow selector (the latter reusable by a
  future standalone Assign Flow node).
- Continuous production needs the Building's Flow to repeat, which forces the long-reserved
  **Loop** node into existence (decided separately).
- A Train executor times the build with the per-node Run `state` (like Wait/Gather) and reaches
  the world for affordability, spend, spawn, and Assignment via new primitives, keeping the
  interpreter engine-agnostic (ADR-0006).
- Deferred: production queues, rally points beyond "the assigned Flow moves it," cancel/refund,
  and per-Building tech requirements.
