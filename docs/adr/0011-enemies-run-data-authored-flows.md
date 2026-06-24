# Enemies are Runners driven by data-authored Flows, not a separate AI controller

Survival levels need hostile Units that attack the player. They could be driven by a bespoke
AI controller (a hardcoded behaviour loop per enemy type), or by the **same Flow interpreter**
that drives the player's Units. We chose Flows.

Every on-map thing that runs a Flow is a **Runner** (CONTEXT.md); an **Enemy** is simply a
Runner whose **Faction** is Enemy. Enemy behaviour is expressed as a `FlowModel` — the same
node-graph data the player authors — but supplied by the level, **not** added to the player's
**Library** and **not** editable in the editor. So enemies share the interpreter, the per-Runner
cursor (ADR-0005), and the combat action set, while staying invisible to the authoring UI.

## Why

- **Multiplayer collapses into one model.** If multiplayer arrives, an "enemy" is just another
  Faction's Runners. With Flows, PvE and PvP are the same system — a Faction's Runners run
  Flows; the only difference is provenance (a human's Library vs. level data). A bespoke
  controller cannot have human intent pointed at it, so it would be discarded the day PvP lands.
- **The combat action set is built once.** `Attack`, target acquisition, `Move`, and a loop
  construct are needed by the player's own combat Units regardless. Sharing the interpreter
  means enemies reuse them rather than duplicating the behaviours in a second language.
- **One tick path.** ADR-0006 deliberately made the interpreter drive "any thing with an
  assigned Flow and a cursor." A second AI controller reintroduces exactly the split that ADR
  removed — two codepaths, two sets of bugs.

## Alternatives considered

- **A simple per-type AI controller.** Less ceremony for brainless rushers, and the visual
  authoring payoff is lost on enemies anyway (players never see their Flows). Rejected because
  it does not generalise to multiplayer and duplicates the combat action set. Reconsider only if
  enemies stay trivially dumb *and* multiplayer is abandoned.

## Consequences

- Enemy Flows are authored as plain `FlowModel` JSON (hand-written or via a small helper), kept
  out of `flowLibrary`; the editor and assign overlay continue to list only Player Flows.
- Committing to this pulls perception/targeting and a loop construct forward — but the player's
  combat Units need those nodes anyway, so the cost is timing, not extra scope.
- Enemies carry per-Runner Run state like any Runner; consistent with Runs being momentary and
  unsaved (ADR-0005), a reload restarts enemy behaviour too.
- Deferred: an in-game editor for enemy/scenario Flows, and any notion of allied or neutral
  Factions beyond Player/Enemy.
