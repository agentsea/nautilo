// D392 P2 — desktop tool-runtimes.manifest.json schema + validator.
//
// Superset of the server OfficeCLI manifest shape: os-arch artifact keys,
// optional sizeMin/binaryName/member, and explicit mobile-key rejection.

import { VENDORED_SHA256_HEX_RE } from "@nautilo/config/vendored-binary";

/** Desktop tool-runtimes manifest artifact keys (darwin-only today). */
export type ToolRuntimePlatformKey = "darwin-arm64" | "darwin-x64";

export const DESKTOP_DARWIN_PLATFORM_KEYS: readonly ToolRuntimePlatformKey[] = [
  "darwin-arm64",
  "darwin-x64",
] as const;

const PLATFORM_KEY_RE = /^(darwin|linux|win)-(arm64|x64)(?:-musl)?$/;
const MOBILE_PLATFORM_KEY_RE = /^(ios|android)-/;

export interface ToolRuntimeManifestArtifact {
  readonly url: string | null;
  readonly sha256: string | null;
  readonly binarySha256?: string;
  readonly member?: string;
  readonly sizeMin?: number;
  readonly binaryName?: string;
  readonly machOArch?: "arm64" | "x64";
}

export interface ToolRuntimeManifestEntry {
  readonly version: string;
  readonly license: string;
  readonly source: string;
  readonly binaryName?: string;
  readonly protocol?: string;
  readonly provenance?: ApplyPatchRuntimeProvenance;
  readonly artifacts: Partial<Record<ToolRuntimePlatformKey, ToolRuntimeManifestArtifact>>;
}

/** Desktop-owned source-build descriptor for the packaged apply-patch runtime. */
export interface ApplyPatchRuntimeProvenance {
  readonly format: string;
  readonly upstreamRevision: string;
  readonly licenseSha256: string;
  readonly noticeSha256: string;
  readonly rustToolchain: string;
  readonly cargoLockSha256: string;
  readonly nautiloExtractionRevision: string;
}

export interface ApplyPatchDesktopManifestEntry {
  readonly version: string;
  readonly license: string;
  readonly source: string;
  readonly binaryName: "nautilo-apply-patch";
  readonly protocol: string;
  readonly provenance: ApplyPatchRuntimeProvenance;
  readonly artifacts: Readonly<Record<ToolRuntimePlatformKey, ApplyPatchDesktopManifestArtifact>>;
}

export interface ApplyPatchDesktopManifestArtifact {
  readonly machOArch: "arm64" | "x64";
  readonly target: "aarch64-apple-darwin" | "x86_64-apple-darwin";
  readonly sizeMin: number;
  /** Present only in the generated local build receipt, never the tracked descriptor. */
  readonly sha256?: string;
}

// The legacy consumers of this shared parser are all standard URL-pinned tool
// entries. `getApplyPatchDesktopManifestEntry` narrows the one source-build
// descriptor rather than widening those consumers' artifact contract.
export type ToolRuntimesManifest = Readonly<Record<string, ToolRuntimeManifestEntry>>;

export class ToolRuntimesManifestError extends Error {
  readonly code = "MANIFEST_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "ToolRuntimesManifestError";
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolRuntimesManifestError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseArtifact(
  value: unknown,
  label: string,
): ToolRuntimeManifestArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolRuntimesManifestError(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw["url"] !== "string" || typeof raw["sha256"] !== "string") {
    throw new ToolRuntimesManifestError(`${label} ready artifacts must have a url and sha256`);
  }
  const url = requireNonEmptyString(raw["url"], `${label}.url`);
  const sha256 = requireNonEmptyString(raw["sha256"], `${label}.sha256`).toLowerCase();
  if (!VENDORED_SHA256_HEX_RE.test(sha256)) {
    throw new ToolRuntimesManifestError(`${label}.sha256 must be 64 lowercase hex chars`);
  }
  let binarySha256: string | undefined;
  if (raw["binarySha256"] !== undefined) {
    binarySha256 = requireNonEmptyString(
      raw["binarySha256"],
      `${label}.binarySha256`,
    ).toLowerCase();
    if (!VENDORED_SHA256_HEX_RE.test(binarySha256)) {
      throw new ToolRuntimesManifestError(
        `${label}.binarySha256 must be 64 lowercase hex chars`,
      );
    }
  }
  let member: string | undefined;
  if (raw["member"] !== undefined) {
    member = requireNonEmptyString(raw["member"], `${label}.member`);
  }
  let sizeMin: number | undefined;
  if (raw["sizeMin"] !== undefined) {
    if (typeof raw["sizeMin"] !== "number" || !Number.isInteger(raw["sizeMin"]) || raw["sizeMin"] < 0) {
      throw new ToolRuntimesManifestError(`${label}.sizeMin must be a non-negative integer`);
    }
    sizeMin = raw["sizeMin"];
  }
  let binaryName: string | undefined;
  if (raw["binaryName"] !== undefined) {
    binaryName = requireNonEmptyString(raw["binaryName"], `${label}.binaryName`);
  }
  if (raw["machOArch"] !== undefined) {
    throw new ToolRuntimesManifestError(`${label}.machOArch is only valid for apply-patch`);
  }
  return {
    url,
    sha256,
    ...(binarySha256 !== undefined ? { binarySha256 } : {}),
    ...(member !== undefined ? { member } : {}),
    ...(sizeMin !== undefined ? { sizeMin } : {}),
    ...(binaryName !== undefined ? { binaryName } : {}),
  };
}

