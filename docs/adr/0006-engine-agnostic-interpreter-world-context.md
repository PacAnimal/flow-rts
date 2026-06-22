# The Flow interpreter is engine-agnostic; effects reach the game through an injected world context

The Flow interpreter walks the node graph and advances Runs, but it imports nothing from
Phaser and knows nothing about sprites, tiles-as-pixels, or the scene. Anything a node needs
to *do* in or *ask* of the game world is reached through a small **world context** object
passed into the tick. Move, for example, calls `world.moveToward(runner, destination, dt)`
and gets back whether the Unit has arrived; it never touches a sprite directly. MapScene
implements the world context against Phaser and owns all rendering and input.

We are building execution for Units now, but buildings will later run Flows too (with a
different, building-scoped action set) — so the work was deliberately scoped to keep the
interpreter free of Unit/Phaser specifics. The world-context seam is what makes that real:
the same interpreter ticks any "thing that has an assigned Flow and a cursor," and a
different backend (a building, a headless test) just supplies a different world context.

Alternative considered: **node executors manipulate Phaser objects directly** (Move writes
`unit.sprite.x`). Fewer layers today, but it couples the engine to the renderer, contradicts
the engine-agnostic scope decision, and makes both the future buildings work and any
unit-test of execution awkward. Rejected.

Consequences:
- A node kind's *schema* (ports, params) stays in `nodeKinds.js`; its *executor* (the
  behaviour) lives in the runtime, keyed by kind — node descriptors remain pure, serializable
  data.
- The world context is the single, reviewable list of primitives the game exposes to Flows
  (today: move a runner toward a tile, query position/walkability). New Actions grow this
  interface deliberately rather than reaching into the scene ad hoc.
- The interpreter is unit-testable with a fake world context and no Phaser.
