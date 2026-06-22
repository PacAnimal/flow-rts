# Node Parameters are literals stored on the node, and double as Data-port defaults

Configurable values on a node are **Parameters**: named, typed literals stored on the node
itself and set through the editor UI (the first being Move's `destination`, a Tile picked
via "Select Position"). A Parameter is distinct from a Port — setting it involves no
Connection. A Parameter may be unset, which is a valid authoring state because nothing
executes yet.

This extends ADR-0002, which reserved a typed Data port for the same `destination`. We are
*not* building Data ports/connections yet. Instead, a node's Parameter is defined to be the
inline default of the matching future Data port: when a Data connection is eventually wired
to that input, the incoming value overrides the Parameter; when nothing is wired, the
Parameter's literal is used. This is the Unreal-Blueprints pattern (a pin with an editable
inline default).

Alternatives considered:
- **Build the Data port now** and have the picker set the port's value — pulls the whole
  Data-port/Data-connection system forward for a single literal; rejected as premature.
- **A one-off field on Move** with no general concept — rejected because "Select Position"
  is meant to be reusable; the next configurable node would repeat the work.

Consequences:
- Node descriptors gain a way to declare Parameters (name + type), parallel to Ports.
- Parameters are part of node state and must round-trip through `FlowModel` serialization
  (the previous `fromJSON` reconstructed only `id/kind/x/y` and would have dropped them).
- The position picker is built as a reusable service returning a Tile, not Move-specific,
  so other Parameters/nodes can reuse it.
