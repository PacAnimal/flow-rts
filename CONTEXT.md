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
assigns another Flow to a target Unit. Wait (holds execution for a duration, then continues)
is the first; branch, loop, and Assign Flow remain reserved in the model.
_Avoid_: logic node, control node

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
Hill (plateau) Tiles are not Walkable. This is terrain-type passability, not reachability
(there is no pathfinding yet). A destination must be a Walkable Tile.
_Avoid_: passable, traversable, reachable
