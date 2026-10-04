# Flow RTS

A real-time-strategy game you play **indirectly**. You never select a unit and tell it where to
go. Instead you author **Flows** — node graphs — in a visual editor, assign them to the Units and
Buildings on the map (collectively **Runners**), press Start, and watch your program play the match.

The current Scenario is a survival defence. Workers gather from Deposits, a Command Center trains
and builds, a Barracks and Factory field an army, and fifteen escalating Waves of Chojins arrive
over roughly ten minutes. They do not all come the same way: a Wave may **rush** the Command Center,
**raid** the Deposit field and camp it killing Workers, **flank** in from an edge it did not spawn
on, or **infiltrate** — walk straight through your line without stopping to fight and only engage
once it is standing on your base. You win by outlasting every Wave; you lose the moment the Command
Center falls. Every decision your side makes during those ten minutes was authored before the clock
started.

Vanilla ES modules, Phaser 3 for rendering, Vite for dev/build. No framework, no TypeScript
(JSDoc types only), no test suite.

## Quick start

```bash
npm install
npm run dev       # http://localhost:8090, with HMR
```

```bash
npm run build     # production bundle to dist/
npm run preview   # serve the built bundle
```

Node 18+ (Vite 5). There is no test framework and no linter configured — changes are verified by
running the dev server.

Useful URL flag: `?groundOnly` renders just the procedural ground shader, skipping the terrain
tilemap, Buildings, Units and Decorations. Handy when iterating on the GLSL.

## Playing a match

1. **Read the briefing.** The Wave panel on the left lists the Scenario's whole timeline — when
   each Wave lands, how many Enemies of which type, the map edge they come from, and which Enemy
   Flow they run (hover a row for what that Flow does). That is the challenge you are authoring
   against; it folds down to a next-Wave countdown once you press Start.
2. **Open the editor** — the button on the canvas, or press `F`.
3. **Pick or create a Flow** in the Library panel. A Flow targets one Runner kind (Unit,
   Building, or Marker); a Building-Flow further targets one building type, which fixes the Units its Train
   node offers. Flows can be filed under a freeform Category to keep the Library tidy.

   On a first run the Library is seeded with five **starter Flows** under a *Starters* Category —
   Gather Loop, Stand Guard, Rally and Hold, Train Workers to 6, Train Marines to 8. They are
   ordinary Flows (edit them, clone them, delete them) and between them they demonstrate the three
   idioms nothing else announces: a loop is a Connection wired *backward* and must contain a node
   that waits; an Interrupt reacts without the main line polling; a Branch caps a production loop.
   Assign Gather Loop to your Workers and Train Workers to 6 to the Command Center and you have a
   working economy without authoring anything. Only Rally and Hold needs something from you: a
   Marker named `rally` to head for. Until you place one, its Units wait on Move and the inspector
   says why.
4. **Author it.** Drag node kinds from the palette onto the Canvas, wire Exec output → Exec input,
   and fill in each node's Parameters. Move and Attack-Move name a **Marker** rather than a Tile;
   Build's Location is picked by clicking a Tile on the map.
   There is no loop node: a loop is a Connection wired *backward* to an earlier node, gated by a
   Branch and paced by a Wait. `Ctrl/Cmd+Z` undoes, `Delete` removes the selection, `Esc` clears it.
5. **Place Markers.** The Markers panel (bottom-left) places a named Marker: type a name, then
   click a Tile. Drag a pin to move it at any time, even mid-match. Every Unit heading for that
   Marker re-routes, which is your one in-match lever that commands no Unit. A Marker is a Runner
   too: assign it a Marker-Flow, and that Flow's Move relocates it (ADR-0024).
6. **Assign it.** Close the editor and click a Runner. The assign overlay lists only the Flows that
   match that Runner — Unit-Flows for Units, this-building-type Flows for Buildings. Assigning
   replaces any previous Assignment and starts a fresh Run.
7. **Press ▶ Start.** The toolbar also carries Pause, ↻ Restart, and a ×1–×16 speed control (the
   sim is advanced by running that many substeps per rendered frame, not by scaling time, so
   steering and Tile occupancy stay stable at speed). While
   the simulation runs, clicking any Runner docks the editor beside the map as a read-only
   inspector with that Runner's current node highlighted, plus a status line saying what that node
   is doing *and why it is waiting* — "every Deposit in reach is claimed by another Worker",
   "waiting for 30 alloys" (ADR-0023). That is the way to see what your Flow is actually doing.

