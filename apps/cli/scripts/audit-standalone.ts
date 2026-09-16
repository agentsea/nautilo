#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  parseStandaloneAssetManifest,
  verifyStandaloneAssetManifest,
} from "../src/lib/standalone-assets.ts";
import { auditStandaloneNativeBinary } from "../src/lib/standalone-native-audit.ts";
import type { StandaloneRuntimeQualificationReceiptV1 } from "./build-standalone.ts";
import type { StandaloneCompilerConfigurationReceiptV1 } from "./compile-standalone-native.ts";

const REQUIRED_TOOL_VERSIONS = { syft: "1.50.0", grype: "0.116.1" } as const;
const REPORT_NAMES = [
  "sbom", "licenses", "vulnerabilities", "disclosure", "configuration", "native", "runtime", "scanner-coverage",
] as const;

type JsonRecord = Record<string, unknown>;
type ReportName = typeof REPORT_NAMES[number];

export type StandaloneVulnerabilityPolicyV1 = {
  readonly schemaVersion: 1;
  readonly scanner: "grype";
  readonly scannerVersion: "0.116.1";
  readonly database: { readonly schemaVersion: string; readonly built: string; readonly sourceSha256: string; readonly valid: true };
  readonly findings: readonly { readonly id: string; readonly packageName: string; readonly installedVersion: string; readonly severity: string; readonly fixVersions: readonly string[] }[];
  readonly highCriticalCount: number;
  readonly passed: true;
};

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function sha256Bytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function sha256File(path: string): string { return sha256Bytes(readFileSync(path)); }
function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
  return value;
}

export function assertStandaloneArchiveBinding(path: string, expectedSha256: string): string {
  const archive = requireRegular(path, "archive");
  if (sha256File(archive) !== requireDigest(expectedSha256, "archiveSha256")) {
    throw new Error("Standalone archive does not match its build receipt.");
  }
  return archive;
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string.`);
  return value;
}
function requireRegular(path: string, label: string): string {
  const resolved = resolve(path);
  const details = lstatSync(resolved);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
  return resolved;
}
function requireEmptyDirectory(path: string): string {
  const resolved = resolve(path);
  mkdirSync(resolved, { recursive: true, mode: 0o755 });
  if (readdirSync(resolved).length !== 0) throw new Error("Standalone evidence output directory must be empty.");
  return resolved;
}
function argument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new Error(`Standalone evidence requires --${name} <value>.`);
  return value;
}
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
function writeJson(path: string, value: unknown): void { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 }); }

function runJson(command: string, args: readonly string[], label: string): unknown {
  const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}.`);
  try { return JSON.parse(new TextDecoder().decode(result.stdout)) as unknown; }
  catch { throw new Error(`${label} returned invalid JSON.`); }
}

function exactToolVersion(path: string, name: keyof typeof REQUIRED_TOOL_VERSIONS): string {
  const tool = requireRegular(path, `${name} executable`);
  const receipt = record(runJson(tool, ["version", "-o", "json"], `${name} version`), `${name} version`);
  if (receipt["version"] !== REQUIRED_TOOL_VERSIONS[name]) {
    throw new Error(`${name} version must be ${REQUIRED_TOOL_VERSIONS[name]}.`);
  }
  return tool;
}

export function evaluateStandaloneGrypeReport(value: unknown): StandaloneVulnerabilityPolicyV1 {
  const report = record(value, "Grype report");
  if (!Array.isArray(report["matches"])) throw new Error("Grype report must contain matches.");
  const descriptor = record(report["descriptor"], "Grype descriptor");
  if (descriptor["name"] !== "grype" || descriptor["version"] !== REQUIRED_TOOL_VERSIONS.grype) {
    throw new Error("Grype report has the wrong scanner identity.");
  }
  const database = record(record(descriptor["db"], "Grype database")["status"], "Grype database status");
  if (database["valid"] !== true) throw new Error("Grype vulnerability database is not valid.");
  const source = requireString(database["from"], "Grype database source");
  const sourceMatch = /checksum=sha256%3A([a-f0-9]{64})(?:&|$)/.exec(source);
  if (sourceMatch === null) throw new Error("Grype database source is not checksum-bound.");
  const findings = report["matches"].map((entry, index) => {
    const match = record(entry, `Grype match ${index}`);
    const vulnerability = record(match["vulnerability"], `Grype match ${index} vulnerability`);
    const artifact = record(match["artifact"], `Grype match ${index} artifact`);
    const fix = vulnerability["fix"] === undefined ? {} : record(vulnerability["fix"], `Grype match ${index} fix`);
    const fixVersions = fix["versions"] === undefined ? [] : fix["versions"];
    if (!Array.isArray(fixVersions) || fixVersions.some((item) => typeof item !== "string")) {
      throw new Error(`Grype match ${index} fix versions are malformed.`);
    }
    const exactFixVersions = fixVersions as string[];
    return {
      id: requireString(vulnerability["id"], `Grype match ${index} ID`),
      packageName: requireString(artifact["name"], `Grype match ${index} package`),
      installedVersion: requireString(artifact["version"], `Grype match ${index} version`),
      severity: requireString(vulnerability["severity"], `Grype match ${index} severity`).toLowerCase(),
      fixVersions: [...exactFixVersions].sort(),
    };
  }).sort((left, right) => `${left.id}:${left.packageName}`.localeCompare(`${right.id}:${right.packageName}`));
  const highCriticalCount = findings.filter(({ severity }) => severity === "high" || severity === "critical").length;
  if (highCriticalCount !== 0) throw new Error("Standalone vulnerability policy rejects high or critical findings without an exact reviewed exception.");
  return {
    schemaVersion: 1,
    scanner: "grype",
    scannerVersion: REQUIRED_TOOL_VERSIONS.grype,
    database: {
      schemaVersion: requireString(database["schemaVersion"], "Grype database schema"),
      built: requireString(database["built"], "Grype database build time"),
      sourceSha256: sourceMatch[1]!,
      valid: true,
    },
    findings,
    highCriticalCount,
    passed: true,
  };
}

