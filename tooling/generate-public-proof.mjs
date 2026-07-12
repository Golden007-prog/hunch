#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "dist/cli/index.js");
const target = resolve(root, "site/proof-curve.json");
const stats = JSON.parse(execFileSync(process.execPath, [cli, "stats", "--json"], { cwd: root, encoding: "utf8" }));
const decisionDir = resolve(root, ".hunch/decisions");
const datedDecisions = readdirSync(decisionDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(resolve(decisionDir, name), "utf8")))
  .map((decision) => decision.valid_from ?? decision.date)
  .filter((date) => typeof date === "string" && !Number.isNaN(Date.parse(date)))
  .sort((left, right) => Date.parse(left) - Date.parse(right));
const stride = Math.max(1, Math.ceil(datedDecisions.length / 24));
const stockSeries = datedDecisions
  .map((date, index) => ({ at: date, memories: index + 1 }))
  .filter((_, index) => index === 0 || index === datedDecisions.length - 1 || index % stride === 0);

// This is a derived, public-only pane of glass. It contains exactly the stats
// contract and no overlay records or independently computed marketing numbers.
const proof = {
  schema: "hunch.public-proof/1",
  source: stats.schema,
  generated_at: stats.generated_at,
  stock_series: stockSeries,
  stock: stats.stock,
  return: stats.return,
  compounding: stats.compounding,
};

mkdirSync(dirname(target), { recursive: true });
const temporary = `${target}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`);
renameSync(temporary, target);
console.log(`Wrote ${target}`);
