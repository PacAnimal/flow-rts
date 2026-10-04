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

## Amendment: Enemy variety is expressed as Flows, one per Wave

For a long time the decision above was true but unexercised: every Enemy ran the same two-node
rush, so the whole Scenario was answered by stacking damage at one door. The Signal nodes, the three
spare spawn edges and the 120x90 map all went unused, and the Enemy had exactly one idea.

The Scenario now carries a small registry of named **Enemy Flows** (`ENEMY_FLOWS` in
`src/scenario.js`), and each Wave names the one its Units are born running via the `flow` field
ADR-0014 already put in the Wave shape. Four exist: **rush** (straight at the Command Center),
**raid** (works the Deposit field first, camping it before turning on the base), **flank** (skirts a
quarter-turn around the base and attacks from an edge the briefing did not name), and **infiltrate**
(a plain Move, which engages nothing, so it walks through the defending line and only fights once it
is standing on the Command Center). This cost no new node kinds and no new systems — it is the
existing vocabulary pointed somewhere other than the front door.

**Destinations are injected, not hard-coded.** The builders stay pure: the world resolves the Tiles
each Flow needs for *this* Wave — the Deposit field that exists now, the staging Tile for this spawn
edge — and hands them in. Every builder falls back to the base when a Tile is unavailable (an
exhausted field, no Command Center), so an Enemy Flow always has somewhere to go. This keeps
`scenario.js` engine-free exactly as ADR-0006 requires of every non-world module.

**One Flow per Wave, not per Unit.** Enemies previously got a FlowModel each, because the rush baked
in its own target Tile. A Wave is one group with one plan, so it now builds one model that all its
Units share, each keeping its own Run — the shared-definition model of ADR-0003, which Enemy Flows
had been quietly departing from.

**Every Flow ends on a Hold at the base.** Attack-Move completes once it has arrived *and* is not
engaged (ADR-0012), so an Enemy arriving with nothing yet in range would run its line out and stand
inert for the rest of the match. The trailing Hold makes the end state a standing fight.

The Wave briefing (ADR-0014 amendment) names and colour-codes each Wave's Flow, because a timeline
that says only "10 Chojin from the south" is no longer the whole challenge.

Deferred: ranged and anti-Worker Enemy archetypes, which need Enemy Unit *types* (and art) rather
than Flows — the stat axis this amendment deliberately did not touch; per-Unit roles within one
Wave; and Enemy Flows that read Signals or react with Interrupts rather than running a fixed line.