function walkFiles(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(current, entry.name);
    const details = lstatSync(path);
    if (details.isSymbolicLink()) throw new Error("Standalone disclosure audit rejects symlinks.");
    if (details.isDirectory()) return walkFiles(root, path);
    if (!details.isFile()) throw new Error("Standalone disclosure audit rejects non-regular files.");
    return [path];
  });
}

export function createStandaloneDisclosureReport(input: {
  bundleRoot: string;
  source: string;
  platform: string;
  archiveSha256: string;
  forbiddenMarkers: readonly string[];
}): unknown {
  const files = walkFiles(input.bundleRoot);
  const findings: Array<{ category: string; path: string; rule: string; matchSha256: string }> = [];
  let bytesInspected = 0;
  const rules: readonly [string, RegExp][] = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
    ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
    ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ];
  for (const path of files) {
    const relativePath = path.slice(resolve(input.bundleRoot).length + 1).replaceAll("\\", "/");
    if (/(?:^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.netrc|\.git-credentials|auth\.json)$/.test(relativePath)) {
      findings.push({ category: "package-auth-config", path: relativePath, rule: "forbidden-auth-path", matchSha256: sha256Bytes(Buffer.from(relativePath)) });
    }
    if (/\.(?:js|css)?\.map$/.test(relativePath)) {
      findings.push({ category: "source-map", path: relativePath, rule: "source-map-path", matchSha256: sha256Bytes(Buffer.from(relativePath)) });
    }
    const bytes = readFileSync(path);
    bytesInspected += bytes.length;
    const text = bytes.toString("latin1");
    for (const [rule, pattern] of rules) {
      for (const match of text.matchAll(pattern)) findings.push({
        category: "secret-material", path: relativePath, rule, matchSha256: sha256Bytes(Buffer.from(match[0])),
      });
    }
    for (const marker of input.forbiddenMarkers) {
      if (marker !== "" && text.includes(marker)) findings.push({
        category: "operator-path", path: relativePath, rule: "forbidden-marker", matchSha256: sha256Bytes(Buffer.from(marker)),
      });
    }
  }
  findings.sort((left, right) => `${left.category}:${left.path}:${left.rule}`.localeCompare(`${right.category}:${right.path}:${right.rule}`));
  if (findings.length !== 0) throw new Error("Standalone bounded disclosure policy found prohibited material.");
  return {
    schemaVersion: 1,
    claim: "bounded-taxonomy-only",
    source: input.source,
    platform: input.platform,
    archiveSha256: input.archiveSha256,
    categories: ["secret-material", "package-auth-config", "operator-path", "source-map"],
    coverage: { filesInspected: files.length, bytesInspected },
    findings,
    passed: true,
    limitation: "Does not claim detection of all PII or all possible sensitive information.",
  };
}

function strictRuntime(value: unknown, source: string, version: string, platform: string, archiveSha256: string): StandaloneRuntimeQualificationReceiptV1 {
  const runtime = record(value, "runtime qualification") as StandaloneRuntimeQualificationReceiptV1 & JsonRecord;
  const booleans = ["versionAndHelp", "composeAssetBoundary", "nativePortProbe", "hostPlanRedacted", "keychainWriteReadDelete", "durableCredentialStore", "railwayOauthPkce"];
  const expectedKeys = ["schemaVersion", "source", "version", "platform", "archiveSha256", ...booleans].sort();
  if (
    Object.keys(runtime).sort().join(",") !== expectedKeys.join(",") || runtime.schemaVersion !== 1 ||
    runtime.source !== source || runtime.version !== version || runtime.platform !== platform || runtime.archiveSha256 !== archiveSha256 ||
    booleans.some((key) => runtime[key] !== true)
  ) throw new Error("Standalone runtime qualification is incomplete or bound to different bytes.");
  return runtime;
}

