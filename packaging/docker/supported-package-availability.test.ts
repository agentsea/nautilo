import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectSupportedPackageAvailability, SUPPORTED_PACKAGE_PROBE, type SupportedPackageAvailability } from "./supported-package-availability.ts";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput } from "./vulnerability-policy.ts";

const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = read("fixtures/arm64-chromium-availability-2026-10-01.json");
const decisions = read("server-vulnerability-exceptions.input.json").exceptions.filter((e: {unavailableFix?: unknown}) => e.unavailableFix);
const digest = "sha256:" + "a".repeat(64);
const image = {digest, reference: "registry.example/runtime@" + digest, sizeBytes: 42};
const now = "2026-10-01T21:40:00Z";
const manifest: EvaluateVulnerabilityPolicyInput["manifest"] = {
  version: 1, sourceSha: "b".repeat(40), dockerfileSha256: digest,
  baseImages: [{role: "runtime", identity: "registry.example/base@" + digest}],
  architecture: "linux/arm64", image, capturedAt: now, tools: {grype: "1", trivy: "1"},
  databases: [{name: "grype", identity: "db", version: "1"}],
};
function availability(): SupportedPackageAvailability {
  return {image, architecture: "linux/arm64", distribution: "debian:13", checkedAt: now, verifiedBy: "apt-secure",
    signedIndexes: {"trixie": "d".repeat(64), "trixie-updates": "e".repeat(64), "trixie-security": "f".repeat(64)},
    packages: ["chromium-common", "chromium-headless-shell"].map(packageName => ({
      packageName, installedVersion: "154.0.8037.57-1~deb13u1",
      availableVersion: "154.0.8037.57-1~deb13u1", fixedVersion: fixture.fixedVersion, fixAvailable: false,
    }))};
}
function input(): EvaluateVulnerabilityPolicyInput {
  return {manifest, evaluatedAt: now, supportedPackageAvailability: availability(),
    policy: parseVulnerabilityPolicy(JSON.stringify({version: 1, exceptions: decisions, binding: {
      image: {digest, reference: image.reference}, architecture: manifest.architecture, databases: {grype: "b".repeat(64), trivy: "c".repeat(64)},
    }})),
    databaseIdentity: {version: 1, databases: {
      grype: {provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: "b".repeat(64)},
      trivy: {provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: "c".repeat(64)},
    }},
    grype: {matches: fixture.findingTuples.filter((f: string[]) => f[0] === "grype").map((f: (string|boolean)[]) => ({
      vulnerability: {id: f[1], severity: f[4], fix: {versions: f[5] ? [fixture.fixedVersion] : []}},
      artifact: {name: f[2], version: f[3]},
    }))},
    trivy: {Results: [{Vulnerabilities: fixture.findingTuples.filter((f: string[]) => f[0] === "trivy").map((f: (string|boolean)[]) => ({
      VulnerabilityID: f[1], PkgName: f[2], InstalledVersion: f[3], Severity: f[4], FixedVersion: f[5] ? fixture.fixedVersion : "",
    }))}]},
  };
}
const probeOutput = () => [
  ...Object.entries(availability().signedIndexes).map(([suite, hash]) => "index " + suite + " " + hash),
  ...availability().packages.map(p => ["package", p.packageName, p.installedVersion, p.availableVersion, p.fixedVersion, p.fixAvailable].join(" ")),
].join("\n");

