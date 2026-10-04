# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flow RTS is a real-time-strategy game the player controls *indirectly*: instead of issuing
commands, the player authors **Flows** (node graphs) in a visual editor and assigns them to
on-map **Runners** (Units and Buildings), which execute them. The current scenario is a survival
defence — gather resources, train units, and survive waves of enemies.

Vanilla ES modules, Phaser 3 for rendering, Vite for dev/build. No framework, no test suite, no
TypeScript (JSDoc types only).

## Commands

```bash
npm run dev       # Vite dev server on http://localhost:8090 (HMR)
npm run build     # production build to dist/
npm run preview   # serve the built bundle
```

There is **no test framework and no linter** configured. Verify changes by running the dev server.

Useful URL flags: `?groundOnly` renders just the procedural ground shader (skips terrain tilemap,
buildings, units, decorations) — handy when iterating on the shader.

The `scripts/*.py` are offline sprite-pipeline tools (Pillow + PyMatting), not part of the game
runtime: `cut_sprites.py` slices sprite sheets, `remove_bg.py` does alpha-matte background removal,
`build_terrain_tileset.py` assembles the terrain tileset PNG. Run them by hand when regenerating art.

## Read these first

This project keeps its design intent in two places that are the source of truth for *why* the code
is shaped the way it is. Consult them before non-trivial changes:

- **`CONTEXT.md`** — the domain glossary. Terminology is enforced with discipline: each term has a
  precise meaning and a list of words to *avoid*. Use the exact vocabulary (Flow, Runner, Run,
  Node, Exec/Data port, Parameter, Deposit, Cargo, Stockpile, Scenario, Wave, Objective, …). Do not
  call a Flow a "graph" or a Deposit a "resource node". This matters for both code and comments.
- **`docs/adr/`** — 23 Architecture Decision Records (numbered `0001`–`0023`). Code comments cite
  them constantly (e.g. `docs/adr/0006`). When you touch a subsystem, the relevant ADR explains the
  constraint you must preserve. Adding a significant architectural decision means writing a new ADR.

## Architecture

### The central seam: engine-agnostic interpreter ↔ injected world (ADR-0006)

The single most important boundary. The Flow interpreter (`src/flow/runtime.js`) imports nothing
from Phaser and never touches a sprite. Everything a node needs to *do in* or *ask of* the game
goes through a `world` context object — a flat bag of primitive callbacks (`moveToward`, `collect`,
`deliver`, `test`, `attackMove`, `train`, …). `MapScene` builds the only real `world` (in
`create()`, search `this._world =`) backed by Phaser. **Game logic layers must not import Phaser.**
This keeps `runtime.js`, `movement.js`, `combat.js`, `pathfinding.js`, `units.js`, `resources.js`,
`conditions.js`, and `scenario.js` pure and engine-free.

### Flow model, execution, and the editor

- **`src/flow/model.js`** — `FlowModel`: a plain, JSON-serializable graph of `nodes` +
  `connections`. The single source of truth; the editor renders from it. Enforces connection rules
  (exec→exec, output→input, exec-output cardinality of 1).
- **`src/flow/nodeKinds.js`** — pure, serializable descriptors for every node kind (category, title,
  ports, params, and the `runner` kind it applies to: `'any'` / `'unit'` / `'building'`). Adding a
  node kind = a descriptor here + an executor in `runtime.js`. Keep descriptors data-only.
- **`src/flow/runtime.js`** — the interpreter. `startRun` / `tickRun` advance a per-Runner **Run**
  `{ flowId, current, status, state }`. The cursor reads the *live* model each tick (edits take
  effect mid-run; deleting the current node halts the Run — ADR-0005). Executors return
  `running(reason)` (park the cursor, and say why — ADR-0023) or `done(outPort)` (follow that Exec
  connection). A reason only the world knows is written into the node's scratch `state` by the world
  primitive and read back out by the executor — no new `world` call. Instant nodes chain within one
  tick, guarded by `maxSteps`. A loop is a back-edge connection, not a node kind (CONTEXT.md).
- **`src/flow/editor.js`** + `editor.css` — the editor is a hand-built **DOM overlay** (with an SVG
  layer for connections) above the Phaser canvas, *not* a Phaser scene (ADR-0001). Toggle with the
  button or the `F` key. It renders from the currently-selected Flow's model and writes edits back.
  Structural edits go through `commit()`, which bumps a reactive `store` (`src/flow/store.js`, a
  Svelte-store-shaped `{get,set,update,subscribe}`) that triggers a re-render.
- **`src/flow/library.js`** — `flowLibrary`, the app-wide singleton collection of named Flows,
  persisted to `localStorage`. A Flow is a *shared definition* (ADR-0003): many Runners can run one
  Flow; editing it changes all of them. Each runner keeps its own Run state.