function strictCompilerConfiguration(value: unknown, platform: string): StandaloneCompilerConfigurationReceiptV1 {
  const configuration = record(value, "compiler configuration") as StandaloneCompilerConfigurationReceiptV1 & JsonRecord;
  const expectedKeys = [
    "schemaVersion", "target", "autoloadDotenv", "autoloadBunfig", "autoloadTsconfig", "autoloadPackageJson", "exactNativeKeyringRedirect", "embeddedNativeDeveloperIdCodeSigned", "embeddedNativeBindingInput", "embeddedNativeBindingSha256",
    "adHocCodeSigned", "developerIdCodeSigned", "hardenedRuntime", "secureTimestamp",
  ].sort();
  const validAdHoc = configuration.adHocCodeSigned === true &&
    configuration.developerIdCodeSigned === false && configuration.hardenedRuntime === false &&
    configuration.secureTimestamp === false;
  const validDeveloperId = configuration.adHocCodeSigned === false &&
    configuration.developerIdCodeSigned === true && configuration.hardenedRuntime === true &&
    configuration.secureTimestamp === true;
  if (
    Object.keys(configuration).sort().join(",") !== expectedKeys.join(",") ||
    configuration.schemaVersion !== 1 || configuration.target !== `bun-${platform}` ||
    configuration.autoloadDotenv !== false || configuration.autoloadBunfig !== false ||
    configuration.autoloadTsconfig !== false || configuration.autoloadPackageJson !== false ||
    configuration.exactNativeKeyringRedirect !== true ||
    configuration.embeddedNativeDeveloperIdCodeSigned !== configuration.developerIdCodeSigned ||
    typeof configuration.embeddedNativeBindingInput !== "string" || configuration.embeddedNativeBindingInput.trim() === "" ||
    typeof configuration.embeddedNativeBindingSha256 !== "string" || !/^[a-f0-9]{64}$/.test(configuration.embeddedNativeBindingSha256) ||
    (!validAdHoc && !validDeveloperId)
  ) throw new Error("Standalone compiler configuration receipt is incomplete or bound to a different platform.");
  return configuration;
}

function reportEntry(output: string, name: ReportName): { type: ReportName; path: string; size: number; sha256: string } {
  const path = join(output, `${name}.json`);
  const details = lstatSync(path);
  return { type: name, path: basename(path), size: details.size, sha256: sha256File(path) };
}

