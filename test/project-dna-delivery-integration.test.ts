import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverProjectDna } from "../src/core/projectDna.js";
import { projectDnaDeliverySupplement } from "../src/core/projectDnaDelivery.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hunch DNA delivery test",
  GIT_AUTHOR_EMAIL: "hunch-dna-delivery@example.test",
  GIT_COMMITTER_NAME: "Hunch DNA delivery test",
  GIT_COMMITTER_EMAIL: "hunch-dna-delivery@example.test",
};

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("a sealed DNA profile becomes a bounded advisory delivery supplement", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hunch-project-dna-delivery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "CONTRIBUTING.md"), "Behavior changes must include tests. Keep pull requests small and focused.\n");
  writeFileSync(join(root, "value.txt"), "0\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fix: initialize mutation fixture");
  for (let index = 1; index <= 5; index++) {
    writeFileSync(join(root, "value.txt"), `${index}\n`);
    git(root, "add", "value.txt");
    git(root, "commit", "-qm", `fix: update mutation fixture ${index}`);
  }

  const profile = discoverProjectDna(root);
  const supplement = projectDnaDeliverySupplement(profile, 3);
  assert.ok(supplement);
  assert.equal(supplement.id, profile.profile_id);
  assert.equal(supplement.kind, "project-dna");
  assert.equal(supplement.priority, 425);
  assert.match(supplement.text, /PROJECT DNA/);
  assert.match(supplement.text, new RegExp(profile.repository_revision));
  assert.match(supplement.text, /never override Hunch decisions, constraints, policy/i);
  assert.equal((supplement.text.match(/^• /gm) ?? []).length <= 4, true, "trait cap plus optional omission marker stays bounded");
});
