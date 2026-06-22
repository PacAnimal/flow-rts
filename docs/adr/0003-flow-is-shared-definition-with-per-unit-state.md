# A Flow is a shared definition with per-unit execution state

A Flow is a single reusable definition living in the Library. Assigning a Flow to several
Units does not copy it: all those Units run the same definition, so editing the Flow once
changes the behaviour of every Unit running it. Each Unit, however, holds its own execution
state (where it is within the Flow). This is a class/instance split — the Flow is the class,
a Unit's running of it is the instance.

The main alternative was copy-on-assign: assigning stamps an independent copy of the nodes
onto the Unit, so Library entries are just templates and edits never propagate. We rejected
it because the player wants a curated *Library* of behaviours and "tune one Flow, all units
using it improve" is the expected workflow; copy-on-assign loses that and multiplies the
graphs to maintain.

Consequences:
- A Unit runs at most one assigned Flow at a time; assigning a new one replaces it.
- The OnStart Event fires once per Unit when that Unit's Flow begins running — not once
  globally at game start.
- Execution state must be stored per Unit (per Assignment), separate from the Flow definition.
- A future Assign Flow node hands out Flow definitions by reference, not by copy.
