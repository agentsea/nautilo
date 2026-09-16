import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  CANONICAL_RUNTIME_IMAGE_REPOSITORY,
  LEGACY_RUNTIME_IMAGE_REPOSITORY,
  parseBootstrapArtifactRecordJson,
  parseRuntimeArtifactRecordJson,
  RELEASE_TOPOLOGY_SCHEMA_VERSION,
  type RuntimeArtifactRecordApproval,
  type SignedReleaseManifest,
  verifyReleaseManifest,
} from "@nautilo/hosting";
import type { RailwayPlanReleaseInput } from "@nautilo/railway-hosting";

import { CLI_RELEASE_TRUSTED_PUBLIC_KEYS } from "./cli-release-trust";
import { resolveServerProductionRelease, SERVER_RELEASE_TIMEOUT_MS } from "./server-release-source.ts";

const MAX_RELEASE_ARTIFACT_BYTES = 1024 * 1024;

export const RAILWAY_PRODUCTION_RELEASE_BASE_URL =
  "https://media.nautilo.ai/server/releases" as const;

export function immutableHostingManifestUrl(runtimeArtifact: {
  readonly image: string;
  readonly sourceSha: string;
  readonly manifestDigest: string;
}): string {
  const repository = runtimeArtifact.image.split("@", 1)[0];
  const namespace = repository === CANONICAL_RUNTIME_IMAGE_REPOSITORY
    ? "/runtime-v2"
    : repository === LEGACY_RUNTIME_IMAGE_REPOSITORY
      ? ""
      : null;
  if (namespace === null) throw new Error("unsupported-runtime-repository");
  return `${RAILWAY_PRODUCTION_RELEASE_BASE_URL}${namespace}/${runtimeArtifact.sourceSha}/${
    runtimeArtifact.manifestDigest.replace(":", "-")
  }/hosting-manifest.json`;
}

export const RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_MANIFEST_PATH" as const;
export const RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_TRUST_ROOT_PATH" as const;
export const RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH" as const;
export const RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA" as const;
export const RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST" as const;
export const RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH" as const;
export const RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA" as const;
export const RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV =
  "NAUTILO_RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST" as const;

const QUALIFICATION_ENVIRONMENT_KEYS = [
  RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV,
  RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV,
  RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV,
  RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV,
  RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV,
  RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV,
  RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV,
  RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV,
] as const;

interface QualificationTrustRoot {
  readonly schemaVersion: 1;
  readonly trustedPublicKeys: Readonly<Record<string, string>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseTrustRoot(value: unknown): QualificationTrustRoot | null {
  if (!isPlainObject(value) || Object.keys(value).some((key) =>
    key !== "schemaVersion" && key !== "trustedPublicKeys")) return null;
  if (value["schemaVersion"] !== 1 || !isPlainObject(value["trustedPublicKeys"])) return null;
  const entries = Object.entries(value["trustedPublicKeys"]);
  if (entries.length !== 1 || entries.some(([key, publicKey]) =>
    !/^[a-z][a-z0-9-]{0,62}$/.test(key) ||
    typeof publicKey !== "string" ||
    publicKey.length === 0 ||
    publicKey.length > 1024)) return null;
  return {
    schemaVersion: 1,
    trustedPublicKeys: Object.fromEntries(entries) as Readonly<Record<string, string>>,
  };
}

async function readOwnerOnlyJson(path: string): Promise<unknown> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile() ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    (process.platform !== "win32" && (status.mode & 0o077) !== 0) ||
    status.size > MAX_RELEASE_ARTIFACT_BYTES) throw new Error("unsafe-release-artifact");
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid()) ||
      (process.platform !== "win32" && (opened.mode & 0o077) !== 0) ||
      opened.size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error("unsafe-release-artifact");
    }
    const body = await handle.readFile();
    if (body.byteLength > MAX_RELEASE_ARTIFACT_BYTES) throw new Error("unsafe-release-artifact");
    return JSON.parse(body.toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error("unsafe-release-artifact");
    }
  }
  if (response.body === null) throw new Error("unsafe-release-artifact");
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RELEASE_ARTIFACT_BYTES) throw new Error("unsafe-release-artifact");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export interface RailwayProductionReleaseOptions {
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly trustedPublicKeys?: Readonly<Record<string, string>>;
}

