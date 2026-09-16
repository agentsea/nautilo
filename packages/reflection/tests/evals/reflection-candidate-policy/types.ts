export const REFLECTION_CORPUS_SCHEMA =
  "nautilo/reflection-candidate-corpus/v1" as const;
export const REFLECTION_RESULT_SCHEMA =
  "nautilo/reflection-candidate-results/v1" as const;

export type EvaluationMode = "same_room" | "cross_room";
export type RecordSourceKind = "memory" | "journal" | "message" | "parent";
export type RecordPosture = "authored" | "derived";
export type RecordLifecycle =
  | "current"
  | "stale"
  | "superseded"
  | "resolved"
  | "sunset";
export type CandidatePolicyId =
  | "semantic_neighbors"
  | "existing_parent"
  | "temporal_room_anchor";
export type BaselineId = "memory" | "journal_recent" | "flat_combined";

export interface SyntheticAudiencePath {
  /** One exact, disjunctive effective-audience alternative. */
  namespaceId: string;
  domainId: string;
  humanIds: readonly string[];
  includesPublicBoundary: boolean;
}

export interface SyntheticRecord {
  id: string;
  sourceKind: RecordSourceKind;
  posture: RecordPosture;
  statement: string;
  observedAt: string;
  roomAnchors: readonly string[];
  audiencePaths: readonly SyntheticAudiencePath[];
  parentIds: readonly string[];
  lifecycle: RecordLifecycle;
}

export interface SyntheticInvocationNamespace extends SyntheticAudiencePath {
  roomId: string;
}

export interface CandidateFixture {
  id: string;
  mode: EvaluationMode;
  description: string;
  invocation: SyntheticInvocationNamespace;
  changedRecordId: string;
  records: readonly SyntheticRecord[];
  /** Recorded output of the deterministic fake embedding/similarity port. */
  semanticScores: Readonly<Record<string, number>>;
  requiredCandidateIds: readonly string[];
  acceptableCandidateIds: readonly string[];
  forbiddenCandidateIds: readonly string[];
}

export interface ReflectionCandidateCorpus {
  schema: typeof REFLECTION_CORPUS_SCHEMA;
  version: string;
  policyVersion: string;
  boundGrid: readonly number[];
  baselineBound: number;
  semanticMinimumScore: number;
  fixtures: readonly CandidateFixture[];
}

export interface CandidateSemanticView {
  id: string;
  sourceKind: Exclude<RecordSourceKind, "message">;
  observedAt: string;
  roomAnchors: readonly string[];
  parentIds: readonly string[];
}

export interface CandidateTrace {
  eligiblePoolSize: number;
  consideredIds: readonly string[];
  openedSemanticIds: readonly string[];
  scoredIds: readonly string[];
}

export interface CandidateRun {
  selectedIds: readonly string[];
  scores: Readonly<Record<string, number>>;
  trace: CandidateTrace;
}

export interface FixtureMetrics {
  usefulNeighborRecall: number;
  contaminationRate: number;
  selectedCount: number;
  comparedCount: number;
  anchorCoverage: number;
  existingParentCoverage: number;
  repeatStable: boolean;
}

export interface FixtureGateResult {
  authorityLeakFree: boolean;
  forbiddenExposureFree: boolean;
  requiredRelationshipsReachable: boolean;
  deterministic: boolean;
  passed: boolean;
  failures: readonly string[];
}

export interface FixtureEvaluationResult {
  fixtureId: string;
  mode: EvaluationMode;
  selectedIds: readonly string[];
  trace: CandidateTrace;
  metrics: FixtureMetrics;
  gates: FixtureGateResult;
}

export interface AggregateEvaluationResult {
  id: CandidatePolicyId | BaselineId;
  kind: "candidate_policy" | "baseline";
  mode: EvaluationMode;
  bound: number;
  fixtures: readonly FixtureEvaluationResult[];
  aggregate: {
    hardGatesPassed: boolean;
    meanRecall: number;
    meanContamination: number;
    totalSelected: number;
    totalCompared: number;
    repeatStable: boolean;
  };
}

export interface PolicyDecision {
  mode: EvaluationMode;
  outcome: "selected" | "reject_all";
  policyId: CandidatePolicyId | null;
  bound: number | null;
  reason: string;
}

export interface ReflectionEvaluationReport {
  schema: typeof REFLECTION_RESULT_SCHEMA;
  corpusVersion: string;
  policyVersion: string;
  boundGrid: readonly number[];
  baselineBound: number;
  semanticMinimumScore: number;
  baselines: readonly AggregateEvaluationResult[];
  candidatePolicies: readonly AggregateEvaluationResult[];
  decisions: readonly PolicyDecision[];
}
