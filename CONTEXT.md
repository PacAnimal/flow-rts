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
A Run holds where the Runner currently is within the Flow and is one of: running (working
through the Flow), idle (no Flow, or the Flow finished), or halted (its current Node was
removed by an edit). Distinct from the Assignment (which Flow) and the Flow (the shared
definition): assigning a Flow starts a fresh Run; re-assigning discards the old one. A Run
is per-Runner and momentary — it is not saved, so reloading restarts every Run from scratch.
_Avoid_: process, thread, session, instance

**Node**:
A single box in a Flow. Every node has a kind: Event, Action, or Flow Control.
_Avoid_: block, box, step

**Event**:
A node kind that starts execution when something happens (e.g. OnStart, which fires once
per Runner the moment its Flow begins running on that Runner — not a single global game start).
An Event has an outgoing Exec port and no incoming Exec port — execution begins here.
_Avoid_: trigger (reserved sense below), hook, signal

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
_Avoid_: structure, depot, base

**Enemy**:
A Runner whose Faction is Enemy — not its own kind of thing. A spawned attacker is an Enemy
Unit; a hostile spawner would be an Enemy Building. Enemies run Flows on the same interpreter
as Player Runners, but their Flows are authored as level data, never appear in the Library, and
are not editable in the editor.
_Avoid_: mob, monster, hostile, AI

**Health**:
How much damage a Runner can take before it is destroyed — a current/max pair carried by every
Runner, Units and Buildings alike. At 0 the Runner is **destroyed**: removed from the map (its
Footprint freed, for a Building) and its Run ends. Death is just Health reaching 0, not a
separate Run status. A Runner's max Health (and its other combat numbers) come from its type's
data table, not from any Node.
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
A Worker's temporary hold on a single Deposit while it gathers there — the mechanism that spreads
Workers across a cluster. At most one Worker claims a Deposit at a time; a gathering Worker takes
the nearest *unclaimed* Deposit (within reach of where it was sent), walks to a free Tile beside it,
and harvests. The Claim is released the moment the Worker's Cargo fills and it leaves to deliver (and
on any abnormal end — the Worker is re-assigned or destroyed, or the Deposit is gathered empty), so a
Deposit frees for the next Worker. If every Deposit in reach is already claimed, the Worker waits in
place until one frees rather than crowding a claimed Deposit. A Claim is world state, not part of a
Run, and is never saved. Distinct from an Assignment (a Flow bound to a Runner).
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
