import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy, type VulnerabilityPolicyV1 } from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = readonly ["grype" | "trivy", string, string, string, "high", boolean, string[]];
const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = read("fixtures/server-scanner-drift-2026-10-03.json") as { architectures: Record<Architecture, Tuple[]> };
const decisions = (read("server-vulnerability-exceptions.input.json") as { exceptions: VulnerabilityPolicyV1["exceptions"] })
  .exceptions.filter(entry => entry.advisoryId === "CVE-2026-95619");
const digest = `sha256:${"a".repeat(64)}`;

function evaluate(architecture: Architecture, tuples: Tuple[], options: {
  decisions?: VulnerabilityPolicyV1["exceptions"];
  evaluatedAt?: string;
} = {}) {
  const binding = {
    image: { digest, reference: `registry.example/runtime@${digest}` }, architecture,
    databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
  };
  return evaluateVulnerabilityPolicy({
    policy: parseVulnerabilityPolicy(JSON.stringify({ version: 1, binding, exceptions: options.decisions ?? decisions })),
    manifest: {
      version: 1, sourceSha: "a".repeat(40), dockerfileSha256: digest,
      baseImages: [{ role: "runtime", identity: `registry.example/base@${digest}` }],
      architecture, image: { ...binding.image, sizeBytes: 42 },
      tools: { grype: "1", trivy: "1" }, databases: [{ name: "grype", identity: "db", version: "1" }],
      capturedAt: "2026-10-03T15:15:00Z",
    },
    databaseIdentity: {
      version: 1,
      databases: {
        grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
        trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
      },
    },
    grype: { matches: tuples.filter(([scanner]) => scanner === "grype").map(([, id, name, version, severity, , versions]) => ({
      vulnerability: { id, severity, fix: { versions } }, artifact: { name, version },
    })) },
    trivy: { Results: [{ Vulnerabilities: tuples.filter(([scanner]) => scanner === "trivy").map(([, id, name, version, severity, , versions]) => ({
      VulnerabilityID: id, PkgName: name, InstalledVersion: version, Severity: severity.toUpperCase(), FixedVersion: versions.join(", "),
    })) }] },
    evaluatedAt: options.evaluatedAt ?? "2026-10-03T15:16:00Z",
  });
}

describe("October multipart remediation and GCC decisions", () => {
  test("pins the available Busboy patch in both dependency closures without suppressions", () => {
    expect(read("../../package.json").overrides["@fastify/busboy"]).toBe("3.2.1");
    expect(read("runtime-install/package.json").overrides["@fastify/busboy"]).toBe("3.2.1");
    for (const path of ["../../bun.lock", "runtime-install/bun.lock"]) {
      const lock = readFileSync(join(import.meta.dir, path), "utf8");
      expect(lock).toContain('"@fastify/busboy": ["@fastify/busboy@3.2.1"');
      expect(lock).not.toContain('"@fastify/busboy@3.2.0"');
    }
    const source = read("server-vulnerability-exceptions.input.json");
    expect(source.exceptions.some((entry: { packageName: string }) => entry.packageName === "@fastify/busboy")).toBe(false);
  });

  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    test(`${architecture}: replay preserves all blockers and only accepts exact unfixed GCC tuples`, () => {
      const tuples = fixture.architectures[architecture];
      expect(tuples).toHaveLength(8);
      const original = evaluate(architecture, tuples, { decisions: [] });
      expect(original.failures).toHaveLength(12);
      const withGccDecisions = evaluate(architecture, tuples);
      expect(withGccDecisions.failures).toHaveLength(8);
      expect(withGccDecisions.failures.filter(f => f.code === "fixable-high-critical")).toHaveLength(4);

      // The next image must remove these Busboy findings by installing its patch.
      // This policy replay alone is not proof of a rebuilt image.
      const gcc = tuples.filter(tuple => tuple[2] !== "@fastify/busboy");
      const accepted = evaluate(architecture, gcc);
      expect(decisions).toHaveLength(4);
      expect(accepted.failures).toEqual([]);
      expect(accepted.warnings).toEqual([]);
      expect(evaluate(architecture, gcc, { evaluatedAt: "2026-10-23T00:00:00Z" }).failures.map(f => f.code))
        .toContain("expired-exception");
      const fixed: Tuple[] = gcc.map(tuple => [tuple[0], tuple[1], tuple[2], tuple[3], tuple[4], true, ["14.2.0-20"]]);
      expect(evaluate(architecture, fixed).failures.map(f => f.code)).toContain("fixable-high-critical");
      const changed: Tuple[] = gcc.map(tuple => [tuple[0], tuple[1], tuple[2], "14.2.0-20", tuple[4], false, []]);
      expect(evaluate(architecture, changed).failures.map(f => f.code)).toContain("unmatched-high-critical");
    });
  }
});
