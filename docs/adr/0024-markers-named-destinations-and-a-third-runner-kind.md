# Markers: named destinations, and a third Runner kind

A Move destination used to be an absolute Tile picked on the map, so a player Flow was welded to
one map position: it could not be reused, could not be sensibly described (`Move → (74, 31)`), and
once START was pressed the player had no lever except editing nodes. We add the **Marker**: a
named, player-placed Tile. Player **Move** and **Attack-Move** no longer take a Tile at all. They
name a Marker (`Move → "front"`), and the world resolves that name to a Tile on every tick.

A Marker is also a **Runner** (CONTEXT.md), the third kind after Unit and Building. It can be
assigned a **Marker-Flow**, and its one Action is its own **Move**, which relocates the Marker
instantly. The player can script where a destination *is* (`OnWaveIncoming → Move(forward line)`),
and every Unit heading there follows.

## Decision details

- **Named Tiles over literal Tiles, for player Flows only.** Move / Attack-Move declare a
  `marker` Parameter (type `markerName`) and no longer declare `destination`. The executor resolves
  `world.markerTile(name)` each tick. Because Move already re-issues its goal every tick from the
  live model, and `setGoal` re-paths when the Tile changes (ADR-0007), a moved Marker re-routes
  every Unit on the node with no new machinery. Level-authored Enemy Flows still set a literal
  `destination` (the world injects it, ADR-0011 amendment). The executor reads it only when no
  Marker is named. It is undeclared, so the editor never shows it, and Enemy Flows are never edited.

- **Old player Flows are migrated on load, not honoured.** A Library Flow saved before this change
  carries a picked `destination` on Move / Attack-Move. Leaving it in place would keep steering
  Units by a Parameter the editor can no longer display. That is a Flow behaving differently from
  what it shows, the exact trap ADR-0023 exists to close. `FlowLibrary.load` drops it, and the node
  reads as unset (⚠) until a Marker is chosen. Only the Library is migrated. **Build** keeps its
  literal Footprint anchor: placing a specific structure on a specific spot is a different
  intent from "go to the front".

- **A Marker is a Runner, so its Flow is a Marker-Flow (amends ADR-0015).** `targetKind` gains
  `'marker'` beside `'unit'` and `'building'`. The palette offers the common Events and Flow
  Control plus the Marker Action `MoveMarker` (titled *Move*), and the assign overlay offers a
  Marker only Marker-Flows. We reused the Runner machinery wholesale rather than inventing a "Marker
  script": Assignment, Run, Frames, Interrupts, Signals, the inspector and the reason line all
  work unchanged. A Marker has a Faction (Player, so its Signals are the player's) but **no
  Health**. It is not in `units` or `buildings`, so nothing targets it, nothing paths around it,
  and it occupies no Tile. This amends CONTEXT.md's "every Runner carries Health".

- **A Marker's Move teleports.** A Marker is a place, not a body, so there is no travel, and
  `MoveMarker` is instant like SetSignal. It is the one place a player Flow still names a literal
  Tile, which is the point: a Marker-Flow is where positions are authored. A pick that is not
  Walkable is snapped to the nearest Walkable Tile.

- **A missing Marker parks the Run; it does not complete the node (ADR-0023).** If the named Marker
  does not exist (never placed, or deleted), Move / Attack-Move return `running('no Marker named
  "front"')`. Completing instead would let `Move(front) → Hold` hold wherever the Unit happens to
  stand, a silent wrong answer. Parking says what is wrong, and the Run carries on the moment
  the Marker is placed. An *unset* Marker Parameter is still a no-op that advances (ADR-0004), and
  the editor flags it. Deleting a Marker never rewrites a Flow.

- **Names are identities: unique, and never renamed in place.** A Marker is referenced by name
  like a Signal. Unlike a Signal, a Marker is a thing that has to exist, so names are unique.
  There is no rename: renaming would silently re-point or orphan every Flow that names it, and
  delete-and-place is the honest equivalent. The editor's `markerName` input is free text backed by
  a datalist of placed Markers plus names Flows already use, modelled on `signalName`
  (ADR-0022). A Flow can name a Marker before the Marker exists.

- **Persisted with the Library; hand moves persist, Flow moves do not.** A Flow that says `front`
  is useless if `front` evaporates on reload, so Marker records `{ name, x, y, flowId }` are saved
  with the Library. A drag by the player is an authoring decision and is saved on release. A
  Marker-Flow's Move is behaviour and is world state, so Restart puts every Marker back where the
  player last left it. A Marker's Assignment lives on its own record rather than in the
  label-keyed Assignment map, because a player-chosen name could shadow a Runner label like
  "Worker 3".

- **Dragging is allowed while the match runs.** It is the player's one in-match lever that does
  not break the premise: it moves a *destination*, not a Unit. A drag snaps only onto Walkable
  Tiles.

## Dependency recorded

Persisting Marker Tiles is safe only because terrain, Deposits and Decorations are generated from
**fixed RNG seeds** in `MapScene`, so a Tile coordinate means the same place on every run. If terrain
ever becomes seeded per level or per playthrough, Markers must become per-Scenario world state
instead (like Signals and the Stockpile). A Flow naming a Marker that does not exist already parks
safely rather than breaking.

## Alternatives considered

- **A `marker` Parameter beside `destination`, with the Marker winning when set.** This keeps every
  old Flow working, but leaves two ways to say "go there". The literal Tile is the one this
  decision exists to retire from player Flows. Rejected in favour of requiring a Marker.
- **Markers as plain world objects with no Flow.** Simpler, but the player could then only move them
  by hand, and could not author a timed advance or a Signal-driven fallback point. Making them
  Runners cost almost nothing, because every piece of Run machinery already existed.
- **The word "waypoint".** CONTEXT.md reserves it in the opposite sense (a Path is made of waypoints).

## Consequences

- New: `FlowLibrary.markers` with `addMarker` / `removeMarker` / `getMarker` / `markerNames`.
  New world primitives `markerTile(name)` and `relocateMarker(marker, tile)`. The `markerName`
  Parameter type and the `MoveMarker` node kind. A Markers HUD panel (place, centre on, delete) and
  draggable map pins in `MapScene`.
- Still open: a Marker on a Walkable Tile that is *unreachable* (an enclosed pocket) fails the old
  silent way, because `setGoal` marks a pathless goal as arrived (BACKLOG). Pre-placed Scenario
  Markers, which would replace the injected Enemy destination Tiles, remain a possible second step.
