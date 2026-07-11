import type { G2BehaviorAttestation } from "./g2BehaviorAttestation.js";
import type { PolicySpec } from "./schema.js";

export function executableBehaviorAttestationError(
  policy: PolicySpec,
  currentAttestations: G2BehaviorAttestation[],
): string | null {
  if (policy.assertion.kind !== "executable-behavior") return null;
  const binding = policy.assertion.attestation;
  const current = currentAttestations.find((attestation) => attestation.id === binding.id);
  if (!current
    || current.disposition !== "selected"
    || current.content_hash !== binding.content_hash
    || current.candidate_id !== binding.candidate_id
    || current.candidate_hash !== binding.candidate_hash
    || current.replay_id !== binding.replay_id
    || current.replay_hash !== binding.replay_hash) {
    return "executable behavior policy is not bound to a current exact selected human attestation";
  }
  return null;
}
