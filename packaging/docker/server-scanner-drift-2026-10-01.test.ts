import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, parseVulnerabilityPolicy } from "./vulnerability-policy.ts";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = readonly ["grype" | "trivy", string, string, string, "high" | "critical", false];
const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));
const fixture = read("fixtures/server-scanner-drift-2026-10-01.json") as {
  qualificationRun: number;
  sourceSha: string;
  architectures: Record<Architecture, Tuple[]>;
};
const source = read("server-vulnerability-exceptions.input.json");
const decisions = source.exceptions.filter((entry: { reviewedAt: string }) => entry.reviewedAt === "2026-10-01T20:28:00Z");
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
      capturedAt: "2026-10-01T20:28:00Z",
    },
    databaseIdentity: {
      version: 1,
      databases: {
        grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: binding.databases.grype },
        trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: binding.databases.trivy },
      },
    },
    grype: { matches: tuples.filter(([scanner]) => scanner === "grype").map(([, advisoryId, name, version, severity]) => ({
      vulnerability: { id: advisoryId, severity: severity, fix: { versions: [] } },
      artifact: { name, version },
    })) },
    trivy: { Results: [{ Vulnerabilities: tuples.filter(([scanner]) => scanner === "trivy").map(([, advisoryId, name, version, severity]) => ({
      VulnerabilityID: advisoryId, PkgName: name, InstalledVersion: version, Severity: severity.toUpperCase(), FixedVersion: "",
    })) }] },
    evaluatedAt: "2026-10-01T20:29:00Z",
  });
}

describe("October security package decisions", () => {
  test("covers only the 36 reviewed no-supported-fix or patched-package metadata tuples", () => {
    expect(decisions).toHaveLength(36);
    for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
      const report = evaluate(architecture);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
    }
  });
  test("does not authorize the vulnerable Chromium predecessor", () => {
    const report = evaluate("linux/arm64", f => f[2].startsWith("chromium")
      ? [f[0], f[1], f[2], "154.0.8037.57-1~deb13u1", f[4], false] : f);
    expect(report.failures.map(f => f.code)).toContain("unmatched-high-critical");
  });
  test("ships supported fixes in the runtime projection and invalidates stale apt layers", () => {
    const projected = readFileSync(join(import.meta.dir, "runtime-install/bun.lock"), "utf8");
    expect(projected).toContain('"fastify": ["fastify@5.12.5"');
    expect(projected).not.toContain("fastify@5.11.2");
    expect(decisions.some((e: {packageName: string}) => e.packageName === "fastify")).toBe(false);
    const floors = readFileSync(join(import.meta.dir, "server-security-package-floors.txt"), "utf8");
    for (const pkg of ["chromium-common", "chromium-headless-shell"]) {
      expect(floors).toContain(pkg + " 154.0.8037.92-1~deb13u1");
    }
    const dockerfile = readFileSync(join(import.meta.dir, "Dockerfile"), "utf8");
    expect(dockerfile.indexOf("COPY packaging/docker/server-security-package-floors.txt"))
      .toBeLessThan(dockerfile.lastIndexOf("apt-get update"));
    expect(dockerfile).toContain("sh /tmp/check-security-package-floors.sh");
  });
});
