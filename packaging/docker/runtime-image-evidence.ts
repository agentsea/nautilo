import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

export type RuntimeImageArchitecture = "linux/amd64" | "linux/arm64";

export interface RuntimeImageBaseIdentity {
  /** A stable label such as `builder` or `runtime`. */
  readonly role: string;
  /** Immutable OCI authority in `repository@sha256:<digest>` form. */
  readonly identity: string;
}

export interface RuntimeImageDatabaseIdentity {
  readonly name: string;
  readonly identity: string;
  readonly version: string;
}

/**
 * The durable, digest-bound input shared by all later exact-image reports.
 * Tool output is intentionally not modelled here: Task 0.3 owns the scanner
 * installation and its report-specific schemas.
 */
export interface RuntimeImageEvidenceManifestV1 {
  readonly version: 1;
  readonly sourceSha: string;
  readonly dockerfileSha256: string;
  readonly baseImages: readonly RuntimeImageBaseIdentity[];
  readonly architecture: RuntimeImageArchitecture;
  readonly image: Readonly<{
    readonly digest: string;
    readonly reference: string;
    readonly sizeBytes: number;
  }>;
  readonly tools: Readonly<Record<string, string>>;
  readonly databases: readonly RuntimeImageDatabaseIdentity[];
  readonly capturedAt: string;
}

export interface WrittenRuntimeImageEvidence {
  readonly directory: string;
  readonly manifestPath: string;
}

const SHA256_PATTERN = /^sha256:([a-f0-9]{64})$/;
const SOURCE_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EMPTY_SHA256 = "0".repeat(64);

function fail(message: string): never {
  throw new Error(`Runtime image evidence is invalid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-blank string`);
  return value;
}

function assertSha256(value: unknown, label: string): string {
  const digest = nonBlankString(value, label);
  const match = SHA256_PATTERN.exec(digest);
  if (!match || match[1] === EMPTY_SHA256) fail(`${label} must be a non-zero sha256 digest`);
  return digest;
}

function assertImmutableReference(value: unknown, label: string, expectedDigest?: string): string {
  const reference = nonBlankString(value, label);
  if (/\s/.test(reference)) fail(`${label} must not contain whitespace`);
  const separator = reference.lastIndexOf("@");
  if (separator < 1 || separator !== reference.indexOf("@")) {
    fail(`${label} must use immutable repository@sha256 authority`);
  }
  const repository = reference.slice(0, separator);
  const digest = reference.slice(separator + 1);
  const lastSegment = repository.slice(repository.lastIndexOf("/") + 1);
  if (repository === "" || lastSegment === "" || lastSegment.includes(":")) {
    fail(`${label} must not use a mutable tag authority`);
  }
  assertSha256(digest, `${label} digest`);
  if (expectedDigest !== undefined && digest !== expectedDigest) {
    fail(`${label} digest must match image.digest`);
  }
  return reference;
}

function assertIsoTimestamp(value: unknown): string {
  const timestamp = nonBlankString(value, "capturedAt");
  const date = new Date(timestamp);
  const canonical = Number.isNaN(date.valueOf()) ? "" : date.toISOString();
  const canonicalWholeSeconds = canonical.replace(".000Z", "Z");
  if (timestamp !== canonical && timestamp !== canonicalWholeSeconds) {
    fail("capturedAt must be a canonical ISO-8601 UTC timestamp");
  }
  return timestamp;
}

function assertStringRecord(value: unknown, label: string): asserts value is Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length === 0) fail(`${label} must contain at least one version`);
  for (const [key, version] of Object.entries(value)) {
    nonBlankString(key, `${label} key`);
    nonBlankString(version, `${label}.${key}`);
  }
}

