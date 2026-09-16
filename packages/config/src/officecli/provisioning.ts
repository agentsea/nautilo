// D372 P4 — OfficeCLI binary provisioning + checksum policy (pure helpers).
//
// Parses a pinned manifest, resolves the vendored binary path for the current
// platform, and verifies on-disk integrity via sha256. No network I/O and no
// download logic — operators/vendor scripts place binaries under
// packages/server/vendor/officecli/ and record hashes in manifest.json.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOfficeCliPath } from "./run";
import {
  resetVendoredBinaryVerifyCache,
  verifyVendoredBinaryOnce,
  type VendoredBinaryVerifyOutcome,
} from "../vendored-binary";

// ============================================================================
// Constants
// ============================================================================

/** Lowercase hex sha256 as used in tool-runtimes.manifest.json and here. */
export const OFFICECLI_SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** Default vendored tree relative to monorepo root (see docs/officecli-provisioning.md). */
export const DEFAULT_OFFICECLI_VENDOR_REL = "packages/server/vendor/officecli";

export const OFFICECLI_MANIFEST_FILENAME = "manifest.json";

export const OFFICECLI_VERSION_STAMP_FILENAME = ".version";

/** Env override for the vendor root directory (absolute or repo-relative). */
export const OFFICECLI_VENDOR_ROOT_ENV = "OFFICECLI_VENDOR_ROOT";

// ============================================================================
// Platform keys
// ============================================================================

export type OfficeCliPlatformKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win-x64";

const PLATFORM_KEY_BY_OS: Readonly<Record<string, Partial<Record<string, OfficeCliPlatformKey>>>> = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { x64: "win-x64", arm64: "win-x64" },
};

/**
 * Map Node `process.platform` + `process.arch` to a manifest artifact key.
 * Returns null when the host has no pinned artifact slot (e.g. win32-ia32).
 */
export function detectOfficeCliPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): OfficeCliPlatformKey | null {
  const byArch = PLATFORM_KEY_BY_OS[platform];
  if (byArch === undefined) return null;
  return byArch[arch] ?? null;
}

// ============================================================================
// Manifest types + parser
// ============================================================================

export interface OfficeCliManifestArtifact {
  /** Lowercase hex sha256 of the on-disk binary bytes. Required for verify. */
  readonly sha256: string;
  /** Optional minimum byte size guard (desktop vendor scripts use ~1MB). */
  readonly sizeMin?: number;
  /** Override binary filename for this artifact (default `officecli` / `.exe` on win). */
  readonly binaryName?: string;
  /**
   * Optional upstream download URL — recorded for provenance only. Verify helpers
   * never fetch; a future vendor script may use it out-of-band.
   */
  readonly url?: string;
}

export interface OfficeCliManifestEntry {
  readonly version: string;
  readonly source: string;
  readonly license: string;
  /** Default binary basename when an artifact omits `binaryName`. */
  readonly binaryName?: string;
  readonly artifacts: Partial<Record<OfficeCliPlatformKey, OfficeCliManifestArtifact>>;
}

export interface OfficeCliManifest {
  readonly officecli: OfficeCliManifestEntry;
}

