# A building-Flow is further typed by the building type it targets

ADR-0015 types a Flow by Runner *kind* (`Unit` or `Building`). But Buildings are not
interchangeable: a Command Center makes Workers, a Barracks makes Marines (their producible
Units come from the `producedBy` data table, ADR-0013). A single `Building` kind is too coarse —
it would let an author point a Command Center's `Train` node at Marines, which it cannot build.

We refine the tag: a **building-Flow also declares its building type** (`command_center`,
`barracks`, …), set when the Flow is created. `targetKind` stays the Runner kind (ADR-0015 holds);
`buildingType` is a second, building-only field.

The Library offers one "new Flow" button per *producer* Building (a building type with at least
one producible Unit), the `Train` node's Unit dropdown lists only `producibleBy(buildingType)`, and
the assign overlay offers a Building only Flows whose `buildingType` matches it.

## Why

- **The dropdown can only be exact if the Flow knows its building.** A Flow is a shared definition
  authored without a concrete Runner (ADR-0003), so the editor cannot infer the building from the
  assignment. Carrying the building type on the Flow is what lets the `Train` palette show the
  right Units at authoring time.
- **It mirrors ADR-0015's narrowing.** Per-kind action sets became per-building-type producible
  sets by the same move — a finer tag, not a new mechanism. It extends cleanly when the Factory
  gains Units.

## Alternatives considered

- **Runtime enforcement only** (keep generic `Building` Flows; the dropdown lists every producible
  Unit; a Building no-ops a Unit it can't make). No model change, but the dropdown shows Units a
  given Building can't build, and an author gets no guardrail. Rejected as the primary mechanism —
  but kept as a cheap backstop: `_train` still no-ops when `producedBy !== building.type`.

## Consequences

- `FlowModel` gains a `buildingType` field (null for Unit Flows), round-tripped through
  serialization like `targetKind`. `library.create`, the editor, and `assign.js` thread it through.
- The Factory produces nothing yet, so it gets no "new Flow" button and no assignable Flows — it is
  an inert Runner until it gains producible Units.
- Building Flows authored before this change have no `buildingType` and so match no Building; they
  must be recreated. (No built-in building Flow exists, so only hand-authored ones are affected.)
- Deferred: producing the same Unit from more than one building type, and any Factory roster.