function parseApplyPatchArtifact(
  value: unknown,
  label: string,
  expectedMachOArch: "arm64" | "x64",
  expectedTarget: "aarch64-apple-darwin" | "x86_64-apple-darwin",
): ApplyPatchDesktopManifestArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolRuntimesManifestError(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  const expectedKeys = raw["sha256"] === undefined
    ? ["machOArch", "sizeMin", "target"]
    : ["machOArch", "sha256", "sizeMin", "target"];
  if (keys.join(",") !== expectedKeys.join(",")) {
    throw new ToolRuntimesManifestError(`${label} must contain only target, machOArch, sizeMin, and an optional generated sha256 receipt`);
  }
  if (raw["machOArch"] !== expectedMachOArch) throw new ToolRuntimesManifestError(`${label}.machOArch must be ${expectedMachOArch}`);
  if (raw["target"] !== expectedTarget) throw new ToolRuntimesManifestError(`${label}.target must be ${expectedTarget}`);
  if (typeof raw["sizeMin"] !== "number" || !Number.isInteger(raw["sizeMin"]) || raw["sizeMin"] < 100_000) {
    throw new ToolRuntimesManifestError(`${label}.sizeMin must be an integer at least 100000`);
  }
  const sha256 = raw["sha256"] === undefined ? undefined : requireSha256(raw["sha256"], `${label}.sha256`);
  return { machOArch: expectedMachOArch, target: expectedTarget, sizeMin: raw["sizeMin"], ...(sha256 !== undefined ? { sha256 } : {}) };
}

function validateArtifactKey(key: string, label: string): void {
  if (MOBILE_PLATFORM_KEY_RE.test(key)) {
    throw new ToolRuntimesManifestError(
      `${label} key ${JSON.stringify(key)} is forbidden — mobile platforms are out of scope for vendored tool runtimes (D392 §4)`,
    );
  }
  if (!PLATFORM_KEY_RE.test(key)) {
    throw new ToolRuntimesManifestError(
      `${label} key ${JSON.stringify(key)} must use os-arch form (e.g. darwin-arm64, linux-x64-musl)`,
    );
  }
  if (key === "arm64" || key === "x64") {
    throw new ToolRuntimesManifestError(
      `${label} key ${JSON.stringify(key)} is bare-arch — use os-arch keys (e.g. darwin-${key})`,
    );
  }
}

