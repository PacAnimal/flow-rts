# Hybrid execution/data port model for Connections

A Connection currently represents **execution flow** (Blueprints-style): an Exec output
means "when I fire, run what's connected next." But each Port is modelled as either an
Exec port or a Data port, so typed Data ports and Data connections (e.g. a destination
value feeding into Move) can be added later without restructuring the model.

The alternatives were a pure dataflow graph (wires carry values, sequencing implicit) or
an exec-only model with no room for data. We picked the hybrid because RTS control reads
naturally as sequenced commands (favouring exec), while actions clearly need parameters
later (favouring data) — designing the Port abstraction for both now avoids a painful
migration once Data ports arrive.

Consequence: node kinds are defined by a schema/descriptor that declares their ports, and
the Port abstraction must distinguish kind (Exec|Data) and direction (input|output) from
the start, even though only Exec ports are rendered today.
