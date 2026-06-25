import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempStore } from "./helpers.js";
import { updateClaudeMd } from "../src/integrations/claudemd.js";
import { refreshExistingGrounding } from "../src/integrations/providers.js";

test("self-heal: refreshExistingGrounding rewrites a stale grounding doc, idempotently, no scaffolding", (t) => {
  const { store, root, cleanup } = tempStore();
  t.after(cleanup);
  const claude = join(root, "CLAUDE.md");
  updateClaudeMd(root, store); // create a correct CLAUDE.md
  // simulate grounding written by an OLD generator (the param-name bug)
  writeFileSync(claude, readFileSync(claude, "utf8").replace("hunch_query(query)", "hunch_query(question)"));
  assert.match(readFileSync(claude, "utf8"), /hunch_query\(question\)/);

  const changed = refreshExistingGrounding(root, store);
  assert.deepEqual(changed, ["CLAUDE.md"], "the stale doc was healed");
  assert.doesNotMatch(readFileSync(claude, "utf8"), /hunch_query\(question\)/);
  assert.match(readFileSync(claude, "utf8"), /hunch_query\(query\)/);

  // idempotent: a second pass changes nothing
  assert.deepEqual(refreshExistingGrounding(root, store), []);

  // refresh-only: never scaffolds a doc the project doesn't already have
  assert.equal(existsSync(join(root, "AGENTS.md")), false);
  assert.equal(existsSync(join(root, ".cursor", "rules", "hunch.mdc")), false);
});
