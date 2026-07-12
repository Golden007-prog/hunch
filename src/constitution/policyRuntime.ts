import {
  BEHAVIOR_MUTATION_ENGINE,
  BEHAVIOR_POLICY_EVALUATOR,
  MUTATION_ENGINE,
  POLICY_EVALUATOR,
  type PolicySpec,
} from "./schema.js";

export type PolicyEvaluatorIdentity = typeof POLICY_EVALUATOR | typeof BEHAVIOR_POLICY_EVALUATOR;
export type PolicyMutationEngineIdentity = typeof MUTATION_ENGINE | typeof BEHAVIOR_MUTATION_ENGINE;

export function evaluatorForPolicy(policy: PolicySpec): PolicyEvaluatorIdentity {
  return policy.assertion.kind === "executable-behavior" ? BEHAVIOR_POLICY_EVALUATOR : POLICY_EVALUATOR;
}

export function mutationEngineForPolicy(policy: PolicySpec): PolicyMutationEngineIdentity {
  return policy.assertion.kind === "executable-behavior" ? BEHAVIOR_MUTATION_ENGINE : MUTATION_ENGINE;
}
