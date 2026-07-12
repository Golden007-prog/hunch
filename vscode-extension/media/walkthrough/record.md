# Capture what you decide

When you make a non-trivial choice, record it so the next person (or agent) inherits it.

Run **Hunch: Capture…** and pick what kind of memory it is:

- **Decision** — what you decided and why. Recorded through the same `hunch mcp`
  write path Claude Code uses.
- **Invariant** — a rule the codebase must not break.
- **Bug** — a failure worth remembering (root cause, never-twice).

Every write is delegated — the extension never edits `.hunch/` JSON itself, so
each record goes through the CLI's atomic, validated path. If the CLI isn't on
your `PATH`, set **`hunch.cliPath`** in Settings.
