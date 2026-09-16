export const COVERAGE_SURFACES = [
  "db",
  "file",
  "wire",
  "cache",
  "processor",
  "log",
  "notification",
  "backup",
  "export",
] as const;

export type CoverageSurface = (typeof COVERAGE_SURFACES)[number];

export const KEY_FAMILIES = [
  "namespace_ai",
  "namespace_human",
  "namespace_ai_or_human",
  "agent_runtime",
  "agent_management",
] as const;

export type KeyFamily = (typeof KEY_FAMILIES)[number];

export const MIGRATION_STATES = [
  "not_started",
  "shadow",
  "verified",
  "ciphertext_reading",
  "ciphertext_only",
  "not_applicable",
] as const;

export type MigrationState = (typeof MIGRATION_STATES)[number];

export const REMEDIATION_STATES = ["untriaged", "planned", "deferred"] as const;
export type RemediationState = (typeof REMEDIATION_STATES)[number];

export const RELEASE_IMPACTS = [
  "blocks_enabled_scope",
  "blocks_whole_product_claim",
] as const;
export type ReleaseImpact = (typeof RELEASE_IMPACTS)[number];

type CoverageCommon = {
  readonly id: string;
  readonly surface: CoverageSurface;
  readonly locator: string;
  readonly owner: string;
  readonly readers: readonly string[];
  readonly writers: readonly string[];
  readonly migrationState: MigrationState;
  readonly retention: string;
  readonly testEvidence: readonly string[];
};

export type ProtectedCoverageEntry = CoverageCommon & {
  readonly classification: "protected";
  readonly keyFamily: KeyFamily;
  readonly bridgeRepository: string;
  readonly negativeTestEvidence: readonly string[];
};

export type BoundedMetadataCoverageEntry = CoverageCommon & {
  readonly classification: "bounded_metadata";
  readonly metadataAllowlist: readonly string[];
  readonly plaintextReason: string;
};

export type PublicCoverageEntry = CoverageCommon & {
  readonly classification: "public";
  readonly plaintextReason: string;
};

export type OperatorSecretCoverageEntry = CoverageCommon & {
  readonly classification: "operator_secret";
  readonly secretStoreLocation: string;
  readonly backupProcedure: string;
  readonly excludedFromAgentGrants: true;
};

export type DeviceLocalCoverageEntry = CoverageCommon & {
  readonly classification: "device_local";
  readonly deviceStorage: string;
  readonly cleanupContract: string;
};

export type EncryptionCoverageEntry =
  | ProtectedCoverageEntry
  | BoundedMetadataCoverageEntry
  | PublicCoverageEntry
  | OperatorSecretCoverageEntry
  | DeviceLocalCoverageEntry;

export type EncryptionClassification = EncryptionCoverageEntry["classification"];

export type EncryptionBaselineDebt = {
  readonly id: string;
  readonly surface: CoverageSurface;
  readonly locator: string;
  readonly owner: string;
  readonly reason: string;
  readonly remediationState: RemediationState;
  readonly releaseImpact: ReleaseImpact;
  readonly evidenceGap: string;
};

export type CoverageException = {
  readonly id: string;
  readonly owner: string;
  readonly scope: readonly string[];
  readonly reason: string;
  readonly compensatingControls: readonly string[];
  readonly testEvidence: readonly string[];
  readonly reviewBy: string;
  readonly releaseImpact: ReleaseImpact;
};

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

type CandidateObject = Record<string, unknown> & {
  id?: unknown;
  surface?: unknown;
  locator?: unknown;
  owner?: unknown;
  readers?: unknown;
  writers?: unknown;
  migrationState?: unknown;
  retention?: unknown;
  testEvidence?: unknown;
  classification?: unknown;
  keyFamily?: unknown;
  bridgeRepository?: unknown;
  negativeTestEvidence?: unknown;
  metadataAllowlist?: unknown;
  plaintextReason?: unknown;
  secretStoreLocation?: unknown;
  backupProcedure?: unknown;
  excludedFromAgentGrants?: unknown;
  deviceStorage?: unknown;
  cleanupContract?: unknown;
  reason?: unknown;
  remediationState?: unknown;
  releaseImpact?: unknown;
  evidenceGap?: unknown;
  scope?: unknown;
  compensatingControls?: unknown;
  reviewBy?: unknown;
};

function isRecord(value: unknown): value is CandidateObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDescriptive(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 12;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return isStringArray(value) && value.length > 0;
}

function isStableId(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(value);
}

function isRepositoryRelativePath(value: string): boolean {
  return value.trim() === value
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.includes("\\")
    && value.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== ".."
    );
}

function isTestPath(value: string): boolean {
  return isRepositoryRelativePath(value)
    && /\.test\.(?:ts|tsx|js|jsx)$/.test(value);
}

function isTestPathArray(value: unknown): value is readonly string[] {
  return isNonEmptyStringArray(value) && value.every(isTestPath);
}

