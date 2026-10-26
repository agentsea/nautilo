import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput, type VulnerabilityPolicyExceptionSourceV1 } from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type ScannerFixture = {
  grype: { matches: { vulnerability: { id: string; severity: string; fix: { versions: string[]; state: string } }; artifact: { name: string; version: string } }[] };
  trivy: { Results: { Vulnerabilities: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; Severity: string; Status: string }[] }[] };
};
const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, name), "utf8"));
const fixture = read("fixtures/server-advisory-metadata-2026-10-24.json") as {
  reviewedAt: string; expiresAt: string; unchangedExceptionsSha256: string;
  architectures: Record<Architecture, ScannerFixture>;
};
const source = read("server-vulnerability-exceptions.input.json") as VulnerabilityPolicyExceptionSourceV1;
const advisoryIds = ["CVE-2026-113351", "CVE-2026-115506", "CVE-2026-113679"];
const decisions = source.exceptions.filter(entry => advisoryIds.includes(entry.advisoryId));

function input(architecture: Architecture, reports = fixture.architectures[architecture]): EvaluateVulnerabilityPolicyInput {
  const digest = `sha256:${"a".repeat(64)}`;
  const image = { digest, reference: `registry.example/runtime@${digest}`, sizeBytes: 42 };
  const binding = { image: { digest, reference: image.reference }, architecture, databases: { grype: "b".repeat(64), trivy: "c".repeat(64) } };
  return {
    policy: parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: decisions })),
    manifest: { version: 1, sourceSha: "d".repeat(40), dockerfileSha256: digest,
      baseImages: [{ role: "runtime", identity: `registry.example/base@${digest}` }], architecture, image,
      tools: { grype: "synthetic-binding", trivy: "synthetic-binding" },
      databases: [{ name: "grype", identity: "synthetic-binding", version: "1" }], capturedAt: fixture.reviewedAt },
    databaseIdentity: { version: 1, databases: {
      grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
      trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
    } },
    ...reports, evaluatedAt: fixture.reviewedAt,
  };
}

describe("Debian Expat and HarfBuzz advisory metadata", () => {
  test("adds only four exact decisions for 21 days and preserves all previous policy fields", () => {
    expect(source.exceptions).toHaveLength(86);
    expect(decisions.map(entry => [entry.advisoryId, entry.packageName, entry.installedVersion, entry.severity])).toEqual([
      ["CVE-2026-113351", "libexpat1", "2.9.0-1~deb13u1", "high"],
      ["CVE-2026-115506", "libexpat1", "2.9.0-1~deb13u1", "high"],
      ["CVE-2026-113679", "libharfbuzz-subset0", "10.2.0-1+deb13u1", "high"],
      ["CVE-2026-113679", "libharfbuzz0b", "10.2.0-1+deb13u1", "high"],
    ]);
    const unchanged = source.exceptions.filter(entry => !advisoryIds.includes(entry.advisoryId));
    expect(createHash("sha256").update(JSON.stringify(unchanged)).digest("hex")).toBe(fixture.unchangedExceptionsSha256);
    for (const entry of decisions) {
      expect("observedBy" in entry && entry.observedBy).toEqual(["grype"]);
      expect(entry.reviewedAt).toBe("2026-10-24T00:00:00Z");
      expect(entry.expiresAt).toBe("2026-11-14T00:00:00Z");
      expect(entry.unavailableFix).toBeUndefined();
      expect(entry.rationale).toContain(`https://security-tracker.debian.org/tracker/${entry.advisoryId}`);
    }
  });

  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    test(`${architecture}: preserves native scanner severities and reproduces the four gate failures`, () => {
      const replay = input(architecture);
      const native = fixture.architectures[architecture];
      expect(native.grype.matches.map(match => match.vulnerability.severity)).toEqual(["High", "High", "High", "High"]);
      expect(native.trivy.Results[0]!.Vulnerabilities.map(v => [v.VulnerabilityID, v.PkgName, v.Severity])).toEqual([
        ["CVE-2026-113351", "libexpat1", "MEDIUM"],
        ["CVE-2026-115506", "libexpat1", "UNKNOWN"],
        ["CVE-2026-113679", "libharfbuzz-subset0", "MEDIUM"],
        ["CVE-2026-113679", "libharfbuzz0b", "MEDIUM"],
      ]);
      const before = evaluateVulnerabilityPolicy({ ...replay, policy: { ...replay.policy, exceptions: [] } });
      expect(before.failures).toHaveLength(4);
      expect(before.failures.every(failure => failure.code === "unmatched-high-critical")).toBe(true);
      const after = evaluateVulnerabilityPolicy(replay);
      expect(after.passed).toBe(true);
      expect(after.findings).toHaveLength(4);
      expect(after.findings.every(finding => finding.scanner === "grype" && finding.severity === "high" && !finding.fixable)).toBe(true);
      expect(after.failures).toEqual([]);
      expect(after.warnings).toEqual([]);
      expect(after.exceptions.every(entry => entry.used)).toBe(true);
    });

    test(`${architecture}: rejects every changed tuple, newly reported fix, and expired decision`, () => {
      for (let index = 0; index < decisions.length; index++) {
        for (const change of ["advisory", "package", "version", "severity", "fix"] as const) {
          const reports = structuredClone(fixture.architectures[architecture]);
          const match = reports.grype.matches[index]!;
          if (change === "advisory") match.vulnerability.id += "-changed";
          if (change === "package") match.artifact.name += "-changed";
          if (change === "version") match.artifact.version += "-changed";
          if (change === "severity") match.vulnerability.severity = "Critical";
          if (change === "fix") match.vulnerability.fix = { versions: ["synthetic-fixed-version"], state: "fixed" };
          const report = evaluateVulnerabilityPolicy(input(architecture, reports));
          expect(report.passed).toBe(false);
          expect(report.failures.map(failure => failure.code)).toContain(change === "fix" ? "fixable-high-critical" : "unmatched-high-critical");
        }
      }
      const report = evaluateVulnerabilityPolicy({ ...input(architecture), evaluatedAt: fixture.expiresAt });
      expect(report.passed).toBe(false);
      expect(report.failures.filter(failure => failure.code === "expired-exception")).toHaveLength(4);
    });
  }
});
