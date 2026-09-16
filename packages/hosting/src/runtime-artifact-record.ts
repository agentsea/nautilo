/**
 * D488's receiving contract for D490's published runtime handoff.
 *
 * This deliberately revalidates only the compact, signed-off artifact record.
 * It does not import the image build, scanner, or GitHub workflow machinery.
 */
export const RUNTIME_ARTIFACT_RECORD_SCHEMA_VERSION = 1 as const;
export const RUNTIME_ARTIFACT_RECORD_MAX_BYTES = 64 * 1024;
export const CANONICAL_RUNTIME_IMAGE_REPOSITORY = "ghcr.io/agentsea/nautilo-runtime-v2";
export const LEGACY_RUNTIME_IMAGE_REPOSITORY = "ghcr.io/agentsea/nautilo-runtime";

export const RUNTIME_ARTIFACT_AUTH_CONTRACT =
  "Anonymous pull of ghcr.io/agentsea/nautilo-runtime-v2 by immutable digest; runtime requires configured Logto OIDC.";
export const LEGACY_RUNTIME_ARTIFACT_AUTH_CONTRACT =
  "Anonymous pull of ghcr.io/agentsea/nautilo-runtime by immutable digest; runtime requires configured Logto OIDC.";
export const RUNTIME_ARTIFACT_DATABASE_COMPATIBILITY =
  "This record adds no database migration; use the existing ComposeDriver migration-aware release transaction.";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const PLATFORM_NAMES = ["linux/amd64", "linux/arm64"] as const;
const EVIDENCE_NAMES = ["sbom", "vulnerabilities", "disclosure", "licenses", "acceptance"] as const;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const ZERO_SOURCE_SHA = "0".repeat(40);

type PlatformName = typeof PLATFORM_NAMES[number];
type EvidenceName = typeof EVIDENCE_NAMES[number];
type Digest = `sha256:${string}`;

export interface RuntimeArtifactRecordV1 {
  readonly version: typeof RUNTIME_ARTIFACT_RECORD_SCHEMA_VERSION;
  readonly sourceSha: string;
  readonly image: `${typeof CANONICAL_RUNTIME_IMAGE_REPOSITORY | typeof LEGACY_RUNTIME_IMAGE_REPOSITORY}@sha256:${string}`;
  readonly manifestDigest: Digest;
  readonly architectures: Readonly<Record<PlatformName, Digest>>;
  readonly evidence: Readonly<Record<EvidenceName, Digest>>;
  readonly compatibility: Readonly<{
    readonly authContract: typeof RUNTIME_ARTIFACT_AUTH_CONTRACT | typeof LEGACY_RUNTIME_ARTIFACT_AUTH_CONTRACT;
    readonly database: typeof RUNTIME_ARTIFACT_DATABASE_COMPATIBILITY;
    readonly rollback: "full-bundle-required";
  }>;
}

/**
 * An identity selected by an authority outside the downloaded D490 record.
 * A structurally valid record is evidence, not permission to release it.
 */
export interface RuntimeArtifactRecordApproval {
  readonly sourceSha: string;
  readonly manifestDigest: Digest;
}

declare const VERIFIED_RUNTIME_ARTIFACT_RECORD: unique symbol;
/** A record that has crossed this package's exact V1 receiving gate. */
export type VerifiedRuntimeArtifactRecord = RuntimeArtifactRecordV1 & {
  readonly [VERIFIED_RUNTIME_ARTIFACT_RECORD]: true;
};

export type RuntimeArtifactRecordFailureCode =
  | "hosting.runtime-artifact.malformed"
  | "hosting.runtime-artifact.unsupported-version"
  | "hosting.runtime-artifact.unapproved-runtime"
  | "hosting.runtime-artifact.inconsistent-digest"
  | "hosting.runtime-artifact.missing-evidence"
  | "hosting.runtime-artifact.incompatible-contract";

export type RuntimeArtifactRecordVerification =
  | { readonly ok: true; readonly record: VerifiedRuntimeArtifactRecord }
  | { readonly ok: false; readonly code: RuntimeArtifactRecordFailureCode };

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

function isApprovedIdentity(value: unknown): value is RuntimeArtifactRecordApproval {
  return isPlainObject(value) && hasExactKeys(value, ["sourceSha", "manifestDigest"]) &&
    readSourceSha(value["sourceSha"]) !== null && readDigest(value["manifestDigest"]) !== null;
}

function readCanonicalImage(value: unknown, expectedDigest: Digest): RuntimeArtifactRecordV1["image"] | null {
  if (typeof value !== "string" || value.length > 255) return null;
  const repository = [CANONICAL_RUNTIME_IMAGE_REPOSITORY, LEGACY_RUNTIME_IMAGE_REPOSITORY]
    .find((candidate) => value.startsWith(`${candidate}@`));
  if (repository === undefined) return null;
  const prefix = `${repository}@`;
  const digest = readDigest(value.slice(prefix.length));
  return digest !== null && digest === expectedDigest
    ? value as RuntimeArtifactRecordV1["image"]
    : null;
}

