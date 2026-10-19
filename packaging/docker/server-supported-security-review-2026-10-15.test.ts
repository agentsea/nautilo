import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput, type VulnerabilityPolicyV1 } from "./vulnerability-policy";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean, string[]];
const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, name), "utf8"));
const review = read("fixtures/server-supported-security-review-2026-10-15.json") as {
  reviewedAt: string; expiresAt: string; retiredInstalledVersion: string; installedVersion: string;
  availableVersion: string; fixedFloor: string; retiredDecisionCount: number; unchangedDecisionCount: number; newDecisionCount: number;
  architectures: Record<Architecture, Tuple[]>;
  reviewedAdvisories: Record<string, { url: string; description: string; supportedStatus: string; upstreamFixedVersion: string; unstablePackageVersion: string }>;
};
const source = read("fixtures/server-policy-before-upgrade-2026-10-19.json") as { exceptions: VulnerabilityPolicyV1["exceptions"] };
const previous = read("fixtures/server-policy-before-chromium-upgrade-2026-10-15.json") as typeof source;
const isChromium = (entry: { packageName: string }) => entry.packageName.startsWith("chromium-");

function input(architecture: Architecture): EvaluateVulnerabilityPolicyInput {
  const digest = "sha256:" + "a".repeat(64), image = { digest, reference: "registry.example/runtime@" + digest, sizeBytes: 42 };
  const binding = { image: { digest, reference: image.reference }, architecture, databases: { grype: "b".repeat(64), trivy: "c".repeat(64) } };
  const tuples = review.architectures[architecture];
  const packages = [...new Map(source.exceptions.filter(e => e.unavailableFix?.architecture === architecture).map(e => [
    e.packageName + "\0" + e.unavailableFix!.fixedVersion,
    { packageName: e.packageName, installedVersion: e.installedVersion, availableVersion: e.unavailableFix!.availableVersion,
      fixedVersion: e.unavailableFix!.fixedVersion, fixAvailable: false },
  ])).values()];
  return {
    policy: parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: source.exceptions })),
    manifest: { version: 1, sourceSha: "a".repeat(40), dockerfileSha256: digest,
      baseImages: [{ role: "runtime", identity: "registry.example/base@" + digest }], architecture, image,
      tools: { grype: "1", trivy: "1" }, databases: [{ name: "grype", identity: "db", version: "1" }], capturedAt: review.reviewedAt },
    databaseIdentity: { version: 1, databases: {
      grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
      trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
    } },
    grype: { matches: tuples.filter(t => t[0] === "grype").map(([, id, name, version, severity, , versions]) => ({
      vulnerability: { id, severity, fix: { versions } }, artifact: { name, version },
    })) },
    trivy: { Results: [{ Vulnerabilities: tuples.filter(t => t[0] === "trivy").map(([, id, name, version, severity, , versions]) => ({
      VulnerabilityID: id, PkgName: name, InstalledVersion: version, Severity: severity, FixedVersion: versions.join(", "),
    })) }] },
    supportedPackageAvailability: { image, architecture, distribution: "debian:13", checkedAt: review.reviewedAt,
      verifiedBy: "apt-secure", signedIndexes: { trixie: "d".repeat(64), "trixie-updates": "e".repeat(64), "trixie-security": "f".repeat(64) }, packages },
    evaluatedAt: review.reviewedAt,
  };
}

describe("supported Chromium binary security decisions", () => {
  test("retires the patched binary decisions while preserving every unrelated approval byte", () => {
    expect(previous.exceptions).toHaveLength(644);
    expect(previous.exceptions.filter(isChromium)).toHaveLength(556);
    expect(source.exceptions).toHaveLength(260);
    expect(source.exceptions.filter(e => !isChromium(e))).toEqual(previous.exceptions.filter(e => !isChromium(e)));
    expect(source.exceptions.filter(isChromium)).toHaveLength(172);
    expect(source.exceptions.some(e => e.installedVersion === review.retiredInstalledVersion)).toBe(false);
    expect(review).toMatchObject({ retiredDecisionCount: 556, unchangedDecisionCount: 88, newDecisionCount: 172,
      installedVersion: "155.0.8059.39-1~deb13u1", availableVersion: "155.0.8059.39-1~deb13u1", fixedFloor: "155.0.8059.79",
      expiresAt: "2026-10-23T00:00:00Z" });
    expect(review.architectures["linux/amd64"]).toEqual(review.architectures["linux/arm64"]);
    expect(Object.keys(review.reviewedAdvisories)).toHaveLength(37);
    for (const entry of source.exceptions.filter(isChromium)) {
      const advisory = review.reviewedAdvisories[entry.advisoryId]!;
      expect(advisory.supportedStatus).toBe("open");
      expect(advisory.upstreamFixedVersion).toBe(review.fixedFloor);
      expect(advisory.unstablePackageVersion).toBe(review.fixedFloor + "-1");
      expect(entry.rationale).toContain(advisory.url);
      expect(entry.reviewedAt).toBe(review.reviewedAt);
      expect(entry.expiresAt).toBe(review.expiresAt);
      expect(entry.unavailableFix).toEqual({ architecture: entry.unavailableFix!.architecture,
        distribution: "debian:13", availableVersion: review.availableVersion, fixedVersion: review.fixedFloor });
      const exact = review.architectures[entry.unavailableFix!.architecture].filter(t =>
        t[1] === entry.advisoryId && t[2] === entry.packageName && t[3] === entry.installedVersion && t[4] === entry.severity);
      expect(exact.length).toBeGreaterThan(0);
      expect(entry.observedBy).toEqual([...new Set(exact.map(t => t[0]))].sort());
    }
  });

  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    test(architecture + ": accepts only the complete exact native inventory and fresh binary availability", () => {
      const replay = input(architecture), report = evaluateVulnerabilityPolicy(replay);
      expect(report.findings).toHaveLength(282);
      expect(report.passed).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      const chromium = report.findings.filter(isChromium);
      expect(chromium).toHaveLength(134);
      expect(chromium.every(f => !f.fixable && f.fixedVersions === undefined)).toBe(true);
      expect(chromium.some(f => f.severity === "critical")).toBe(true);
      const withoutNew = evaluateVulnerabilityPolicy({ ...replay, policy: { ...replay.policy,
        exceptions: source.exceptions.filter(e => !isChromium(e)) } });
      expect(withoutNew.failures.filter(f => f.code === "unmatched-high-critical")).toHaveLength(134);
      const proof = replay.supportedPackageAvailability!;
      for (const change of [{ checkedAt: "2026-10-14T00:00:00Z" }, { signedIndexes: {} },
        { image: { ...proof.image, digest: "sha256:" + "f".repeat(64) } },
        { packages: proof.packages.map(p => isChromium(p) ? { ...p, availableVersion: review.fixedFloor, fixAvailable: true } : p) },
        { packages: proof.packages.map(p => isChromium(p) ? { ...p, availableVersion: review.availableVersion + ".changed" } : p) }]) {
        expect(evaluateVulnerabilityPolicy({ ...replay, supportedPackageAvailability: { ...proof, ...change } }).passed).toBe(false);
      }
      expect(evaluateVulnerabilityPolicy({ ...replay, supportedPackageAvailability: undefined }).passed).toBe(false);
      expect(evaluateVulnerabilityPolicy({ ...replay, evaluatedAt: review.expiresAt }).passed).toBe(false);
    });
  }
});
