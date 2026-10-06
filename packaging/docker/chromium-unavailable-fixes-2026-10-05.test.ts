import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput, type VulnerabilityPolicyV1 } from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean, string[]];
const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = read("fixtures/chromium-unavailable-fixes-2026-10-05.json") as {
  architectures: Record<Architecture, Tuple[]>; renewals: Record<Architecture, Tuple[]>;
};
const advisories = new Set(fixture.architectures["linux/amd64"].map(tuple => tuple[1]));
const decisions = (read("server-vulnerability-exceptions.input.json") as { exceptions: VulnerabilityPolicyV1["exceptions"] })
  .exceptions.filter(entry => advisories.has(entry.advisoryId));
const digest = `sha256:${"a".repeat(64)}`;
const evaluatedAt = "2026-10-05T10:40:00Z";

function input(architecture: Architecture): EvaluateVulnerabilityPolicyInput {
  const binding = {
    image: { digest, reference: `registry.example/runtime@${digest}` }, architecture,
    databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
  };
  return {
    policy: parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: decisions })),
    manifest: {
      version: 1, sourceSha: "a".repeat(40), dockerfileSha256: digest,
      baseImages: [{ role: "runtime", identity: `registry.example/base@${digest}` }],
      architecture, image: { ...binding.image, sizeBytes: 42 },
      tools: { grype: "1", trivy: "1" }, databases: [{ name: "grype", identity: "db", version: "1" }],
      capturedAt: evaluatedAt,
    },
    databaseIdentity: {
      version: 1,
      databases: {
        grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
        trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
      },
    },
    grype: { matches: fixture.architectures[architecture].map(([, id, name, version, severity, , versions]) => ({
      vulnerability: { id, severity, fix: { versions } }, artifact: { name, version },
    })) },
    trivy: { Results: [] },
    supportedPackageAvailability: {
      image: { ...binding.image, sizeBytes: 42 }, architecture, distribution: "debian:13",
      checkedAt: evaluatedAt, verifiedBy: "apt-secure",
      signedIndexes: { trixie: "d".repeat(64), "trixie-updates": "e".repeat(64), "trixie-security": "f".repeat(64) },
      packages: ["chromium-common", "chromium-headless-shell"].map(packageName => ({
        packageName, installedVersion: "154.0.8037.92-1~deb13u1", availableVersion: "154.0.8037.92-1~deb13u1",
        fixedVersion: "154.0.8037.97", fixAvailable: false,
      })),
    },
    evaluatedAt,
  };
}

describe("Chromium decisions require a fresh supported-package gap", () => {
  test("covers the complete ten findings on both architectures with twenty exact decisions", () => {
    expect(advisories.size).toBe(5);
    expect(decisions).toHaveLength(20);
    expect(fixture.architectures["linux/amd64"]).toEqual(fixture.architectures["linux/arm64"]);
    for (const tuples of Object.values(fixture.architectures)) expect(tuples).toHaveLength(10);
  });

  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    test(`${architecture}: renews only the seven rechecked tuples with unchanged fixable blockers`, () => {
      const tuples = fixture.renewals[architecture];
      const renewalIds = new Set(tuples.map(tuple => tuple[1]));
      const source = read("server-vulnerability-exceptions.input.json") as { exceptions: VulnerabilityPolicyV1["exceptions"] };
      const exceptions = source.exceptions.filter(entry => renewalIds.has(entry.advisoryId));
      expect(exceptions).toHaveLength(7);
      expect(tuples).toHaveLength(11);
      const replay = input(architecture);
      const result = evaluateVulnerabilityPolicy({ ...replay, policy: { ...replay.policy, exceptions },
        grype: { matches: tuples.filter(tuple => tuple[0] === "grype").map(([, id, name, version, severity]) => ({
          vulnerability: { id, severity, fix: { versions: [] } }, artifact: { name, version },
        })) },
        trivy: { Results: [{ Vulnerabilities: tuples.filter(tuple => tuple[0] === "trivy").map(([, id, name, version, severity]) => ({
          VulnerabilityID: id, PkgName: name, InstalledVersion: version, Severity: severity, FixedVersion: "",
        })) }] },
      });
      expect(result.passed).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.exceptions.every(entry => entry.used && entry.expiresAt === "2026-10-23T00:00:00Z")).toBe(true);
      const changed = evaluateVulnerabilityPolicy({ ...replay, policy: { ...replay.policy, exceptions },
        grype: { matches: tuples.filter(tuple => tuple[0] === "grype").map(([, id, name, version, severity]) => ({
          vulnerability: { id, severity, fix: { versions: ["supported-fixed-build"] } }, artifact: { name, version },
        })) }, trivy: { Results: [] },
      });
      expect(changed.failures.filter(failure => failure.code === "fixable-high-critical")).toHaveLength(7);
    });

    test(`${architecture}: accepts only the evidenced package gap`, () => {
      const replay = input(architecture);
      const result = evaluateVulnerabilityPolicy(replay);
      expect(result.passed).toBe(true);
      expect(result.exceptions.filter(entry => entry.used)).toHaveLength(10);
      expect(result.warnings).toEqual([]);
      expect(result.findings.filter(finding => finding.severity === "critical")).toHaveLength(4);
      expect(evaluateVulnerabilityPolicy({ ...replay, supportedPackageAvailability: undefined }).passed).toBe(false);
      expect(evaluateVulnerabilityPolicy({ ...replay, policy: { ...replay.policy, exceptions: [] } }).failures).toHaveLength(10);
      expect(evaluateVulnerabilityPolicy({ ...replay, evaluatedAt: "2026-10-23T00:00:00Z" }).failures.map(failure => failure.code))
        .toContain("expired-exception");
    });

    test(`${architecture}: a patched candidate, changed version, or changed fix threshold blocks`, () => {
      for (const change of [
        { availableVersion: "154.0.8037.97-1~deb13u1", fixAvailable: true },
        { availableVersion: "154.0.8037.92-1~deb13u2" },
        { installedVersion: "154.0.8037.92-1~deb13u2" },
        { fixedVersion: "154.0.8037.98" },
      ]) {
        const replay = input(architecture);
        const availability = replay.supportedPackageAvailability!;
        const result = evaluateVulnerabilityPolicy({ ...replay, supportedPackageAvailability: {
          ...availability, packages: availability.packages.map(entry => ({ ...entry, ...change })),
        } });
        expect(result.passed).toBe(false);
        expect(result.failures).toHaveLength(10);
      }
      const replay = input(architecture);
      const tuples = fixture.architectures[architecture];
      const fixed = evaluateVulnerabilityPolicy({ ...replay, grype: { matches: tuples.map(([, id, name, version, severity]) => ({
        vulnerability: { id, severity, fix: { versions: ["154.0.8037.98"] } }, artifact: { name, version },
      })) } });
      expect(fixed.passed).toBe(false);
      expect(fixed.failures.filter(failure => failure.code === "fixable-high-critical")).toHaveLength(10);
    });
  }
});
