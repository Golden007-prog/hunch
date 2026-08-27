import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDiff } from "../src/extractors/diff.js";

test("PHP files and declarations participate in changed-file history", () => {
  const diff = `diff --git a/src/Worker.php b/src/Worker.php
index 1111111..2222222 100644
--- a/src/Worker.php
+++ b/src/Worker.php
@@ -1,2 +1,6 @@
 <?php
-class Worker {}
+final class Worker {}
+trait Logs {}
+enum State { case Ready; }
+function helper(): void {}
+require 'src/bootstrap.php';
`;
  const result = analyzeDiff(diff);
  assert.deepEqual(result.filesModified, ["src/Worker.php"]);
  assert.ok(result.changedSymbols.some(({ name, kind }) => name === "Worker" && kind === "class"));
  assert.ok(result.addedSymbols.some(({ name, kind }) => name === "Logs" && kind === "trait"));
  assert.ok(result.addedSymbols.some(({ name, kind }) => name === "State" && kind === "enum"));
  assert.ok(result.addedSymbols.some(({ name, kind }) => name === "helper" && kind === "function"));
  assert.deepEqual(result.addedDeps, ["src/bootstrap.php"]);
});