/** Rejects incomplete, mutable, or internally inconsistent release identity. */
export function assertRuntimeImageEvidenceManifest(value: unknown): asserts value is RuntimeImageEvidenceManifestV1 {
  if (!isRecord(value)) fail("manifest must be an object");
  if (value.version !== 1) fail("version must be 1");

  const sourceSha = nonBlankString(value.sourceSha, "sourceSha");
  if (!SOURCE_SHA_PATTERN.test(sourceSha) || sourceSha === "0".repeat(sourceSha.length)) {
    fail("sourceSha must be a non-zero lowercase Git SHA");
  }
  assertSha256(value.dockerfileSha256, "dockerfileSha256");

  if (!Array.isArray(value.baseImages) || value.baseImages.length === 0) {
    fail("baseImages must contain at least one immutable base-image identity");
  }
  const baseRoles = new Set<string>();
  for (const baseImage of value.baseImages) {
    if (!isRecord(baseImage)) fail("baseImages entries must be objects");
    const role = nonBlankString(baseImage.role, "baseImages role");
    if (baseRoles.has(role)) fail(`baseImages role ${role} is duplicated`);
    baseRoles.add(role);
    assertImmutableReference(baseImage.identity, `baseImages.${role}.identity`);
  }

  if (value.architecture !== "linux/amd64" && value.architecture !== "linux/arm64") {
    fail("architecture must be linux/amd64 or linux/arm64");
  }
  const image = value.image;
  if (!isRecord(image)) fail("image must be an object");
  const imageDigest = assertSha256(image.digest, "image.digest");
  assertImmutableReference(image.reference, "image.reference", imageDigest);
  if (typeof image.sizeBytes !== "number" || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0) {
    fail("image.sizeBytes must be a positive safe integer");
  }

  assertStringRecord(value.tools, "tools");
  if (!Array.isArray(value.databases) || value.databases.length === 0) {
    fail("databases must contain at least one database identity/version");
  }
  const databaseNames = new Set<string>();
  for (const database of value.databases) {
    if (!isRecord(database)) fail("databases entries must be objects");
    const name = nonBlankString(database.name, "databases name");
    if (databaseNames.has(name)) fail(`databases name ${name} is duplicated`);
    databaseNames.add(name);
    nonBlankString(database.identity, `databases.${name}.identity`);
    nonBlankString(database.version, `databases.${name}.version`);
  }
  assertIsoTimestamp(value.capturedAt);
}

/**
 * Relative evidence location. Every segment is cryptographic identity or a
 * fixed architecture token, so distinct qualified images cannot collide.
 */
export function runtimeImageEvidenceRelativePath(manifest: RuntimeImageEvidenceManifestV1): string {
  assertRuntimeImageEvidenceManifest(manifest);
  return posix.join(
    `source-${manifest.sourceSha}`,
    `dockerfile-${manifest.dockerfileSha256.slice("sha256:".length)}`,
    manifest.architecture.replace("/", "-"),
    `image-${manifest.image.digest.slice("sha256:".length)}`,
  );
}

/**
 * Creates exactly one evidence directory and manifest. Existing paths are a
 * collision, including a partially written prior attempt; this is deliberate
 * fail-closed preservation rather than an overwrite or recovery mechanism.
 */
export async function writeRuntimeImageEvidence(
  rootDirectory: string,
  manifest: RuntimeImageEvidenceManifestV1,
): Promise<WrittenRuntimeImageEvidence> {
  assertRuntimeImageEvidenceManifest(manifest);
  const relativePath = runtimeImageEvidenceRelativePath(manifest);
  const directory = resolve(rootDirectory, ...relativePath.split("/"));
  const manifestPath = join(directory, "manifest.json");

  await mkdir(dirname(directory), { recursive: true, mode: 0o755 });
  try {
    await mkdir(directory, { mode: 0o755 });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error(`Runtime image evidence collision: ${directory} already exists`);
    }
    throw error;
  }
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
  } catch (error) {
    throw new Error(`Runtime image evidence write failed after reserving ${directory}: ${errorMessage(error)}`, { cause: error });
  }

  return { directory, manifestPath };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
