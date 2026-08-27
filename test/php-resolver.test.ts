import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composerPsr4Mappings,
  parsePhpUseDeclaration,
  phpExternalSpecifier,
  resolvePhpImportTargets,
  resolvePhpReference,
} from "../src/extractors/php.js";

const composer = {
  autoload: { "psr-4": { "App\\": "src/", "Unsafe\\": "../outside" } },
  "autoload-dev": { "psr-4": { "App\\Tests\\": ["tests/phpunit", "/absolute"] } },
};
const mappings = composerPsr4Mappings(composer);
const files = new Set([
  "src/Contracts/Runner.php",
  "src/Service/Worker.php",
  "src/Support/Logs.php",
  "tests/phpunit/WorkerTest.php",
  "bootstrap.php",
]);

test("Composer PSR-4 mappings merge production and dev roots while rejecting unsafe paths", () => {
  assert.deepEqual(mappings, [
    { prefix: "App\\Tests\\", directories: ["tests/phpunit"] },
    { prefix: "App\\", directories: ["src"] },
  ]);
});
test("PHP use declarations preserve aliases and grouped imports", () => {
  assert.deepEqual(parsePhpUseDeclaration("use App\\Contracts\\Runner as JobRunner;"), [
    { fqn: "App\\Contracts\\Runner", alias: "JobRunner" },
  ]);
  assert.deepEqual(parsePhpUseDeclaration("use App\\{Contracts\\Runner, Support\\Logs as Logger};"), [
    { fqn: "App\\Contracts\\Runner", alias: "Runner" },
    { fqn: "App\\Support\\Logs", alias: "Logger" },
  ]);
  assert.deepEqual(parsePhpUseDeclaration("use function App\\Support\\helper;"), [
    { fqn: "App\\Support\\helper", alias: "helper" },
  ]);
});

test("aliases, current namespaces, imports, and includes resolve only to exact tracked files", () => {
  const uses = ["use App\\Contracts\\Runner as JobRunner;"];
  assert.deepEqual(resolvePhpReference("JobRunner", "App\\Service", uses, mappings, files), {
    symbolName: "Runner",
    files: ["src/Contracts/Runner.php"],
  });
  assert.deepEqual(resolvePhpReference("Worker", "App\\Service", uses, mappings, files), {
    symbolName: "Worker",
    files: ["src/Service/Worker.php"],
  });
  assert.deepEqual(resolvePhpImportTargets("bootstrap.php", "require 'src/Service/Worker.php'", null, [], mappings, files), [
    "src/Service/Worker.php",
  ]);
  assert.deepEqual(resolvePhpImportTargets("src/bootstrap.php", "require __DIR__ . '/Support/Logs.php'", null, [], mappings, files), [
    "src/Support/Logs.php",
  ]);
  assert.deepEqual(resolvePhpImportTargets("bootstrap.php", "require $dynamic", null, [], mappings, files), []);
});

test("unresolved PHP namespaces get bounded external identities", () => {
  assert.equal(phpExternalSpecifier("use Symfony\\Component\\Console\\Application;"), "php:symfony");
  assert.equal(phpExternalSpecifier("require $dynamic"), null);
});
