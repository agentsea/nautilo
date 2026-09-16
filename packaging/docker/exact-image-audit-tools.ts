/**
 * D490 Task 0.3.1 — checksum-pinned scanner installation for exact-image
 * auditing. This module deliberately installs tools only; Task 0.3.2 owns
 * report orchestration and digest-bound output contracts.
 */
import { isAbsolute, join } from "node:path";
import {
  fetchAndVerifyVendoredBinary,
  type FetchVendoredBinaryInput,
  type FetchVendoredBinaryResult,
} from "../../packages/config/src/vendored-binary-fetch.ts";

const AUDIT_TOOL_NAMES = ["syft", "grype", "trivy"] as const;
const AUDIT_TOOL_PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-amd64", "linux-arm64"] as const;

export type ExactImageAuditToolName = typeof AUDIT_TOOL_NAMES[number];
export type ExactImageAuditToolPlatformKey = typeof AUDIT_TOOL_PLATFORM_KEYS[number];

export interface ExactImageAuditToolArtifact {
  readonly url: string;
  readonly sha256: string;
}

export interface ExactImageAuditToolDefinition {
  readonly version: string;
  readonly archiveMember: string;
  readonly artifacts: Readonly<Record<ExactImageAuditToolPlatformKey, ExactImageAuditToolArtifact>>;
}

export interface ExactImageAuditToolManifestV1 {
  readonly version: 1;
  readonly tools: Readonly<Record<ExactImageAuditToolName, ExactImageAuditToolDefinition>>;
}

interface RequiredArtifactPin {
  readonly filename: string;
  readonly sha256: string;
}

interface RequiredToolPin {
  readonly repository: string;
  readonly version: string;
  readonly archiveMember: string;
  readonly artifacts: Readonly<Record<ExactImageAuditToolPlatformKey, RequiredArtifactPin>>;
}

const REQUIRED_TOOL_PINS: Readonly<Record<ExactImageAuditToolName, RequiredToolPin>> = {
  syft: {
    repository: "anchore/syft",
    version: "1.50.0",
    archiveMember: "syft",
    artifacts: {
      "darwin-arm64": { filename: "syft_1.50.0_darwin_arm64.tar.gz", sha256: "e32fdb9d47823fa633748a1efca2528fd77c37469ea93c9e40ab835da44e4cce" },
      "darwin-x64": { filename: "syft_1.50.0_darwin_amd64.tar.gz", sha256: "d11a8c7bc27114853bd7c1e1b2f3be3ddda3a1de17aee585329f04c369341c75" },
      "linux-amd64": { filename: "syft_1.50.0_linux_amd64.tar.gz", sha256: "bf7b29ff57f06da30918266a0e1c2885a8f99784798d1bdb1628886aa015d788" },
      "linux-arm64": { filename: "syft_1.50.0_linux_arm64.tar.gz", sha256: "887c57cbcc2d0e8c5c110a4571a3fc7150058b24d74f993ee4663516e5c8ce86" },
    },
  },
  grype: {
    repository: "anchore/grype",
    version: "0.116.1",
    archiveMember: "grype",
    artifacts: {
      "darwin-arm64": { filename: "grype_0.116.1_darwin_arm64.tar.gz", sha256: "f493f169cbaae48bade169532b20235fc16653d2a044a5bc6fe6f69a3923f975" },
      "darwin-x64": { filename: "grype_0.116.1_darwin_amd64.tar.gz", sha256: "e5ff3adac317511876de7863598587a7dbab0c47c8e150368b7df06909c11f4e" },
      "linux-amd64": { filename: "grype_0.116.1_linux_amd64.tar.gz", sha256: "0122df7b655981abe547ad3d2190d65551dac6a2bfc80b4dc2a989b5d0587458" },
      "linux-arm64": { filename: "grype_0.116.1_linux_arm64.tar.gz", sha256: "a8d7504a149629324eb5f4ce3dc25dfd211bbfe047e64ee2bf7844b466c3d84d" },
    },
  },
  trivy: {
    repository: "aquasecurity/trivy",
    version: "0.73.0",
    archiveMember: "trivy",
    artifacts: {
      "darwin-arm64": { filename: "trivy_0.73.0_macOS-ARM64.tar.gz", sha256: "80cc25faaf6378e37701202d0b4f9f43d9e413d198d594ba60fdf559fe44a683" },
      "darwin-x64": { filename: "trivy_0.73.0_macOS-64bit.tar.gz", sha256: "d39d1374dd3e35d48621b82df9b6625fe69f9920cc67d2739ed81bb679f16f51" },
      "linux-amd64": { filename: "trivy_0.73.0_Linux-64bit.tar.gz", sha256: "2edd39da482bb4e9831962487b68f68e3928ec3137794757f54d00383d79547b" },
      "linux-arm64": { filename: "trivy_0.73.0_Linux-ARM64.tar.gz", sha256: "13833d97e8a1a5367471c372a173180157f593bece570e20d5d925fef552f5dd" },
    },
  },
};

