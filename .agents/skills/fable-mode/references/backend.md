# Fable Mode — Backend playbook

APIs, services, data, contracts, migrations. The gates, sharpened for state you
can corrupt and callers you can't see.

## Gate 1 — SCOPE
- "Done" = an observed request/response or a data invariant demonstrated to hold,
  never "endpoint written."
- Say out loud whether the contract changes — request/response shape, status
  codes, event payloads, DB schema. A breaking change is a different task with a
  different blast radius; name which one this is.
- Name the consistency requirement: what must never be half-done? That sentence
  drives Gate 3.

## Gate 2 — EVIDENCE
- Walk the callers before touching a shared function, endpoint, or table — grep
  for every consumer, including jobs, other services, and old clients that
  can't redeploy with you.
- Read the existing idiom for errors, transactions, auth, and validation from a
  neighboring handler; match it.
- For data work: look at REAL rows, not the schema's optimism. Nulls, legacy
  shapes, and duplicates live in production, not in types.

## Gate 3 — ATTACK
- Concurrency: two of these requests interleaved — still correct? Where is the
  race, and what serializes it?
- Partial failure: the process dies between write A and write B — what state is
  left, and who repairs it?
- Idempotency: the client retries (they always retry) — double effect or safe?
- Migration order: old code running against new schema during deploy, and new
  code against old schema during rollback — both must survive.
- The boring killers: timezone, encoding, pagination off-by-one, N+1 hiding in a
  loop.

## Gate 4 — VERIFY
- Run the service and hit the real endpoint — happy path AND the error paths you
  claimed to handle (send the bad payload, drop the permission).
- Inspect persisted state directly after the call; the response saying "ok" is
  not evidence the row is right.
- Exercise the dependents you found in Gate 2 — their tests at minimum.
- Migrations: run up AND down against a realistic data copy, not an empty dev DB.
- Performance claims get a number or stay out of the report.

## Tripwires
- Changing a shared contract without having walked its callers → Gate 2.
- catch-and-log-and-continue on a write path → Gate 3; that's corruption deferred.
- Multi-step write with no story for dying in the middle → Gate 3.
- "Works locally" as the verification of a deploy-order concern → Gate 4.
