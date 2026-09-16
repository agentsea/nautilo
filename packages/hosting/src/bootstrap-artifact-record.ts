/** D488's receiving contract for the independently published bootstrap image. */
export const BOOTSTRAP_ARTIFACT_RECORD_SCHEMA_VERSION = 1 as const;
export const BOOTSTRAP_ARTIFACT_RECORD_MAX_BYTES = 64 * 1024;
export const CANONICAL_BOOTSTRAP_IMAGE_REPOSITORY = "ghcr.io/agentsea/nautilo-bootstrap-runtime-v2";
export const LEGACY_BOOTSTRAP_IMAGE_REPOSITORY = "ghcr.io/agentsea/nautilo-bootstrap-runtime";

export const BOOTSTRAP_ARTIFACT_EXECUTION_CONTRACT =
  "One-shot nonroot database and Logto reconciliation; never a long-running customer service.";
export const BOOTSTRAP_ARTIFACT_SAFE_FAILURE_CONTRACT =
  "Missing or invalid environment and unreachable databases exit non-zero with receipt-safe JSON and no secret values.";
export const BOOTSTRAP_ARTIFACT_DATABASE_COMPATIBILITY =
  "Reconciliation is idempotent and retryable; promotion requires native missing-database safe-failure evidence.";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const PLATFORM_NAMES = ["linux/amd64", "linux/arm64"] as const;
const EVIDENCE_NAMES = ["sbom", "vulnerabilities", "disclosure", "licenses", "safeFailure"] as const;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const ZERO_SOURCE_SHA = "0".repeat(40);

type PlatformName = typeof PLATFORM_NAMES[number];
type EvidenceName = typeof EVIDENCE_NAMES[number];
type Digest = `sha256:${string}`;

export interface BootstrapArtifactRecordV1 {
  readonly version: typeof BOOTSTRAP_ARTIFACT_RECORD_SCHEMA_VERSION;
  readonly sourceSha: string;
  readonly image: `${typeof CANONICAL_BOOTSTRAP_IMAGE_REPOSITORY | typeof LEGACY_BOOTSTRAP_IMAGE_REPOSITORY}@sha256:${string}`;
  readonly manifestDigest: Digest;
  readonly architectures: Readonly<Record<PlatformName, Digest>>;
  readonly evidence: Readonly<Record<EvidenceName, Digest>>;
  readonly compatibility: Readonly<{
    readonly execution: typeof BOOTSTRAP_ARTIFACT_EXECUTION_CONTRACT;
    readonly safeFailure: typeof BOOTSTRAP_ARTIFACT_SAFE_FAILURE_CONTRACT;
    readonly database: typeof BOOTSTRAP_ARTIFACT_DATABASE_COMPATIBILITY;
    readonly rollback: "rerun-idempotently";
  }>;
}

export interface BootstrapArtifactRecordApproval {
  readonly sourceSha: string;
  readonly manifestDigest: Digest;
}

declare const VERIFIED_BOOTSTRAP_ARTIFACT_RECORD: unique symbol;
export type VerifiedBootstrapArtifactRecord = BootstrapArtifactRecordV1 & {
  readonly [VERIFIED_BOOTSTRAP_ARTIFACT_RECORD]: true;
};

export type BootstrapArtifactRecordFailureCode =
  | "hosting.bootstrap-artifact.malformed"
  | "hosting.bootstrap-artifact.unsupported-version"
  | "hosting.bootstrap-artifact.unapproved-bootstrap"
  | "hosting.bootstrap-artifact.inconsistent-digest"
  | "hosting.bootstrap-artifact.missing-evidence"
  | "hosting.bootstrap-artifact.incompatible-contract";

export type BootstrapArtifactRecordVerification =
  | { readonly ok: true; readonly record: VerifiedBootstrapArtifactRecord }
  | { readonly ok: false; readonly code: BootstrapArtifactRecordFailureCode };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function readDigest(value: unknown): Digest | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) && value !== ZERO_DIGEST
    ? value as Digest
    : null;
}

function readSourceSha(value: unknown): string | null {
  return typeof value === "string" && SOURCE_SHA_PATTERN.test(value) && value !== ZERO_SOURCE_SHA
    ? value
    : null;
}

function isApprovedIdentity(value: unknown): value is BootstrapArtifactRecordApproval {
  return isPlainObject(value) && hasExactKeys(value, ["sourceSha", "manifestDigest"]) &&
    readSourceSha(value["sourceSha"]) !== null && readDigest(value["manifestDigest"]) !== null;
}

function readDigests(value: unknown, names: readonly string[]): Readonly<Record<string, Digest>> | null {
  if (!isPlainObject(value) || !hasExactKeys(value, names)) return null;
  const output: Record<string, Digest> = {};
  for (const name of names) {
    const digest = readDigest(value[name]);
    if (digest === null) return null;
    output[name] = digest;
  }
  return output;
}

