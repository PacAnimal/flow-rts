# Backlog

Candidate work, written so a fresh session can pick one up without re-deriving the design. Each
task says **what**, **why it belongs in this game specifically**, **where the code is**, whether it
needs an **ADR**, and the **gotchas** found while reading the code.

This is a backlog, not a plan — nothing here is committed to, and the ordering inside a section is
rough priority, not a sequence. `CONTEXT.md` and `docs/adr/` remain the sources of truth; where a
task contradicts them, they win and the task is wrong.

Effort tags are **S** (an afternoon), **M** (a day or two), **L** (more, or needs art).

---

## Next up

*Empty — Markers shipped (ADR-0024). Pick from below.*

---

## Observability — the authoring loop

The wave briefing and Run reasons (ADR-0023) landed; these are the rest of that argument.

### Live cursor heat in the editor · **S**
While the sim runs, tint each node with how many Runners' cursors sit on it right now
(`Gather ×12`). Run cursors are already read every frame by `_syncInspector`; the editor is a DOM
overlay, so this is a class and a count. It turns the editor into a live dashboard and is the
feature that finally makes ADR-0005's live-model-read *feel* like the signature mechanic.

### Stalled-Runner badges on the map · **S**
An icon over any Runner whose Run is `halted`, or has sat on one node past a threshold with an
unchanged `run.reason`. ADR-0023 deliberately deferred this as an alert-*policy* decision layered
on the reason contract; the data is now there. Decide: what counts as stalled, and for how long.

### Signals readout · **S**
A HUD list of currently-raised Signals and who raised them. Deferred explicitly in ADR-0022's
consequences. Signals are invisible today, which makes the coordination system hard to trust.

### Spin-rule detection in the editor diagnostics · **S**
`CONTEXT.md` documents that an all-instant back-edge spins and ends the Run, and
`src/flow/templates.js`'s checks already detect it statically. `_diagnostics()` in `editor.js`
covers unset required Parameters and unreachable nodes but not this. Port the cycle walk from
`check_starters` over: for each cycle, if every node kind is instant (`Branch`, `SetSignal`,
`Build`, Events), flag it. It is the single most likely authoring mistake and it is detectable.

---

## Flow language

### Call Flow — a Flow as a subroutine · **M** · needs an ADR
A node that runs another Flow and returns. The machinery already exists: ADR-0019's Frame stack is
exactly a call stack, `pushHandler` is the push, and `flowRef` is an existing Parameter type
(`Train` uses it). Needs a recursion guard against `MAX_STACK_DEPTH`. This is the highest-value
language addition available and far cheaper than it looks — it lets a player build reusable
behaviours ("gather cycle", "survival reflex") and compose them, which is the natural next step
after Categories organised the Library.

### Counted Repeat · **M** · needs an ADR
`Repeat N times`. The Frame scratch resets on node re-entry, so the count needs to live beside
`run.timers` (keyed by node id) rather than in `run.state` — `timers` is the existing precedent for
per-node state that survives re-entry. ADR-0014 named the absence of counted loops as the reason
Waves are data rather than a spawner Flow, so landing this reopens that "purist" option.

---

## Economy and combat

### Repair · **S**
Deferred in ADR-0018's consequences, and the obvious missing Worker verb. Reuses the Construct
claim/slot machinery almost verbatim. Gives the Command Center (1500 HP, and the lose condition) a
counterplay other than killing them first — and the new `raid` and `infiltrate` Enemy Flows make
damage-at-the-base routine rather than terminal.

### Supply cap · **M**
There is none, so optimal play is "train until the alloys run out" and `Build` has no reason to
fire more than twice. A `supply` cost per Unit type and `supplyProvided` on a buildable depot adds a
production decision; the `unit_count` Condition already exists to author against it. Medium value —
it constrains without adding texture on its own, so do it after something that adds texture.

### Lean into Biopulp · **S**
Corpses becoming harvestable Deposits (`_spawnBiopulpDeposit`) is the most original economic idea
in the game and currently a footnote. It is a risk/reward loop that only works in an authoring
game: harvesting the battlefield needs a Worker Flow with a survival reflex, and you have to commit
to that gamble before the match. Tune yields so the Zapper/Reaper line is genuinely gated on it.

**Blocked by** the Gather-resume bug below — a flee-and-return Worker Flow does not currently work,
which is the exact Flow this loop requires.

