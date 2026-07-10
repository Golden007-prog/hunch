import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HunchStore } from "../store/hunchStore.js";
import { writeFileAtomic } from "../core/io.js";
import { shortHash } from "../core/ids.js";
import { proofPlanContentHash } from "./canonical.js";
import {
  PolicyProofSchema,
  ProofPlanSchema,
  PolicySpecSchema,
  EvidenceEventSchema,
  type EvidenceEvent,
  type PolicyProof,
  type ProofPlan,
  type PolicySpec,
} from "./schema.js";

const encode = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

function loadRecords<T>(dir: string, parse: (raw: unknown) => T, label: string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      out.push(parse(JSON.parse(readFileSync(join(dir, name), "utf8"))));
    } catch (e) {
      // A policy store can control CI. Skipping a corrupt record would turn an
      // enforcement failure into a false pass, so fail visibly instead.
      throw new Error(`invalid ${label}/${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Git-native policy/proof source of truth. Kept separate from the legacy entity
 * registry for the first slice so existing schema-v2 repositories and SQLite
 * compatibility remain unchanged. */
export class PolicyRepository {
  private readonly publicHome: string;
  private readonly privateHome?: string;

  constructor(root: string, private readonly store: HunchStore) {
    this.publicHome = join(root, ".hunch");
    this.privateHome = store.privateDir;
  }

  private dir(home: "public" | "private", kind: "policies" | "proofs" | "plans" | "evidence"): string {
    const base = home === "private" ? this.privateHome : this.publicHome;
    if (!base) throw new Error("No private Hunch overlay is configured; refusing to write a private policy.");
    return join(base, kind);
  }

  private policiesIn(home: "public" | "private"): PolicySpec[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "policies"), (v) => PolicySpecSchema.parse(v), "policies");
  }

  private proofsIn(home: "public" | "private"): PolicyProof[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "proofs"), (v) => PolicyProofSchema.parse(v), "proofs");
  }

  private evidenceIn(home: "public" | "private"): EvidenceEvent[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "evidence"), (v) => EvidenceEventSchema.parse(v), "evidence");
  }

  private plansIn(home: "public" | "private"): ProofPlan[] {
    if (home === "private" && !this.privateHome) return [];
    return loadRecords(this.dir(home, "plans"), validatePlan, "plans");
  }

  listPolicies(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicySpec[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.policiesIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.policiesIn("public").map((p) => [p.id, p]));
    if (!opts.publicOnly) for (const p of this.policiesIn("private")) byId.set(p.id, p);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getPolicy(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): PolicySpec | undefined {
    return this.listPolicies(opts).find((p) => p.id === id);
  }

  getProof(id: string, opts: { publicOnly?: boolean } = {}): PolicyProof | undefined {
    const byId = new Map(this.proofsIn("public").map((p) => [p.id, p]));
    if (!opts.publicOnly) for (const p of this.proofsIn("private")) byId.set(p.id, p);
    return byId.get(id);
  }

  listPlans(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofPlan[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.plansIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.plansIn("public").map((p) => [p.id, p]));
    if (!opts.publicOnly) for (const p of this.plansIn("private")) byId.set(p.id, p);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getPlan(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): ProofPlan | undefined {
    return this.listPlans(opts).find((p) => p.id === id);
  }

  listEvidence(opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): EvidenceEvent[] {
    if (opts.publicOnly && opts.privateOnly) throw new Error("choose only one of publicOnly or privateOnly");
    if (opts.privateOnly) return this.evidenceIn("private").sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(this.evidenceIn("public").map((e) => [e.id, e]));
    if (!opts.publicOnly) for (const e of this.evidenceIn("private")) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getEvidence(id: string, opts: { publicOnly?: boolean; privateOnly?: boolean } = {}): EvidenceEvent | undefined {
    return this.listEvidence(opts).find((e) => e.id === id);
  }

  homeOfPolicy(id: string): "public" | "private" | undefined {
    if (this.privateHome && existsSync(join(this.dir("private", "policies"), `${id}.json`))) return "private";
    if (existsSync(join(this.dir("public", "policies"), `${id}.json`))) return "public";
    return undefined;
  }

  putPolicy(policy: PolicySpec, opts: { private?: boolean } = {}): PolicySpec {
    const parsed = PolicySpecSchema.parse(policy);
    const existing = this.homeOfPolicy(parsed.id);
    if (existing === "public" && parsed.data_class !== "public" && !opts.private) {
      throw new Error(`refusing to write ${parsed.data_class} policy ${parsed.id} into its existing public home; migrate it to the private overlay first`);
    }
    const home = opts.private ? "private" : existing ?? (parsed.data_class !== "public" || this.store.unified ? "private" : "public");
    const dir = this.dir(home, "policies");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  putProof(proof: PolicyProof, policyId: string): PolicyProof {
    const parsed = PolicyProofSchema.parse(proof);
    const home = this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
    const dir = this.dir(home, "proofs");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  putPlan(plan: ProofPlan, policyId: string, opts: { private?: boolean; public?: boolean } = {}): ProofPlan {
    const parsed = validatePlan(plan);
    if (opts.private && opts.public) throw new Error("choose only one proof-plan home");
    const home = opts.private
      ? "private"
      : opts.public
        ? "public"
        : this.homeOfPolicy(policyId) ?? (parsed.data_class === "public" && !this.store.unified ? "public" : "private");
    const dir = this.dir(home, "plans");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }

  putEvidence(event: EvidenceEvent, opts: { private?: boolean } = {}): EvidenceEvent {
    const parsed = EvidenceEventSchema.parse(event);
    const home = opts.private || parsed.data_class !== "public" || this.store.unified ? "private" : "public";
    const dir = this.dir(home, "evidence");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${parsed.id}.json`), encode(parsed));
    return parsed;
  }
}

function validatePlan(raw: unknown): ProofPlan {
  const plan = ProofPlanSchema.parse(raw);
  const hash = proofPlanContentHash(plan);
  if (plan.content_hash !== hash) throw new Error(`proof plan ${plan.id} content hash mismatch`);
  if (plan.id !== `plan_${shortHash(hash)}`) throw new Error(`proof plan ${plan.id} id does not match its canonical content`);
  return plan;
}

/** One-time private migration for the Constitution's standalone Git-native
 * records. Copy/validate everything before deleting the public directories;
 * private records win on an id collision. */
export function movePolicyArtifactsToPrivate(publicHunchDir: string, privateHunchDir: string): { policies: number; proofs: number; plans: number; evidence: number } {
  const counts = { policies: 0, proofs: 0, plans: 0, evidence: 0 };
  const move = <T extends { id: string }>(
    kind: "policies" | "proofs" | "plans" | "evidence",
    parse: (raw: unknown) => T,
  ): number => {
    const from = join(publicHunchDir, kind);
    if (!existsSync(from)) return 0;
    const pub = loadRecords(from, parse, kind);
    const to = join(privateHunchDir, kind);
    const priv = new Map(loadRecords(to, parse, kind).map((r) => [r.id, r]));
    mkdirSync(to, { recursive: true });
    for (const rec of pub) {
      if (!priv.has(rec.id)) writeFileAtomic(join(to, `${rec.id}.json`), encode(rec));
    }
    rmSync(from, { recursive: true, force: true });
    return pub.length;
  };
  counts.policies = move("policies", (v) => PolicySpecSchema.parse(v));
  counts.proofs = move("proofs", (v) => PolicyProofSchema.parse(v));
  counts.plans = move("plans", validatePlan);
  counts.evidence = move("evidence", (v) => EvidenceEventSchema.parse(v));
  return counts;
}