export function auditStandalone(input: { buildReceiptPath: string; toolsDirectory: string; output: string }): unknown {
  const output = requireEmptyDirectory(input.output);
  const build = record(json(requireRegular(input.buildReceiptPath, "build receipt")), "build receipt");
  const archivePathValue = requireString(build["archivePath"], "archive path");
  const archiveSha256 = requireDigest(build["archiveSha256"], "archiveSha256");
  const archivePath = assertStandaloneArchiveBinding(archivePathValue, archiveSha256);
  const bundleRoot = resolve(requireString(build["bundleRoot"], "bundle root"));
  const manifestPath = requireRegular(join(bundleRoot, "artifact-manifest.json"), "artifact manifest");
  const manifest = parseStandaloneAssetManifest(json(manifestPath));
  verifyStandaloneAssetManifest(join(bundleRoot, "share/nautilo"), manifest);
  const binary = requireRegular(join(bundleRoot, "bin/nautilo"), "standalone binary");
  const native = auditStandaloneNativeBinary({ binaryPath: binary, platform: manifest.platform, forbiddenRoots: [resolve(dirname(dirname(dirname(import.meta.dir))))] });
  const runtime = strictRuntime(build["runtimeQualification"], manifest.source, manifest.version, manifest.platform, archiveSha256);
  const compilerConfiguration = strictCompilerConfiguration(build["compilerConfiguration"], manifest.platform);
  const sbomPath = requireRegular(requireString(build["sbomPath"], "SBOM path"), "SBOM");
  const licensesPath = requireRegular(requireString(build["licenseInventoryPath"], "license inventory path"), "license inventory");
  const sbom = record(json(sbomPath), "SBOM");
  const licenses = record(json(licensesPath), "license inventory");
  for (const evidence of [sbom, licenses]) {
    const properties = evidence === sbom ? record(sbom["metadata"], "SBOM metadata")["properties"] : undefined;
    if (evidence === licenses) {
      if (licenses["source"] !== manifest.source || licenses["platform"] !== manifest.platform || licenses["archiveSha256"] !== archiveSha256 || licenses["complete"] !== true) {
        throw new Error("Standalone license inventory binding is invalid.");
      }
    } else if (!Array.isArray(properties) || !properties.some((item) => record(item, "SBOM property")["name"] === "ai.nautilo.archive.sha256" && record(item, "SBOM property")["value"] === archiveSha256)) {
      throw new Error("Standalone SBOM is not bound to the archive.");
    }
  }
  const syft = exactToolVersion(join(input.toolsDirectory, "syft"), "syft");
  const grype = exactToolVersion(join(input.toolsDirectory, "grype"), "grype");
  const scanRoot = mkdtempSync(join(tmpdir(), "nautilo-standalone-audit-"));
  try {
    const syftRaw = runJson(syft, [`dir:${bundleRoot}`, "-o", "cyclonedx-json", "-q"], "Syft archive scan");
    const syftRecord = record(syftRaw, "Syft report");
    const syftComponents = syftRecord["components"] === undefined ? [] : syftRecord["components"];
    if (!Array.isArray(syftComponents)) throw new Error("Syft report components are malformed.");
    const grypeRaw = runJson(grype, [`sbom:${sbomPath}`, "-o", "json"], "Grype SBOM scan");
    const vulnerabilityPolicy = evaluateStandaloneGrypeReport(grypeRaw);
    const vulnerabilities = {
      ...vulnerabilityPolicy,
      source: manifest.source,
      version: manifest.version,
      platform: manifest.platform,
      archiveSha256,
      scannerExecutableSha256: sha256File(grype),
    };
    const disclosure = createStandaloneDisclosureReport({
      bundleRoot,
      source: manifest.source,
      platform: manifest.platform,
      archiveSha256,
      forbiddenMarkers: [resolve(dirname(dirname(dirname(import.meta.dir))))],
    });
    const configuration = {
      schemaVersion: 1, source: manifest.source, version: manifest.version, platform: manifest.platform, archiveSha256,
      compilerConfiguration,
      assetManifestVerified: true, exactRuntimeAssetTree: true, checkoutFallbackDisabled: true, passed: true,
    };
    const scannerCoverage = {
      schemaVersion: 1, source: manifest.source, platform: manifest.platform, archiveSha256,
      scanner: "syft", scannerVersion: REQUIRED_TOOL_VERSIONS.syft,
      scannerExecutableSha256: sha256File(syft), componentCount: syftComponents.length,
      completeDependencyAuthority: false,
      authoritativeInventory: "compiler-closure-cyclonedx",
      limitation: "Syft does not identify packages embedded in the Bun standalone executable; its result is retained as independent coverage evidence, not used as the dependency authority.",
    };
    writeJson(join(output, "sbom.json"), sbom);
    writeJson(join(output, "licenses.json"), licenses);
    writeJson(join(output, "vulnerabilities.json"), vulnerabilities);
    writeJson(join(output, "disclosure.json"), disclosure);
    writeJson(join(output, "configuration.json"), configuration);
    writeJson(join(output, "native.json"), { ...native, source: manifest.source, version: manifest.version, archiveSha256 });
    writeJson(join(output, "runtime.json"), runtime);
    writeJson(join(output, "scanner-coverage.json"), scannerCoverage);
    const reports = REPORT_NAMES.map((name) => reportEntry(output, name));
    const index = { schemaVersion: 1, source: manifest.source, version: manifest.version, platform: manifest.platform, archiveSha256, reports };
    writeJson(join(output, "report-index.json"), index);
    const receipt = {
      schemaVersion: 1, passed: true, source: manifest.source, version: manifest.version, platform: manifest.platform,
      archive: { filename: basename(archivePath), size: lstatSync(archivePath).size, sha256: archiveSha256 },
      reportIndexSha256: sha256File(join(output, "report-index.json")), reportCount: reports.length,
      componentCount: Array.isArray(sbom["components"]) ? sbom["components"].length : 0,
      licenseCount: licenses["componentCount"], vulnerabilityHighCriticalCount: vulnerabilityPolicy.highCriticalCount,
      disclosurePassed: true, configurationPassed: true, nativePassed: true, runtimePassed: true,
      signingStatus: compilerConfiguration.developerIdCodeSigned
        ? "developer-id-signed-candidate; Apple notarization required before release assembly"
        : "ad-hoc-candidate-evidence; public release prohibited",
    };
    writeJson(join(output, "platform-gate-receipt.json"), receipt);
    return receipt;
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const result = auditStandalone({
      buildReceiptPath: argument(process.argv.slice(2), "build-receipt"),
      toolsDirectory: argument(process.argv.slice(2), "tools"),
      output: argument(process.argv.slice(2), "output"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Standalone evidence audit failed."}\n`);
    process.exitCode = 2;
  }
}
