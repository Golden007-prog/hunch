import { compareCodeUnits } from "./canonicalOrder.js";
import { assertProjectDnaProfile, type ProjectDnaCategory, type ProjectDnaProfile, type ProjectDnaTrait } from "./projectDna.js";

export const PROJECT_DNA_SUPPLEMENT_KIND = "project-dna" as const;
const DEFAULT_TRAIT_CAP = 8;
const MAX_TRAIT_CAP = 16;

export interface ProjectDnaDeliverySupplement {
  id: string;
  kind: typeof PROJECT_DNA_SUPPLEMENT_KIND;
  text: string;
  priority: number;
}

const CATEGORY_ORDER: Record<ProjectDnaCategory, number> = {
  communication: 0,
  review: 1,
  engineering: 2,
  culture: 3,
  vocabulary: 4,
};

function orderedTraits(profile: ProjectDnaProfile): ProjectDnaTrait[] {
  return [...profile.traits].sort((left, right) =>
    CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
      || right.confidence - left.confidence
      || compareCodeUnits(left.key, right.key));
}

/**
 * Render Project DNA through Hunch's existing DeliverySupplement seam.
 *
 * The caller still owns the final hard budget via buildDeliveryEnvelope(); this
 * function only prepares compact, evidence-identifiable orientation text. The
 * profile ID/revision remain visible so a host can preserve provider provenance.
 */
export function projectDnaDeliverySupplement(
  profileValue: unknown,
  traitCap = DEFAULT_TRAIT_CAP,
): ProjectDnaDeliverySupplement | null {
  assertProjectDnaProfile(profileValue);
  const profile = profileValue;
  if (!Number.isSafeInteger(traitCap) || traitCap < 1 || traitCap > MAX_TRAIT_CAP) {
    throw new Error(`project DNA trait cap must be an integer between 1 and ${MAX_TRAIT_CAP}`);
  }
  const selected = orderedTraits(profile).slice(0, traitCap);
  if (!selected.length) return null;

  const lines = selected.map((trait) => {
    const evidence = trait.evidence.map((item) => item.ref).slice(0, 2).join(", ");
    return `• [${trait.category}] ${trait.claim} (${trait.confidence.toFixed(2)}; ${trait.id}; evidence: ${evidence})`;
  });
  const omitted = Math.max(0, profile.traits.length - selected.length);
  const text = [
    `PROJECT DNA — observed repository conventions (advisory, ${profile.profile_id}, revision ${profile.repository_revision})`,
    ...lines,
    omitted ? `• … ${omitted} lower-priority DNA trait(s) omitted from this orientation slice.` : "",
    "Use these traits to communicate and contribute naturally. They never override Hunch decisions, constraints, policy, or current task evidence.",
  ].filter(Boolean).join("\n");

  return {
    id: profile.profile_id,
    kind: PROJECT_DNA_SUPPLEMENT_KIND,
    text,
    // Ranked memory and blocking invariants remain above this supplement. Hosts
    // may lower this further, but should not raise observational DNA over authority.
    priority: 425,
  };
}
