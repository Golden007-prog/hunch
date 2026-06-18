# See the shape of the system

Run **Hunch: Component Graph** from the Command Palette.

The graph rolls the symbol-level call graph up to **components**:

- **Node size** = symbols the component owns
- **Color** = fragility (green → red)
- **Link width** = how tightly two components call into each other
- **Badges** = invariants ⛔ and bugs 🐞 recorded against the component

Drag nodes, scroll to zoom, and click a component to jump to its code.

Use **Hunch: Search** (`Ctrl/Cmd+Shift+P`) to fuzzy-find any decision, invariant,
bug, or component without leaving the keyboard.
