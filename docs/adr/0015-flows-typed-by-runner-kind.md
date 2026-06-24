# A Flow is typed by the Runner kind it targets

Once Buildings became Runners (CONTEXT.md), the Action set split in two: Unit-only Actions
(`Move`, `Gather`, `Deliver`, `Attack-Move`, `Hold`) and Building-only Actions (`Train`). A
"build Marines" Flow is meaningless on a Marine, and "gather crystals" is meaningless on a
Barracks. We make each **Flow declare its target Runner kind** (`Unit` or `Building`), set when
the Flow is created.

The palette shows only that kind's Actions (plus the always-common Event/Flow-Control nodes —
`OnStart`, `Wait`, `Branch`), and the assign overlay offers a Runner only Flows of its kind.

## Why

- **The tool guides instead of permitting nonsense.** The alternative — untyped Flows where an
  off-kind node simply no-ops (`Train` on a Unit does nothing, like Gather with no Deposit) —
  needs no model change but lets an author build and assign incoherent Flows with no feedback,
  and leaves the palette a cluttered mix of unit and building Actions.
- **It future-proofs per-type action sets.** Later refinements (a Worker can Gather, a Marine
  cannot) become a narrowing of the same tag, not a new mechanism.

## Alternatives considered

- **Untyped Flows with off-kind no-ops.** Simpler model, but no authoring guardrails and a noisy
  palette. Rejected.

## Consequences

- A Flow gains a `targetKind` field (round-trips through `FlowModel` serialization, like
  Parameters in ADR-0004). The editor palette and `assign.js` filter on it.
- Events and Flow Control are common to both kinds; only Actions partition. A Flow built purely
  from common nodes still must pick a kind — an accepted minor annoyance.
- The Library is now effectively partitioned by kind, though it remains one collection.
- Deferred: finer per-unit-type action sets (Worker vs Marine), and any "mixed" Flow that could
  run on more than one kind.
