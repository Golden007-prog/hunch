import { test } from "node:test";
import assert from "node:assert/strict";
import { LANGUAGES, CODE_EXTENSIONS, languageFor } from "../src/extractors/languages.js";

test("LANGUAGES has typescript entries covering both grammars (plain + tsx)", () => {
  const ts = LANGUAGES.filter((l) => l.id === "typescript");
  assert.ok(ts.length >= 2, "expected a plain-TS entry and a TSX entry");
});

test("CODE_EXTENSIONS matches the existing TS/JS/Python/Go/YAML extension list", () => {
  assert.deepEqual(
    [...CODE_EXTENSIONS].sort(),
    [".cjs", ".cts", ".go", ".js", ".jsx", ".mjs", ".mts", ".py", ".pyi", ".tpl", ".ts", ".tsx", ".yaml", ".yml"].sort(),
  );
});

test("languageFor resolves .go to the go LanguageSpec", () => {
  const lang = languageFor("cmd/server/main.go");
  assert.ok(lang, "no LanguageSpec for .go");
  assert.equal(lang!.id, "go");
});

test("languageFor resolves every TS/JS extension to the typescript LanguageSpec", () => {
  for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
    const lang = languageFor(`file${ext}`);
    assert.ok(lang, `no LanguageSpec for ${ext}`);
    assert.equal(lang!.id, "typescript");
  }
});

test("languageFor returns null for a non-code file", () => {
  assert.equal(languageFor("README.md"), null);
});

test("the typescript LanguageSpec's builtinMethods includes the existing JS builtin allowlist", () => {
  const ts = LANGUAGES.find((l) => l.id === "typescript")!;
  for (const m of ["map", "filter", "push", "then", "toString"]) {
    assert.ok(ts.builtinMethods.has(m), `missing builtin method ${m}`);
  }
});

test("languageFor resolves .yml and .yaml to the yaml LanguageSpec", () => {
  for (const ext of [".yml", ".yaml"]) {
    const lang = languageFor(`file${ext}`);
    assert.ok(lang, `no LanguageSpec for ${ext}`);
    assert.equal(lang!.id, "yaml");
  }
});

test("languageFor resolves .tpl (Helm helper templates) to the yaml LanguageSpec", () => {
  const lang = languageFor("templates/_helpers.tpl");
  assert.ok(lang, "no LanguageSpec for .tpl");
  assert.equal(lang!.id, "yaml");
});

test("the yaml LanguageSpec declares its alias->anchor edges as \"references\", not \"calls\"", () => {
  const yaml = LANGUAGES.find((l) => l.id === "yaml")!;
  assert.equal(yaml.referenceEdgeType, "references");
});
