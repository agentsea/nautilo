export const LIMIT_INVENTORY_SCHEMA_VERSION = 2;

export const LIMIT_EFFECTS = [
  "bound",
  "chunk",
  "clamp",
  "concurrency",
  "evict",
  "omit",
  "paginate",
  "payload",
  "reject",
  "retain",
  "retry",
  "sample",
  "schema_max",
  "summarize",
  "terminate",
  "truncate",
  "warn",
] as const;
export type LimitEffect = typeof LIMIT_EFFECTS[number];

export const LIMIT_REACHABILITIES = [
  "live",
  "operator_ci",
  "test",
  "migration_history",
  "generated",
  "vendor",
  "external",
] as const;
export type LimitReachability = typeof LIMIT_REACHABILITIES[number];

export const LIMIT_SOURCE_KINDS = ["typescript", "json", "yaml", "shell", "toml"] as const;
export type LimitSourceKind = typeof LIMIT_SOURCE_KINDS[number];

export const EXTRACTION_CONFIDENCES = ["high", "medium", "low"] as const;
export type ExtractionConfidence = typeof EXTRACTION_CONFIDENCES[number];

export const MECHANICAL_PRIORITIES = ["high", "medium", "low"] as const;
export type MechanicalPriority = typeof MECHANICAL_PRIORITIES[number];

export const LIMIT_LANES = ["primary", "scout", "evidence"] as const;
export type LimitLane = typeof LIMIT_LANES[number];

export type LimitSite = {
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly detector: string;
  readonly expression: string;
  readonly reasonCode: string;
};

export type LimitObservation = {
  readonly locator: string;
  readonly fingerprint: string;
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly owner: string;
  readonly sourceKind: LimitSourceKind;
  readonly detector: string;
  readonly effect: LimitEffect;
  readonly value: string;
  readonly unit: string;
  readonly reachability: LimitReachability;
  readonly extractionConfidence: ExtractionConfidence;
  readonly mechanicalPriority: MechanicalPriority;
  readonly reasonCode: string;
  readonly effects: readonly LimitEffect[];
  readonly reasonCodes: readonly string[];
  readonly lane: LimitLane;
  readonly siteCount: number;
  readonly sites: readonly LimitSite[];
};

export const LIMIT_INVESTIGATION_LINK_KINDS = [
  "caller",
  "consumer",
  "continuation",
  "definition",
  "generated_consumer",
  "import",
  "policy_family",
] as const;
export type LimitInvestigationLinkKind = typeof LIMIT_INVESTIGATION_LINK_KINDS[number];

export type LimitInvestigationLink = {
  readonly kind: LimitInvestigationLinkKind;
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly reasonCode: string;
  readonly detail: string;
  readonly relatedLocator?: string;
};

export type LimitDetectorCoverage = {
  readonly recordType: "coverage";
  readonly supportedSourceKinds: readonly LimitSourceKind[];
  readonly supportedSyntax: readonly string[];
  readonly unsupportedSyntax: readonly string[];
};

export type LimitScanEvidence = {
  readonly observations: readonly LimitObservation[];
  readonly coverage: LimitDetectorCoverage;
  readonly linksByLocator: ReadonlyMap<string, readonly LimitInvestigationLink[]>;
};

export const LIMIT_CLASSIFICATIONS = [
  "authoritative_hard_limit",
  "measured_operational_limit",
  "lossless_boundary",
  "caller_policy",
  "soft_default",
  "ui_projection",
  "temporary_debt",
  "arbitrary",
] as const;
export type LimitClassification = typeof LIMIT_CLASSIFICATIONS[number];

export const LIMIT_DISPOSITIONS = [
  "retain",
  "derive",
  "remove",
  "redesign",
  "defer_named",
] as const;
export type LimitDisposition = typeof LIMIT_DISPOSITIONS[number];

export type ReviewedLimitDecision = {
  readonly locator: string;
  readonly fingerprint: string;
  readonly classification: LimitClassification;
  readonly disposition: LimitDisposition;
  readonly authority: string;
  readonly owner: string;
  readonly lossAndCompleteness: string;
  readonly visibility: string;
  readonly continuationOrRecovery: string;
  readonly evidence: readonly string[];
  readonly rationale: string;
};

export type LegacyLimitDebt = {
  readonly locator: string;
  readonly fingerprint: string;
  readonly owner: string;
  readonly mechanicalPriority: MechanicalPriority;
};

export type LegacyLimitLock = {
  readonly schemaVersion: number;
  readonly count: number;
  readonly sha256: string;
};

export type LimitCheckResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly observations: number;
  readonly reviewed: number;
  readonly legacy: number;
  readonly unreviewed: number;
};

export function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
