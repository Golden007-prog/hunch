#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { Command } from "commander";
import { discoverProjectDna, evaluateProjectDnaMatch, type ProjectDnaArtifact } from "../core/projectDna.js";
import { diffProjectDna } from "../core/projectDnaDelta.js";
import { projectDnaDeliverySupplement } from "../core/projectDnaDelivery.js";

function gitRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
  } catch {
    throw new Error("Project DNA must run inside a Git repository");
  }
}

function printProfile(root: string, revision: string, json: boolean): void {
  const profile = discoverProjectDna(root, revision);
  if (json) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Project DNA ${profile.profile_id}\n`);
  process.stdout.write(`revision: ${profile.repository_revision}\n`);
  process.stdout.write(`history sample: ${profile.history_sample_count}\n`);
  process.stdout.write(`committed convention files: ${profile.source_files.length ? profile.source_files.join(", ") : "none"}\n`);
  if (!profile.traits.length) {
    process.stdout.write("traits: none yet (insufficient evidence)\n");
    return;
  }
  for (const trait of profile.traits) {
    process.stdout.write(`- [${trait.category}] ${trait.claim} (${trait.confidence.toFixed(2)}; ${trait.id})\n`);
  }
}

const program = new Command();
program
  .name("hunch-dna")
  .description("Derive and inspect Hunch Project DNA from exact committed repository evidence.")
  .option("--revision <ref>", "Git revision to inspect", "HEAD")
  .option("--json", "emit the sealed machine-readable profile")
  .action((options: { revision: string; json?: boolean }) => {
    printProfile(gitRoot(), options.revision, !!options.json);
  });

program
  .command("match")
  .description("Score a commit/PR/issue/message against deterministic applicable DNA traits.")
  .requiredOption("--kind <kind>", "commit | pull_request | issue | message")
  .requiredOption("--title <title>", "artifact title/subject")
  .option("--body <body>", "artifact body")
  .option("--revision <ref>", "Git revision whose DNA applies", "HEAD")
  .option("--json", "emit the sealed match contract")
  .action((options: { kind: string; title: string; body?: string; revision: string; json?: boolean }) => {
    if (!(new Set(["commit", "pull_request", "issue", "message"])).has(options.kind)) {
      throw new Error("--kind must be commit, pull_request, issue, or message");
    }
    const artifact: ProjectDnaArtifact = {
      kind: options.kind as ProjectDnaArtifact["kind"],
      title: options.title,
      ...(options.body !== undefined ? { body: options.body } : {}),
    };
    const globals = program.opts<{ revision?: string; json?: boolean }>();
    const revision = options.revision ?? globals.revision ?? "HEAD";
    const json = options.json ?? globals.json ?? false;
    const profile = discoverProjectDna(gitRoot(), revision);
    const match = evaluateProjectDnaMatch(profile, artifact);
    if (json) process.stdout.write(`${JSON.stringify(match, null, 2)}\n`);
    else {
      process.stdout.write(`Project DNA match: ${match.score === null ? "n/a" : `${match.score}%`} (${match.applicable_checks} applicable checks)\n`);
      for (const check of match.checks.filter((item) => item.applicable)) {
        process.stdout.write(`- ${check.passed ? "PASS" : "FAIL"} ${check.key}: ${check.detail}\n`);
      }
    }
  });

program
  .command("context")
  .description("Render the bounded advisory DNA supplement intended for Hunch delivery/context assembly.")
  .option("--revision <ref>", "Git revision to inspect", "HEAD")
  .option("--traits <count>", "maximum DNA traits in the orientation slice", "8")
  .option("--json", "emit supplement JSON")
  .action((options: { revision: string; traits: string; json?: boolean }) => {
    const globals = program.opts<{ revision?: string; json?: boolean }>();
    const revision = options.revision ?? globals.revision ?? "HEAD";
    const json = options.json ?? globals.json ?? false;
    const cap = Number(options.traits);
    const supplement = projectDnaDeliverySupplement(discoverProjectDna(gitRoot(), revision), cap);
    if (json) process.stdout.write(`${JSON.stringify(supplement, null, 2)}\n`);
    else process.stdout.write(`${supplement?.text ?? "No evidence-backed Project DNA traits yet."}\n`);
  });

program
  .command("diff")
  .description("Compare DNA at two exact revisions; reports observation drift without inferring causality.")
  .argument("<from>", "older Git revision")
  .argument("<to>", "newer Git revision")
  .option("--json", "emit the sealed delta contract")
  .action((from: string, to: string, options: { json?: boolean }) => {
    const root = gitRoot();
    const delta = diffProjectDna(discoverProjectDna(root, from), discoverProjectDna(root, to));
    const json = options.json ?? program.opts<{ json?: boolean }>().json ?? false;
    if (json) process.stdout.write(`${JSON.stringify(delta, null, 2)}\n`);
    else {
      process.stdout.write(`Project DNA drift ${delta.delta_id}: ${delta.changed ? `${delta.changes.length} change(s)` : "no observed change"}\n`);
      for (const change of delta.changes) process.stdout.write(`- ${change.kind}: ${change.key}\n`);
    }
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`hunch-dna: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