export class OfficeCliManifestError extends Error {
  readonly code: "MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "OfficeCliManifestError";
    this.code = "MANIFEST_INVALID";
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OfficeCliManifestError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseArtifact(value: unknown, label: string): OfficeCliManifestArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OfficeCliManifestError(`${label} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const sha256 = requireNonEmptyString(raw["sha256"], `${label}.sha256`).toLowerCase();
  if (!OFFICECLI_SHA256_HEX_RE.test(sha256)) {
    throw new OfficeCliManifestError(`${label}.sha256 must be 64 lowercase hex chars`);
  }
  let sizeMin: number | undefined;
  if (raw["sizeMin"] !== undefined) {
    if (typeof raw["sizeMin"] !== "number" || !Number.isInteger(raw["sizeMin"]) || raw["sizeMin"] < 0) {
      throw new OfficeCliManifestError(`${label}.sizeMin must be a non-negative integer`);
    }
    sizeMin = raw["sizeMin"];
  }
  const binaryName =
    raw["binaryName"] !== undefined
      ? requireNonEmptyString(raw["binaryName"], `${label}.binaryName`)
      : undefined;
  const url =
    raw["url"] !== undefined ? requireNonEmptyString(raw["url"], `${label}.url`) : undefined;
  return {
    sha256,
    ...(sizeMin !== undefined ? { sizeMin } : {}),
    ...(binaryName !== undefined ? { binaryName } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

/**
 * Parse and validate manifest JSON. Accepts either the wrapped
 * `{ "officecli": { ... } }` shape or a bare entry object (for tests).
 */
export function parseOfficeCliManifest(jsonText: string): OfficeCliManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OfficeCliManifestError(`manifest is not valid JSON: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OfficeCliManifestError("manifest root must be an object");
  }
  const root = parsed as Record<string, unknown>;
  const entryRaw =
    root["officecli"] !== undefined ? root["officecli"] : parsed;
  if (entryRaw === null || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
    throw new OfficeCliManifestError("officecli entry must be an object");
  }
  const entry = entryRaw as Record<string, unknown>;
  const version = requireNonEmptyString(entry["version"], "officecli.version");
  const source = requireNonEmptyString(entry["source"], "officecli.source");
  const license = requireNonEmptyString(entry["license"], "officecli.license");
  const binaryName =
    entry["binaryName"] !== undefined
      ? requireNonEmptyString(entry["binaryName"], "officecli.binaryName")
      : undefined;
  const artifactsRaw = entry["artifacts"];
  if (artifactsRaw === null || typeof artifactsRaw !== "object" || Array.isArray(artifactsRaw)) {
    throw new OfficeCliManifestError("officecli.artifacts must be an object");
  }
  const artifacts: Partial<Record<OfficeCliPlatformKey, OfficeCliManifestArtifact>> = {};
  for (const [key, value] of Object.entries(artifactsRaw as Record<string, unknown>)) {
    artifacts[key as OfficeCliPlatformKey] = parseArtifact(value, `officecli.artifacts.${key}`);
  }
  if (Object.keys(artifacts).length === 0) {
    throw new OfficeCliManifestError("officecli.artifacts must contain at least one platform entry");
  }
  const officecli: OfficeCliManifestEntry = { version, source, license, artifacts };
  if (binaryName !== undefined) {
    return { officecli: { ...officecli, binaryName } };
  }
  return { officecli };
}

export function loadOfficeCliManifest(manifestPath: string): OfficeCliManifest {
  const text = readFileSync(manifestPath, "utf8");
  return parseOfficeCliManifest(text);
}

// ============================================================================
// Path resolution
// ============================================================================

