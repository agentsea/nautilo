#!/usr/bin/env bun
/** Fail-closed architecture gate for the exact D488 bootstrap image. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertRuntimeImageEvidenceManifest } from "./runtime-image-evidence.ts";
import type { ExactImageAuditReportIndexV1 } from "./exact-image-audit.ts";
import type { ReleaseArchitectureGateReceiptV1 } from "./release-evidence-gate.ts";

const REQUIRED_REPORT_TYPES = [
  "sbom", "vulnerabilities", "image-analysis", "vulnerability-policy",
  "image-inspect", "image-history", "bounded-disclosure",
] as const;
const APPROVED_PACKAGES = [
  "base-files", "ca-certificates", "libc6", "media-types", "netbase", "tzdata",
  "tzdata-legacy",
] as const;
const STAGING_REPOSITORY = "ghcr.io/agentsea/nautilo-bootstrap-staging";

function fail(message: string): never { throw new Error(`D488 bootstrap release evidence gate failed: ${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
function hash(path: string): string { return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; }
function safeReportPath(directory: string, path: unknown): string {
  if (typeof path !== "string" || basename(path) !== path || path === "." || path === "..") fail("report path must be a safe basename");
  return join(directory, path);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has an unexpected shape`);
}

export function evaluateBootstrapArchitectureEvidence(
  evidenceDirectory: string,
  nativeProbePath: string,
): ReleaseArchitectureGateReceiptV1 {
  const directory = resolve(evidenceDirectory);
  const manifest = json(join(directory, "manifest.json"));
  assertRuntimeImageEvidenceManifest(manifest);
  if (manifest.image.reference !== `${STAGING_REPOSITORY}@${manifest.image.digest}`) {
    fail("manifest image is not the immutable private bootstrap staging digest");
  }
  const indexPath = join(directory, "report-index.json");
  const index = record(json(indexPath), "report index") as unknown as ExactImageAuditReportIndexV1;
  if (index.version !== 1 || index.sourceSha !== manifest.sourceSha || index.architecture !== manifest.architecture ||
    JSON.stringify(index.image) !== JSON.stringify(manifest.image)) fail("report index binding does not match manifest");
  if (!Array.isArray(index.reports) || index.reports.length !== REQUIRED_REPORT_TYPES.length) fail("report index is incomplete");
  const reportTypes = index.reports.map((entry) => entry.type);
  if (new Set(reportTypes).size !== REQUIRED_REPORT_TYPES.length || REQUIRED_REPORT_TYPES.some((type) => !reportTypes.includes(type))) {
    fail("report index does not contain each required report exactly once");
  }
  const reports = new Map<string, unknown>();
  for (const entry of index.reports) {
    if (entry.sourceSha !== manifest.sourceSha || entry.architecture !== manifest.architecture ||
      JSON.stringify(entry.image) !== JSON.stringify(manifest.image)) fail(`${entry.type} report binding does not match manifest`);
    const path = safeReportPath(directory, entry.path);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.sizeBytes || hash(path) !== entry.sha256) fail(`${entry.type} report bytes do not match index`);
    reports.set(entry.type, JSON.parse(bytes.toString("utf8")) as unknown);
  }

  const vulnerability = record(reports.get("vulnerability-policy"), "vulnerability policy report");
  if (vulnerability["passed"] !== true || !Array.isArray(vulnerability["failures"]) || vulnerability["failures"].length !== 0) {
    fail("vulnerability policy did not pass cleanly");
  }
  const disclosure = record(reports.get("bounded-disclosure"), "bounded disclosure report");
  const coverage = record(disclosure["coverage"], "bounded disclosure coverage");
  if (disclosure["passed"] !== true || !Array.isArray(disclosure["findings"]) || disclosure["findings"].length !== 0 ||
    !Array.isArray(coverage["unscannedTextFiles"]) || coverage["unscannedTextFiles"].length !== 0) {
    fail("bounded disclosure policy did not pass with complete text coverage");
  }

  const sbom = record(reports.get("sbom"), "SBOM");
  if (!Array.isArray(sbom["artifacts"]) || sbom["artifacts"].length === 0) fail("SBOM has no package inventory");
  const packageNames = sbom["artifacts"].map((entry, indexValue) => {
    const artifact = record(entry, `SBOM artifact ${indexValue}`);
    if (typeof artifact["name"] !== "string" || artifact["name"] === "") fail(`SBOM artifact ${indexValue} has no name`);
    return artifact["name"];
  }).sort();
  if (JSON.stringify([...new Set(packageNames)]) !== JSON.stringify([...APPROVED_PACKAGES].sort())) {
    fail(`runtime package closure changed: ${[...new Set(packageNames)].join(", ")}`);
  }

  const trivy = record(reports.get("image-analysis"), "Trivy image analysis");
  if (!Array.isArray(trivy["Results"])) fail("Trivy image analysis has no Results");
  const licenseResults = trivy["Results"].filter((entry) => record(entry, "Trivy result")["Class"] === "license");
  const licenseCount = licenseResults.reduce((total, entry) => {
    const licenses = record(entry, "Trivy license result")["Licenses"];
    if (!Array.isArray(licenses)) fail("Trivy license result has no Licenses array");
    return total + licenses.length;
  }, 0);
  if (licenseCount === 0) fail("Trivy license inventory is empty");

  const nativePath = resolve(nativeProbePath);
  const native = record(json(nativePath), "native probe");
  const nativeImage = record(native["image"], "native probe image");
  const probe = record(native["probe"], "native probe result");
  if (native["sourceSha"] !== manifest.sourceSha || native["dockerfileSha256"] !== manifest.dockerfileSha256 ||
    native["requestedPlatform"] !== manifest.architecture || native["executionMode"] !== "native" ||
    nativeImage["reference"] !== manifest.image.reference || nativeImage["sizeBytes"] !== manifest.image.sizeBytes ||
    !Array.isArray(nativeImage["repoDigests"]) || !nativeImage["repoDigests"].includes(manifest.image.reference)) {
    fail("native probe identity or execution mode does not match manifest");
  }
  if (probe["user"] !== "nonroot:nonroot" ||
    JSON.stringify(probe["entrypoint"]) !== JSON.stringify(["/usr/local/bin/nautilo-hosted-bootstrap"]) ||
    probe["network"] !== "none" || probe["rootFilesystem"] !== "read-only") {
    fail("native probe did not enforce the runtime confinement contract");
  }
  const missingEnvironment = record(probe["missingEnvironment"], "missing-environment result");
  const missingEnvironmentFailure = record(missingEnvironment["failure"], "missing-environment failure");
  const invalidMode = record(probe["invalidMode"], "invalid-mode result");
  const missingDatabase = record(probe["missingDatabase"], "missing-database result");
  const missingDatabaseFailure = record(missingDatabase["failure"], "missing-database failure");
  if (!Array.isArray(missingDatabase["clusters"]) || missingDatabase["clusters"].length !== 1) {
    fail("native missing-database evidence must contain exactly one failed app cluster");
  }
  const missingDatabaseCluster = record(missingDatabase["clusters"][0], "missing-database app cluster");
  const missingDatabaseClusterFailure = record(missingDatabaseCluster["failure"], "missing-database app cluster failure");
  if (missingEnvironment["status"] !== "failed" || missingEnvironmentFailure["kind"] !== "invalid-environment" ||
    missingEnvironmentFailure["code"] !== "missing-app-postgres-admin-url" ||
    invalidMode["status"] !== "failed" || invalidMode["code"] !== "invalid-bootstrap-mode" ||
    missingDatabase["status"] !== "failed" || missingDatabaseFailure["kind"] !== "reconciliation-failed" ||
    missingDatabaseFailure["cluster"] !== "app" || missingDatabaseCluster["status"] !== "failed" ||
    !Array.isArray(missingDatabaseCluster["checkpoints"]) || missingDatabaseCluster["checkpoints"].length !== 0 ||
    missingDatabaseClusterFailure["kind"] !== "adapter-failure" ||
    missingDatabaseClusterFailure["cluster"] !== "app" || missingDatabaseClusterFailure["retryable"] !== true) {
    fail("native safe-failure evidence is incomplete");
  }
  exactKeys(invalidMode, ["status", "code"], "invalid-mode result");

  return {
    version: 1,
    passed: true,
    sourceSha: manifest.sourceSha,
    dockerfileSha256: manifest.dockerfileSha256,
    architecture: manifest.architecture,
    image: manifest.image,
    baseImages: manifest.baseImages,
    databases: manifest.databases,
    reportIndexSha256: hash(indexPath),
    nativeProbeSha256: hash(nativePath),
    reportCount: index.reports.length,
    packageCount: sbom["artifacts"].length,
    licenseCount,
    prohibitedPackages: [],
    executionMode: "native",
    capturedAt: index.capturedAt,
  };
}

function summary(receipt: ReleaseArchitectureGateReceiptV1): string {
  return [
    `# D488 bootstrap ${receipt.architecture} release gate`, "", "Status: PASS", "",
    `- Source: \`${receipt.sourceSha}\``,
    `- Image: \`${receipt.image.reference}\``,
    `- Packages inventoried: ${receipt.packageCount}`,
    `- Licenses inventoried: ${receipt.licenseCount}`,
    `- Native execution: ${receipt.executionMode}`, "",
  ].join("\n");
}

if (import.meta.main) {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) values.set(process.argv[index]!, process.argv[index + 1]!);
  const evidence = values.get("--evidence");
  const nativeProbe = values.get("--native-probe");
  const receipt = values.get("--receipt");
  const humanSummary = values.get("--summary");
  if (!evidence || !nativeProbe || !receipt || !humanSummary) fail("usage: --evidence <dir> --native-probe <json> --receipt <json> --summary <md>");
  const result = evaluateBootstrapArchitectureEvidence(evidence, nativeProbe);
  writeFileSync(resolve(receipt), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  writeFileSync(resolve(humanSummary), summary(result), { flag: "wx", mode: 0o644 });
  process.stdout.write(`[d488:bootstrap-release-evidence-gate] PASS ${result.architecture} ${result.image.digest}\n`);
}
