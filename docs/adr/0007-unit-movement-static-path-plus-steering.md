# Unit movement: a static A* Path plus a dynamic steering layer, both owned by the world

A Unit's Move is carried out by two stacked systems, mirroring how an RTS like StarCraft 2
separates "route around the terrain" from "flow around other units":

1. **Static terrain pathfinding.** When a Move begins, A* runs over the Walkable Tile grid
   (8-directional, octile cost, no diagonal corner-cutting through unwalkable Tiles) to find a
   route, which is then **string-pulled/smoothed** (drop a waypoint whenever the previous kept
   point has clear Walkable line-of-sight to the next) so the Unit takes natural any-angle
   segments instead of jagged grid steps. Terrain is fixed, so this Path is computed **once**
   and cached; if A* finds no route, the destination is unreachable and the Move completes
   immediately (the Unit gives up) rather than stalling the Flow.

2. **Dynamic local avoidance.** Every frame each Unit's velocity is `arrive-along-Path +
   separation` from nearby Units, clamped to Walkable terrain (wall-sliding), with a final
   pass that pushes apart any residual overlap. Units thus flow around one another in real
   time; other Units are never baked into the Path.

Both systems live on the **world** side (`MapScene`), not in the interpreter — extending
ADR-0006. Pathfinding needs the terrain grid and avoidance needs all-Units neighbour queries,
both of which are world concerns; keeping them there leaves the interpreter engine-agnostic.
The `Move` executor is unchanged: it calls `world.moveToward(runner, dest, dt)`, which only
sets/refreshes the Unit's goal and returns an `arrived` flag. Actual integration happens in a
single per-frame movement pass over all Units, run after Runs tick (so a Move sets its goal)
and before sprites sync. Idle Units take part in the pass too, so a crowd shoves them aside.

Alternatives considered:
- **Grid A* with no smoothing** — units move in visibly griddy steps; rejected on look.
- **RVO / ORCA** for avoidance — higher fidelity and near collision-free, but a large math and
  tuning surface; rejected for now in favour of steering+separation, which is far simpler to
  build and debug and reads as convincingly SC2-ish at this scale.
- **Pure positional push-apart** (no steering velocity) — units bump-then-separate instead of
  anticipating; rejected on feel.
- **Per-unit avoidance baked into A\*** (treating units as grid obstacles + frequent repath) —
  expensive and twitchy; the static/dynamic split is the standard answer.

Crowd handling: because many Units can run the same Flow toward the same Tile, arrival uses a
generous radius **and** a stuck-timeout (a Unit that stops making progress near the goal is
treated as arrived). Without this, Units would fight forever over a single destination Tile
and their Moves would never complete.

Consequences:
- A Unit gains a collision radius and per-Unit movement state (cached Path, current waypoint,
  arrived/stuck) held on the world side; none of it is persisted (consistent with the Run
  being momentary, ADR-0005).
- The A* + smoothing is a pure, Phaser-free module (testable with a Walkable predicate); the
  steering pass operates on Unit positions and a Walkable query, also Phaser-free.
- CONTEXT.md gains **Path** and a reachability distinction on **Walkable**.
- Deferred: flow-field group movement, RVO/ORCA, velocity smoothing/momentum, and richer
  repath/stuck-resolution. These can layer in without disturbing the static/dynamic split.
