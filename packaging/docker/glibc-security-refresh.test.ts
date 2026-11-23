import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateVulnerabilityPolicy, type EvaluateVulnerabilityPolicyInput } from "./vulnerability-policy.ts";

const read = (file: string) => JSON.parse(readFileSync(join(import.meta.dir, file), "utf8"));
const fixed = new Set(["CVE-2026-19499", "CVE-2026-5435"]);
const glibc = (entry: { packageName: string }) => ["libc6", "libc-bin"].includes(entry.packageName);
const version = "2.41-12+deb13u5";
// Later Kerberos retirement is covered by kerberos-security-refresh.test.ts.
const retiredKerberos = (entry: { installedVersion: string }) => entry.installedVersion === "1.21.3-5+deb13u1";

test("both image contracts require the supported glibc refresh", () => {
  const bootstrap = readFileSync(join(import.meta.dir, "Dockerfile.bootstrap"), "utf8");
  expect(bootstrap).toContain(`apt-get download libc6=${version}`);
  expect(bootstrap).not.toContain("apt-get download libc6=2.41-12+deb13u4");
  const floors = readFileSync(join(import.meta.dir, "server-security-package-floors.txt"), "utf8");
  for (const name of ["libc6", "libc-bin"]) expect(floors.split("\n")).toContain(`${name} ${version}`);
});

for (const kind of ["server", "bootstrap"] as const) {
  const before = read(`fixtures/${kind}-vulnerability-exceptions-2026-11-22-before-glibc.json`);
  const current = read(kind === "server" ? "server-vulnerability-exceptions.input.json" : "bootstrap-vulnerability-policy.input.json");
  const residual = current.exceptions.filter(glibc);
  test(`${kind}: retires only fixed tuples and preserves unrelated decisions and expiry`, () => {
    expect(current.exceptions.filter((entry: any) => fixed.has(entry.advisoryId) && glibc(entry))).toEqual([]);
    expect(current.exceptions.filter((entry: any) => !glibc(entry) && !retiredKerberos(entry))).toEqual(before.exceptions.filter((entry: any) => !glibc(entry) && !retiredKerberos(entry)));
    expect(before.exceptions.length - current.exceptions.length).toBe((kind === "server" ? 4 : 2) + before.exceptions.filter(retiredKerberos).length);
    expect(residual).toHaveLength(kind === "server" ? 2 : 1);
    for (const entry of residual) {
      const old = before.exceptions.find((item: any) => item.advisoryId === entry.advisoryId && item.packageName === entry.packageName);
      expect(entry.advisoryId).toBe("CVE-2026-84243");
      expect(entry.installedVersion).toBe(version);
      expect(entry.expiresAt).toBe(old.expiresAt);
      expect(entry.severity).toBe(old.severity);
      expect(entry.rationale).toContain("https://security-tracker.debian.org/tracker/CVE-2026-84243");
      expect(entry.rationale).toContain("No platform reachability waiver");
    }
  });
  for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
    const digest = `sha256:${"a".repeat(64)}`;
    const image = { digest, reference: `registry.example/runtime@${digest}`, sizeBytes: 42 };
    const input: EvaluateVulnerabilityPolicyInput = {
      policy: { version: 1, binding: { image: { digest, reference: image.reference }, architecture, databases: { grype: "b".repeat(64), trivy: "c".repeat(64) } }, exceptions: residual },
      manifest: { version: 1, sourceSha: "d".repeat(40), dockerfileSha256: digest, baseImages: [{ role: "runtime", identity: `registry.example/base@${digest}` }], architecture, image, tools: { grype: "synthetic", trivy: "synthetic" }, databases: [{ name: "grype", identity: "synthetic", version: "1" }], capturedAt: "2026-11-22T13:46:00Z" },
      databaseIdentity: { version: 1, databases: { grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: "b".repeat(64) }, trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: "c".repeat(64) } } },
      grype: { matches: residual.map((entry: any) => ({ vulnerability: { id: entry.advisoryId, severity: entry.severity, fix: { versions: [], state: "not-fixed" } }, artifact: { name: entry.packageName, version: entry.installedVersion } })) },
      trivy: { Results: [] }, evaluatedAt: "2026-11-22T13:46:00Z",
    };
    test(`${kind} ${architecture}: exact residual passes; old version, available fix and expiry fail`, () => {
      const result = evaluateVulnerabilityPolicy(input);
      expect(result.passed).toBe(true);
      expect(result.warnings).toEqual([]);
      const old = structuredClone(input);
      for (const match of (old.grype as any).matches) match.artifact.version = "2.41-12+deb13u4";
      expect(evaluateVulnerabilityPolicy(old).passed).toBe(false);
      const patched = structuredClone(input);
      for (const match of (patched.grype as any).matches) match.vulnerability.fix = { versions: ["synthetic-supported-fix"], state: "fixed" };
      expect(evaluateVulnerabilityPolicy(patched).failures.some((failure) => failure.code === "fixable-high-critical")).toBe(true);
      expect(evaluateVulnerabilityPolicy({ ...input, evaluatedAt: residual[0].expiresAt }).passed).toBe(false);
    });
  }
}
