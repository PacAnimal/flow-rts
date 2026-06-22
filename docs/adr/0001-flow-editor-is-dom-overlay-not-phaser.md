# Flow editor is a DOM overlay, not a Phaser scene

The game renders in Phaser on a `<canvas>`, but the flow editor (the node Canvas,
palette, draggable Nodes, and Connections) is built as an absolutely-positioned
HTML/DOM layer over the canvas, with Connections drawn in an SVG overlay — not as
Phaser GameObjects in a Scene.

We chose this because a node editor leans heavily on things the DOM gives for free —
text, hit-testing, dragging, scrolling, and (later) inline inputs on nodes — all of
which would have to be reimplemented inside Phaser. The cost is two render/input worlds
to coordinate (the editor overlay suppresses Phaser pointer input while open).

A future reader seeing an otherwise all-Phaser game may assume the editor "should" be a
Phaser scene; this records that the split is deliberate.
