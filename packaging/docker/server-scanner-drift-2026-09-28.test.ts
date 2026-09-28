import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateVulnerabilityPolicy,
  parseVulnerabilityPolicy,
  type VulnerabilityPolicyV1,
} from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type FindingTuple = readonly ["grype", string, string, string, "high", false];

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = readJson("fixtures/server-scanner-drift-2026-09-28.json") as {
  architectures: Record<Architecture, FindingTuple[]>;
};
const source = readJson("server-vulnerability-exceptions.input.json") as Pick<VulnerabilityPolicyV1, "exceptions">;
const architectures: Architecture[] = ["linux/amd64", "linux/arm64"];
const expected: FindingTuple[] = [
  ["grype", "CVE-2026-88372", "libsndfile1", "1.2.2-2+deb13u1", "high", false],
  ["grype", "CVE-2026-93543", "libxi6", "2:1.8.2-1", "high", false],
];
const imageDigest = `sha256:${"a".repeat(64)}`;

function evaluate(architecture: Architecture, fixVersions: string[] = [], packageVersion?: string) {
  const binding = {
    image: { digest: imageDigest, reference: `registry.example/runtime@${imageDigest}` },
    architecture,
    databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
  };
  const decisions = source.exceptions.filter((entry) =>
    entry.advisoryId === "CVE-2026-88372" || entry.advisoryId === "CVE-2026-93543");
  const policy = parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: decisions }));
  const manifest = {
    version: 1 as const,
    sourceSha: "d".repeat(40),
    dockerfileSha256: `sha256:${"d".repeat(64)}`,
    baseImages: [{ role: "runtime", identity: `registry.example/base@sha256:${"e".repeat(64)}` }],
    architecture,
    image: { ...binding.image, sizeBytes: 42 },
    tools: { grype: "1", trivy: "1" },
    databases: [{ name: "grype", identity: "db", version: "1" }],
    capturedAt: "2026-09-28T18:50:00Z",
  };
  const databaseIdentity = {
    version: 1 as const,
    databases: {
      grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
      trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
    },
  };
  const grype = { matches: fixture.architectures[architecture].map(([, advisoryId, name, version]) => ({
    vulnerability: { id: advisoryId, severity: "High", fix: { versions: fixVersions } },
    artifact: { name, version: packageVersion ?? version },
  })) };
  return evaluateVulnerabilityPolicy({
    policy, manifest, databaseIdentity, grype, trivy: { Results: [] }, evaluatedAt: "2026-09-28T18:59:00Z",
  });
}

describe("September 28 server scanner drift", () => {
  test("binds exactly the two retained findings on both architectures", () => {
    for (const architecture of architectures) {
      expect(fixture.architectures[architecture]).toEqual(expected);
      const report = evaluate(architecture);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.findings.map(({ scanner, advisoryId, packageName, installedVersion, severity, fixable }) =>
        [scanner, advisoryId, packageName, installedVersion, severity, fixable]))
        .toEqual(expected);
    }
  });

  test("fails closed on a changed installed version or newly available fix", () => {
    for (const architecture of architectures) {
      expect(evaluate(architecture, [], "9.9.9").failures.map(({ code }) => code))
        .toEqual(["unmatched-high-critical", "unmatched-high-critical"]);
      expect(evaluate(architecture, ["supported-fix"]).failures.map(({ code }) => code))
        .toEqual(["fixable-high-critical", "fixable-high-critical"]);
    }
  });
});
