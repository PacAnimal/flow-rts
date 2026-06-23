# Flow RTS

A real-time-strategy game the player controls indirectly: instead of issuing commands
by hand, the player authors **Flows** — node graphs — and assigns them to units, which
then run them. This document is the glossary for that domain. It is not a spec.

## Language

**Flow**:
A reusable node graph defining a behaviour. Flows live in the Library and are assigned to
Units to control them. A Flow is a shared *definition*: assigning one Flow to several Units
means they all run the same definition (edit it once, all run the change), while each Unit
keeps its own execution state. The editor edits one Flow at a time.
_Avoid_: graph, script, program, behaviour tree

**Library**:
The player's collection of authored Flows. The source from which Flows are assigned to Units.
_Avoid_: list, catalogue, project

**Unit**:
A controllable entity on the map. A Unit runs at most one assigned Flow at a time (its
current behaviour); assigning a new Flow replaces the old one. Many Units may share one Flow.
_Avoid_: entity, actor, agent, sprite

**Assignment**:
The link between a Unit and the single Flow it currently runs. Created when a Flow is
assigned to a Unit; replaced (not stacked) when another Flow is assigned.
_Avoid_: binding, attachment

**Run**:
A Unit's live execution of its assigned Flow — the *instance* to the Flow's *definition*.
A Run holds where the Unit currently is within the Flow and is one of: running (working
through the Flow), idle (no Flow, or the Flow finished), or halted (its current Node was
removed by an edit). Distinct from the Assignment (which Flow) and the Flow (the shared
definition): assigning a Flow starts a fresh Run; re-assigning discards the old one. A Run
is per-Unit and momentary — it is not saved, so reloading restarts every Run from scratch.
_Avoid_: process, thread, session, instance

**Node**:
A single box in a Flow. Every node has a kind: Event, Action, or Flow Control.
_Avoid_: block, box, step

**Event**:
A node kind that starts execution when something happens (e.g. OnStart, which fires once
per Unit the moment its Flow begins running on that Unit — not a single global game start).
An Event has an outgoing Exec port and no incoming Exec port — execution begins here.
_Avoid_: trigger (reserved sense below), hook, signal

**Action**:
A node kind that performs an effect in the game when executed (e.g. Move). An Action has
an incoming Exec port and an outgoing Exec port so it can be chained after other nodes.
_Avoid_: command, task, operation

**Flow Control**:
A node kind that directs execution between other nodes (e.g. branch, delay, loop), or
acts on the Flow system itself — notably a future Assign Flow node that, when executed,
assigns another Flow to a target Unit. Wait (holds execution for a duration) and Branch (routes
to one of two outputs by a Condition) exist; loop and Assign Flow remain reserved in the model.
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
A player structure occupying a Footprint of Tiles that it blocks, so Units path around it. The
Command Center is the first Building and the place a Worker delivers Cargo to grow the Stockpile.
_Avoid_: structure, depot, base

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
finite amount of its Resource and is removed (its Tile freed) once gathered empty.
_Avoid_: resource node (Node is reserved), patch, source, vein

**Cargo**:
The Resource amount a Unit is currently carrying — a single {Resource, amount} slot (a Unit
carries one Resource type at a time), bounded by the Unit's carry capacity. Capacity defaults
to one gather's worth (10 Crystals today) and may be raised later by upgrades. Gathering adds
its yield up to that capacity; a Worker already full does not gather. A Worker empties its Cargo
into the player's Stockpile by delivering it at a Command Center.
_Avoid_: inventory, load, payload, stockpile (that is the player-wide store), hold

**Stockpile**:
The player's accumulated Resources, kept per Resource type and shown in the materials panel. It
grows only when a Worker delivers its Cargo at a Command Center; nothing spends it yet. Distinct
from Cargo (one Unit's load): the Stockpile is the whole player's total.
_Avoid_: bank, treasury, materials (the UI's label for it), resources (a Resource is the type)
