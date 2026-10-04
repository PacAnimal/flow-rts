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

### Named map locations, as a new Parameter type  · **M** · needs an ADR

**What.** Two halves of one feature:

- a **Marker** — a named, player-placed Tile on the map (`front`, `home`, `north gate`), which the
  player drops and can drag while the match runs; and
- a new **Parameter type** that points at one by name, so `Move`, `Attack-Move` and `Build` can take
  `Move → "front"` in place of an absolute Tile. The name is resolved through the `world` at run
  time — the same trick `Retreat` already uses to find the nearest Command Center without naming a
  destination (`retreatDest`), generalised to a place the player names.

**Why this game.** Two problems, one feature:

- *Flows are welded to one map.* A Move destination is an absolute Tile picked on the map, so a
  Flow cannot be shared, reused on another Scenario, or even sensibly described. `Move → "front"`
  is portable; `Move → (74, 31)` is not.
- *The player has no legitimate in-match agency.* Once START is pressed the only lever is editing
  nodes. Dragging a Marker is a lever that does **not** break the premise: you are moving a
  *destination*, not commanding a Unit. Every Runner running `Move(front)` re-routes, because
  `Move` re-issues its goal every tick from the live model and `setGoal` recomputes the Path when
  the destination Tile changes (`src/movement.js`). The mechanism already works — this only gives
  it a handle.

It also pairs with Signals (ADR-0022): `OnSignal "defend" → Move(home, spread) → Hold` is a
complete, readable defensive doctrine, and the player repositions `home` without touching it.

#### Naming — read this first

**Do not call it a Waypoint.** `CONTEXT.md`'s **Path** entry already reserves that word in the
opposite sense: *"a Path is made of waypoints"*, and lists `waypoints` under its _Avoid_ list. A
named map location is not a Path waypoint, and this project enforces that distinction.

Recommended term: **Marker** — a named Tile the player places on the map. No collision with any
existing entry. Alternatives if Marker reads too UI-ish: **Landmark**, **Post**. Avoid *rally
point* (ambiguous with `Move` + `spread`, ADR-0020), *beacon*, *flag*, *pin*.

The new CONTEXT.md entry should say roughly: a named Tile on the map that a Parameter may reference
in place of a literal Tile; player-placed and movable while the match runs; the name is freeform
like a Category or a Signal name, so the set in play is whatever names are in use.
_Avoid_: waypoint (reserved — see Path), rally point, beacon, flag, pin.

#### Design

1. **Storage: persist them with the Library.** A Flow that references `front` is useless if `front`
   evaporates on reload, which is the asymmetry that would make this annoying rather than useful.
   Persisting is safe *today*: terrain, Deposits and Decorations are generated from **fixed** RNG
   seeds (`mkRNG(42)`, `(77)`, `(1337)`, `(2718)`, `(7777)` in `MapScene`), so the map is identical
   every run and a Tile coordinate means the same thing across reloads.

   Record that dependency in the ADR. If terrain ever becomes seeded per level or per playthrough,
   Markers must become per-Scenario world state (like Signals and the Stockpile) instead, and a
   Flow referencing a missing Marker must stay inert rather than break.

2. **A `marker` Parameter beside `destination`, not replacing it.** Add a `marker` param of a new
   `markerName` type to `Move` / `AttackMove` / `Build`. When set it wins; when unset the literal
   `destination` is used as today. This keeps every existing Flow working and matches ADR-0004's
   framing of a Parameter as a default that something else may override.

3. **A `markerName` Parameter type**, modelled *exactly* on `signalName` (ADR-0022): a free-text
   input backed by a `<datalist>` of names already used across the Library. Copy
   `_signalNames()` in `src/flow/editor.js` — the harvesting logic is the same shape.

4. **One world primitive** (ADR-0006): `markerTile(name) → {x,y} | null`. The executors resolve
   through it:
   ```js
   const dest = node.params?.marker ? world.markerTile(node.params.marker) : node.params?.destination;
   if (!dest) return done();   // unset or unknown Marker is inert (ADR-0004)
   ```

5. **Placing and moving them.** A HUD control ("＋ Marker"), then name it, then pick a Tile.
   `src/flow/positionPicker.js` already does picking: the editor asks, the scene provides
   (`registerPositionPicker`), and it supports a `footprint` preview. Reuse it unchanged. Render
   each Marker as a small labelled pin; dragging the pin calls the same setter.

#### Where

| File | Change |
| --- | --- |
| `src/flow/nodeKinds.js` | `marker` param on Move / AttackMove / Build |
| `src/flow/runtime.js` | resolve `marker` before `destination` in those three executors |
| `src/scenes/MapScene.js` | `_markers` map, `markerTile` on `this._world`, placing/dragging, pin rendering |
| `src/flow/editor.js` | `markerName` param type + datalist; `REQUIRED_PARAMS` (see gotchas) |
| `src/flow/library.js` | persist Markers alongside entries, if storing them with the Library |
| `CONTEXT.md`, `docs/adr/00XX` | the new term; the ADR |

#### Gotchas

- **`REQUIRED_PARAMS` will false-flag.** `src/flow/editor.js` has
  `Move: ['destination'], AttackMove: ['destination'], Build: ['buildingType', 'destination']`.
  With a Marker set, `destination` is legitimately empty — the diagnostic needs to become
  "`destination` **or** `marker`", or every Marker-driven node shows a ⚠.
- **An unwalkable or unreachable Marker fails silently.** `MovementSystem.setGoal` sets
  `arrived = true` when `findPath` returns nothing, so a Move to an unreachable Tile *completes*
  and the Flow walks on as if it had arrived. ADR-0023 now gives you the place to say so: return
  `running('Marker "front" is not reachable')`, or snap the Marker to the nearest walkable Tile on
  placement. Worth fixing as part of this — it is the same silent failure as the separate task
  below, and Markers will make it much more common.
- **Deleting a Marker that Flows reference.** Treat it like an unset Parameter (inert, ADR-0004),
  not an error. Never auto-rewrite a Flow.
- **The Scenario could use these too.** Enemy Flows currently get literal Tiles injected by the
  world (`_enemyTargetTile` / `_enemyEconomyTile` / `_enemyFlankTile`, ADR-0011 amendment).
  Pre-placed Scenario Markers would be a tidier way to express the same thing — optional, and a
  second step.

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
this a home now — report it as a reason, or surface it on the node. Fold into the Markers task,
which makes it far more common.

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
| Starter Flows seeded into the Library; ×8 / ×16 speed with a clamped substep | *working tree* |