function parseEntry(value: unknown, toolName: string): ToolRuntimeManifestEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolRuntimesManifestError(`${toolName} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const version = requireNonEmptyString(raw["version"], `${toolName}.version`);
  const license = requireNonEmptyString(raw["license"], `${toolName}.license`);
  const source = requireNonEmptyString(raw["source"], `${toolName}.source`);
  const binaryName =
    raw["binaryName"] !== undefined
      ? requireNonEmptyString(raw["binaryName"], `${toolName}.binaryName`)
      : undefined;
  const isApplyPatch = toolName === "apply-patch";
  const protocol = raw["protocol"];
  const provenanceRaw = raw["provenance"];
  if (isApplyPatch) {
    if (binaryName !== "nautilo-apply-patch") {
      throw new ToolRuntimesManifestError("apply-patch.binaryName must be nautilo-apply-patch");
    }
    if (typeof protocol !== "string" || protocol.trim().length === 0) {
      throw new ToolRuntimesManifestError("apply-patch.protocol must be a non-empty string");
    }
  } else if (protocol !== undefined || provenanceRaw !== undefined) {
    throw new ToolRuntimesManifestError(`${toolName}.protocol and ${toolName}.provenance are only valid for apply-patch`);
  }
  const artifactsRaw = raw["artifacts"];
  if (artifactsRaw === null || typeof artifactsRaw !== "object" || Array.isArray(artifactsRaw)) {
    throw new ToolRuntimesManifestError(`${toolName}.artifacts must be an object`);
  }
  const artifacts: Partial<Record<ToolRuntimePlatformKey, ToolRuntimeManifestArtifact>> = {};
  const applyPatchArtifacts: Partial<Record<ToolRuntimePlatformKey, ApplyPatchDesktopManifestArtifact>> = {};
  for (const [key, artifactValue] of Object.entries(artifactsRaw as Record<string, unknown>)) {
    validateArtifactKey(key, `${toolName}.artifacts`);
    if (isApplyPatch) {
      applyPatchArtifacts[key as ToolRuntimePlatformKey] = parseApplyPatchArtifact(
        artifactValue,
        `${toolName}.artifacts.${key}`,
        key === "darwin-arm64" ? "arm64" : "x64",
        key === "darwin-arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
      );
    } else {
      artifacts[key as ToolRuntimePlatformKey] = parseArtifact(artifactValue, `${toolName}.artifacts.${key}`);
    }
  }
  if (Object.keys(isApplyPatch ? applyPatchArtifacts : artifacts).length === 0) {
    throw new ToolRuntimesManifestError(`${toolName}.artifacts must contain at least one platform entry`);
  }
  if (isApplyPatch) {
    if (Object.keys(applyPatchArtifacts).sort().join(",") !== DESKTOP_DARWIN_PLATFORM_KEYS.join(",")) {
      throw new ToolRuntimesManifestError("apply-patch.artifacts must contain exactly darwin-arm64 and darwin-x64");
    }
    const provenance = parseApplyPatchProvenance(provenanceRaw);
    return {
      version,
      license,
      source,
      artifacts: applyPatchArtifacts as Readonly<Record<ToolRuntimePlatformKey, ApplyPatchDesktopManifestArtifact>>,
      binaryName: "nautilo-apply-patch",
      protocol: (protocol as string).trim(),
      provenance,
    } as unknown as ToolRuntimeManifestEntry;
  }
  return {
    version,
    license,
    source,
    artifacts,
    ...(binaryName !== undefined ? { binaryName } : {}),
  };
}

function parseApplyPatchProvenance(value: unknown): ApplyPatchRuntimeProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolRuntimesManifestError("apply-patch.provenance must be an object");
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  const expected = ["cargoLockSha256", "format", "licenseSha256", "nautiloExtractionRevision", "noticeSha256", "rustToolchain", "upstreamRevision"].sort().join(",");
  if (keys !== expected) throw new ToolRuntimesManifestError("apply-patch.provenance has unexpected fields");
  return {
    format: requireNonEmptyString(raw["format"], "apply-patch.provenance.format"),
    upstreamRevision: requireNonEmptyString(raw["upstreamRevision"], "apply-patch.provenance.upstreamRevision"),
    licenseSha256: requireSha256(raw["licenseSha256"], "apply-patch.provenance.licenseSha256"),
    noticeSha256: requireSha256(raw["noticeSha256"], "apply-patch.provenance.noticeSha256"),
    rustToolchain: requireNonEmptyString(raw["rustToolchain"], "apply-patch.provenance.rustToolchain"),
    cargoLockSha256: requireSha256(raw["cargoLockSha256"], "apply-patch.provenance.cargoLockSha256"),
    nautiloExtractionRevision: requireSha256(raw["nautiloExtractionRevision"], "apply-patch.provenance.nautiloExtractionRevision"),
  };
}

function requireSha256(value: unknown, label: string): string {
  const result = requireNonEmptyString(value, label);
  if (!VENDORED_SHA256_HEX_RE.test(result)) throw new ToolRuntimesManifestError(`${label} must be 64 lowercase hex chars`);
  return result;
}

export function getApplyPatchDesktopManifestEntry(manifest: ToolRuntimesManifest): ApplyPatchDesktopManifestEntry {
  const entry = manifest["apply-patch"];
  if (!entry || entry.binaryName !== "nautilo-apply-patch" || !entry.protocol || !entry.provenance) {
    throw new ToolRuntimesManifestError("apply-patch manifest entry is missing or invalid");
  }
  return entry as unknown as ApplyPatchDesktopManifestEntry;
}

/** Parse and validate desktop tool-runtimes manifest JSON. */
export function parseToolRuntimesManifest(jsonText: string): ToolRuntimesManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolRuntimesManifestError(`manifest is not valid JSON: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolRuntimesManifestError("manifest root must be an object");
  }
  const result: Record<string, ToolRuntimeManifestEntry> = {};
  for (const [toolName, entryValue] of Object.entries(parsed as Record<string, unknown>)) {
    result[toolName] = parseEntry(entryValue, toolName);
  }
  if (Object.keys(result).length === 0) {
    throw new ToolRuntimesManifestError("manifest must contain at least one tool entry");
  }
  return result;
}
