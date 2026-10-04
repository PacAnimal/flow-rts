# A Scenario owns Waves and the Objective as level data, separate from Flows

A survival level needs a threat (enemies arriving over time) and victory rules (survive until
done; lose if the base falls). Neither belongs in a player **Flow** — the player authors unit
behaviour, not the challenge — and neither sits naturally on an Enemy Runner's Flow. We
introduce a **Scenario**: the level-as-data, the counterpart to the **Library**. The Library is
what the player authors; the Scenario is the fixed challenge the world enforces. It owns two
things:

- **Waves** — a data timeline of `{ at, count, unitType, flow, spawnPoint }` entries the world
  plays out. Each spawned Enemy Unit is *born running* a data-authored Flow, the same
  born-with-a-Flow mechanism `Train` uses (ADR-0013), so spawned enemies need no special path.
- **Objective** — win/lose rules evaluated by the world: **lose** when the Command Center is
  destroyed (ADR-0012 Health); **win** when every Wave has spawned **and** no living Enemy
  remains (clear-the-last-wave). This is self-pacing and needs no separate timer concept; a
  survival-timer variant can layer on later as another Objective type.

## Why a data timeline, not enemy-spawner Flows

Waves *could* be an Enemy spawner Building running a data-authored Flow
(`OnStart → Wait → Train → Wait → …`) — maximally consistent with "everything runs on Flows,"
and zero new spawning code. We rejected it for v1 because escalating, counted waves are exactly
what the Flow model can't express cleanly: there is no counted loop and no variables (we
declined both — see the loop decision), so "spawn 10" becomes ten chained `Train` nodes and
ramping difficulty is unwieldy. A data timeline makes counts, timing, multiple spawn points, and
escalation trivial and iteration-friendly — and wave balancing is iteration-heavy. Enemies still
*run* Flows once spawned; only the *schedule* is data, not a Flow.

Keep the enemy-spawner-Flow approach in mind as the "purist" option if variables/counted loops
ever land.

## Why the Objective is world-evaluated, not a Flow

It reads global state (the Command Center's Health, how many Waves remain) and ends the match —
neither is a per-Runner behaviour. It follows the same "world owns evaluation" seam as Conditions
(ADR-0010): the Scenario declares the rules as data; the world checks them.

## Consequences

- A new Scenario layer (level data) owns Waves and Objective; it is not a node graph and runs on
  no Runner. The world plays the wave timeline and checks the Objective each tick.
- Spawned enemies reuse Assignment-at-birth (ADR-0013) with data-authored Flows kept out of the
  Library (ADR-0011).
- The global Start/Pause gate (ADR-0005) now also gates the wave clock and Objective checks.
- CONTEXT.md gains **Scenario**, **Wave**, and **Objective**.
- Deferred: branching/scripted objectives, mid-level events, multiple/simultaneous objectives,
  reinforcement triggers tied to player state, and an authoring tool for Scenarios.

## Amendment: the Wave timeline is shown to the player

The original decision made Waves level *data* and said nothing about whether the player may read it.
In practice they could not: the timeline lived only in `src/scenario.js`. That quietly broke the
premise this whole game rests on — "every decision your side makes was authored before the clock
started" — because a challenge you cannot see is not one you can author against. `OnWaveIncoming`
gives a Flow a lead-time Interrupt, but it tells the *author* nothing about what is coming, how many,
or from where, so the only way to plan wave 11 was to read the source or lose to it once.

The Scenario's Wave timeline is therefore **public**: a HUD panel renders it straight from
`SCENARIO.waves`. Expanded it is a pre-match briefing — every Wave with its time, size, Enemy type
and the map edge it arrives from; collapsed it is a live next-Wave readout and countdown. It folds
itself the first time START is pressed, since the briefing has served its purpose by then.

This changes no seam. The panel only *reads* the Scenario and the wave clock and changes nothing,
exactly as the Objective does — the Scenario still declares the challenge as data and the world
still plays it. It is a decision about what the game *tells* the player, recorded here because
hiding the timeline was a (tacit) design choice and this reverses it.

Deferred: telegraphing a Wave's composition on the map itself (an arrow at the spawn edge), and
per-Wave Enemy Flows, which would make the briefing's "what is coming" meaningfully richer than a
count and a type.
