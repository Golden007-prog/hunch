import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { injectionMode, resetSessionInjections } from "../src/core/hookcache.js";

const SID = () => `hunch-test-${process.pid}-${Math.floor(performance.now() * 1000)}`;

test("hookcache: first injection is full, identical repeat is delta, changed content is full again", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING v1"), "full");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING v1"), "delta");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING v2"), "full", "record change re-sends the full block");
  assert.equal(injectionMode(sid, "pre:src/b.ts", "GROUNDING v1"), "full", "keys are independent");
});

test("hookcache: sessions are isolated; missing session id and kill switch always mean full", () => {
  const a = SID(), b = SID();
  assert.equal(injectionMode(a, "k", "X"), "full");
  assert.equal(injectionMode(b, "k", "X"), "full", "another session gets its own first-time full");
  assert.equal(injectionMode(undefined, "k", "X"), "full");
  assert.equal(injectionMode(undefined, "k", "X"), "full", "no session id → never dedups");
  const prev = process.env.HUNCH_HOOK_DEDUP;
  process.env.HUNCH_HOOK_DEDUP = "0";
  try {
    const c = SID();
    assert.equal(injectionMode(c, "k", "X"), "full");
    assert.equal(injectionMode(c, "k", "X"), "full", "kill switch disables dedup");
  } finally {
    if (prev === undefined) delete process.env.HUNCH_HOOK_DEDUP;
    else process.env.HUNCH_HOOK_DEDUP = prev;
  }
});

test("hookcache: resetSessionInjections forgets a session — compaction must re-deliver in full", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING"), "full");
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING"), "delta");
  resetSessionInjections(sid);
  assert.equal(injectionMode(sid, "pre:src/a.ts", "GROUNDING"), "full", "post-compact identical grounding is full again");
  const other = SID();
  assert.equal(injectionMode(other, "k", "X"), "full");
  resetSessionInjections(undefined); // no session id — must be a safe no-op
  assert.equal(injectionMode(other, "k", "X"), "delta", "resetting nothing leaves other sessions intact");
});

test("hookcache: a corrupt cache file degrades to full (grounded beats deduped), then recovers", () => {
  const sid = SID();
  assert.equal(injectionMode(sid, "k", "X"), "full");
  const dir = join(tmpdir(), "hunch-hookcache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), "{not json");
  assert.equal(injectionMode(sid, "k", "X"), "full", "corrupt file must not fake a delta");
  assert.equal(injectionMode(sid, "k", "X"), "delta", "cache rebuilt after the corrupt read");
});