### Ranged and anti-Worker Enemy types · **L** · needs art
The two archetypes cut from the Enemy Flow work (ADR-0011 amendment, "Deferred"): a **sieger** that
outranges a melee line and shells Buildings, and a **worker-hunter** that beelines past the army.
Both are *stats*, not behaviours, so they need Enemy Unit **types** — and therefore sprites, because
`Unit` uses the texture prefix as the data-table key (`this.type = texturePrefix`), so a stat
variant cannot borrow the Chojin art without breaking that convention. Either commission art, or
decide to decouple type from texture (which is its own ADR, against a documented convention).

Until then the player's Tank/Mech/Marine roster has no rock-paper-scissors to answer, because every
Enemy is melee.

---

## Cheap wins

### Run metrics on the end banner · **S**
Nodes authored, Flows used, edits made after START, peak army, Resources left in the ground. Gives
a one-and-done Scenario replay value and quietly scores the hands-off ideal the game is about.

### Export / import Flows as JSON · **S**
The Library is `localStorage`-only; `toJSON` / `fromJSON` already exist on both `FlowLibrary` and
`FlowModel`. Sharing a clever Flow is the natural social hook for this genre, and it is most of a
backup story too.

---

## Found while working — these want a decision

### Gather resumes from a stale Frame after an Interrupt · **bug**
A Worker interrupted mid-`Gather` keeps `state.arrived = true` and its Claim in the Frame scratch.
ADR-0019's freeze-and-continue restores that scratch exactly, so after (say) `OnDamaged → Retreat`
pops, the Worker — now standing at the Command Center — skips the approach, runs the harvest timer
down and calls `world.collect`, which has **no adjacency check** (`_collect` in `MapScene`). It
harvests a Deposit across the map.

This is why `src/flow/templates.js` ships "Stand Guard" (whose `Hold` re-issues cleanly on resume)
rather than the gather-and-flee Flow that would otherwise be the best teaching example, and it
blocks the Biopulp task above.

Options: have `Gather` re-validate adjacency on resume (clear `arrived` when the Worker is no
longer beside its claimed Deposit); or have `_collect` refuse at range; or give an executor a
`resume` hook so freeze-and-continue is not always literal. The third is the general fix and the
one that probably deserves an ADR, since it amends ADR-0019.

### Unreachable Move destinations fail silently · **S**
`MovementSystem.setGoal` sets `arrived = true` when `findPath` finds no route, so a Move to an
unreachable Tile completes immediately and the Flow continues as though it arrived. ADR-0023 gives
this a home now — report it as a reason, or surface it on the node. Markers (ADR-0024) closed half
of it: a Marker can only sit on a Walkable Tile (placement, drag and a Marker-Flow's Move all
enforce it). A Walkable Tile in an enclosed pocket still fails the old silent way.

### Marker follow-ups (ADR-0024)
- **Pre-placed Scenario Markers.** Enemy Flows still get literal Tiles injected
  (`_enemyTargetTile` / `_enemyEconomyTile` / `_enemyFlankTile`); Scenario-owned Markers would
  express the same thing and let the Enemy reuse the `marker` path. Needs a decision on whether
  Enemy Flows may see player Markers (today `markerTile` is player-wide and Enemies never ask).
- **A starter Marker-Flow.** No starter teaches Marker-Flows yet; e.g. `OnWaveIncoming → Move` to
  push the `rally` line forward before each Wave.
- **Off-kind Events in the Marker palette.** `OnDamaged` and the Unit-centric Branch Conditions
  are offered on Marker-Flows (they are `runner: 'any'`) but can never fire / are always false
  there. Harmless; a per-kind exclusion would tidy the palette.
- **Unvalidated:** the Markers panel at narrow widths, and whether it collides with the wave
  briefing on short windows.

### Unvalidated by anyone who has played it
- The Wave mix across the four Enemy Flows (three raids, two infiltrations) changes the Scenario's
  difficulty and was never played, only reasoned about.
- The briefing's Flow tags and the six-button speed toolbar have not been looked at on screen,
  particularly at narrow window widths.

---

## Done

| Shipped | Commit |
| --- | --- |
| Wave briefing (ADR-0014 amendment) + Run reasons (ADR-0023) | `0f07712` |
| Enemy Flows per Wave: rush / raid / flank / infiltrate (ADR-0011 amendment) | `903abfe` |
| Starter Flows seeded into the Library; ×8 / ×16 speed with a clamped substep | `d9acdf9` |
| Markers: named, draggable destinations that are also Runners; player Move / Attack-Move require one (ADR-0024) | *working tree* |
