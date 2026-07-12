# Fable Mode — QA / test playbook

Writing tests, fixing tests, building test plans. The prime directive: a test's
value is its ability to FAIL. A test you never saw fail is a hope, not a test.

## Gate 1 — SCOPE
- "Done" = a test that fails on the defect and passes on correct code — both
  observed, not assumed.
- Name the BEHAVIOR under test, not the function: "expired token is rejected,"
  never "test validateToken." Behavior survives refactors; function names don't.
- For a test plan: state what is deliberately out of scope, or the plan will
  silently promise everything.

## Gate 2 — EVIDENCE
- Read the code under test before writing the test — test what it does, not what
  its name implies it does.
- Read the suite's idiom first: fixtures, factories, helpers, how it isolates
  state. A test that invents its own setup style is a maintenance bug.
- If testing a bugfix: reproduce the bug FIRST and capture the exact failure.
  That failure is the assertion.

## Gate 3 — ATTACK
- Mutate mentally: reintroduce the bug — does this test catch it? Break the code
  in a plausible nearby way — still caught? A test that survives mutation is
  testing nothing.
- Edge matrix, every input: empty / one / many / max, boundary ±1, wrong type,
  duplicate, concurrent. Pick the ones that map to real callers, and say which
  you skipped.
- Attack your doubles: is the mock so complete the test now verifies the mock?
- State the coverage gap honestly: what does this suite still NOT protect?

## Gate 4 — VERIFY
- See it fail. Revert the fix or flip the assertion once — watch the test go red
  with the failure you expected, then green. No red-then-green, no test.
- Run the whole suite, not just your file — your fixture or state leak breaks
  neighbors, not yourself.
- Flake check: run the new test twice; any time/order/network dependence shows
  up now or at 2am in CI.

## Tripwires
- Weakening an assertion to make it pass → Gate 3; the assertion was the evidence.
- Test passes on the very first run → suspicious, prove it CAN fail → Gate 4.
- Asserting implementation details (call counts, private state) when behavior is
  assertable → brittle; assert the behavior.
- sleep()/timeout as synchronization → flake factory; await the actual condition.
- Deleting or skipping a failing test to unblock → that test was load-bearing;
  Gate 2 on why it fails.