export interface ResolveOfficeCliVendorRootInput {
  /** Monorepo root; used when vendorRoot is relative. Defaults to process.cwd(). */
  readonly repoRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function hasOfficeCliManifest(vendorRoot: string): boolean {
  try {
    return statSync(join(vendorRoot, OFFICECLI_MANIFEST_FILENAME)).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the vendored OfficeCLI tree from this shared config module without any
 * cwd or env assumptions. Walks upward from `import.meta.url` until the
 * monorepo-relative `packages/server/vendor/officecli/manifest.json` exists.
 */
export function findOfficeCliVendorRoot(startUrl: string = import.meta.url): string | null {
  let dir = dirname(fileURLToPath(startUrl));
  while (true) {
    const candidate = pathResolve(dir, DEFAULT_OFFICECLI_VENDOR_REL);
    if (hasOfficeCliManifest(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the officecli vendor directory.
 *
 * Precedence:
 *   1. `env.OFFICECLI_VENDOR_ROOT` (absolute or relative to repoRoot/cwd)
 *   2. `<repoRoot>/packages/server/vendor/officecli`, when repoRoot is provided
 *   3. upward discovery from this module to the bundled server vendor tree
 *   4. `<process.cwd()>/packages/server/vendor/officecli` fallback
 */
export function resolveOfficeCliVendorRoot(
  input: ResolveOfficeCliVendorRootInput = {},
): string {
  const env = input.env ?? process.env;
  const repoRoot = input.repoRoot ?? process.cwd();
  const override = env[OFFICECLI_VENDOR_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    const trimmed = override.trim();
    return pathResolve(repoRoot, trimmed);
  }
  if (input.repoRoot !== undefined) {
    return pathResolve(input.repoRoot, DEFAULT_OFFICECLI_VENDOR_REL);
  }
  return findOfficeCliVendorRoot() ?? pathResolve(repoRoot, DEFAULT_OFFICECLI_VENDOR_REL);
}

export interface ResolveVendoredOfficeCliPathInput {
  readonly vendorRoot: string;
  readonly platformKey: OfficeCliPlatformKey;
  readonly manifest: OfficeCliManifest;
}

/**
 * Resolve the expected on-disk path for a vendored binary:
 *   `<vendorRoot>/<platformKey>/<binaryName>`
 */
export function resolveVendoredOfficeCliPath(input: ResolveVendoredOfficeCliPathInput): string {
  const artifact = input.manifest.officecli.artifacts[input.platformKey];
  if (artifact === undefined) {
    throw new OfficeCliProvisioningError(
      `manifest has no artifact for platform ${input.platformKey}`,
      "PLATFORM_UNSUPPORTED",
    );
  }
  const binaryName = resolveBinaryName(
    input.platformKey,
    artifact.binaryName ?? input.manifest.officecli.binaryName,
  );
  return join(input.vendorRoot, input.platformKey, binaryName);
}

function resolveBinaryName(
  platformKey: OfficeCliPlatformKey,
  configured?: string,
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  return platformKey.startsWith("win-") ? "officecli.exe" : "officecli";
}

// ============================================================================
// Checksum verification
// ============================================================================

export function normalizeSha256Hex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  return OFFICECLI_SHA256_HEX_RE.test(trimmed) ? trimmed : null;
}

/** Compute sha256 hex digest of an in-memory buffer (sync). */
export function sha256HexOfBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stream a file and return its sha256 hex digest (async). */
export async function sha256HexOfFile(filePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export interface VerifyBinaryChecksumInput {
  readonly binaryPath: string;
  readonly expectedSha256: string;
  readonly sizeMin?: number;
}

export interface VerifyBinaryChecksumResult {
  readonly ok: boolean;
  readonly actualSha256: string;
  readonly size: number;
  readonly expectedSha256: string;
}

export class OfficeCliProvisioningError extends Error {
  readonly code:
    | "PLATFORM_UNSUPPORTED"
    | "BINARY_MISSING"
    | "BINARY_NOT_EXECUTABLE"
    | "SIZE_TOO_SMALL"
    | "CHECKSUM_MISMATCH";

  constructor(
    message: string,
    code:
      | "PLATFORM_UNSUPPORTED"
      | "BINARY_MISSING"
      | "BINARY_NOT_EXECUTABLE"
      | "SIZE_TOO_SMALL"
      | "CHECKSUM_MISMATCH",
  ) {
    super(message);
    this.name = "OfficeCliProvisioningError";
    this.code = code;
  }
}

function assertFileExists(binaryPath: string): number {
  try {
    const st = statSync(binaryPath);
    if (!st.isFile()) {
      throw new OfficeCliProvisioningError(
        `expected a file at ${binaryPath}`,
        "BINARY_MISSING",
      );
    }
    return st.size;
  } catch (err) {
    if (err instanceof OfficeCliProvisioningError) throw err;
    throw new OfficeCliProvisioningError(
      `binary not found at ${binaryPath}`,
      "BINARY_MISSING",
    );
  }
}

function assertExecutable(binaryPath: string, platformKey: OfficeCliPlatformKey): void {
  if (platformKey.startsWith("win-")) return;
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    throw new OfficeCliProvisioningError(
      `binary is not executable: ${binaryPath}`,
      "BINARY_NOT_EXECUTABLE",
    );
  }
}

/**
 * Verify on-disk binary integrity against the manifest artifact.
 * Throws `OfficeCliProvisioningError` on any failure.
 */
export async function verifyOfficeCliBinary(
  input: VerifyBinaryChecksumInput & { readonly platformKey?: OfficeCliPlatformKey },
): Promise<VerifyBinaryChecksumResult> {
  const expected = normalizeSha256Hex(input.expectedSha256);
  if (expected === null) {
    throw new OfficeCliManifestError("expectedSha256 must be 64 lowercase hex chars");
  }
  const size = assertFileExists(input.binaryPath);
  if (input.sizeMin !== undefined && size < input.sizeMin) {
    throw new OfficeCliProvisioningError(
      `binary size ${size} is below minimum ${input.sizeMin} (${input.binaryPath})`,
      "SIZE_TOO_SMALL",
    );
  }
  if (input.platformKey !== undefined) {
    assertExecutable(input.binaryPath, input.platformKey);
  }
  const actualSha256 = await sha256HexOfFile(input.binaryPath);
  if (actualSha256 !== expected) {
    throw new OfficeCliProvisioningError(
      `sha256 mismatch for ${input.binaryPath}\n  expected ${expected}\n  got      ${actualSha256}`,
      "CHECKSUM_MISMATCH",
    );
  }
  return { ok: true, actualSha256, size, expectedSha256: expected };
}

// ============================================================================
// Composite provisioning check
// ============================================================================

export interface CheckOfficeCliProvisioningInput {
  readonly repoRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly vendorRoot?: string;
  readonly platformKey?: OfficeCliPlatformKey | null;
  readonly manifestPath?: string;
}

export interface CheckOfficeCliProvisioningResult {
  readonly platformKey: OfficeCliPlatformKey;
  readonly vendorRoot: string;
  readonly manifestPath: string;
  readonly binaryPath: string;
  readonly version: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * End-to-end local provisioning check: resolve vendor root → load manifest →
 * resolve binary path for the host platform → verify sha256 (+ optional sizeMin).
 */
export async function checkOfficeCliProvisioning(
  input: CheckOfficeCliProvisioningInput = {},
): Promise<CheckOfficeCliProvisioningResult> {
  const vendorRoot =
    input.vendorRoot ??
    resolveOfficeCliVendorRoot({
      ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
  const manifestPath =
    input.manifestPath ?? join(vendorRoot, OFFICECLI_MANIFEST_FILENAME);
  const platformKey =
    input.platformKey === undefined
      ? detectOfficeCliPlatformKey()
      : input.platformKey;
  if (platformKey === null) {
    throw new OfficeCliProvisioningError(
      `unsupported host platform ${process.platform}-${process.arch}`,
      "PLATFORM_UNSUPPORTED",
    );
  }
  const manifest = loadOfficeCliManifest(manifestPath);
  const artifact = manifest.officecli.artifacts[platformKey];
  if (artifact === undefined) {
    throw new OfficeCliProvisioningError(
      `manifest has no artifact for platform ${platformKey}`,
      "PLATFORM_UNSUPPORTED",
    );
  }
  const binaryPath = resolveVendoredOfficeCliPath({ vendorRoot, platformKey, manifest });
  const verified = await verifyOfficeCliBinary({
    binaryPath,
    expectedSha256: artifact.sha256,
    ...(artifact.sizeMin !== undefined ? { sizeMin: artifact.sizeMin } : {}),
    platformKey,
  });
  return {
    platformKey,
    vendorRoot,
    manifestPath,
    binaryPath,
    version: manifest.officecli.version,
    sha256: verified.actualSha256,
    size: verified.size,
  };
}

/**
 * Suggested `OFFICECLI_PATH` for dev-stack / server startup after a successful
 * provisioning check. Absolute path to the verified vendored binary.
 */
export function officeCliPathEnvValue(binaryPath: string): string {
  return binaryPath;
}

// ============================================================================
// Non-throwing availability probe (D391 — platform-gate OfficeCLI DOCX tools)
// ============================================================================

/**
 * True if `p` exists, is a regular file, and the current process can execute
 * it. On Windows the X_OK check is effectively an existence check (NTFS has no
 * POSIX exec bit), which is the right behavior for `officecli.exe`. Never
 * throws — any fs error (missing, permission, broken symlink) → false.
 */
function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOfficeCliOrNullInput {
  /** Monorepo root; used to resolve the default vendored tree. Defaults to process.cwd(). */
  readonly repoRoot?: string;
  /** Env map to read OFFICECLI_PATH / OFFICECLI_VENDOR_ROOT from. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override vendor root directory. Defaults to `resolveOfficeCliVendorRoot(...)`. */
  readonly vendorRoot?: string;
  /** Override manifest path. Defaults to `<vendorRoot>/manifest.json`. */
  readonly manifestPath?: string;
  /** Override platform key. Defaults to `detectOfficeCliPlatformKey()`. Pass null to force "unsupported". */
  readonly platformKey?: OfficeCliPlatformKey | null;
}

/**
 * Resolve a usable OfficeCLI binary path WITHOUT throwing — the runtime
 * equivalent of `resolveOfficeImportBinaryPath` in `app-tool-host.ts`, but
 * non-throwing and checksum-free (this is an availability probe, not an
 * integrity verification).
 *
 * Resolution order (first usable hit wins):
 *   1. `OFFICECLI_PATH` env override (or `input.override` if passed to
 *      `resolveOfficeCliPath`) — must exist AND be executable.
 *   2. `officecli` found on `env.PATH` — `resolveOfficeCliPath` already
 *      checks the executable bit, so this is included for parity with the
 *      runtime resolution path.
 *   3. The vendored binary for the host platform key under the resolved
 *      vendor root — must exist AND be executable. Manifest parse failures,
 *      unsupported platforms, and missing artifacts all collapse to `null`
 *      rather than throwing.
 *
 * Returns the absolute binary path on success, or `null` when no usable
 * binary is available on this host. Never throws.
 */
export function resolveOfficeCliOrNull(
  input: ResolveOfficeCliOrNullInput = {},
): string | null {
  // 1 + 2. OFFICECLI_PATH override + PATH lookup (matches runtime resolution
  // in `app-tool-host.ts` / `routes/workspace-artifacts.ts`).
  const configured = resolveOfficeCliPath({
    ...(input.env !== undefined ? { env: input.env } : {}),
  });
  if (configured !== null && isExecutableFile(configured)) {
    return configured;
  }

  // 3. Vendored binary for the host platform.
  const platformKey =
    input.platformKey === undefined ? detectOfficeCliPlatformKey() : input.platformKey;
  if (platformKey === null) return null;

  const vendorRoot =
    input.vendorRoot ??
    resolveOfficeCliVendorRoot({
      ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
  const manifestPath = input.manifestPath ?? join(vendorRoot, OFFICECLI_MANIFEST_FILENAME);

  let manifest: OfficeCliManifest;
  try {
    manifest = loadOfficeCliManifest(manifestPath);
  } catch {
    return null;
  }
  const artifact = manifest.officecli.artifacts[platformKey];
  if (artifact === undefined) return null;

  let binaryPath: string;
  try {
    binaryPath = resolveVendoredOfficeCliPath({ vendorRoot, platformKey, manifest });
  } catch {
    return null;
  }
  if (!isExecutableFile(binaryPath)) return null;
  return binaryPath;
}

/**
 * Zero-config resolver for agent/server callers that should use the bundled
 * OfficeCLI binary by default. `OFFICECLI_PATH` remains a dev override; PATH is
 * intentionally ignored so the vendored binary is the default when present.
 * Never throws.
 */
export function resolveVendoredOfficeCliOrNull(): string | null {
  return resolveOfficeCliOrNull({
    env: { ...process.env, PATH: "" },
  });
}

/**
 * Convenience boolean wrapper around `resolveOfficeCliOrNull`. True when a
 * usable OfficeCLI binary is available on this host (override, PATH, or
 * vendored). Never throws — safe to call from registration / startup paths
 * that must not crash on unsupported platforms.
 */
export function officeCliAvailable(input: ResolveOfficeCliOrNullInput = {}): boolean {
  return resolveOfficeCliOrNull(input) !== null;
}

// ============================================================================
// Verify-once integrity gate (D391 2.4 — thin OfficeCLI adapter over the
// shared D392 primitive `@nautilo/config/vendored-binary`)
// ============================================================================
//
// `officeCliAvailable` is a fast existence+exec probe (registration path). This
// is the runtime integrity layer for the actual import/export invocation: hash
// the vendored binary against the manifest sha ONCE per process (cached),
// instead of re-hashing ~34MB on every call. The fetch-time check in
// `dev/scripts/vendor-officecli.ts` remains the load-bearing supply-chain gate;
// this is defense-in-depth against on-disk corruption / a botched deploy.
//
// The hash/cache/tolerate logic is NOT OfficeCLI-specific and lives in the
// shared `verifyVendoredBinaryOnce` helper (reusable by the desktop
// tool-runtimes as D392 completes). This module only supplies the OfficeCLI
// resolution + manifest lookup, and maps `platformKey` → the platform policy.

/** Re-exported from the shared helper; unchanged shape for existing callers. */
export type OfficeCliVerifyOutcome = VendoredBinaryVerifyOutcome;

/** Per-process cache keyed by absolute binary path → usable? (owned by OfficeCLI). */
const officeCliVerificationCache = new Map<string, boolean>();

/** Test-only: clear the per-process verify-once cache. */
export function resetOfficeCliVerificationCache(): void {
  resetVendoredBinaryVerifyCache(officeCliVerificationCache);
}

/**
 * Resolve the pinned manifest expectation for `binaryPath`, but ONLY when
 * `binaryPath` is the vendored binary for `platformKey`. Returns null for
 * operator overrides / PATH binaries (no pinned sha to compare against) and for
 * any manifest resolution failure — in all those cases the caller trusts the
 * binary (standard practice: we can only verify what we pinned).
 */
function resolveVendoredExpectation(
  binaryPath: string,
  platformKey: OfficeCliPlatformKey | null,
  input: ResolveOfficeCliOrNullInput,
): { readonly sha256: string; readonly platformKey: OfficeCliPlatformKey } | null {
  if (platformKey === null) return null;
  const vendorRoot =
    input.vendorRoot ??
    resolveOfficeCliVendorRoot({
      ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
  const manifestPath = input.manifestPath ?? join(vendorRoot, OFFICECLI_MANIFEST_FILENAME);
  let manifest: OfficeCliManifest;
  try {
    manifest = loadOfficeCliManifest(manifestPath);
  } catch {
    return null;
  }
  const artifact = manifest.officecli.artifacts[platformKey];
  if (artifact === undefined) return null;
  let vendoredPath: string;
  try {
    vendoredPath = resolveVendoredOfficeCliPath({ vendorRoot, platformKey, manifest });
  } catch {
    return null;
  }
  if (vendoredPath !== binaryPath) return null;
  const sha = normalizeSha256Hex(artifact.sha256);
  if (sha === null) return null;
  return { sha256: sha, platformKey };
}

/**
 * Verify-once runtime integrity gate for OfficeCLI. Resolves a usable binary
 * (override / PATH / vendored) and delegates the hash/cache/tolerate decision
 * to the shared `verifyVendoredBinaryOnce` primitive. Never throws.
 *
 * Platform policy: darwin uses `"tolerate-signed"` (macOS ad-hoc code-signs an
 * unsigned binary on first execution, mutating bytes so the on-disk sha drifts
 * from the manifest after run #1 — the fetch-time verify of the pristine bytes
 * is authoritative). linux/win use `"strict"` — a mismatch is refused.
 */
export async function verifyOfficeCliOnce(
  input: ResolveOfficeCliOrNullInput = {},
): Promise<OfficeCliVerifyOutcome> {
  const binaryPath = resolveOfficeCliOrNull(input);
  const platformKey =
    input.platformKey === undefined ? detectOfficeCliPlatformKey() : input.platformKey;
  const expected =
    binaryPath === null ? null : resolveVendoredExpectation(binaryPath, platformKey, input);

  return verifyVendoredBinaryOnce({
    binaryPath,
    expectedSha256: expected?.sha256 ?? null,
    policy: expected?.platformKey.startsWith("darwin-") ? "tolerate-signed" : "strict",
    label: "OfficeCLI",
    cache: officeCliVerificationCache,
  });
}
