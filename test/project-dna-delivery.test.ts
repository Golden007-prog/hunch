import assert from "node:assert/strict";
import test from "node:test";
import { projectDnaDeliverySupplement } from "../src/core/projectDnaDelivery.js";
import type { ProjectDnaProfile } from "../src/core/projectDna.js";

const revision = "a".repeat(40);
const profile: ProjectDnaProfile = {
  schema: "hunch.project-dna/1",
  profile_id: "pdna_000000000000000000000000",
  repository_id: "pdnar_000000000000000000000000",
  repository_revision: revision,
  history_sample_count: 0,
  source_files: [],
  traits: [],
  content_hash: `sha256:${"0".repeat(64)}`,
};

test("DNA delivery renderer refuses unsealed caller-made profiles", () => {
  assert.throws(() => projectDnaDeliverySupplement(profile), /seal|identity/);
});