export function verifyBootstrapArtifactRecord(
  value: unknown,
  approval: BootstrapArtifactRecordApproval,
): BootstrapArtifactRecordVerification {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "version", "sourceSha", "image", "manifestDigest", "architectures", "evidence", "compatibility",
  ])) return { ok: false, code: "hosting.bootstrap-artifact.malformed" };
  if (value["version"] !== BOOTSTRAP_ARTIFACT_RECORD_SCHEMA_VERSION) {
    return { ok: false, code: "hosting.bootstrap-artifact.unsupported-version" };
  }
  const sourceSha = readSourceSha(value["sourceSha"]);
  const manifestDigest = readDigest(value["manifestDigest"]);
  if (sourceSha === null || manifestDigest === null) {
    return { ok: false, code: "hosting.bootstrap-artifact.malformed" };
  }
  if (!isApprovedIdentity(approval) || approval.sourceSha !== sourceSha || approval.manifestDigest !== manifestDigest) {
    return { ok: false, code: "hosting.bootstrap-artifact.unapproved-bootstrap" };
  }
  const image = value["image"];
  if (image !== `${CANONICAL_BOOTSTRAP_IMAGE_REPOSITORY}@${manifestDigest}` &&
    image !== `${LEGACY_BOOTSTRAP_IMAGE_REPOSITORY}@${manifestDigest}`) {
    return { ok: false, code: "hosting.bootstrap-artifact.unapproved-bootstrap" };
  }
  const architectures = readDigests(value["architectures"], PLATFORM_NAMES);
  if (architectures === null) return { ok: false, code: "hosting.bootstrap-artifact.malformed" };
  const amd64 = architectures["linux/amd64"]!;
  const arm64 = architectures["linux/arm64"]!;
  if (amd64 === arm64 || amd64 === manifestDigest || arm64 === manifestDigest) {
    return { ok: false, code: "hosting.bootstrap-artifact.inconsistent-digest" };
  }
  const evidence = readDigests(value["evidence"], EVIDENCE_NAMES);
  if (evidence === null) return { ok: false, code: "hosting.bootstrap-artifact.missing-evidence" };
  const compatibility = value["compatibility"];
  if (!isPlainObject(compatibility) || !hasExactKeys(compatibility, ["execution", "safeFailure", "database", "rollback"]) ||
    compatibility["execution"] !== BOOTSTRAP_ARTIFACT_EXECUTION_CONTRACT ||
    compatibility["safeFailure"] !== BOOTSTRAP_ARTIFACT_SAFE_FAILURE_CONTRACT ||
    compatibility["database"] !== BOOTSTRAP_ARTIFACT_DATABASE_COMPATIBILITY ||
    compatibility["rollback"] !== "rerun-idempotently") {
    return { ok: false, code: "hosting.bootstrap-artifact.incompatible-contract" };
  }
  return {
    ok: true,
    record: {
      version: BOOTSTRAP_ARTIFACT_RECORD_SCHEMA_VERSION,
      sourceSha,
      image: image as BootstrapArtifactRecordV1["image"],
      manifestDigest,
      architectures: { "linux/amd64": amd64, "linux/arm64": arm64 },
      evidence: {
        sbom: evidence["sbom"]!,
        vulnerabilities: evidence["vulnerabilities"]!,
        disclosure: evidence["disclosure"]!,
        licenses: evidence["licenses"]!,
        safeFailure: evidence["safeFailure"]!,
      },
      compatibility: {
        execution: BOOTSTRAP_ARTIFACT_EXECUTION_CONTRACT,
        safeFailure: BOOTSTRAP_ARTIFACT_SAFE_FAILURE_CONTRACT,
        database: BOOTSTRAP_ARTIFACT_DATABASE_COMPATIBILITY,
        rollback: "rerun-idempotently",
      },
    } as VerifiedBootstrapArtifactRecord,
  };
}

export function parseBootstrapArtifactRecordJson(
  value: Uint8Array | string,
  approval: BootstrapArtifactRecordApproval,
): BootstrapArtifactRecordVerification {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (bytes === 0 || bytes > BOOTSTRAP_ARTIFACT_RECORD_MAX_BYTES) {
    return { ok: false, code: "hosting.bootstrap-artifact.malformed" };
  }
  try {
    return verifyBootstrapArtifactRecord(
      JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8")) as unknown,
      approval,
    );
  } catch {
    return { ok: false, code: "hosting.bootstrap-artifact.malformed" };
  }
}

export function projectBootstrapImage(
  record: VerifiedBootstrapArtifactRecord,
): BootstrapArtifactRecordV1["image"] {
  return record.image;
}
