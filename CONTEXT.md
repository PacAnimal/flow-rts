# Flow RTS

A real-time-strategy game the player controls indirectly: instead of issuing commands
by hand, the player authors **Flows** — node graphs — and assigns them to units, which
then run them. This document is the glossary for that domain. It is not a spec.

## Language

**Flow**:
A reusable node graph defining a behaviour. Flows live in the Library and are assigned to
Runners to control them. A Flow is a shared *definition*: assigning one Flow to several
Runners means they all run the same definition (edit it once, all run the change), while each
Runner keeps its own execution state. Each Flow **targets one Runner kind** (Unit or Building),
which fixes the Actions its palette offers and limits which Runners it can be assigned to — a
Building-Flow cannot be assigned to a Unit. A Building-Flow further targets one **building type**
(e.g. Command Center, Barracks), which fixes the Units its Train offers and limits it to that one
building type. The editor edits one Flow at a time.
_Avoid_: graph, script, program, behaviour tree

**Library**:
The player's collection of authored Flows. The source from which Flows are assigned to Units.
_Avoid_: list, catalogue, project

**Category**:
A player-authored label that files a Flow under a named bucket to organise the Library — e.g.
*Economy*, *Combat*, *Experimental*. A Flow belongs to at most one Category; an unlabelled Flow is
**Uncategorized**. Categories are freeform: the set in play is simply the distinct names currently
used across Flows — there is no managed roster, so a Category is created by naming it on a Flow and
disappears when its last Flow leaves it. A Category is Library-organisation metadata carried on the
Library entry beside the Flow's name, never part of the Flow definition: it is not assigned to a
Runner and editing it changes no behaviour. Purely an authoring aid — it groups Flows into
collapsible sections in the Library panel and the assign overlay and has no effect on how a Flow runs.
_Avoid_: folder, tag, group, catalogue (Library's avoid-word), bucket

**Runner**:
Any on-map thing that can be assigned a Flow and hold a Run — the thing a Flow runs *on*.
Units and Buildings are both Runners; the Assignment, Run, cursor, and OnStart machinery is
defined on the Runner, not on Units specifically. What a Runner can *do* depends on its kind:
the interpreter passes the Runner to each node's executor (which the code calls `runner`), and
the world exposes a kind-appropriate action set (Units move/gather; Buildings produce). A
Runner runs at most one Flow at a time.
_Avoid_: host, agent, actor, entity, owner

**Faction**:
The side a Runner belongs to. A survival level has two — **Player** and **Enemy** — with room
for more later (e.g. a neutral side, or further sides once multiplayer exists). Faction decides
friend from foe for combat and targeting. The player authors Flows (in the Library) only for
Player Runners; Enemy Runners run Flows too, but those are supplied by the level, not the Library.
_Avoid_: side, team, owner, allegiance

**Unit**:
A controllable, *moving* entity on the map — a kind of Runner. A Unit runs at most one assigned
Flow at a time (its current behaviour); assigning a new Flow replaces the old one. Many Units
may share one Flow. Distinct from a Building (the immobile kind of Runner): only Units move,
steer around crowds, and carry Cargo.
_Avoid_: entity, actor, agent, sprite

**Assignment**:
The link between a Runner and the single Flow it currently runs. Created when a Flow is
assigned to a Runner; replaced (not stacked) when another Flow is assigned.
_Avoid_: binding, attachment

**Run**:
A Runner's live execution of its assigned Flow — the *instance* to the Flow's *definition*.
A Run is a **stack of Frames**: its bottom is the **base Frame** (the OnStart line, if any) and
an Interrupt firing pushes a handler Frame on top. Only the top Frame advances; the rest are
suspended beneath it. A Run is one of: running (a Frame is advancing, or the stack is empty but an
Interrupt can still fire — OnStart is optional, so a purely reactive Flow stays armed), idle (no
Flow, or the base line ended *and* nothing can ever fire again — every Interrupt is a spent
one-shot, or there are none), or halted (the node a live Frame sits on was removed by an edit).
A Run therefore outlives its base line: a repeating Interrupt keeps servicing the Runner after the
main line is done, so such a Run is never idle while assigned. Distinct from the Assignment (which Flow) and the Flow (the shared definition): assigning
a Flow starts a fresh Run; re-assigning discards the old one. A Run is per-Runner and momentary
— it is not saved, so reloading restarts every Run from scratch.
_Avoid_: process, thread, session, instance

**Frame**:
One cursor position within a Run's stack: the id of the Node it sits on plus that Node's
in-progress scratch state. The **base Frame** is the bottom of the stack — the OnStart line, the
Runner's main behaviour. An Interrupt firing pushes a handler Frame above it; when that handler's
chain ends, its Frame is **popped** and the Frame beneath **resumes** exactly where it was
(freeze-and-continue: its scratch state is untouched while suspended). Only the top Frame advances.
_Avoid_: thread, coroutine, stack entry, level

**Node**:
A single box in a Flow. Every node has a kind: Event, Action, or Flow Control.
_Avoid_: block, box, step

**Event**:
A node kind that starts execution when something happens (e.g. OnStart, which fires once
per Runner the moment its Flow begins running on that Runner — not a single global game start).
An Event has an outgoing Exec port and no incoming Exec port — execution begins here. OnStart
roots the base Frame; an **Interrupt** is an Event that can fire *again* mid-Run and preempt.
_Avoid_: trigger (reserved sense below), hook, signal

**Interrupt**:
An Event that fires *during* a Run (not just at the start) and preempts whatever the Run is
doing. When an Interrupt fires it **suspends** the running Frame (the world halts that Frame's
in-flight movement/combat intent) and pushes a handler Frame rooted at the Interrupt; the handler
chain runs to its end, then its Frame is popped and the suspended Frame resumes. Interrupts stack:
one firing while a handler already runs pushes above it (LIFO). OnTimer (fires after a delay) is
the first Interrupt. Distinct from OnStart, which fires once and roots the base Frame rather than
preempting.
_Avoid_: trigger, hook, signal, exception

**Action**:
A node kind that performs an effect in the game when executed (e.g. Move). An Action has
an incoming Exec port and an outgoing Exec port so it can be chained after other nodes.
_Avoid_: command, task, operation

**Flow Control**:
A node kind that directs execution between other nodes (e.g. branch, delay), or acts on the
Flow system itself. Wait (holds execution for a duration) and Branch (routes to one of two
outputs by a Condition) exist. A **loop** is not a node: it is a Connection wired *backward*
to an earlier Node, gated by a Branch and paced by a Wait (an all-instant back-edge with no
waiting Node spins and ends the Run, so a loop must contain one). Assigning a Flow to another
Runner is, for now, a capability of the Train Action rather than its own node.
_Avoid_: logic node, control node

**Branch**:
A Flow Control node that evaluates a Condition and sends execution down one of two Exec outputs,
**Yes** or **No** — the first Node that makes a choice. It evaluates the moment the cursor
reaches it (it does not wait); if the chosen output has nothing wired, the Run ends there.
_Avoid_: if, conditional, switch, decision

**Condition**:
A named boolean test on Unit or game state that a Branch evaluates — e.g. *Cargo full*,
*Deposit adjacent*, *Stockpile ≥ N*. Chosen from a fixed set; some take an argument (an amount).
A Condition only reads state to answer true/false; it never changes anything.
_Avoid_: predicate, check, test, rule, trigger

**Port**:
A connection point on a node. Every Port is either an Exec port or a Data port, and is
either an input or an output.
_Avoid_: pin, socket, slot, anchor

**Exec port**:
A Port that carries execution (control flow), not a value. An Exec output means "when I
fire, run what's connected next"; an Exec input means "run me when fired."
_Avoid_: trigger port, flow port

**Data port**:
A Port that carries a typed value between nodes (e.g. a destination feeding into Move).
Reserved in the model; no Data ports exist yet. A node's Parameter of the same name is
the Data port's inline default — the value used when nothing is wired to it.
_Avoid_: value port, argument port

**Parameter**:
A named, typed value configured on a Node itself (e.g. Move's `destination`, a Tile).
Distinct from a Port: a Parameter is set on the node (no Connection involved). When the
matching Data port is later wired, the incoming value overrides the Parameter. A
Parameter may be unset — a valid authoring state, since nothing executes yet.
_Avoid_: property, field, attribute, setting

**Connection**:
A wire joining one node's output Port to another node's input Port. An Exec connection
joins Exec ports (the only kind today); a Data connection joins Data ports (future).
_Avoid_: edge, wire, link, arrow

**Canvas**:
The surface in the editor where Nodes are placed and Connections are drawn.
_Avoid_: workspace, board, sheet

**Tile**:
One cell of the map's grid. The map is a grid of Tiles. A Tile is addressed by integer
coordinates {x, y} in Tile units (not pixels); positions like Move's destination are
stored this way and converted to pixels only when something moves.
_Avoid_: cell, square, grid square

**Walkable**:
A property of a Tile that a Unit may stand on or move to: lowland ground and ramp Tiles.
Hill (plateau) Tiles are not Walkable. Walkability is terrain-type passability of a single
Tile, distinct from reachability — whether a Unit can actually get to a Tile, which depends
on a Path of Walkable Tiles connecting them. A Move destination must be Walkable, and is
carried out only if it is also reachable. Separately, a Tile occupied by a Deposit is blocked
even where the terrain is Walkable — a Unit can neither stand on nor path through it.
_Avoid_: passable, traversable

**Path**:
The route a Unit follows to reach its Move destination: a sequence of waypoints over
Walkable Tiles that goes around unwalkable terrain. A Path is found when the Move begins
(terrain is fixed) and then followed; if none exists, the destination is unreachable. Other
Units are not part of a Path — they are avoided locally, moment to moment, as a Unit travels
along it, so two Units sharing a destination settle near it rather than stacking on one Tile.
_Avoid_: route, trail, track, waypoints (a Path is made of waypoints)

**Footprint**:
The set of Tiles an on-map thing covers: a rectangle, width×height in Tiles, anchored at a
top-left Tile. A 1×1 Footprint is a single Tile. Decisions like blocking apply across a thing's
whole Footprint. Deposits, Decorations, and Buildings each have a Footprint.
_Avoid_: area, extent, bounds, footprint cells

**Decoration**:
A piece of map scenery occupying a Footprint of Tiles — trees and holes today; more later.
Each Decoration has a type, which declares its sprite(s) and Footprint size, and is either
blocking or not: a blocking Decoration (an *obstacle*) makes its whole Footprint unwalkable so
Units path around it, while a non-blocking one is passable. Decorations are scattered when a
level spawns and never overlap one another or any other occupied Tiles. Distinct from a Deposit
(a gatherable Resource source) and a Building (a player structure), though all occupy Tiles.
_Avoid_: prop, scenery, obstacle (an obstacle is just a blocking Decoration, not its own thing)

**Building**:
A player structure occupying a Footprint of Tiles that it blocks, so Units path around it — the
immobile kind of Runner. The Command Center is the first Building and the place a Worker delivers
Cargo to grow the Stockpile. Unlike a Unit, a Building does not move; its Flow drives a
building-scoped action set (e.g. producing Units) rather than movement. Each Building has a type
that fixes which Units it can produce — a Command Center trains Workers, a Barracks trains Marines.
A Building enters the world either pre-placed by the Scenario or grown from a Construction Site.
_Avoid_: structure, depot, base

**Construction Site**:
A placed-but-unfinished Building: where a Building will stand once built. A Command Center's Build
Action places one (choosing the building type and a Footprint of Tiles); Workers then complete it.
A Construction Site is its *own* thing, not a Building and not a Runner — it holds no Flow and runs
nothing — but it occupies and blocks its Footprint from the moment it is placed and carries Health,
so it is a destructible combat target (an Enemy can raze a half-built structure, freeing its
Footprint and losing the investment). When its build work is complete it is replaced by the finished
Building of that type. Rendered as the finished Building's sprite, transparent at first and fading
solid as it nears completion.
_Avoid_: scaffold (informal art-speak for the transparent rendering, not the entity), building site, blueprint

**Enemy**:
A Runner whose Faction is Enemy — not its own kind of thing. A spawned attacker is an Enemy
Unit; a hostile spawner would be an Enemy Building. Enemies run Flows on the same interpreter
as Player Runners, but their Flows are authored as level data, never appear in the Library, and
are not editable in the editor.
_Avoid_: mob, monster, hostile, AI

**Health**:
How much damage a destructible map thing can take before it is destroyed — a current/max pair.
Every Runner carries Health (Units and Buildings alike); so does a Construction Site, which has
Health without being a Runner. At 0 the thing is **destroyed**: removed from the map (its Footprint
freed, for a Building or Construction Site) and, for a Runner, its Run ends. Death is just Health
reaching 0, not a separate Run status. Max Health (and the other combat numbers) come from a data
table keyed by type, not from any Node.
_Avoid_: hit points, HP, life, durability

**Damage**:
The amount an attack subtracts from a target Runner's Health. A Unit's Damage, range, and attack
cooldown are properties of its type (a pure data table, as gather rates are on the Resource type
in ADR-0008), not Parameters on any Node.
_Avoid_: hurt, hit, DPS, power

**Resource**:
A type of gatherable material that Workers collect — Crystals today; more (e.g. Gas, Wood)
later. A Worker that gathers comes to hold an amount of a Resource. The Resource is the
*what* (the kind of material); a Deposit is the *where* (a source of it on the map).
_Avoid_: material, mineral, item, loot, goods

**Deposit**:
A gatherable source of a Resource occupying a single Tile on the map; what a Worker gathers
from. A crystal cluster on the map is several Deposits on neighbouring Tiles (one Deposit per
Tile). A Deposit blocks its Tile — no Unit can stand on or path through it — so a Worker
gathers while standing on an adjacent Tile, i.e. *beside* the Deposit. A Deposit holds a
finite amount of its Resource and is removed (its Tile freed) once gathered empty. At most one
Worker **claims** a Deposit at a time, so several Workers gathering together spread across distinct
Deposits rather than crowding one (see Claim).
_Avoid_: resource node (Node is reserved), patch, source, vein

**Claim**:
A Runner's temporary hold on a spot in the world — the mechanism that makes several Runners sharing
one Flow spread across distinct places instead of crowding one. It takes three forms.

Its original and primary form is a Worker's hold on a single Deposit while it gathers there. At most
one Worker claims a Deposit at a time; a gathering Worker takes the nearest *unclaimed* Deposit
(within reach of where it was sent), walks to a free Tile beside it, and harvests. The Claim is
released the moment the Worker's Cargo fills and it leaves to deliver (and on any abnormal end — the
Worker is re-assigned or destroyed, or the Deposit is gathered empty), so a Deposit frees for the next
Worker. If every Deposit in reach is already claimed, the Worker waits in place until one frees rather
than crowding a claimed Deposit.

The second spreads Workers across construction: a Construction Site has up to **four** build slots,
and a Worker running Construct claims one free slot (within reach of where it was sent) and stands
beside the Footprint contributing build work. Unlike a Deposit (exclusive — one claim), a Site admits
up to four claims at once; with every nearby slot taken (or no Site in reach) the Worker waits in
place. The Claim frees when the Site completes or is destroyed, or on any abnormal end.

The third spreads any Runner across a Move destination: when a Move has **spread** set, each Runner
claims a distinct Tile near the destination rather than all heading to the same one, so a squad
sharing one patrol Flow stands on separate Tiles instead of stacking. The hold lasts while the Runner
travels to and stands on its Tile, freeing when it next moves, is re-assigned, or is destroyed.
Unlike the Deposit and build-slot claims, a Runner that finds no free Tile does **not** wait — it
falls back to the destination, so a Move always completes.

A Claim is world state, not part of a Run, and is never saved. Distinct from an Assignment (a Flow
bound to a Runner).
_Avoid_: reservation, lock, assignment (reserved for Flow↔Runner), booking, ownership, hold (that is
Hold Position)

**Cargo**:
The Resource amount a Unit is currently carrying — a single {Resource, amount} slot (a Unit
carries one Resource type at a time), bounded by the Unit's carry capacity. Capacity defaults
to one gather's worth (10 Crystals today) and may be raised later by upgrades. Gathering adds
its yield up to that capacity; a Worker already full does not gather. A Worker empties its Cargo
into the player's Stockpile by delivering it at a Command Center.
_Avoid_: inventory, load, payload, stockpile (that is the player-wide store), hold

**Stockpile**:
The player's accumulated Resources, kept per Resource type and shown in the materials panel. It
grows when a Worker delivers its Cargo at a Command Center and is spent by production (a Train
node deducts a Unit's cost from it). Distinct from Cargo (one Unit's load): the Stockpile is the
whole player's total.
_Avoid_: bank, treasury, materials (the UI's label for it), resources (a Resource is the type)

**Scenario**:
A level defined as data — the threat and the victory rules the player plays *against* and does
not author. A Scenario owns its Waves and its Objective. It is the counterpart to the Library:
the Library is what the player authors (Flows for Player Runners); the Scenario is the fixed
challenge the world enforces. Distinct from a Flow — a Scenario is not a node graph and runs on
no Runner.
_Avoid_: level (the in-world map), mission, map, stage

**Wave**:
A timed group of Enemy spawns within a Scenario: a number of Enemy Units of a type, appearing at
a spawn point at a scheduled time, each born already running a data-authored Flow (the same
born-with-a-Flow mechanism Train uses). Waves are a data timeline the world plays out, not a
Flow.
_Avoid_: spawn, round, horde, swarm

**Objective**:
A Scenario's win/lose rules, evaluated by the world (not by any Flow). For a survival Scenario:
the player **loses** when the Command Center is destroyed, and **wins** by surviving all Waves
(and/or a survival timer). Reads Runner Health and Wave progress; changes nothing.
_Avoid_: goal, mission, win condition, victory, quest