Drag the map to pan, scroll to zoom. The Library persists to `localStorage`, so your Flows survive
a reload, and so do your Markers, at the spot you last dragged them to. Runs do not: reloading restarts every Runner from its Flow's On Start.

Because a Flow is a *shared definition*, assigning one Flow to six Workers means all six run the
same definition and an edit changes all of them at once — while each keeps its own execution state.
Several mechanisms exist so that shared Flows don't make Runners pile up: a gathering Worker
**claims** a Deposit so the crew spreads across the patch, a Construction Site admits four Workers
at once, and a Move with *spread* set sends each Runner to its own Tile near the destination.

## The Flow language

A node is an Event, an Action, or a Flow Control node. Events start execution; Actions do something
in the world; Flow Control directs execution between nodes.

### Events

| Node | Fires |
| --- | --- |
| On Start | Once, when the Flow begins running on that Runner — roots the Run's base Frame |
| On Timer | After a delay, optionally repeating |
| On Damaged | When the Runner takes damage |
| On Wave Incoming | A configurable lead time before the next Wave spawns |
| On Signal | On a named Signal's rising edge |
| On Signal Lowered | On a named Signal's falling edge |

Every Event except On Start is an **Interrupt**: it preempts the running Frame, pushes a handler
Frame on top of the Run's stack, and the suspended Frame resumes exactly where it was once the
handler's chain ends (ADR-0019). A Flow with no On Start at all is still valid — it just sits armed,
purely reactive.

### Actions

Unit Actions: **Move** (A\* path to a named Marker, optionally spread), **Gather Resources**,
**Deliver Resources**, **Attack-Move**, **Hold Position**, **Retreat**, **Construct**, and
**Roam and Attack** (the critter behaviour).

Building Actions: **Train Unit** (blocks on the Stockpile, then produces a Unit already running a
Flow you nominate), **Research Upgrade**, and **Build** (places a Construction Site for Workers to
raise).

Marker Action: **Move**, which relocates the Marker to a Tile instantly.

**Set Signal** works on any Runner.

### Flow Control

**Wait** holds execution for a duration. **Branch** evaluates a Condition the instant the cursor
reaches it and routes to its Yes or No output.

Conditions are a fixed catalog, not a wired value: *Cargo full*, *Cargo empty*, *Deposit adjacent*,
*At command center*, *Stockpile ≥ N*, *Enemy in range*, *Enemy nearby (radius)*, *Own health below
%*, *Own unit count ≥ N*, *Own building exists*, *Signal raised*.

### Signals

A Signal is a named boolean shared across a Faction — a blackboard that lets pre-authored Flows act
as a team without one Runner naming another. A Command Center raises `defend`; every Marine's
On Signal `defend` handler sends it home. Signals are scoped per Faction, so Player and Enemy Flows
never read each other's.

## Architecture

### The central seam: engine-agnostic interpreter ↔ injected world (ADR-0006)

The most important boundary in the codebase. The Flow interpreter imports nothing from Phaser and
never touches a sprite. Everything a node needs to *do in* or *ask of* the game goes through a
`world` context object — a flat bag of primitive callbacks (`moveToward`, `collect`, `deliver`,
`test`, `attackMove`, `train`, …). `MapScene` builds the only real `world`, backed by Phaser.

That keeps the interpreter and every system and data module pure and engine-free; `MapScene` is the
single Phaser-aware game-logic file.

### Module map

**Flow model, execution, editor** (`src/flow/`)

| File | Role |
| --- | --- |
| `model.js` | `FlowModel` — a plain, JSON-serializable graph of nodes + connections, and the connection rules (exec→exec, output→input, exec-output cardinality of 1) |
| `nodeKinds.js` | Pure, serializable descriptors for every node kind: category, title, ports, params, and the Runner kind it applies to |
| `runtime.js` | The interpreter. `startRun` / `tickRun` advance a per-Runner Run over a stack of Frames, reading the *live* model each tick so edits take effect mid-Run |
| `editor.js` + `editor.css` | The editor: a hand-built DOM overlay with an SVG connection layer, above the Phaser canvas — not a Phaser scene (ADR-0001) |
| `library.js` | `flowLibrary`, the app-wide collection of named Flows, persisted to `localStorage` |
| `store.js` | A tiny Svelte-store-shaped reactive cell that drives editor re-renders |
| `assign.js`, `positionPicker.js` | The assign overlay, and picking a map Tile for a `tile` Parameter |

