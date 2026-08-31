/**
 * Stable public programmatic surface for the Project DNA Engine.
 *
 * Keep transport/orchestration consumers on this barrel so internal core file
 * layout can evolve without changing the published contract entry point.
 */
export {
  PROJECT_DNA_CATEGORIES,
  PROJECT_DNA_MATCH_SCHEMA_VERSION,
  PROJECT_DNA_SCHEMA_VERSION,
  assertProjectDnaMatch,
  assertProjectDnaProfile,
  discoverProjectDna,
  evaluateProjectDnaMatch,
  type ProjectDnaArtifact,
  type ProjectDnaCategory,
  type ProjectDnaEvidence,
  type ProjectDnaEvidenceKind,
  type ProjectDnaMatch,
  type ProjectDnaMatchCheck,
  type ProjectDnaProfile,
  type ProjectDnaTrait,
} from "./core/projectDna.js";
export {
  PROJECT_DNA_DELTA_SCHEMA_VERSION,
  assertProjectDnaDelta,
  diffProjectDna,
  type ProjectDnaChangeKind,
  type ProjectDnaDelta,
  type ProjectDnaTraitChange,
} from "./core/projectDnaDelta.js";
export {
  PROJECT_DNA_SUPPLEMENT_KIND,
  projectDnaDeliverySupplement,
  type ProjectDnaDeliverySupplement,
} from "./core/projectDnaDelivery.js";
