# Fable Mode — Infra / DevOps playbook

CI/CD, build systems, config, deploys, scripts. Blast radius here is "everyone,
at once" — ceremony scales accordingly, and the sizing rule's fast path rarely
applies.

## Gate 1 — SCOPE
- "Done" = the pipeline/deploy/script observed succeeding in an environment that
  matters, plus a named rollback path. No rollback story, no change.
- Name who consumes this config besides you: other services, other branches,
  scheduled jobs, teammates' machines. Config files always have more readers
  than authors.

## Gate 2 — EVIDENCE
- Establish what's ACTUALLY in effect, not what the file says: env layering,
  flag precedence, cached images, the CI runner's real versions. `echo` /
  `--dry-run` / debug output beat reading YAML.
- Check platform docs for the version you're on — CI syntax and cloud defaults
  drift; training-data memory of them is stale by default.
- Diff your environment against the failing one before claiming "works on my
  machine" means anything: OS, shell, versions, env vars.

## Gate 3 — ATTACK
- Partial apply: the script/deploy dies halfway — what state is left, and does a
  re-run repair it or make it worse?
- Idempotence: run it twice — same result, or duplicated resources?
- Secrets: does anything you touched end up in a log, an artifact, an error
  message, or a commit?
- Cross-platform: paths, line endings, shell quoting (win vs posix) — scripts
  break on the machine you didn't test.
- What does this change do to the OTHER pipelines/branches sharing the runner,
  cache, or config include?

## Gate 4 — VERIFY
- Dry-run first where it exists; then a real run in branch/staging BEFORE main.
- Run it twice to prove idempotence — don't assume it.
- Verify the rollback actually rolls back — a rollback tested only in prose is a
  second incident.
- After a "fix," confirm the pipeline is green for the RIGHT reason: read the
  logs, don't just read the badge.

## Tripwires
- Disabling a check/test/lint to make the pipeline green → that check was the
  evidence; Gate 3 on why it fires.
- Editing prod config directly to test a theory → staging exists for theories.
- Removing a version pin to "fix" a build → you traded one failure now for a
  random one later; pin and explain.
- Secrets pasted into a command line, log, or file that outlives the session →
  stop, rotate if exposed, redo safely.