**The world** (Phaser side)

- `src/scenes/MapScene.js` — the orchestrator: terrain generation, the procedural-ground GLSL
  shader, the tilemap, the shared Tile-occupancy layer, Deposits and Decorations, the per-frame
  update loop (tick every Run → resolve combat → integrate movement → advance the Wave clock → sync
  sprites), the HUD, the `world` context, and every world primitive the interpreter calls.
- `src/entities/` — on-map sprite wrappers. `runner.js` is the shared Runner mixin (Health,
  Faction, health bar); `Unit.js` / `Building.js` are the bases and the rest are thin
  type-specific subclasses.

**Pure systems** (no Phaser)

- `src/movement.js` — static A\* terrain Path plus dynamic per-frame steering: arrive, separation,
  overlap resolution. Other Units are avoided locally, not pathed around (ADR-0007).
- `src/pathfinding.js` — A\* over the walkable Tile grid, with string-pull smoothing.
- `src/combat.js` — a Unit carries a combat *intent* set by the Attack-Move / Hold executors; this
  system acquires targets, drives chase/stop into the movement system, and applies Damage by
  callback (ADR-0012).

**Data tables** (pure, no game state) — game numbers live here, not as node Parameters, so adding a
type is a new table entry:

- `src/units.js` — `UNIT_TYPES` / `BUILDING_TYPES` (health, damage, range, aggro, cooldown, cost,
  buildTime, carry capacity) and `FACTION`.
- `src/resources.js` — Alloys, Sludge, Biopulp: gather time, yield, deposit amount, sprites.
- `src/upgrades.js` — the Upgrade catalog: cost, research time, and the stat modifiers or ability
  each grants.
- `src/conditions.js` — the Branch Condition catalog (metadata only; evaluation lives in MapScene).
- `src/decorations.js` — scatterable scenery and Footprints.
- `src/scenario.js` — the survival Waves and the named Enemy Flows each Wave runs (rush / raid /
  flank / infiltrate), plus the critter Flow. All data-authored and deliberately kept out of the
  Library; the world injects the destination Tiles so the builders stay engine-free.

## Repo layout

```
src/            game source (see module map above)
docs/adr/       24 Architecture Decision Records
CONTEXT.md      the domain glossary — the source of truth for terminology
CLAUDE.md       working notes for Claude Code
index.html      Vite entry
sprites/        unit, building, Deposit and Decoration art
public/         assets copied verbatim into the build (favicon, terrain tileset)
models/         3D source models for the sprite pipeline
concepts/       concept portraits and model-generation scripts
scripts/        offline sprite-pipeline tools (not part of the game runtime)
```

## Documentation

Two places hold the design intent, and they are the source of truth for *why* the code is shaped
the way it is:

- **`CONTEXT.md`** — the domain glossary. Terminology is enforced with discipline: every term has a
  precise meaning and a list of words to avoid. A Flow is not a "graph"; a Deposit is not a
  "resource node". The vocabulary is expected to hold in code, identifiers and comments.
- **`docs/adr/`** — 24 Architecture Decision Records. Code comments cite them constantly (e.g.
  `docs/adr/0006`); when you touch a subsystem, the matching ADR explains the constraint you need
  to preserve. A significant new architectural decision means a new ADR.

## Art pipeline

The `scripts/` directory holds offline tooling, not game code. Run it by hand when regenerating art.

- Python (Pillow + PyMatting): `cut_sprites.py` slices sprite sheets, `remove_bg.py` does
  alpha-matte background removal, `build_terrain_tileset.py` assembles the terrain tileset PNG.
- Node: `render_sprites.mjs` renders a 16-direction sprite sheet from a GLB model, and the
  `rig_*.mjs` / `test_*.mjs` scripts drive and diagnose the character rigs in `models/`.

## Status

Early and actively changing — version 0.1.0, one Scenario, no save beyond the Library.

Two things to know before poking at it: the game is developed and run through the Vite dev server,
and most art lives in `sprites/` at the repo root, which Vite serves in dev but does not copy into
`dist/` — only `public/` is. A production build therefore isn't the supported way to run the game
today.
