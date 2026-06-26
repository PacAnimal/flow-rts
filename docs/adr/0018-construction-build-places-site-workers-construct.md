# Construction: a Build Action places a Construction Site, Workers Construct it

Buildings have until now entered the world only pre-placed by the Scenario (ADR-0014). To let the
player grow their base, we add **construction** — and split it across *two* Runner kinds rather than
making it one Building action. A Command Center's **Build** Action places a **Construction Site**; a
Worker's **Construct** Action does the labour of finishing it. This mirrors the real division the
game already leans on — one Runner *commissions*, another *acts* — and reuses the gather/claim
machinery (ADR-0008/0017) almost wholesale.

## What construction does

1. **Build** (a Building-scoped Action, Command-Center-only) takes three Parameters: a `buildingType`
   (the buildable set — Barracks, Factory — via a `buildableBuildings()` helper that mirrors
   `producibleBy`), a `destination` Tile (the Footprint's top-left anchor, picked with a footprint
   preview so only a free, walkable, on-map area can be confirmed), and an optional `assignFlow` (a
   Building-Flow for the chosen type, so the finished Building is *born running* — the same born-with-
   a-Flow idea as Train, ADR-0013).
2. When Build runs: if the Stockpile affords the building's `cost` **and** the Footprint is clear, it
   deducts the cost, places a Construction Site, and **completes immediately** (it does not tie up the
   Command Center for the build). If unaffordable, or the Footprint is blocked at run time, Build is a
   **no-op and advances** — no spend, no Site.
3. A **Construction Site** occupies and blocks its Footprint from placement and carries Health, but is
   *its own entity* — not a Building, not a Runner (it holds no Flow and runs nothing).
4. **Construct** (a Unit-scoped Action, no Parameters) sends a Worker to claim one of the Site's **≤4
   build slots** within reach of where it was rallied, stand beside the Footprint, and contribute
   build work. With every nearby slot taken or no Site in reach, the Worker **waits in place**.
5. Each frame the Site accrues `(attached builders) × dt` of progress and completes at `buildTime`
   (the solo-worker time). So N builders finish in `buildTime / N`, capped at 4; **0 builders ⇒ no
   progress**. On completion the Site is replaced by a real Building of that type at full Health, born
   running its `assignFlow` (or idle), with the Footprint occupancy carried over. Each contributing
   Worker's Construct then completes and advances.

## Why two nodes across two Runner kinds, not one Building action

Train (ADR-0013) makes a Building produce a Unit *by itself*. We could have modelled construction the
same way — Build blocks the Command Center for `buildTime`, then a Building appears. We rejected that:
the design intent is that **Workers** build, so that construction competes with gathering for Worker
attention (a real economic choice) and so "more Workers ⇒ faster" is expressible at all. Splitting the
work onto the Worker's Construct node is what makes the Worker the scarce resource, and it reuses the
gather-beside-a-Deposit / claim-a-slot loop the player already understands.

## Why the Construction Site is its own entity, not a Building-in-a-state

A Site has Health and a Footprint like a Building, so folding it into `Building` with an `under
construction` flag was tempting. We kept it **separate** because a Site has no Flow, no Run, no Train
menu, and no Assignment — bolting "is it really a Building yet?" guards onto every Building code path
would be worse than a small dedicated entity that is swapped for a real Building on completion.

The cost is a deliberate glossary change: **Health is no longer Runner-only**. A Construction Site is
destructible (an Enemy can raze a half-built structure, freeing the Footprint and forfeiting the
spent cost) without being a Runner, so CONTEXT.md now defines Health on "destructible map things."

## Why Build no-ops instead of blocking (unlike Train)

Train *blocks* on affordability so continuous production self-throttles to income. Build instead
**advances** when it can't afford or place. Building is a deliberate, one-shot placement at an author-
chosen Tile, not a continuous pump: blocking risks a permanent stall (a Deposit could sit on the
chosen Footprint forever), and a Command Center stuck on an unaffordable Build would freeze the rest
of its Flow. To build continuously the author loops `Build → Wait` and lets it retry, or gates it with
a Branch. This is the first Action to diverge from Train's block-until-ready posture.

## Why ≤4 slots, reach-limited, waiting — the Claim extension

Construct reuses Claim (ADR-0017) but stretches it: a Deposit admits **one** Worker, a Site admits
**four**. A Worker claims the nearest free slot of a Site *within reach of where it was rallied* — the
same reach rule as Gather, chosen over "build anywhere on the map" so Workers stay local and don't
abandon a base to build a distant Site. The "nearest Site with a free slot" rule distributes a crowd
across multiple Sites automatically; only when all reachable slots are full (or no Site is reachable)
does a Worker wait in place, exactly as Gather waits on a fully-claimed cluster.

## Consequences

- `BUILDING_TYPES` gains `cost`, `buildTime` (solo-worker seconds), and a `buildable` flag; a
  `buildableBuildings()` helper joins `producibleBy`/`producerBuildings`. The Command Center gains a
  builder capability that gates the Build node into Command-Center Flows only — a building-type-aware
  palette filter, extending the Runner-kind filter of ADR-0015/0016.
- New node kinds Build (`runner: 'building'`, restricted to `command_center`) and Construct
  (`runner: 'unit'`), with executors in `runtime.js` and new world primitives (place a Site, claim a
  build slot, accrue construction) — keeping the interpreter engine-agnostic (ADR-0006).
- The `flowRef` param type gains a building-type filter (Build's `assignFlow`), reusing Train's
  Library-Flow selector but scoped to the built building's type.
- The position picker gains a Footprint-preview/validation mode so a multi-Tile building can be
  anchored on a known-buildable area. Buildability rejects only *blocking* occupants (Deposits,
  trees, other Buildings/Sites); a non-blocking occupant — ground decor, base clearance — is built
  over, so it is more lenient than the strict spawn-time `_groundClear`.
- A Construction Site renders as the target Building's sprite at `alpha = 0.4 + 0.6 × progress` (60%
  transparent at placement, fully solid at completion — a near-invisible 90% read too faint), with
  an amber construction progress bar (distinct from production-blue / gather-green / deliver-yellow),
  and a standard Building health bar.
- Construction Sites and dynamically-built Buildings are **runtime-only** — not persisted across
  reload, consistent with Runs (ADR-0005) and Claims (ADR-0017) never being saved.
- Deferred: cancel/refund of a Site, repairing damaged Buildings (a natural future use of a Worker
  Construct-like node), build-slot visualisation, and per-building tech/placement-radius requirements.
