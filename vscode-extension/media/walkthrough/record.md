# Write memory back

When you make a non-trivial choice, record it so the next person (or agent) inherits it.

- **Hunch: Record Invariant…** captures a rule the codebase must not break.
- **Hunch: Record Bug…** captures a failure (symptom + suspects) from a failing test.

These delegate to the `hunch` CLI — the extension never edits `.hunch/` JSON
itself, so every write goes through the CLI's atomic, validated path. If the CLI
isn't on your `PATH`, set **`hunch.cliPath`** in Settings.

> Decisions are recorded from Claude Code chat via the `hunch_record_decision`
> MCP tool — the richest write-path, with full provenance.
