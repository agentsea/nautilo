import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput, type VulnerabilityPolicyV1 } from "./vulnerability-policy";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean, string[]];
const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, name), "utf8"));
const fixture = read("fixtures/server-security-review-2026-10-11.json") as {
  reviewedAt: string; expiresAt: string; architectures: Record<Architecture, Tuple[]>;
  reviewedAdvisories: Record<string, { url: string; fixedThreshold: string | null; releases: Record<string, { status: string }> }>;
};
const source = read("fixtures/server-policy-before-chromium-upgrade-2026-10-15.json") as { exceptions: VulnerabilityPolicyV1["exceptions"] };
// Replay the earlier scanner metadata with its original exact fixed thresholds.
// Current Debian-package thresholds are qualified separately against new raw
// observations; changing current policy must not rewrite this historical input.
const refreshed = read("fixtures/server-chromium-fixed-version-refresh-2026-10-12.json") as {
  installedVersion: string; packages: string[];
  cases: { advisoryId: string; severity: string; previousThreshold: string; fixedVersion: string }[];
};
source.exceptions = source.exceptions.map((entry) => {
  const revision = refreshed.cases.find(c => c.advisoryId === entry.advisoryId && c.severity === entry.severity);
  if (!revision || !refreshed.packages.includes(entry.packageName)
    || entry.installedVersion !== refreshed.installedVersion
    || entry.unavailableFix?.fixedVersion !== revision.fixedVersion) return entry;
  return { ...entry, unavailableFix: { ...entry.unavailableFix, fixedVersion: revision.previousThreshold } };
});
const digest = `sha256:${"a".repeat(64)}`;
function input(architecture: Architecture): EvaluateVulnerabilityPolicyInput {
  const image = { digest, reference: `registry.example/runtime@${digest}`, sizeBytes: 42 };
  const binding = { image: { digest: image.digest, reference: image.reference }, architecture, databases: { grype: "b".repeat(64), trivy: "c".repeat(64) } };
  const tuples = fixture.architectures[architecture];
  const requirements = source.exceptions.filter(e => e.unavailableFix?.architecture === architecture);
  const packages = [...new Map(requirements.map(e => [e.packageName + e.unavailableFix!.fixedVersion, {
    packageName: e.packageName, installedVersion: e.installedVersion, availableVersion: e.unavailableFix!.availableVersion,
    fixedVersion: e.unavailableFix!.fixedVersion, fixAvailable: false,
  }])).values()];
  return {
    policy: parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: source.exceptions })),
    manifest: { version: 1, sourceSha: "a".repeat(40), dockerfileSha256: digest,
      baseImages: [{ role: "runtime", identity: `registry.example/base@${digest}` }], architecture, image,
      tools: { grype: "1", trivy: "1" }, databases: [{ name: "grype", identity: "db", version: "1" }], capturedAt: fixture.reviewedAt },
    databaseIdentity: { version: 1, databases: {
      grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
      trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
    } },
    grype: { matches: tuples.filter(t => t[0] === "grype").map(([, id, name, version, severity,, versions]) => ({
      vulnerability: { id, severity, fix: { versions } }, artifact: { name, version },
    })) },
    trivy: { Results: [{ Vulnerabilities: tuples.filter(t => t[0] === "trivy").map(([, id, name, version, severity,, versions]) => ({
      VulnerabilityID: id, PkgName: name, InstalledVersion: version, Severity: severity, FixedVersion: versions.join(", "),
    })) }] },
    supportedPackageAvailability: { image, architecture, distribution: "debian:13", checkedAt: fixture.reviewedAt,
      verifiedBy: "apt-secure", signedIndexes: { trixie: "d".repeat(64), "trixie-updates": "e".repeat(64), "trixie-security": "f".repeat(64) }, packages },
    evaluatedAt: fixture.reviewedAt,
  };
}

describe("supported package security review", () => {
  test("retains the complete matched native inventories and primary-source dispositions", () => {
    expect(fixture.architectures["linux/amd64"]).toEqual(fixture.architectures["linux/arm64"]);
    expect(fixture.architectures["linux/amd64"]).toHaveLength(506);
    expect(Object.keys(fixture.reviewedAdvisories)).toHaveLength(51);
    const decisions = source.exceptions.filter(e => e.reviewedAt === fixture.reviewedAt);
    expect(decisions).toHaveLength(200);
    for (const e of decisions) {
      const advisory = fixture.reviewedAdvisories[e.advisoryId]!;
      expect(advisory.releases.trixie!.status).toBe("open");
      expect(e.rationale).toContain(advisory.url);
      expect(e.expiresAt).toBe(fixture.expiresAt);
      if (advisory.fixedThreshold) expect(e.unavailableFix?.fixedVersion).toBe(advisory.fixedThreshold);
      else expect(advisory.releases.sid!.status).toBe("open");
    }
  });
  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    test(`${architecture}: accepts all exact observations without unused decisions`, () => {
      const report = evaluateVulnerabilityPolicy(input(architecture));
      expect(report.passed).toBe(true);
      expect(report.findings).toHaveLength(506);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
    });
    test(`${architecture}: missing or changed availability and expired decisions fail closed`, () => {
      const replay = input(architecture);
      expect(evaluateVulnerabilityPolicy({ ...replay, supportedPackageAvailability: undefined }).passed).toBe(false);
      const proof = replay.supportedPackageAvailability!;
      for (const change of [{ checkedAt: "2026-10-10T00:00:00Z" }, { signedIndexes: {} },
        { packages: proof.packages.map(p => ({ ...p, availableVersion: p.fixedVersion, fixAvailable: true })) }]) {
        expect(evaluateVulnerabilityPolicy({ ...replay, supportedPackageAvailability: { ...proof, ...change } }).passed).toBe(false);
      }
      expect(evaluateVulnerabilityPolicy({ ...replay, evaluatedAt: fixture.expiresAt }).passed).toBe(false);
    });
  }
});
