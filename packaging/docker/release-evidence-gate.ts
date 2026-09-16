#!/usr/bin/env bun
/** Fail-closed V0 release gate over one complete, digest-bound architecture evidence set. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertRuntimeImageEvidenceManifest, type RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";
import type { ExactImageAuditReportIndexV1 } from "./exact-image-audit.ts";

const REQUIRED_REPORT_TYPES = [
  "sbom", "vulnerabilities", "image-analysis", "vulnerability-policy",
  "image-inspect", "image-history", "bounded-disclosure",
] as const;
const PROHIBITED_PACKAGES = [
  "@browserbasehq/stagehand", "@langchain/community", "electron", "eslint",
  "ibm-cloud-sdk-core", "ibm-watson", "node-pty", "playwright", "playwright-core",
  "turbo", "vitest",
] as const;
const REQUIRED_RUNTIME_TYPESCRIPT_VERSION = "5.9.3";

export interface ReleaseArchitectureGateReceiptV1 {
  readonly version: 1;
  readonly passed: true;
  readonly sourceSha: string;
  readonly dockerfileSha256: string;
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly image: RuntimeImageEvidenceManifestV1["image"];
  readonly baseImages: RuntimeImageEvidenceManifestV1["baseImages"];
  readonly databases: RuntimeImageEvidenceManifestV1["databases"];
  readonly reportIndexSha256: string;
  readonly nativeProbeSha256: string;
  readonly reportCount: number;
  readonly packageCount: number;
  readonly licenseCount: number;
  readonly prohibitedPackages: readonly string[];
  readonly executionMode: "native";
  readonly capturedAt: string;
}

function fail(message: string): never { throw new Error(`D490 release evidence gate failed: ${message}`); }
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

export function evaluateReleaseArchitectureEvidence(evidenceDirectory: string, nativeProbePath: string): ReleaseArchitectureGateReceiptV1 {
  const directory = resolve(evidenceDirectory);
  const manifest = json(join(directory, "manifest.json"));
  assertRuntimeImageEvidenceManifest(manifest);
  const indexPath = join(directory, "report-index.json");
  const index = record(json(indexPath), "report index") as unknown as ExactImageAuditReportIndexV1;
  if (index.version !== 1 || index.sourceSha !== manifest.sourceSha || index.architecture !== manifest.architecture || JSON.stringify(index.image) !== JSON.stringify(manifest.image)) {
    fail("report index binding does not match manifest");
  }
  if (!Array.isArray(index.reports) || index.reports.length !== REQUIRED_REPORT_TYPES.length) fail("report index is incomplete");
  const reportTypes = index.reports.map((entry) => entry.type);
  if (new Set(reportTypes).size !== REQUIRED_REPORT_TYPES.length || REQUIRED_REPORT_TYPES.some((type) => !reportTypes.includes(type))) {
    fail("report index does not contain each required report exactly once");
  }
  const reports = new Map<string, unknown>();
  for (const entry of index.reports) {
    if (entry.sourceSha !== manifest.sourceSha || entry.architecture !== manifest.architecture || JSON.stringify(entry.image) !== JSON.stringify(manifest.image)) {
      fail(`${entry.type} report binding does not match manifest`);
    }
    const path = safeReportPath(directory, entry.path);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.sizeBytes || hash(path) !== entry.sha256) fail(`${entry.type} report bytes do not match index`);
    reports.set(entry.type, JSON.parse(bytes.toString("utf8")) as unknown);
  }

  const vulnerability = record(reports.get("vulnerability-policy"), "vulnerability policy report");
  if (vulnerability.passed !== true || !Array.isArray(vulnerability.failures) || vulnerability.failures.length !== 0) fail("vulnerability policy did not pass cleanly");
  const disclosure = record(reports.get("bounded-disclosure"), "bounded disclosure report");
  const coverage = record(disclosure.coverage, "bounded disclosure coverage");
  if (disclosure.passed !== true || !Array.isArray(disclosure.findings) || disclosure.findings.length !== 0 || !Array.isArray(coverage.unscannedTextFiles) || coverage.unscannedTextFiles.length !== 0) {
    fail("bounded disclosure policy did not pass with complete text coverage");
  }

  const sbom = record(reports.get("sbom"), "SBOM");
  if (!Array.isArray(sbom.artifacts) || sbom.artifacts.length === 0) fail("SBOM has no package inventory");
  const packages = sbom.artifacts.map((entry, index) => {
    const artifact = record(entry, `SBOM artifact ${index}`);
    if (typeof artifact.name !== "string" || artifact.name.length === 0) fail(`SBOM artifact ${index} has no package name`);
    return { name: artifact.name, version: artifact.version };
  });
  const packageNames = packages.map(({ name }) => name);
  const presentProhibited = PROHIBITED_PACKAGES.filter((name) => packageNames.includes(name));
  if (presentProhibited.length > 0) fail(`prohibited packages are present: ${presentProhibited.join(", ")}`);
  const runtimeTypeScriptVersions = [...new Set(
    packages.filter(({ name }) => name === "typescript").map(({ version }) => (
      typeof version === "string" && version.length > 0 ? version : "<missing>"
    )),
  )].sort();
  if (JSON.stringify(runtimeTypeScriptVersions) !== JSON.stringify([REQUIRED_RUNTIME_TYPESCRIPT_VERSION])) {
    fail(`runtime TypeScript package inventory must contain only ${REQUIRED_RUNTIME_TYPESCRIPT_VERSION}; found ${runtimeTypeScriptVersions.join(", ") || "none"}`);
  }

  const trivy = record(reports.get("image-analysis"), "Trivy image analysis");
  if (!Array.isArray(trivy.Results)) fail("Trivy image analysis has no Results");
  const licenseResults = trivy.Results.filter((entry) => record(entry, "Trivy result").Class === "license");
  if (licenseResults.length === 0) fail("Trivy image analysis contains no license inventory");
  const licenseCount = licenseResults.reduce((total, entry) => {
    const licenses = record(entry, "Trivy license result").Licenses;
    if (!Array.isArray(licenses)) fail("Trivy license result has no Licenses array");
    return total + licenses.length;
  }, 0);
  if (licenseCount === 0) fail("Trivy license inventory is empty");

  const nativePath = resolve(nativeProbePath);
  const native = record(json(nativePath), "native probe");
  const nativeImage = record(native.image, "native probe image");
  const probe = record(native.probe, "native probe result");
  const encryptionInventory = record(probe.encryptionInventory, "encryption inventory probe");
  const sharp = record(probe.sharp, "Sharp probe");
  const argon2 = record(probe.argon2, "argon2 probe");
  const officecli = record(probe.officecli, "OfficeCLI probe");
  const screenshots = officecli.screenshots;
  if (native.sourceSha !== manifest.sourceSha || native.requestedPlatform !== manifest.architecture || native.executionMode !== "native") fail("native probe identity or execution mode does not match manifest");
  if (nativeImage.reference !== manifest.image.reference || nativeImage.sizeBytes !== manifest.image.sizeBytes || !Array.isArray(nativeImage.repoDigests) || !nativeImage.repoDigests.includes(manifest.image.reference)) {
    fail("native probe image identity does not match manifest");
  }
  if (encryptionInventory.typescriptVersion !== REQUIRED_RUNTIME_TYPESCRIPT_VERSION) {
    fail(`native TypeScript runtime probe must report ${REQUIRED_RUNTIME_TYPESCRIPT_VERSION}`);
  }
  const officeFormats = Array.isArray(screenshots)
    ? screenshots.map((entry, index) => {
      const screenshot = record(entry, `OfficeCLI screenshot ${index}`);
      if (typeof screenshot.format !== "string" || typeof screenshot.sizeBytes !== "number" || screenshot.sizeBytes < 100 || typeof screenshot.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(screenshot.sha256)) {
        fail(`OfficeCLI screenshot ${index} is incomplete`);
      }
      return screenshot.format;
    }).sort()
    : fail("OfficeCLI probe has no screenshots");
  if (probe.platform !== manifest.architecture || sharp.version !== "0.35.4" || typeof sharp.sha256 !== "string" || argon2.verified !== true || argon2.rejectedWrongValue !== true || officecli.browserExecutable !== "/usr/bin/chromium" || JSON.stringify(officeFormats) !== JSON.stringify(["docx", "pptx", "xlsx"])) {
    fail("native Sharp/argon2 and OfficeCLI behavior is incomplete");
  }

  return {
    version: 1, passed: true, sourceSha: manifest.sourceSha,
    dockerfileSha256: manifest.dockerfileSha256, architecture: manifest.architecture,
    image: manifest.image, baseImages: manifest.baseImages, databases: manifest.databases,
    reportIndexSha256: hash(indexPath), nativeProbeSha256: hash(nativePath),
    reportCount: index.reports.length, packageCount: sbom.artifacts.length,
    licenseCount, prohibitedPackages: presentProhibited, executionMode: "native",
    capturedAt: index.capturedAt,
  };
}

function summary(receipt: ReleaseArchitectureGateReceiptV1): string {
  return [
    `# D490 ${receipt.architecture} release gate`, "", "Status: PASS", "",
    `- Source: \`${receipt.sourceSha}\``,
    `- Image: \`${receipt.image.reference}\``,
    `- Reports: ${receipt.reportCount}`,
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
  const result = evaluateReleaseArchitectureEvidence(evidence, nativeProbe);
  writeFileSync(resolve(receipt), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  writeFileSync(resolve(humanSummary), summary(result), { flag: "wx", mode: 0o644 });
  process.stdout.write(`[d490:release-evidence-gate] PASS ${result.architecture} ${result.image.digest}\n`);
}
