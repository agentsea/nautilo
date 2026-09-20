import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateVulnerabilityPolicy,
  type VulnerabilityPolicyV1,
} from "./vulnerability-policy.ts";

const digest = `sha256:${"a".repeat(64)}`;
const databaseSha = (letter: string) => letter.repeat(64);

describe("Chromium 153 vulnerability exceptions", () => {
  test("matches only the 14 reviewed finding identities", () => {
    const source = JSON.parse(readFileSync(join(import.meta.dir, "server-vulnerability-exceptions.input.json"), "utf8")) as {
      exceptions: VulnerabilityPolicyV1["exceptions"];
    };
    const reviewed = source.exceptions.filter((entry) =>
      /^CVE-2026-933(?:72|73|74|75|77|81|82)$/.test(entry.advisoryId)
    );
    const matches = reviewed.map((entry) => ({
      vulnerability: {
        id: entry.advisoryId,
        severity: entry.severity === "critical" ? "Critical" : "High",
        fix: { versions: [] },
      },
      artifact: { name: entry.packageName, version: entry.installedVersion },
    }));
    const policy: VulnerabilityPolicyV1 = {
      version: 1,
      binding: {
        image: { digest, reference: `registry.example/nautilo/server@${digest}` },
        architecture: "linux/arm64",
        databases: { grype: databaseSha("b"), trivy: databaseSha("c") },
      },
      exceptions: reviewed,
    };
    const manifest = {
      version: 1 as const,
      sourceSha: "d".repeat(40),
      dockerfileSha256: `sha256:${"e".repeat(64)}`,
      baseImages: [{ role: "runtime", identity: `registry.example/base@sha256:${"f".repeat(64)}` }],
      architecture: "linux/arm64" as const,
      image: { digest, reference: `registry.example/nautilo/server@${digest}`, sizeBytes: 42 },
      tools: { grype: "1", trivy: "1" },
      databases: [{ name: "grype", identity: "db", version: "1" }],
      capturedAt: "2026-09-20T16:12:15Z",
    };
    const input = {
      policy,
      manifest,
      databaseIdentity: {
        version: 1 as const,
        databases: {
          grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: databaseSha("b") },
          trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: databaseSha("c") },
        },
      },
      grype: { matches },
      trivy: { Results: [] },
      evaluatedAt: "2026-09-20T16:12:15Z",
    };

    const report = evaluateVulnerabilityPolicy(input);
    expect(reviewed).toHaveLength(14);
    expect(report.passed).toBe(true);
    expect(report.findings).toHaveLength(14);
    expect(report.exceptions.every((entry) => entry.used)).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);

    const changedVersion = structuredClone(matches);
    changedVersion[0]!.artifact.version = "153.0.8010.47-2~deb13u1";
    const broadened = evaluateVulnerabilityPolicy({ ...input, grype: { matches: changedVersion } });
    expect(broadened.passed).toBe(false);
    expect(broadened.failures.map((failure) => failure.code)).toEqual(["unmatched-high-critical"]);
  });
});
