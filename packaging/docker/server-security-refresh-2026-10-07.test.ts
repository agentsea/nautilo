import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput, type VulnerabilityPolicyV1 } from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean, string[]];
const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = read("fixtures/server-security-refresh-2026-10-07.json") as {
  architectures: Record<Architecture, Tuple[]>; upstreamFixes: Record<string, string>;
};
const current = read("server-vulnerability-exceptions.input.json") as {exceptions: VulnerabilityPolicyV1["exceptions"]};
const retired = read("fixtures/server-policy-before-retirement-2026-10-07.json") as typeof current;
const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-10-07T09:45:00Z";
const key = (e: {advisoryId: string; packageName: string; installedVersion: string; severity: string}) =>
  [e.advisoryId, e.packageName, e.installedVersion, e.severity].join("\0");

function input(architecture: Architecture, patched = false): EvaluateVulnerabilityPolicyInput {
  const image = {digest, reference: `registry.example/runtime@${digest}`};
  const binding = {image, architecture, databases: {grype: "b".repeat(64), trivy: "c".repeat(64)}};
  const tuples = fixture.architectures[architecture].filter(t => !patched || !["@modelcontextprotocol/sdk", "sharp"].includes(t[2]));
  const thresholds = [...new Set(Object.values(fixture.upstreamFixes))];
  return {
    policy: parseVulnerabilityPolicy(JSON.stringify({version: 1, binding, exceptions: current.exceptions})),
    manifest: {version: 1, sourceSha: "a".repeat(40), dockerfileSha256: digest,
      baseImages: [{role: "runtime", identity: `registry.example/base@${digest}`}], architecture,
      image: {...image, sizeBytes: 42}, tools: {grype: "1", trivy: "1"},
      databases: [{name: "grype", identity: "db", version: "1"}], capturedAt: now},
    databaseIdentity: {version: 1, databases: {
      grype: {provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype},
      trivy: {provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy},
    }},
    grype: {matches: tuples.filter(t => t[0] === "grype").map(([,id,name,version,severity,,versions]) => ({
      vulnerability: {id,severity,fix:{versions}}, artifact:{name,version},
    }))},
    trivy: {Results: [{Vulnerabilities: tuples.filter(t => t[0] === "trivy").map(([,id,name,version,severity,,versions]) => ({
      VulnerabilityID:id,PkgName:name,InstalledVersion:version,Severity:severity,FixedVersion:versions.join(", "),
    }))}]},
    supportedPackageAvailability: {image:{...image,sizeBytes:42}, architecture, distribution:"debian:13",
      checkedAt:now, verifiedBy:"apt-secure", signedIndexes:{trixie:"d".repeat(64),"trixie-updates":"e".repeat(64),"trixie-security":"f".repeat(64)},
      packages: thresholds.flatMap(fixedVersion => ["chromium-common","chromium-headless-shell"].map(packageName => ({
        packageName,installedVersion:"154.0.8037.92-1~deb13u1",availableVersion:"154.0.8037.92-1~deb13u1",fixedVersion,fixAvailable:false,
      }))),
    }, evaluatedAt:now,
  };
}

describe("patched runtime libraries and supported Chromium availability", () => {
  test("keeps the complete native scanner inventories identical", () => {
    expect(fixture.architectures["linux/amd64"]).toEqual(fixture.architectures["linux/arm64"]);
    expect(fixture.architectures["linux/amd64"]).toHaveLength(328);
    expect(Object.keys(fixture.upstreamFixes)).toHaveLength(91);
    expect(new Set(Object.values(fixture.upstreamFixes))).toEqual(new Set(["154.0.8037.97","155.0.8059.39"]));
  });
  test("ships supported patches without package exceptions", () => {
    for (const path of ["../../packages/mcp-client/package.json","../../packages/claude-agent-sdk-host/package.json"])
      expect(read(path).dependencies["@modelcontextprotocol/sdk"]).toBe("1.31.0");
    for (const path of ["../../packages/server/package.json","../../apps/desktop/package.json"])
      expect(read(path).dependencies.sharp).toBe("0.35.5");
    for (const path of ["../../bun.lock","runtime-install/bun.lock"]) {
      const lock = readFileSync(join(import.meta.dir,path),"utf8");
      expect(lock).toContain("@modelcontextprotocol/sdk@1.31.0");
      expect(lock).toContain("sharp@0.35.5");
      expect(lock).not.toContain("@modelcontextprotocol/sdk@1.30.0");
      expect(lock).not.toContain("sharp@0.35.4");
    }
    expect(current.exceptions.some(e => ["sharp","@modelcontextprotocol/sdk"].includes(e.packageName))).toBe(false);
  });
  for (const architecture of ["linux/amd64","linux/arm64"] as const) {
    test(`${architecture}: available patches remain blocking until installed`, () => {
      const report = evaluateVulnerabilityPolicy(input(architecture));
      expect(report.passed).toBe(false);
      expect(report.failures.filter(f => f.code === "fixable-high-critical")).toHaveLength(4);
      expect(report.failures.filter(f => f.code === "unmatched-high-critical")).toHaveLength(4);
      expect(report.warnings).toEqual([]);
    });
    test(`${architecture}: remediated replay has no unmatched or unused decisions`, () => {
      const replay = input(architecture,true);
      const report = evaluateVulnerabilityPolicy(replay);
      expect(report.passed).toBe(true);
      expect(report.findings).toHaveLength(324);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      const active = current.exceptions.filter(e => !e.unavailableFix || e.unavailableFix.architecture === architecture);
      expect(report.exceptions.filter(e => e.used)).toHaveLength(active.length);
      const currentKeys = new Set(current.exceptions.map(key));
      for (const decision of retired.exceptions.filter(e => !currentKeys.has(key(e))))
        expect(report.findings.some(f => key(f) === key(decision))).toBe(false);
      const missing = evaluateVulnerabilityPolicy({...replay,supportedPackageAvailability:undefined});
      expect(missing.passed).toBe(false);
      const available = replay.supportedPackageAvailability!;
      const fixed = evaluateVulnerabilityPolicy({...replay,supportedPackageAvailability:{...available,
        packages:available.packages.map(p => ({...p,availableVersion:p.fixedVersion,fixAvailable:true})),
      }});
      expect(fixed.failures.filter(f => f.code === "unmatched-high-critical")).toHaveLength(184);
      expect(evaluateVulnerabilityPolicy({...replay,evaluatedAt:"2026-10-23T00:00:00Z"}).passed).toBe(false);
      for (const change of [{architecture:"linux/amd64" as const},{checkedAt:"2026-10-06T10:00:00Z"},{signedIndexes:{}}]) {
        if (change.architecture === architecture) continue;
        expect(evaluateVulnerabilityPolicy({...replay,supportedPackageAvailability:{...available,...change}}).passed).toBe(false);
      }
    });
  }
});