/** Resolve Railway topology from the immutable hosting manifest named by the signed server channel. */
export async function resolveRailwayProductionRelease(
  options: RailwayProductionReleaseOptions = {},
): Promise<RailwayPlanReleaseInput> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const trustedPublicKeys = options.trustedPublicKeys ?? CLI_RELEASE_TRUSTED_PUBLIC_KEYS;
  const serverRelease = await resolveServerProductionRelease({ fetchImpl, trustedPublicKeys });
  if (serverRelease.state !== "verified") return serverRelease;

  const { runtimeArtifact } = serverRelease;
  const manifestUrl = immutableHostingManifestUrl(runtimeArtifact);
  let response: Response;
  try {
    response = await fetchImpl(manifestUrl, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SERVER_RELEASE_TIMEOUT_MS),
    });
  } catch {
    return { state: "invalid" };
  }
  if (!response.ok || response.url !== manifestUrl) return { state: "invalid" };
  try {
    const signedManifest = await readBoundedJson(response);
    const result = verifyReleaseManifest(signedManifest, {
      runtimeVersion: 1,
      protocolVersion: 1,
      topologySchemaVersion: RELEASE_TOPOLOGY_SCHEMA_VERSION,
    }, { trustedPublicKeys });
    if (!result.ok) return { state: "invalid" };
    const server = result.manifest.images.find((image) => image.name === "nautilo-server");
    return server?.reference === runtimeArtifact.image
      ? { state: "verified", channel: "production", manifest: result.manifest, signedManifest: signedManifest as SignedReleaseManifest }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

export async function resolveRailwayRelease(
  environment: NodeJS.ProcessEnv,
  productionOptions: RailwayProductionReleaseOptions = {},
  retainedManifest?: unknown,
): Promise<RailwayPlanReleaseInput> {
  const hasQualificationInput = QUALIFICATION_ENVIRONMENT_KEYS.some((key) =>
    (environment[key]?.trim().length ?? 0) > 0
  );
  if (hasQualificationInput) return resolveRailwayQualificationRelease(environment);
  if (retainedManifest !== undefined) {
    const result = verifyReleaseManifest(retainedManifest, {
      runtimeVersion: 1, protocolVersion: 1, topologySchemaVersion: RELEASE_TOPOLOGY_SCHEMA_VERSION,
    }, { trustedPublicKeys: productionOptions.trustedPublicKeys ?? CLI_RELEASE_TRUSTED_PUBLIC_KEYS });
    return result.ok
      ? { state: "verified", channel: "production", manifest: result.manifest, signedManifest: retainedManifest as SignedReleaseManifest }
      : { state: "invalid" };
  }
  return resolveRailwayProductionRelease(productionOptions);
}

/**
 * Resolve the operator-only manifest used by a disposable Railway proof. It
 * does not discover arbitrary files, fetch mutable channels, or treat a
 * co-delivered public key as production trust. The signed manifest, pinned
 * trust root, and bounded D490 runtime record are all required and are
 * accepted only as qualification authority for this workstation.
 */
export async function resolveRailwayQualificationRelease(
  environment: NodeJS.ProcessEnv,
): Promise<RailwayPlanReleaseInput> {
  const manifestPath = environment[RAILWAY_QUALIFICATION_MANIFEST_PATH_ENV]?.trim();
  const trustRootPath = environment[RAILWAY_QUALIFICATION_TRUST_ROOT_PATH_ENV]?.trim();
  const runtimeArtifactRecordPath = environment[RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_RECORD_PATH_ENV]?.trim();
  const expectedSourceSha = environment[RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]?.trim();
  const expectedManifestDigest = environment[RAILWAY_QUALIFICATION_RUNTIME_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]?.trim();
  const bootstrapArtifactRecordPath = environment[RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_RECORD_PATH_ENV]?.trim();
  const expectedBootstrapSourceSha = environment[RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_SOURCE_SHA_ENV]?.trim();
  const expectedBootstrapManifestDigest = environment[RAILWAY_QUALIFICATION_BOOTSTRAP_ARTIFACT_EXPECTED_MANIFEST_DIGEST_ENV]?.trim();
  if (!manifestPath && !trustRootPath && !runtimeArtifactRecordPath && !expectedSourceSha && !expectedManifestDigest &&
    !bootstrapArtifactRecordPath && !expectedBootstrapSourceSha && !expectedBootstrapManifestDigest) {
    return { state: "not-published" };
  }
  const artifactPaths = [manifestPath, trustRootPath, runtimeArtifactRecordPath, bootstrapArtifactRecordPath];
  if (artifactPaths.some((path) => !path) || new Set(artifactPaths).size !== artifactPaths.length) {
    return { state: "invalid" };
  }
  const runtimeArtifactApproval: RuntimeArtifactRecordApproval = {
    sourceSha: expectedSourceSha ?? "",
    manifestDigest: (expectedManifestDigest ?? "") as `sha256:${string}`,
  };
  const bootstrapArtifactApproval = {
    sourceSha: expectedBootstrapSourceSha ?? "",
    manifestDigest: (expectedBootstrapManifestDigest ?? "") as `sha256:${string}`,
  };

  try {
    const [signedManifest, rawTrustRoot, rawRuntimeArtifactRecord, rawBootstrapArtifactRecord] = await Promise.all([
      readOwnerOnlyJson(manifestPath!),
      readOwnerOnlyJson(trustRootPath!),
      readOwnerOnlyJson(runtimeArtifactRecordPath!),
      readOwnerOnlyJson(bootstrapArtifactRecordPath!),
    ]);
    const trustRoot = parseTrustRoot(rawTrustRoot);
    const runtimeArtifactRecord = parseRuntimeArtifactRecordJson(
      JSON.stringify(rawRuntimeArtifactRecord),
      runtimeArtifactApproval,
    );
    const bootstrapArtifactRecord = parseBootstrapArtifactRecordJson(
      JSON.stringify(rawBootstrapArtifactRecord),
      bootstrapArtifactApproval,
    );
    if (trustRoot === null || !runtimeArtifactRecord.ok || !bootstrapArtifactRecord.ok) return { state: "invalid" };
    const result = verifyReleaseManifest(signedManifest, {
      runtimeVersion: 1,
      protocolVersion: 1,
      topologySchemaVersion: RELEASE_TOPOLOGY_SCHEMA_VERSION,
    }, { trustedPublicKeys: trustRoot.trustedPublicKeys });
    if (!result.ok) return { state: "invalid" };
    const server = result.manifest.images.find((image) => image.name === "nautilo-server");
    const bootstrap = result.manifest.images.find((image) => image.name === "nautilo-bootstrap");
    return server?.reference === runtimeArtifactRecord.record.image &&
      bootstrap?.reference === bootstrapArtifactRecord.record.image
      ? { state: "verified", channel: "qualification", manifest: result.manifest }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}