function readDigests(
  value: unknown,
  names: readonly string[],
): Readonly<Record<string, Digest>> | null {
  if (!isPlainObject(value) || !hasExactKeys(value, names)) return null;
  const output: Record<string, Digest> = {};
  for (const name of names) {
    const digest = readDigest(value[name]);
    if (digest === null) return null;
    output[name] = digest;
  }
  return output;
}

/**
 * Validates a D490 artifact record before D488 can project its runtime image
 * into a larger five-image release. This is intentionally not a release
 * verification: bootstrap, Logto, Postgres, signing, and distribution remain
 * separate authorities.
 */
export function verifyRuntimeArtifactRecord(
  value: unknown,
  approval: RuntimeArtifactRecordApproval,
): RuntimeArtifactRecordVerification {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "version", "sourceSha", "image", "manifestDigest", "architectures", "evidence", "compatibility",
  ])) {
    return { ok: false, code: "hosting.runtime-artifact.malformed" };
  }
  if (value["version"] !== RUNTIME_ARTIFACT_RECORD_SCHEMA_VERSION) {
    return { ok: false, code: "hosting.runtime-artifact.unsupported-version" };
  }
  const sourceSha = readSourceSha(value["sourceSha"]);
  if (sourceSha === null) {
    return { ok: false, code: "hosting.runtime-artifact.malformed" };
  }

  const manifestDigest = readDigest(value["manifestDigest"]);
  if (manifestDigest === null) return { ok: false, code: "hosting.runtime-artifact.malformed" };
  const image = readCanonicalImage(value["image"], manifestDigest);
  if (image === null) return { ok: false, code: "hosting.runtime-artifact.unapproved-runtime" };
  if (!isApprovedIdentity(approval) || approval.sourceSha !== sourceSha || approval.manifestDigest !== manifestDigest) {
    return { ok: false, code: "hosting.runtime-artifact.unapproved-runtime" };
  }

  const architectures = readDigests(value["architectures"], PLATFORM_NAMES);
  if (architectures === null) return { ok: false, code: "hosting.runtime-artifact.malformed" };
  const amd64 = architectures["linux/amd64"];
  const arm64 = architectures["linux/arm64"];
  if (amd64 === manifestDigest || arm64 === manifestDigest || amd64 === arm64) {
    return { ok: false, code: "hosting.runtime-artifact.inconsistent-digest" };
  }

  const evidence = readDigests(value["evidence"], EVIDENCE_NAMES);
  if (evidence === null) return { ok: false, code: "hosting.runtime-artifact.missing-evidence" };
  if (!isPlainObject(value["compatibility"]) || !hasExactKeys(value["compatibility"], ["authContract", "database", "rollback"])) {
    return { ok: false, code: "hosting.runtime-artifact.incompatible-contract" };
  }
  const expectedAuthContract = image.startsWith(`${CANONICAL_RUNTIME_IMAGE_REPOSITORY}@`)
    ? RUNTIME_ARTIFACT_AUTH_CONTRACT
    : LEGACY_RUNTIME_ARTIFACT_AUTH_CONTRACT;
  if (value["compatibility"]["authContract"] !== expectedAuthContract ||
    value["compatibility"]["database"] !== RUNTIME_ARTIFACT_DATABASE_COMPATIBILITY ||
    value["compatibility"]["rollback"] !== "full-bundle-required") {
    return { ok: false, code: "hosting.runtime-artifact.incompatible-contract" };
  }

  return {
    ok: true,
    record: {
      version: RUNTIME_ARTIFACT_RECORD_SCHEMA_VERSION,
      sourceSha,
      image,
      manifestDigest,
      architectures: {
        "linux/amd64": amd64,
        "linux/arm64": arm64,
      },
      evidence: {
        sbom: evidence["sbom"]!,
        vulnerabilities: evidence["vulnerabilities"]!,
        disclosure: evidence["disclosure"]!,
        licenses: evidence["licenses"]!,
        acceptance: evidence["acceptance"]!,
      },
      compatibility: {
        authContract: expectedAuthContract,
        database: RUNTIME_ARTIFACT_DATABASE_COMPATIBILITY,
        rollback: "full-bundle-required",
      },
    } as VerifiedRuntimeArtifactRecord,
  };
}

/** Parses a bounded JSON artifact before applying the same exact receiving gate. */
export function parseRuntimeArtifactRecordJson(
  value: Uint8Array | string,
  approval: RuntimeArtifactRecordApproval,
): RuntimeArtifactRecordVerification {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (bytes === 0 || bytes > RUNTIME_ARTIFACT_RECORD_MAX_BYTES) {
    return { ok: false, code: "hosting.runtime-artifact.malformed" };
  }
  try {
    return verifyRuntimeArtifactRecord(
      JSON.parse(typeof value === "string" ? value : Buffer.from(value).toString("utf8")) as unknown,
      approval,
    );
  } catch {
    return { ok: false, code: "hosting.runtime-artifact.malformed" };
  }
}

/** The only server image reference D488 may place into a V1 hosting manifest. */
export function projectRuntimeImage(record: VerifiedRuntimeArtifactRecord): RuntimeArtifactRecordV1["image"] {
  return record.image;
}