export class ExactImageAuditToolsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactImageAuditToolsError";
  }
}

function fail(message: string): never {
  throw new ExactImageAuditToolsError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-blank string`);
  return value;
}

function assertSha256(value: unknown, label: string): string {
  const sha256 = nonBlankString(value, label);
  if (!/^[a-f0-9]{64}$/.test(sha256) || sha256 === "0".repeat(64)) {
    fail(`${label} must be a non-zero lowercase SHA-256 hex digest`);
  }
  return sha256;
}

function expectedReleaseUrl(pin: RequiredToolPin, artifact: RequiredArtifactPin): string {
  return `https://github.com/${pin.repository}/releases/download/v${pin.version}/${artifact.filename}`;
}

/** Rejects manifest drift, mutable release locations, and incomplete platform coverage. */
export function assertExactImageAuditToolManifest(value: unknown): asserts value is ExactImageAuditToolManifestV1 {
  if (!isRecord(value)) fail("manifest must be an object");
  assertExactKeys(value, "manifest", ["version", "tools"]);
  if (value["version"] !== 1) fail("manifest.version must be 1");
  if (!isRecord(value["tools"])) fail("manifest.tools must be an object");
  assertExactKeys(value["tools"], "manifest.tools", AUDIT_TOOL_NAMES);

  for (const toolName of AUDIT_TOOL_NAMES) {
    const definition = value["tools"][toolName];
    const required = REQUIRED_TOOL_PINS[toolName];
    if (!isRecord(definition)) fail(`manifest.tools.${toolName} must be an object`);
    assertExactKeys(definition, `manifest.tools.${toolName}`, ["version", "archiveMember", "artifacts"]);
    if (nonBlankString(definition["version"], `manifest.tools.${toolName}.version`) !== required.version) {
      fail(`manifest.tools.${toolName}.version must be ${required.version}`);
    }
    if (nonBlankString(definition["archiveMember"], `manifest.tools.${toolName}.archiveMember`) !== required.archiveMember) {
      fail(`manifest.tools.${toolName}.archiveMember must be ${required.archiveMember}`);
    }
    if (!isRecord(definition["artifacts"])) fail(`manifest.tools.${toolName}.artifacts must be an object`);
    assertExactKeys(definition["artifacts"], `manifest.tools.${toolName}.artifacts`, AUDIT_TOOL_PLATFORM_KEYS);

    for (const platformKey of AUDIT_TOOL_PLATFORM_KEYS) {
      const artifact = definition["artifacts"][platformKey];
      const expected = required.artifacts[platformKey];
      const label = `manifest.tools.${toolName}.artifacts.${platformKey}`;
      if (!isRecord(artifact)) fail(`${label} must be an object`);
      assertExactKeys(artifact, label, ["url", "sha256"]);
      if (nonBlankString(artifact["url"], `${label}.url`) !== expectedReleaseUrl(required, expected)) {
        fail(`${label}.url must be the exact immutable GitHub release asset URL`);
      }
      if (assertSha256(artifact["sha256"], `${label}.sha256`) !== expected.sha256) {
        fail(`${label}.sha256 does not match the required archive checksum`);
      }
    }
  }
}