function isExactLocatorPart(value: string): boolean {
  return value !== "*" && !value.endsWith(".*") && value.trim() === value;
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function validateCommonEntry(input: CandidateObject): string[] {
  const errors: string[] = [];
  if (!isStableId(input.id)) errors.push("id must be a stable dotted identifier");
  if (!COVERAGE_SURFACES.includes(input.surface as CoverageSurface)) {
    errors.push("surface is invalid");
  }
  if (!isNonEmptyString(input.locator)) errors.push("locator must be non-empty");
  else if (input.locator.endsWith(".*")) {
    errors.push("locator must not end in an unbounded wildcard");
  }
  if (!isNonEmptyString(input.owner)) errors.push("owner must be non-empty");
  if (!isStringArray(input.readers)) errors.push("readers must be a string array");
  if (!isStringArray(input.writers)) errors.push("writers must be a string array");
  if (!MIGRATION_STATES.includes(input.migrationState as MigrationState)) {
    errors.push("migrationState is invalid");
  }
  if (!isDescriptive(input.retention)) errors.push("retention must be descriptive");
  if (!isTestPathArray(input.testEvidence)) {
    errors.push("testEvidence must contain at least one executable test path");
  }
  return errors;
}

export function validateCoverageEntry(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["coverage entry must be an object"] };
  }

  const errors = validateCommonEntry(input);
  switch (input.classification) {
    case "protected":
      if (!KEY_FAMILIES.includes(input.keyFamily as KeyFamily)) {
        errors.push("keyFamily is invalid");
      }
      if (
        !isNonEmptyString(input.bridgeRepository)
        || input.bridgeRepository.startsWith("future:")
        || !input.bridgeRepository.includes("/")
        || !isRepositoryRelativePath(input.bridgeRepository)
      ) {
        errors.push("bridgeRepository must be a concrete repository path");
      }
      if (!isTestPathArray(input.negativeTestEvidence)) {
        errors.push("negativeTestEvidence must contain at least one executable test path");
      }
      break;
    case "bounded_metadata":
      if (
        !isNonEmptyStringArray(input.metadataAllowlist)
        || !input.metadataAllowlist.every(isExactLocatorPart)
      ) {
        errors.push("metadataAllowlist must contain exact field names");
      }
      if (!isDescriptive(input.plaintextReason)) {
        errors.push("plaintextReason must be descriptive");
      }
      break;
    case "public":
      if (!isDescriptive(input.plaintextReason)) {
        errors.push("plaintextReason must be descriptive");
      }
      break;
    case "operator_secret":
      if (!isDescriptive(input.secretStoreLocation)) {
        errors.push("secretStoreLocation must be descriptive");
      }
      if (!isDescriptive(input.backupProcedure)) {
        errors.push("backupProcedure must be descriptive");
      }
      if (input.excludedFromAgentGrants !== true) {
        errors.push("operator secrets must be excluded from Agent grants");
      }
      break;
    case "device_local":
      if (!isDescriptive(input.deviceStorage)) {
        errors.push("deviceStorage must be descriptive");
      }
      if (!isDescriptive(input.cleanupContract)) {
        errors.push("cleanupContract must be descriptive");
      }
      break;
    default:
      errors.push("classification is invalid");
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateBaselineDebt(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["baseline debt must be an object"] };
  }
  const errors: string[] = [];
  if (!isStableId(input.id)) errors.push("id must be a stable dotted identifier");
  if (!COVERAGE_SURFACES.includes(input.surface as CoverageSurface)) {
    errors.push("surface is invalid");
  }
  if (!isNonEmptyString(input.locator)) errors.push("locator must be non-empty");
  if (!isNonEmptyString(input.owner)) errors.push("owner must be non-empty");
  if (!isDescriptive(input.reason)) errors.push("reason must be descriptive");
  if (!REMEDIATION_STATES.includes(input.remediationState as RemediationState)) {
    errors.push("remediationState is invalid");
  }
  if (!RELEASE_IMPACTS.includes(input.releaseImpact as ReleaseImpact)) {
    errors.push("releaseImpact is invalid");
  }
  if (!isDescriptive(input.evidenceGap)) errors.push("evidenceGap must be descriptive");
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

export function validateCoverageException(input: unknown): ValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["coverage exception must be an object"] };
  }
  const errors: string[] = [];
  if (!isStableId(input.id)) errors.push("id must be a stable dotted identifier");
  if (!isNonEmptyString(input.owner)) errors.push("owner must be non-empty");
  if (
    !isNonEmptyStringArray(input.scope)
    || !input.scope.every(isExactLocatorPart)
  ) {
    errors.push("scope must contain at least one exact locator");
  }
  if (!isDescriptive(input.reason)) errors.push("reason must be descriptive");
  if (!isNonEmptyStringArray(input.compensatingControls)) {
    errors.push("compensatingControls must not be empty");
  }
  if (!isTestPathArray(input.testEvidence)) {
    errors.push("testEvidence must contain at least one executable test path");
  }
  if (!isIsoCalendarDate(input.reviewBy)) {
    errors.push("reviewBy must be an ISO calendar date");
  }
  if (!RELEASE_IMPACTS.includes(input.releaseImpact as ReleaseImpact)) {
    errors.push("releaseImpact is invalid");
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
