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

describe("Server release evidence gate", () => {
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

  test("requires the source-pinned native browser and complete linkage on both architectures", () => {
    const mutations: Array<readonly [readonly string[], unknown]> = [
      [["browser"], undefined],
      [["browser", "vendor"], "debian"],
      [["browser", "version"], "156.0.8078.79"],
      [["browser", "platform"], "linux/other"],
      [["browser", "archiveSha256"], "0".repeat(64)],
      [["browser", "executableSha256"], "0".repeat(64)],
      [["browser", "realExecutable"], "/usr/bin/chromium-headless-shell"],
      [["browser", "elf", "machine"], 0],
      [["browser", "elf", "class"], 32],
      [["browser", "elf", "endianness"], "big"],
      [["browser", "linkage"], undefined],
      [["browser", "linkage", "passed"], false],
      [["browser", "linkage", "checkedFiles"], []],
      [["browser", "linkage", "checkedFiles"], ["/opt/nautilo/chromium/chrome-headless-shell", "/tmp/unrelated.so"]],
      [["browser", "linkage", "missing"], ["libmissing.so"]],
    ];
    for (const architecture of ["amd64", "arm64"] as const) {
      const valid = copiedFixture(architecture);
      expect(evaluateReleaseArchitectureEvidence(valid.directory, valid.nativeProbe).passed).toBe(true);
      for (const [path, value] of mutations) {
        const fixture = copiedFixture(architecture);
        const native = JSON.parse(readFileSync(fixture.nativeProbe, "utf8"));
        let target = native.probe as Record<string, unknown>;
        for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
        const key = path[path.length - 1]!;
        if (value === undefined) delete target[key];
        else target[key] = value;
        writeFileSync(fixture.nativeProbe, JSON.stringify(native));
        expect(() => evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe)).toThrow("Browser qualification");
      }
    }
  });

  test("requires linkage coverage for every shipped browser library on both architectures", () => {
    const libraries = ["libEGL.so", "libGLESv2.so", "libvk_swiftshader.so", "libvulkan.so.1"];
    for (const architecture of ["amd64", "arm64"] as const) {
      for (const omitted of ["all-libraries", ...libraries]) {
        const fixture = copiedFixture(architecture);
        const native = JSON.parse(readFileSync(fixture.nativeProbe, "utf8")) as {
          probe: { browser: { linkage: { checkedFiles: string[] } } };
        };
        const linkage = native.probe.browser.linkage;
        linkage.checkedFiles = omitted === "all-libraries"
          ? ["/opt/nautilo/chromium/chrome-headless-shell"]
          : linkage.checkedFiles.filter((path) => path !== `/opt/nautilo/chromium/${omitted}`);
        writeFileSync(fixture.nativeProbe, JSON.stringify(native));
        expect(() => evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe))
          .toThrow("incomplete or failed linkage evidence");
      }
    }
  });

  test("requires the browser component and provenance in digest-bound SBOM evidence", () => {
    for (const mutation of ["missing-proof", "missing-component", "wrong-version", "missing-cpe"] as const) {
      const fixture = copiedFixture("amd64");
      rewriteIndexedReport(fixture, "sbom", (report) => {
        if (mutation === "missing-proof") { delete report.nautiloChromium; return; }
        if (!Array.isArray(report.artifacts)) throw new Error("fixture SBOM has no artifacts");
        if (mutation === "missing-component") {
          report.artifacts = report.artifacts.filter((artifact) => artifact.name !== "google-chrome");
          return;
        }
        const browser = report.artifacts.find((artifact) => artifact.name === "google-chrome");
        if (!browser) throw new Error("fixture SBOM has no browser");
        if (mutation === "wrong-version") browser.version = "156.0.8078.79";
        else browser.cpes = [];
      });
      expect(() => evaluateReleaseArchitectureEvidence(fixture.directory, fixture.nativeProbe)).toThrow();
    }
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

describe("Vulnerability database capture", () => {
  test("hashes exact provider database files and metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "server-db-capture-"));
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
