import { test } from "node:test";
import assert from "node:assert/strict";
import { languageFor } from "../src/extractors/languages.js";
import { attributeCalls, attributeRelations, parseSource } from "../src/extractors/parse.js";

const SOURCE = `<?php
namespace App\\Service;

use App\\Contracts\\Runner as JobRunner;
use App\\Support\\Logs;

trait LocalTrait {}
interface LocalContract {}
class Worker extends BaseWorker implements LocalContract
{
    use LocalTrait;

    public function run(): void
    {
        $runner = new JobRunner();
        $runner->execute();
        JobRunner::build();
        count([]);
    }
}
enum State { case Ready; }
function helper(): void {}
`;

test("PHP is registered as a native LanguageSpec", () => {
  assert.equal(languageFor("src/Worker.php")?.id, "php");
});
test("PHP parsing extracts declarations, imports, calls, namespace, and static type relationships", () => {
  const parsed = parseSource("src/Service/Worker.php", SOURCE)!;
  assert.ok(parsed.parseable);
  assert.equal(parsed.namespace, "App\\Service");
  assert.ok(parsed.imports.includes("use App\\Contracts\\Runner as JobRunner;"));
  assert.deepEqual(parsed.symbols.map(({ name, kind }) => ({ name, kind })), [
    { name: "App\\Service", kind: "type" },
    { name: "LocalTrait", kind: "trait" },
    { name: "LocalContract", kind: "interface" },
    { name: "Worker", kind: "class" },
    { name: "run", kind: "method" },
    { name: "State", kind: "enum" },
    { name: "helper", kind: "function" },
  ]);
  assert.deepEqual(parsed.calls.map((call) => call.callee), ["JobRunner", "execute", "build"]);
  assert.ok(!parsed.calls.some((call) => call.callee === "count"), "PHP builtins do not create coincidental repo edges");

  const calls = attributeCalls(parsed);
  const runIndex = parsed.symbols.findIndex((symbol) => symbol.name === "run");
  assert.deepEqual([...calls.get(runIndex)!.keys()], ["JobRunner", "execute", "build"]);
  const relations = attributeRelations(parsed);
  const workerIndex = parsed.symbols.findIndex((symbol) => symbol.name === "Worker");
  assert.deepEqual(relations.get(workerIndex)!.map(({ target, label }) => ({ target, label })), [
    { target: "BaseWorker", label: "extends" },
    { target: "LocalContract", label: "implements" },
    { target: "LocalTrait", label: "uses trait" },
  ]);
});

test("malformed PHP remains a fail-closed parse issue", () => {
  const parsed = parseSource("src/Broken.php", "<?php class Broken { public function x( {")!;
  assert.equal(parsed.parseable, false);
});