- **`src/flow/assign.js`** / `positionPicker.js` — assigning a Flow to a Runner; picking a map Tile
  for a `tile` parameter (e.g. Move's destination).

### The world (Phaser side)

- **`src/scenes/MapScene.js`** — the large (~2500 lines) orchestrator and the *only* Phaser-aware
  game-logic file. Owns terrain generation, the procedural-ground GLSL shader, the tilemap, the
  shared **Tile-occupancy layer** (`_occupied`, ADR-0009), deposits/crystals, decorations, the
  per-frame `update()` loop (tick every Runner's Run → resolve combat → integrate movement → advance
  the scenario wave clock → sync sprites), the `world` context, and all the world primitives the
  interpreter calls. Conditions are evaluated here in `_testCondition` (ADR-0010).
- **`src/movement.js`** — `MovementSystem` (ADR-0007): static A* terrain Path + dynamic per-frame
  steering (arrive + separation + overlap resolution). Other Units are avoided locally, not pathed
  around. Pure; queries walkability via an injected predicate.
- **`src/pathfinding.js`** — pure A* over the walkable Tile grid + string-pull smoothing.
- **`src/combat.js`** — `CombatSystem` (ADR-0012). A Unit carries a combat *intent*
  (`unit.combat = { mode, dest }`) set by the AttackMove/Hold executors; this system acquires
  targets, drives chase/stop into the movement system, and applies Damage via callback. Targeting is
  resolved in the world, never wired as a Data port.
- **`src/effects.js`** — `AttackEffects`: the attack visuals, driven by MapScene's `onAttack`
  callback. It imports Phaser, but does not break the rule above: it is a render-layer helper, not
  game logic — `CombatSystem` decides *that* an attack lands (ADR-0012), this only shows it. A unit type may name an explicit `attackFx`; otherwise the effect
  falls back to reach (short = melee slash, long = ranged bolt). Each effect is a self-destroying
  tween, so there is no per-frame bookkeeping for MapScene.

### Data tables (pure, no Phaser, no game state)

Game numbers live in data tables, **not** as node Parameters — adding a type is a new table entry:

- **`src/units.js`** — `UNIT_TYPES` / `BUILDING_TYPES` (health, damage, range, aggro, cooldown,
  cost, buildTime, carryCapacity) and `FACTION` (`player` / `enemy` / `critter`).
- **`src/resources.js`** — `RESOURCES` (gather time, yield, deposit amount, sprites).
- **`src/upgrades.js`** — `UPGRADES` (ADR-0021): cost, researchTime, and either `modifiers`
  (additive stat deltas merged onto the target Unit type by MapScene's `effectiveStats` seam) or
  `grants` (named ability flags the world reads). Each Upgrade targets exactly one Unit type; the
  registry of which are *researched* is world state in MapScene, not here.
- **`src/conditions.js`** — the Branch Condition catalog (metadata only; evaluation is in MapScene).
- **`src/decorations.js`** — scatterable map scenery + footprints.
- **`src/scenario.js`** — `SCENARIO` (the survival Waves) + builders for the data-authored Enemy and
  critter Flows that are kept *out* of the Library (ADR-0011, ADR-0014).
- **`src/constants.js`** — the handful of shared magic numbers: `TILE` (64), `EXTRUDE`,
  `UNIT_SPEED`, `UNIT_CARRY_CAPACITY`. Not a per-type table, but the same rule applies — a number
  used in two places belongs here, not inlined.

### Entities

`src/entities/` holds the on-map sprite wrappers. `runner.js` is the shared Runner mixin (Health +
Faction + health bar — both Units and Buildings are Runners). `Unit.js` / `Building.js` are the
bases; the rest (`Worker`, `Marine`, `CommandCenter`, `Barracks`, `Factory`, `Biter`, …) are thin
type-specific subclasses. The texture prefix doubles as the type key into the `units.js` data table.

## Conventions

- **Terminology discipline** — match `CONTEXT.md` exactly in code, identifiers, and comments.
- **Cite ADRs in comments** when implementing or modifying a decision they cover (the existing code
  does this throughout — follow the pattern).
- **No Phaser outside the world layer** — keep `runtime.js` and the system/data modules engine-free;
  reach the game only through the injected `world` context or constructor callbacks.
- **Comments explain *why*** — existing comments are dense, prose-style rationale tied to ADRs and
  CONTEXT.md, not restatements of the code. Match that altitude.
- Tile coordinates are integers in Tile units; convert to pixels (`TILE = 64`) only at render/move
  time. The map is `120 × 90` Tiles.
