import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "../src/core/types.js";
import { tempStore } from "./helpers.js";

const projectRoot = process.cwd();
const tsx = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const cli = join(projectRoot, "src/cli/index.ts");

function reviewDecision(id: string, status: Decision["status"]): Decision {
  return {
    id,
    title: `${status} review fixture`,
    topic: null,
    status,
    context: "fixture",
    decision: "Preserve the review lifecycle boundary.",
    consequences: [],
    alternatives_rejected: [],
    rejected_tripwires: [],
    related_components: [],
    related_files: [],
    supersedes: null,
    superseded_by: null,
    caused_by_bug: null,
    commit: null,
    valid_to: null,
    retired: { symbols: [], deps: [] },
    provenance: {
      source: status === "accepted" ? "human_confirmed" : "llm_draft",
      confidence: status === "accepted" ? 0.95 : 0.5,
      evidence: [],
    },
    date: "2026-01-01T00:00:00.000Z",
  };
}

function review(root: string, id: string) {
  return spawnSync(process.execPath, [tsx, cli, "review", "--reject", id], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUNCH_PRIVATE_DIR: "", HUNCH_SYNTH_PROVIDER: "deterministic" },
  });
}

test("review rejection preserves accepted decisions while still deleting proposed drafts", () => {
  const fixture = tempStore();
  const accepted = reviewDecision("dec_accepted", "accepted");
  const proposed = reviewDecision("dec_proposed", "proposed");
  fixture.store.json.put("decisions", accepted);
  fixture.store.json.put("decisions", proposed);
  fixture.store.close();
  const acceptedPath = join(fixture.root, ".hunch/decisions/dec_accepted.json");
  const proposedPath = join(fixture.root, ".hunch/decisions/dec_proposed.json");

  try {
    const protectedRun = review(fixture.root, accepted.id);
    const protectedOutput = `${protectedRun.stdout}${protectedRun.stderr}`;
    assert.notEqual(protectedRun.status, 0, protectedOutput);
    assert.match(protectedOutput, /refusing to reject accepted decision dec_accepted/i);
    assert.ok(existsSync(acceptedPath), "the accepted record remains intact");

    const draftRun = review(fixture.root, proposed.id);
    const draftOutput = `${draftRun.stdout}${draftRun.stderr}`;
    assert.equal(draftRun.status, 0, draftOutput);
    assert.match(draftOutput, /rejected and removed dec_proposed/);
    assert.ok(!existsSync(proposedPath), "the proposed draft is deleted");
    assert.ok(existsSync(acceptedPath), "rejecting a draft cannot affect the accepted record");
  } finally {
    fixture.cleanup();
  }
});
