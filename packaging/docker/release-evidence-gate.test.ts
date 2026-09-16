import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { databaseIdentityFromCaches } from "./prepare-release-audit.ts";
import { evaluateReleaseArchitectureEvidence } from "./release-evidence-gate.ts";
import { createExactImageEvidenceFixture } from "./exact-image-evidence-fixture.test.ts";

function copiedFixture(architecture: "amd64" | "arm64"): { directory: string; nativeProbe: string } {
  return createExactImageEvidenceFixture({
    architecture: `linux/${architecture}`,
    kind: "server",
  });
}

function rewriteIndexedReport(
  fixture: ReturnType<typeof copiedFixture>,
  type: string,
  mutate: (report: Record<string, unknown>) => void,
): void {
  const indexPath = join(fixture.directory, "report-index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
    reports: Array<{ type: string; path: string; sizeBytes: number; sha256: string }>;
  };
  const entry = index.reports.find((candidate) => candidate.type === type);
  if (!entry) throw new Error(`fixture report is missing: ${type}`);
  const reportPath = join(fixture.directory, entry.path);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  mutate(report);
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, contents);
  entry.sizeBytes = Buffer.byteLength(contents);
  entry.sha256 = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

describe("D490 release evidence gate", () => {
  test("accepts complete digest-bound audit and native evidence", () => {
    const fixture = copiedFixture("arm64");
    const receipt = evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe);
    expect(receipt.passed).toBe(true);
    expect(receipt.architecture).toBe("linux/arm64");
    expect(receipt.reportCount).toBe(7);
    expect(receipt.packageCount).toBeGreaterThan(0);
    expect(receipt.licenseCount).toBeGreaterThan(0);
  });

  test("rejects missing, mutated, and non-native evidence", () => {
    const mutated = copiedFixture("arm64");
    writeFileSync(join(mutated.directory, "sbom.syft.json"), "{}\n");
    expect(() => evaluateReleaseArchitectureEvidence(mutated.directory, mutated.nativeProbe)).toThrow("report bytes do not match index");

    const emulated = copiedFixture("amd64");
    const native = JSON.parse(readFileSync(emulated.nativeProbe, "utf8")) as Record<string, unknown>;
    native.executionMode = "emulated";
    writeFileSync(emulated.nativeProbe, `${JSON.stringify(native, null, 2)}\n`);
    expect(() => evaluateReleaseArchitectureEvidence(emulated.directory, emulated.nativeProbe)).toThrow("execution mode");

    const missing = copiedFixture("arm64");
    const indexPath = join(missing.directory, "report-index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as { reports: unknown[] };
    index.reports.pop();
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    expect(() => evaluateReleaseArchitectureEvidence(missing.directory, missing.nativeProbe)).toThrow("incomplete");

    const missingOfficeCli = copiedFixture("arm64");
    const officeNative = JSON.parse(readFileSync(missingOfficeCli.nativeProbe, "utf8")) as { probe: Record<string, unknown> };
    delete officeNative.probe.officecli;
    writeFileSync(missingOfficeCli.nativeProbe, `${JSON.stringify(officeNative, null, 2)}\n`);
    expect(() => evaluateReleaseArchitectureEvidence(missingOfficeCli.directory, missingOfficeCli.nativeProbe)).toThrow("OfficeCLI");
  });

  test("withholds a receipt for an unreviewed high or critical finding", () => {
    const fixture = copiedFixture("arm64");
    rewriteIndexedReport(fixture, "vulnerability-policy", (report) => {
      report.passed = false;
      report.findings = [{ scanner: "grype", advisoryId: "CVE-FIXTURE-CRITICAL", packageName: "fixture", installedVersion: "1", severity: "critical", fixable: false }];
      report.failures = [{ code: "unmatched-high-critical", message: "fixture finding is not excepted" }];
    });
    expect(() => evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe)).toThrow("vulnerability policy did not pass");
  });

  test("withholds a receipt for a prohibited runtime package", () => {
    const fixture = copiedFixture("arm64");
    rewriteIndexedReport(fixture, "sbom", (report) => {
      if (!Array.isArray(report.artifacts)) throw new Error("fixture SBOM has no artifacts");
      report.artifacts.push({ name: "@langchain/community", version: "fixture", type: "npm" });
    });
    expect(() => evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe)).toThrow("prohibited packages are present: @langchain/community");
  });

  test("requires the exact SBOM and native-probed runtime TypeScript version", () => {
    const missing = copiedFixture("arm64");
    rewriteIndexedReport(missing, "sbom", (report) => {
      if (!Array.isArray(report.artifacts)) throw new Error("fixture SBOM has no artifacts");
      report.artifacts = report.artifacts.filter((artifact) => (
        typeof artifact !== "object" || artifact === null || !("name" in artifact) || artifact.name !== "typescript"
      ));
    });
    expect(() => evaluateReleaseArchitectureEvidence(missing.directory, missing.nativeProbe)).toThrow("found none");

    const wrongInventory = copiedFixture("arm64");
    rewriteIndexedReport(wrongInventory, "sbom", (report) => {
      if (!Array.isArray(report.artifacts)) throw new Error("fixture SBOM has no artifacts");
      const artifact = report.artifacts.find((candidate) => (
        typeof candidate === "object" && candidate !== null && "name" in candidate && candidate.name === "typescript"
      ));
      if (typeof artifact !== "object" || artifact === null || !("version" in artifact)) throw new Error("fixture SBOM is missing TypeScript");
      artifact.version = "5.9.2";
    });
    expect(() => evaluateReleaseArchitectureEvidence(wrongInventory.directory, wrongInventory.nativeProbe)).toThrow("found 5.9.2");

    const wrongProbe = copiedFixture("arm64");
    const native = JSON.parse(readFileSync(wrongProbe.nativeProbe, "utf8")) as {
      probe: { encryptionInventory: { typescriptVersion: string } };
    };
    native.probe.encryptionInventory.typescriptVersion = "5.9.2";
    writeFileSync(wrongProbe.nativeProbe, `${JSON.stringify(native, null, 2)}\n`);
    expect(() => evaluateReleaseArchitectureEvidence(wrongProbe.directory, wrongProbe.nativeProbe)).toThrow("native TypeScript runtime probe");
  });

  test("withholds a receipt for disclosure findings with otherwise valid evidence hashes", () => {
    const fixture = copiedFixture("arm64");
    rewriteIndexedReport(fixture, "bounded-disclosure", (report) => {
      report.passed = false;
      report.findings = [{ category: "secret", rule: "credential-assignment", matchSha256: `sha256:${"a".repeat(64)}` }];
    });
    expect(() => evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe)).toThrow("bounded disclosure policy did not pass");
  });
});

describe("D490 vulnerability database capture", () => {
  test("hashes exact provider database files and metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "d490-db-capture-"));
    const grype = join(root, "grype");
    const trivy = join(root, "trivy");
    mkdirSync(join(grype, "6"), { recursive: true });
    mkdirSync(join(trivy, "db"), { recursive: true });
    writeFileSync(join(grype, "6", "import.json"), JSON.stringify({ client_version: "v6.1.9", source: "db_2026-08-05T00:35:21Z_1.tar.zst" }));
    writeFileSync(join(grype, "6", "vulnerability.db"), "grype");
    writeFileSync(join(trivy, "db", "metadata.json"), JSON.stringify({ Version: 2, UpdatedAt: "2026-08-05T07:37:03.811Z" }));
    writeFileSync(join(trivy, "db", "trivy.db"), "trivy");
    const identity = databaseIdentityFromCaches(grype, trivy);
    expect(identity.databases.grype.schemaVersion).toBe("v6.1.9");
    expect(identity.databases.grype.builtAt).toBe("2026-08-05T00:35:21Z");
    expect(identity.databases.trivy.schemaVersion).toBe("2");
    expect(identity.databases.grype.sha256).toHaveLength(64);
  });
});
