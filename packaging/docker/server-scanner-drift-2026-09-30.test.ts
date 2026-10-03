import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy } from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = readonly ["grype" | "trivy", string, string, string, "high", false];
const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = read("fixtures/server-scanner-drift-2026-09-30.json") as {
  qualificationRun: number;
  sourceSha: string;
  architectures: Record<Architecture, Tuple[]>;
};
// Retired production decisions remain bound to the historical scanner replay.
const source = read("fixtures/retired-server-decisions-2026-09-30.json");
const decisions = source.exceptions.filter((entry: { reviewedAt: string }) => entry.reviewedAt === "2026-09-30T15:20:00Z");
const digest = `sha256:${"a".repeat(64)}`;

function evaluate(architecture: Architecture, mutate?: (finding: Tuple) => Tuple) {
  const tuples = fixture.architectures[architecture].map((finding) => mutate?.(finding) ?? finding);
  const binding = {
    image: { digest, reference: `registry.example/runtime@${digest}` },
    architecture,
    databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
  };
  const policy = parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: decisions }));
  return evaluateVulnerabilityPolicy({
    policy,
    manifest: {
      version: 1, sourceSha: fixture.sourceSha, dockerfileSha256: digest,
      baseImages: [{ role: "runtime", identity: `registry.example/base@${digest}` }],
      architecture, image: { ...binding.image, sizeBytes: 42 },
      tools: { grype: "1", trivy: "1" }, databases: [{ name: "grype", identity: "db", version: "1" }],
      capturedAt: "2026-09-30T15:20:00Z",
    },
    databaseIdentity: {
      version: 1,
      databases: {
        grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
        trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
      },
    },
    grype: { matches: tuples.filter(([scanner]) => scanner === "grype").map(([, advisoryId, name, version]) => ({
      vulnerability: { id: advisoryId, severity: "High", fix: { versions: [] } },
      artifact: { name, version },
    })) },
    trivy: { Results: [{ Vulnerabilities: tuples.filter(([scanner]) => scanner === "trivy").map(([, advisoryId, name, version]) => ({
      VulnerabilityID: advisoryId, PkgName: name, InstalledVersion: version, Severity: "HIGH", FixedVersion: "",
    })) }] },
    evaluatedAt: "2026-09-30T15:21:00Z",
  });
}

describe("September 30 server scanner drift", () => {
  test("binds 32 exact decisions to the identical 33 findings on both architectures", () => {
    expect(fixture.qualificationRun).toBe(36732800983);
    expect(fixture.sourceSha).toBe("7be9793c79390e44496697904100444fa431bd52");
    expect(decisions).toHaveLength(32);
    expect(fixture.architectures["linux/amd64"]).toEqual(fixture.architectures["linux/arm64"]);
    for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
      const report = evaluate(architecture);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.findings.map(({ scanner, advisoryId, packageName, installedVersion, severity, fixable }) =>
        [scanner, advisoryId, packageName, installedVersion, severity, fixable]).sort())
        .toEqual([...fixture.architectures[architecture]].sort());
    }
  });

  test("fails closed if an installed package version changes", () => {
    const report = evaluate("linux/amd64", (finding) => finding[1] === "CVE-2026-94286"
      ? [finding[0], finding[1], finding[2], "9.9.9", finding[4], false] : finding);
    expect(report.failures.map(({ code }) => code)).toContain("unmatched-high-critical");
  });

  test("ships patched brace-expansion only in the server dependency projection", () => {
    const projected = readFileSync(join(import.meta.dir, "runtime-install/bun.lock"), "utf8");
    const root = readFileSync(join(import.meta.dir, "../../bun.lock"), "utf8");
    expect(projected).toContain('"brace-expansion": ["brace-expansion@5.0.11"');
    expect(root).toContain('"brace-expansion": ["brace-expansion@5.0.9"');
  });
});
