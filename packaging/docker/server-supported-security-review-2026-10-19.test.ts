import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput, type VulnerabilityPolicyV1 } from "./vulnerability-policy";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean, string[]];
const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, name), "utf8"));
const review = read("fixtures/server-supported-security-review-2026-10-19.json") as {
  reviewedAt: string; expiresAt: string; chromiumInstalledVersion: string; chromiumFixedFloor: string;
  retiredDecisionCount: number; renewedRisks: string[][]; newDecisionCount: number;
  architectures: Record<Architecture, Tuple[]>; previousFailures: Record<Architecture, string[][]>;
  reviewedAdvisories: Record<string, { url: string; supportedStatus: string; upstreamFixedVersion: string }>;
};
const source = read("fixtures/server-policy-before-security-renewal-2026-10-23.json") as { exceptions: VulnerabilityPolicyV1["exceptions"] };
const previous = read("fixtures/server-policy-before-upgrade-2026-10-19.json") as typeof source;
const isChromium = (entry: { packageName: string }) => entry.packageName.startsWith("chromium-");

function input(architecture: Architecture, decisions = source): EvaluateVulnerabilityPolicyInput {
  const digest = "sha256:" + "a".repeat(64), image = { digest, reference: "registry.example/runtime@" + digest, sizeBytes: 42 };
  const binding = { image: { digest, reference: image.reference }, architecture, databases: { grype: "b".repeat(64), trivy: "c".repeat(64) } };
  const tuples = review.architectures[architecture];
  const packages = [...new Map(decisions.exceptions.filter(e => e.unavailableFix?.architecture === architecture).map(e => [
    e.packageName + "\0" + e.unavailableFix!.fixedVersion,
    { packageName: e.packageName, installedVersion: e.installedVersion, availableVersion: e.unavailableFix!.availableVersion,
      fixedVersion: e.unavailableFix!.fixedVersion, fixAvailable: false },
  ])).values()];
  return {
    policy: parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: decisions.exceptions })),
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

describe("supported runtime package security decisions", () => {
  test("retires only obsolete package versions and preserves unrelated decisions exactly", () => {
    expect(previous.exceptions).toHaveLength(260);
    expect(source.exceptions).toHaveLength(122);
    expect(review.retiredDecisionCount).toBe(178);
    expect(review.renewedRisks).toHaveLength(6);
    expect(review.newDecisionCount).toBe(40);
    const risk = (e: {advisoryId: string; packageName: string; installedVersion: string; severity: string}) =>
      [e.advisoryId, e.packageName, e.installedVersion, e.severity].join("\0");
    const renewed = new Set(review.renewedRisks.map(t => t.join("\0")));
    const retained = previous.exceptions.filter(e => !isChromium(e) && e.packageName !== "libexpat1");
    expect(source.exceptions.filter(e => !isChromium(e) && !renewed.has(risk(e))))
      .toEqual(retained.filter(e => !renewed.has(risk(e))));
    for (const e of source.exceptions.filter(e => renewed.has(risk(e)))) {
      expect(e.reviewedAt).toBe(review.reviewedAt);
      expect(e.expiresAt).toBe(review.expiresAt);
      expect(["CVE-2026-107161", "CVE-2026-107778"]).toContain(e.advisoryId);
      expect(e.rationale).toContain("https://security-tracker.debian.org/");
    }
    expect(source.exceptions.some(e => e.packageName === "libexpat1")).toBe(false);
    expect(review.architectures["linux/amd64"]).toEqual(review.architectures["linux/arm64"]);
    expect(Object.keys(review.reviewedAdvisories)).toHaveLength(10);
    for (const e of source.exceptions.filter(isChromium)) {
      const advisory = review.reviewedAdvisories[e.advisoryId]!;
      expect(advisory.supportedStatus).toBe("vulnerable");
      expect(advisory.upstreamFixedVersion).toBe(review.chromiumFixedFloor);
      expect(e.installedVersion).toBe(review.chromiumInstalledVersion);
      expect(e.rationale).toContain(advisory.url);
      expect(e.reviewedAt).toBe(review.reviewedAt);
      expect(e.expiresAt).toBe(review.expiresAt);
      expect(e.unavailableFix).toEqual({architecture: e.unavailableFix!.architecture, distribution: "debian:13",
        availableVersion: review.chromiumInstalledVersion, fixedVersion: review.chromiumFixedFloor});
      const exact = review.architectures[e.unavailableFix!.architecture].filter(t =>
        t[1] === e.advisoryId && t[2] === e.packageName && t[3] === e.installedVersion && t[4] === e.severity);
      expect(exact.length).toBeGreaterThan(0);
      expect(e.observedBy).toEqual([...new Set(exact.map(t => t[0]))].sort());
    }
  });
  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    test(architecture + ": covers every scanner tuple and reproduces all prior failures", () => {
      const prior = evaluateVulnerabilityPolicy(input(architecture, previous));
      expect(prior.failures.map(f => [f.code, ...f.key!.split("\0")])).toEqual(review.previousFailures[architecture]);
      expect(prior.failures).toHaveLength(38);
      const replay = input(architecture), report = evaluateVulnerabilityPolicy(replay);
      expect(report.findings).toHaveLength(168);
      expect(report.passed).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.exceptions.filter(e => !e.unavailableFix || e.unavailableFix.architecture === architecture).every(e => e.used)).toBe(true);
      const chromium = report.findings.filter(isChromium);
      expect(chromium).toHaveLength(30);
      expect(chromium.every(f => !f.fixable && f.fixedVersions === undefined)).toBe(true);
      expect(chromium.some(f => f.severity === "critical")).toBe(true);
      const missing = evaluateVulnerabilityPolicy({...replay, policy: {...replay.policy, exceptions: source.exceptions.filter(e => !isChromium(e))}});
      expect(missing.failures.filter(f => f.code === "unmatched-high-critical")).toHaveLength(30);
      const proof = replay.supportedPackageAvailability!;
      for (const change of [{checkedAt: "2026-10-18T00:00:00Z"}, {signedIndexes: {}},
        {image: {...proof.image, digest: "sha256:" + "f".repeat(64)}},
        {packages: proof.packages.map(p => ({...p, availableVersion: review.chromiumFixedFloor, fixAvailable: true}))},
        {packages: proof.packages.map(p => ({...p, availableVersion: review.chromiumInstalledVersion + ".changed"}))}]) {
        expect(evaluateVulnerabilityPolicy({...replay, supportedPackageAvailability: {...proof,...change}}).passed).toBe(false);
      }
      expect(evaluateVulnerabilityPolicy({...replay, supportedPackageAvailability: undefined}).passed).toBe(false);
      expect(evaluateVulnerabilityPolicy({...replay, evaluatedAt: review.expiresAt}).passed).toBe(false);
    });
  }
});
