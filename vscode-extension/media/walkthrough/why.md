# Why is this file the way it is?

Open any source file and you'll see Hunch in the editor:

- A **CodeLens** at the top of the file summarizes its invariants, decisions and bugs.
- **Hover** a function to see its bug history and fragility.
- The **Problems panel** lists invariants in scope (and *near*-invariants reached
  through the blast radius) so you don't break them while editing.
- The **status bar** shows the invariant count for the active file.

Run **Hunch: Why is this file the way it is?** from the editor title bar or the
Command Palette for the full brief — invariants, decisions, bug history, and the
blast radius of changing it.