export function parseExactImageAuditToolManifest(text: string): ExactImageAuditToolManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("manifest is not valid JSON");
  }
  assertExactImageAuditToolManifest(value);
  return value;
}

export interface AuditToolHost {
  readonly platform: string;
  readonly arch: string;
}

/** Maps supported Node host tuples and rejects every unsupported tuple. */
export function auditToolPlatformKeyForHost(host: AuditToolHost): ExactImageAuditToolPlatformKey {
  if (host.platform === "darwin" && host.arch === "arm64") return "darwin-arm64";
  if (host.platform === "darwin" && host.arch === "x64") return "darwin-x64";
  if (host.platform === "linux" && host.arch === "x64") return "linux-amd64";
  if (host.platform === "linux" && host.arch === "arm64") return "linux-arm64";
  fail(`unsupported exact-image audit-tool host: ${JSON.stringify(host.platform)}/${JSON.stringify(host.arch)}`);
}

export type FetchAndInstallVendoredBinary = (
  input: FetchVendoredBinaryInput,
) => Promise<FetchVendoredBinaryResult>;

export interface InstallExactImageAuditToolsInput {
  /** Validated version-1 manifest; it is revalidated before every install. */
  readonly manifest: ExactImageAuditToolManifestV1;
  /** Required absolute directory receiving exactly syft, grype, and trivy. */
  readonly destination: string;
  /** Injectable host tuple for deterministic tests; defaults to this process. */
  readonly host?: AuditToolHost;
  /** Injectable downloader/install seam; defaults to the shared verified helper. */
  readonly fetchAndInstall?: FetchAndInstallVendoredBinary;
}

export interface InstalledExactImageAuditTool {
  readonly name: ExactImageAuditToolName;
  readonly version: string;
  readonly path: string;
  readonly archiveSha256: string;
  readonly installed: FetchVendoredBinaryResult;
}

export interface InstallExactImageAuditToolsResult {
  readonly platformKey: ExactImageAuditToolPlatformKey;
  readonly tools: readonly InstalledExactImageAuditTool[];
}

/**
 * Installs all required scanners through the repository's single audited
 * download/checksum/tar-extract helper. It has no report or DB-update behavior.
 */
export async function installExactImageAuditTools(
  input: InstallExactImageAuditToolsInput,
): Promise<InstallExactImageAuditToolsResult> {
  assertExactImageAuditToolManifest(input.manifest);
  if (typeof input.destination !== "string" || input.destination.trim() === "" || !isAbsolute(input.destination)) {
    fail("destination must be an explicitly supplied absolute directory");
  }

  const host = input.host ?? { platform: process.platform, arch: process.arch };
  const platformKey = auditToolPlatformKeyForHost(host);
  const fetchAndInstall = input.fetchAndInstall ?? fetchAndVerifyVendoredBinary;
  const tools: InstalledExactImageAuditTool[] = [];

  for (const name of AUDIT_TOOL_NAMES) {
    const definition = input.manifest.tools[name];
    const artifact = definition.artifacts[platformKey];
    const path = join(input.destination, definition.archiveMember);
    const installed = await fetchAndInstall({
      url: artifact.url,
      sha256: artifact.sha256,
      destPath: path,
      archive: { format: "tar.gz", member: definition.archiveMember },
    });
    tools.push({
      name,
      version: definition.version,
      path,
      archiveSha256: artifact.sha256,
      installed,
    });
  }

  return { platformKey, tools };
}
