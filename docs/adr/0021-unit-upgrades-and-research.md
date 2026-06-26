# Unit Upgrades: player-wide retroactive stat modifiers, unlocked by a blocking Research Action

Buildings produce Units (Train, ADR-0013) and ADR-0013 explicitly deferred "per-Building tech
requirements". This ADR introduces **Upgrades** — permanent improvements to a Unit type — and
**Research**, the Building-scoped Action that unlocks them. Two decisions here are hard to reverse
and were genuine forks, so they are recorded together: neither ships without the other.

## What an Upgrade is

An Upgrade is a single-unlock, single-Unit-targeted improvement living in a pure data table
(`upgrades.js`: `id`, `label`, `unitType`, `cost`, `researchTime`, `requires`, and either
`modifiers` or `grants`) — the same data-table call ADR-0008/0012/0013 made for gather rates, combat
stats, and production. It is **not** a Parameter on any Node. An Upgrade carries either:

- **stat modifiers** — additive deltas to its target type's stats (e.g. `{ maxHealth: +30 }`), or
- an **ability grant** — a named flag (`grants: ['splash']`) the world reads for Upgrades that
  change *how* a Unit fights rather than its numbers.

## Decision 1 — Upgrades are player-wide, retroactive, applied through an `effectiveStats()` seam

Today combat (`combat.js`) and movement read a Unit's stats *live every tick* straight from the
`UNIT_TYPES` table via `getUnitType(unit.type)`. There is no per-Unit copy of stats. To make
"researched Combat Shields ⇒ +30 health" real, we introduce a player-wide upgrade registry (a
sibling to `_stockpile`) and route every stat read through a new `effectiveStats(runner)` helper
that returns `base table stats + the deltas of researched Upgrades for that type`. The `UNIT_TYPES`
table is reframed as **base** stats, not final ones.

The effect is **retroactive and player-wide**: because stats are read at use time, every Unit of the
type — those already fighting and those trained later — gains the Upgrade the instant Research
completes. The registry is **Player-only** (Enemies get harder through Wave data, ADR-0014, not
teching) and **per-playthrough** (it resets with the level and is not saved, exactly like the
Stockpile; Runs already restart from scratch on reload).

**Alternative rejected — per-Unit snapshot at spawn.** Copying stats onto a Unit when it is trained
keeps `getUnitType` as the single source of truth and needs no `effectiveStats` seam. But it is the
wrong feel ("I researched armour and my standing army didn't get tougher") and makes the *timing* of
training fiddly. Player-wide retroactive is the genre-standard mental model and makes the research
investment a clean strategic decision. The cost we accept is the indirection: stat consumers must go
through `effectiveStats`, and *speed* (which lives on the entity, not the table) must be reached by
that seam too if a speed Upgrade is ever added.

A reserved `requires: []` prerequisite field ships from day one (empty today). The model stays flat —
every Upgrade is independently researchable — but the hook is there so a future tech-tree ADR needs
no data migration.

## Decision 2 — Research is a blocking Building-scoped Action with a player-wide in-progress Claim

Research mirrors Train (ADR-0013): a Building-scoped Action whose `unitType`-constrained dropdown
offers only Upgrades targeting a Unit the Building produces (a Barracks researches its infantry's
Upgrades). When the cursor reaches it, Research **blocks until the Stockpile affords the Upgrade's
cost**, deducts it, waits the Upgrade's `researchTime` (reusing Train's building progress bar), then
marks the Upgrade unlocked. Researching an already-unlocked Upgrade is a no-op that advances, so a
looping Flow ("Research → Train → loop") flows past it once done.

**Why blocking, not no-op-and-advance.** Build (ADR-0018) no-ops when unaffordable; Train blocks.
Research follows Train: it is a deliberate, expensive, one-time commitment, and blocking makes
"tech up, then mass units" a two-node line with no Branch — the same elegance ADR-0013 cites. The
accepted consequence is that a Building parked on an unaffordable Research is idle (not training)
until funded — identical to Train's existing trade-off.

**Concurrency — the in-progress Claim.** Because the unlock is player-wide but progress lives in a
Building's node scratch, two Buildings researching the same Upgrade would otherwise both pay and both
time it. So an Upgrade-in-progress is a player-wide **Claim** (a fourth form, see CONTEXT.md): the
first Building to start Research claims the Upgrade; a second Building reaching the same Research
**blocks** rather than paying twice, and advances once it completes. If the researching Building is
**destroyed** mid-Research the investment is **forfeited** and the Claim freed — the Upgrade is free
to Research afresh — mirroring how a razed Construction Site loses its build investment (ADR-0018).

**Alternatives rejected.** (a) *No-op-and-advance for a second Building* is cheaper but means a
Building does not wait for the tech it asked for. (b) *Refund on destroy* is more generous than the
rest of the game's mechanics; forfeiting makes Research a real, attackable commitment.

## Consequences

- A new `upgrades.js` data table and a player-wide upgrade registry (`_upgrades`: researched set +
  in-progress Claims) in MapScene, alongside `_stockpile`.
- A new `effectiveStats(runner)` seam; `combat.js` and stat consumers stop calling `getUnitType`
  directly for the upgradeable stats. Engine-agnostic: the interpreter reaches it through the
  `world` context (`research`, `upgradeResearched`), keeping ADR-0006 intact.
- A new Research node kind (descriptor + executor mirroring Train) and a new `upgradeType` Parameter
  type (a dropdown constrained by the Building's type, rendered like Train's `unitType`).
- A researched-Upgrades panel beside the Stockpile panel; the building progress bar is reused for
  Research-in-progress.
- Deferred: prerequisite tech trees (the `requires` hook is in place), Enemy upgrades, leveled
  Upgrades, and the remaining transforming Upgrades beyond the v1 splash proof (Shaped Charges).