describe("architecture-specific supported binary availability", () => {
  test("replays all 54 raw findings with exactly 42 bounded ARM64 decisions", () => {
    const report = evaluateVulnerabilityPolicy(input());
    expect(decisions).toHaveLength(42);
    expect(report.findings).toHaveLength(54);
    expect(report.findings.filter(f => f.fixable)).toHaveLength(22);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.exceptions.every(e => e.used)).toBe(true);
  });
  test("an available patched binary blocks even scanner findings that claim no fix", () => {
    const evidence = availability();
    const packages = evidence.packages.map(p => ({...p, availableVersion: fixture.fixedVersion, fixAvailable: true}));
    const report = evaluateVulnerabilityPolicy({...input(), supportedPackageAvailability: {...evidence, packages}});
    expect(report.passed).toBe(false);
    expect(report.failures.filter(f => f.code === "unmatched-high-critical")).toHaveLength(54);
    expect(report.failures.filter(f => f.code === "fixable-high-critical")).toHaveLength(22);
  });
  test("wrong architecture, image, freshness, signed metadata or incomplete package proof fails closed", () => {
    const mutations = [
      (e: SupportedPackageAvailability) => ({...e, architecture: "linux/amd64" as const}),
      (e: SupportedPackageAvailability) => ({...e, image: {...image, digest: "sha256:" + "9".repeat(64)}}),
      (e: SupportedPackageAvailability) => ({...e, checkedAt: "2026-09-30T21:40:00Z"}),
      (e: SupportedPackageAvailability) => ({...e, signedIndexes: {}}),
      (e: SupportedPackageAvailability) => ({...e, packages: []}),
    ];
    for (const mutate of mutations) expect(evaluateVulnerabilityPolicy({...input(), supportedPackageAvailability: mutate(availability())}).passed).toBe(false);
    expect(evaluateVulnerabilityPolicy({...input(), supportedPackageAvailability: undefined}).passed).toBe(false);
    const original = input();
    expect(evaluateVulnerabilityPolicy({...original, manifest: {...manifest, architecture: "linux/amd64"},
      policy: {...original.policy, binding: {...original.policy.binding, architecture: "linux/amd64"}}}).passed).toBe(false);
  });
  test("expiry, changed advisory/version/severity, and a different fixed threshold cannot match", () => {
    const original = input();
    expect(evaluateVulnerabilityPolicy({...original, evaluatedAt: decisions[0].expiresAt}).failures.some(f => f.code === "expired-exception")).toBe(true);
    for (const field of ["advisoryId", "installedVersion", "severity"] as const) {
      const exceptions = decisions.map((e: Record<string, unknown>) => ({...e, [field]: field === "severity" ? (e.severity === "high" ? "critical" : "high") : e[field] + "-changed"}));
      expect(evaluateVulnerabilityPolicy({...original, policy: {...original.policy, exceptions}}).passed).toBe(false);
    }
    const trivy = {Results: [{Vulnerabilities: [{VulnerabilityID: decisions[0].advisoryId, PkgName: decisions[0].packageName,
      InstalledVersion: decisions[0].installedVersion, Severity: decisions[0].severity, FixedVersion: "155.0.0-1"}]}]};
    expect(evaluateVulnerabilityPolicy({...original, trivy}).failures.some(f => f.code === "fixable-high-critical")).toBe(true);
  });
  test("collects authenticated indexes on the exact immutable native image without production mounts or installation", async () => {
    const result = await collectSupportedPackageAvailability(manifest, decisions.map((e: typeof decisions[number]) => ({
      packageName: e.packageName, installedVersion: e.installedVersion, unavailableFix: e.unavailableFix,
    })), async (command, args) => {
      expect(command).toBe("docker");
      expect(args).toContain(image.reference);
      expect(args).toContain("--read-only");
      expect(args[args.indexOf("--platform") + 1]).toBe("linux/arm64");
      expect(args).not.toContain("--env-file");
      expect(args).not.toContain("--volume");
      expect(SUPPORTED_PACKAGE_PROBE).toContain("Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg");
      expect(SUPPORTED_PACKAGE_PROBE).toContain("APT::Update::Error-Mode=any");
      expect(SUPPORTED_PACKAGE_PROBE).toContain("AllowInsecureRepositories=false");
      expect(SUPPORTED_PACKAGE_PROBE).not.toContain(" install ");
      expect(SUPPORTED_PACKAGE_PROBE).toContain('${Version}');
      return {exitCode: 0, stdout: probeOutput(), stderr: ""};
    });
    expect(result.packages).toEqual(availability().packages);
    expect(result.signedIndexes).toEqual(availability().signedIndexes);
  });
  test("authentication failures or incomplete/malformed probe results never yield an exception", async () => {
    for (const result of [
      {exitCode: 1, stdout: probeOutput(), stderr: "signature verification failed"},
      {exitCode: 0, stdout: probeOutput().split("\n").slice(1).join("\n"), stderr: ""},
      {exitCode: 0, stdout: probeOutput() + "\ninvalid", stderr: ""},
      {exitCode: 0, stdout: probeOutput() + "\n" + probeOutput().split("\n")[0], stderr: ""},
    ]) await expect(collectSupportedPackageAvailability(manifest, decisions, async () => result)).rejects.toThrow();
  });
});
