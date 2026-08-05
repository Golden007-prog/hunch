/**
 * Graph blind spots (round-2 audit). Both defects made the indexed graph diverge
 * from the real code, which silently weakens EVERY downstream guard: blast radius,
 * `hunch why`, and `not-calls` conformance all reason over edges that were never
 * emitted. Measured on Hunch's own committed graph at the time: 32 classes and 25
 * constructors, every one with fan_in 0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSource } from "../src/extractors/parse.js";

test("TS/JS construction produces a call — `new Foo()` is an edge, not a blind spot (#6)", () => {
  const r = parseSource("src/order.ts", [
    "export class Order { total() { return 1; } }",
    "export function makeOrder() { const o = new Order(); return o; }",
  ].join("\n"));
  assert.equal(r.parseable, true);
  assert.ok(r.calls.some((c) => c.callee === "Order" && !c.member), "new Order() must register as a direct call to Order");
  assert.ok(r.symbols.some((s) => s.kind === "class" && s.name === "Order"));
});

test("namespaced construction is captured as a member call (#6)", () => {
  const r = parseSource("src/x.ts", "const c = new pkg.Client();");
  assert.equal(r.parseable, true);
  assert.ok(r.calls.some((c) => c.callee === "Client" && c.member), "new pkg.Client() must register as a member call");
});

test("Python classes with no directly-nested def are indexed (#14)", () => {
  const r = parseSource("src/models.py", [
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    "class Money:",
    "    amount: int",
    "",
    "class NotFound(Exception):",
    "    pass",
    "",
    "class Service:",
    "    def run(self):",
    "        return Money(1)",
  ].join("\n"));
  assert.equal(r.parseable, true);
  const names = r.symbols.filter((s) => s.kind === "class").map((s) => s.name).sort();
  assert.deepEqual(names, ["Money", "NotFound", "Service"], "a dataclass and an Exception subclass are classes too");
  // The method-bearing class is NOT duplicated (pendingDefs keys by node id and keeps
  // the first classification), and its method is still classified as a method.
  assert.equal(r.symbols.filter((s) => s.name === "Service").length, 1, "no duplicate class symbol");
  assert.ok(r.symbols.some((s) => s.kind === "method" && s.name === "run"), "methods still classify as methods, not functions");
});
