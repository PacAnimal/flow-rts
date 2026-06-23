# Combat Actions acquire their own target in the world; targets are not Data-ported values

A combat Runner must pick what to attack. The intuitive design — a `Find Enemy` node that
*produces a target* wired into an `Attack` node — requires the **Data-port** system
(typed values flowing along Connections) that ADR-0002/0004 reserved but never built, and that
ADR-0010 explicitly declined to build for Conditions. We make the same call for combat:
targeting stays out of the graph as wired data.

For v1, combat is a small set of **self-contained, stateful Actions** that acquire their own
target inside the world — exactly as `Gather` finds its own adjacent Deposit (ADR-0008). Nothing
is wired in. Two Actions cover the bulk of RTS combat:

- **Attack-Move** — moves toward a static Tile **Parameter** (no Data port needed); if an Enemy
  enters range en route, it stops and attacks until that Enemy is destroyed, then resumes toward
  the destination. The offensive push. Engagement and completion are pinned as follows:
  - **Engages within an aggro radius**, a per-unit-type stat slightly larger than attack range
    (not attack range itself) — so a Unit peels off to meet an approaching Enemy rather than
    walking past a threat just outside its reach.
  - **Completes on arrival**, reusing the ADR-0007 arrival radius + stuck-timeout. The
    **stuck-timer is suspended while the Unit is attacking**, so a Unit fighting near its goal
    cannot falsely "arrive" mid-fight; it resumes counting only once it is moving again.
- **Hold** (attack-nearest) — stationary; attacks the nearest in-range Enemy, no-op when none.
  The defensive stander / turret behaviour. Takes an **optional duration** (like Wait): unset/0
  holds the cursor indefinitely (a permanent guard — the default); a positive duration fights in
  place for that long and then advances, so reactive defence (`Hold(3s) → Move home`) composes.

Target selection lives in the **world** behind primitives like `world.attackNearest(runner)`,
the same engine-agnostic seam as `adjacentDeposit`/`collect`/`test` (ADR-0006). The interpreter
learns nothing about Health, range, or Factions.

## Why

- **Honors the Data-port deferral.** ADR-0010 rejected wiring values for one feature; targeting
  is the same shape and gets the same answer. No typed sockets, value nodes, or Data
  connections pulled forward.
- **Reuses the Gather precedent verbatim.** "Action finds its own subject in the world" is an
  established pattern here; combat slots straight into it.
- **Two Actions, broad coverage.** Attack-Move and Hold express offensive pushes and defensive
  lines without any target-reference machinery.

## Alternatives considered

- **(A) Targets as Data** (`Find Enemy` → wire → `Attack`). Maximally composable but forces the
  whole Data-port system into existence now; rejected for v1, kept as the eventual endgame once
  Data ports land for real.
- **(B) An implicit "current target" slot on the Runner** (like Cargo), set by an `Acquire
  Target` Action and read by `Attack` + target Conditions. More flexible than (C), but needs
  several extra nodes/Conditions and still can't express "move toward my target" without a
  dynamic destination (a Data port again). Documented as the next step **if** a persistent
  specific-target reference is later needed.

## Consequences

- New world primitives for target acquisition and attacking; all Faction/Health/range logic
  lives world-side. `Attack-Move` and `Hold` node kinds (Actions); Attack-Move carries a single
  Tile Parameter, Hold is parameterless.
- Combat timing (attack cooldown) uses the per-node Run `state`, like Wait/Gather, so it resets
  cleanly on re-assignment.
- The unit-type data table gains an **aggro radius** alongside attack range; the movement pass
  (ADR-0007) suspends the stuck-timeout while a Unit is mid-attack.
- A Unit's combat intent (`unit.combat`) persists until another combat Action overwrites it or a
  plain **Move** clears it — Move ends a combat stance, so a Unit can actually leave its post
  after a timed Hold (`Hold(3s) → Move`). A Run going idle at a post leaves the stance in place
  (the Unit keeps defending), which is the intended behaviour.
- Deferred: the target-slot model (B), Data-ported targets (A), focus-fire / target priority,
  retreat/kiting behaviours, and projectile visuals.
