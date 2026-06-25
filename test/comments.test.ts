import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInlineIntent } from "../src/extractors/comments.js";

test("extractInlineIntent lifts tagged comments (comment-gated; ignores string literals)", () => {
  const root = mkdtempSync(join(tmpdir(), "hunch-cmt-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src/a.ts"),
      "// hunch-why: sessions live in redis for revocation\n" +
        "export const x = 1;\n" +
        "/* hunch-rule: never call the pay-per-token API here */\n" +
        'const s = "hunch-why: this is a string, not intent";\n',
    );
    writeFileSync(join(root, "b.py"), "# hunch-rule: validate all input\nprint(1)\n");
    writeFileSync(join(root, "src/none.ts"), "export const y = 2; // ordinary comment\n");

    const got = extractInlineIntent(root);
    const keyed = got.map((i) => `${i.kind}|${i.file}|${i.line}|${i.text}`).sort();
    assert.deepEqual(keyed, [
      "rule|b.py|1|validate all input",
      "rule|src/a.ts|3|never call the pay-per-token API here",
      "why|src/a.ts|1|sessions live in redis for revocation",
    ]);
    // a string literal containing the tag (no comment marker before it) is NOT captured
    assert.ok(!got.some((i) => i.text.includes("not intent")), "string literal must not be mistaken for intent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
