# Decorations and a shared Tile-occupancy layer

Level spawning grew three independent things that each put stuff on Tiles — Deposits (tracked,
blocking), bespoke tree and obstacle placers (untracked, non-blocking, free to overlap), and
Buildings (a footprint-sized sprite that didn't block at all). Introducing **Decorations** was
the moment to unify them.

## Decorations are one data-driven concept

A **Decoration** is map scenery occupying a rectangular **Footprint** of Tiles (CONTEXT.md).
The separate tree/obstacle placers are replaced by a single placer driven by a types table
(`decorations.js`, pure data like `resources.js`): each type declares its sprite(s), footprint
`w×h`, and a `blocking` flag. Trees are non-blocking 1×1; holes (the `obstacle_NN` sprites) are
blocking 1×1; bigger/blocking types are just new rows. "Obstacle" is not its own concept — it
is a blocking Decoration.

The alternative (keep the bespoke placers, bolt footprint/overlap onto each) was rejected: it
duplicates the no-overlap logic and leaves "Decoration" informal.

## One shared occupancy layer drives both no-overlap and walkability

Every footprint feature — Deposit, Decoration, Building — registers its Tiles into a single
occupancy map, each marked blocking or not. Two consumers read it:

- **Spawn no-overlap:** a placement is rejected if *any* Tile of its footprint is already
  occupied (by anything). This is what keeps Decorations off each other, off crystals, and off
  the command center.
- **Walkability:** `walkable(t)` = terrain-walkable AND not a *blocking* occupant. A
  non-blocking Decoration (a tree) occupies its Tile for spawn purposes yet stays walkable; a
  blocking one (a hole), a Deposit, or a Building makes its Tiles impassable so Units path
  around them.

This unification also fixes a latent bug: Buildings drew a 3×3 sprite but didn't block, so Units
walked through the command center. Registering Buildings in the occupancy layer closes that.

Rejected: a Decoration-only overlap set that peeks at Deposits and the building footprint
separately. It splits occupancy across systems and leaves the walk-through-building bug.

## Spawn order, clearance, and best-effort placement

Order matters because earlier features reserve Tiles the later ones must avoid: terrain →
command center (reserves its footprint) → a clearance margin around the command center →
crystals → decorations → Units. The **clearance** (command-center footprint plus a few Tiles)
is reserved before scattering so the start area stays open and reachable; Units then spawn into
that clear space and avoid blocking occupants.

Placement is **best-effort**: each attempt picks a spot and is skipped if the footprint isn't
free (bounded retries), so target counts are "typically N", not guaranteed. With a sparse map
this is fine and far simpler than backtracking to hit exact counts.

## Crystals cluster as contiguous blobs

A crystal cluster grows from a seed Tile by repeatedly adding a random adjacent free Tile until
3–6 Deposits are placed, forming a connected patch (an SC2-style mineral line) instead of the
old ±4-Tile scatter that read as loose noise. Each crystal is a blocking Deposit and registers
in the shared occupancy like everything else. One **starter cluster** is guaranteed at the clear
Tile nearest map centre (just outside the command-center clearance), so Workers always begin
with crystals to gather near the base; the rest scatter randomly.

## Consequences

- New pure data module `decorations.js`; `MapScene` gains the occupancy layer
  (`_occupied`) with `walkable()` reading it, plus footprint helpers (free-check, reserve).
- Deposits register in the occupancy layer (still keyed separately for gather adjacency);
  Buildings register and now block; the tree/obstacle functions collapse into one placer.
- Occupancy is built fresh each level spawn and is not persisted (consistent with Runs/Cargo
  being momentary). Removing a Deposit frees its Tile in the occupancy layer too.
- Deferred: non-rectangular footprints, per-type terrain rules (e.g. trees on hilltops),
  exact-count placement, and decorations that change at runtime.
