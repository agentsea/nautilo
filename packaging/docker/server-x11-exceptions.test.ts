import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateVulnerabilityPolicy,
  parseVulnerabilityPolicy,
  type VulnerabilityPolicyV1,
} from "./vulnerability-policy.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const architectures = ["linux/amd64", "linux/arm64"] as const;
const findingTuples: ["grype", string, string, string, "high", false][] = [
  ["grype", "CVE-2026-88806", "libx11-6", "2:1.8.12-1", "high", false],
  ["grype", "CVE-2026-88806", "libx11-data", "2:1.8.12-1", "high", false],
  ["grype", "CVE-2026-88806", "libx11-xcb1", "2:1.8.12-1", "high", false],
  ["grype", "CVE-2026-88807", "libxrender1", "1:0.9.12-1", "high", false],
];
const source = readJson("server-vulnerability-exceptions.input.json") as Pick<VulnerabilityPolicyV1, "exceptions">;
const imageDigest = `sha256:${"a".repeat(64)}`;

function evaluate(architecture: "linux/amd64" | "linux/arm64", fixVersions: string[] = [], packageVersion?: string) {
  const binding = {
    image: { digest: imageDigest, reference: `registry.example/runtime@${imageDigest}` },
    architecture,
    databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
  };
  const decisions = source.exceptions.filter((entry) =>
    entry.advisoryId === "CVE-2026-88806" || entry.advisoryId === "CVE-2026-88807");
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
    capturedAt: "2026-09-23T13:20:00Z",
  };
  const databaseIdentity = {
    version: 1 as const,
    databases: {
      grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
      trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
    },
  };
  const grype = { matches: findingTuples.map(([, advisoryId, name, version]) => ({
    vulnerability: { id: advisoryId, severity: "High", fix: { versions: fixVersions } },
    artifact: { name, version: packageVersion ?? version },
  })) };
  return evaluateVulnerabilityPolicy({
    policy, manifest, databaseIdentity, grype, trivy: { Results: [] }, evaluatedAt: "2026-09-23T13:21:00Z",
  });
}

describe("September 23 X11 security policy", () => {
  test("binds exactly the four observed findings on both architectures", () => {
    expect(findingTuples).toHaveLength(4);
    for (const architecture of architectures) {
      const report = evaluate(architecture);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.findings.map(({ scanner, advisoryId, packageName, installedVersion, severity, fixable }) =>
        [scanner, advisoryId, packageName, installedVersion, severity, fixable]))
        .toEqual(findingTuples);
    }
  });

  test("fails closed if the installed version changes or a supported fix is reported", () => {
    expect(evaluate("linux/amd64", [], "9.9.9").failures.map((entry) => entry.code))
      .toEqual(Array(4).fill("unmatched-high-critical"));
    expect(evaluate("linux/amd64", ["supported-fix"]).failures.map((entry) => entry.code))
      .toEqual(Array(4).fill("fixable-high-critical"));
  });
});
