import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVulnerabilityPolicy, type VulnerabilityPolicyV1 } from "./vulnerability-policy.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));

type FindingTuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean];

describe("September 16 server scanner inventory", () => {
  test("binds every new high/critical tuple exactly without wildcarding", () => {
    const fixture = readJson("fixtures/server-security-inventory-2026-09-16.json") as {
      workflowRunId: number;
      sourceSha: string;
      architecture: string;
      findingTuples: FindingTuple[];
      decision: { reviewedAt: string; expiresAt: string };
    };
    const source = readJson("server-vulnerability-exceptions.input.json") as Pick<VulnerabilityPolicyV1, "exceptions">;
    const parsed = parseVulnerabilityPolicy(JSON.stringify({
      version: 1,
      ...source,
      binding: {
        image: { digest: `sha256:${"a".repeat(64)}`, reference: `registry.example/runtime@sha256:${"a".repeat(64)}` },
        architecture: fixture.architecture,
        databases: { grype: "b".repeat(64), trivy: "c".repeat(64) },
      },
    }));

    expect(fixture.workflowRunId).toBe(35135410942);
    expect(fixture.sourceSha).toBe("aa110c48e4da843c543791252f9bd304dc2b585d");
    expect(fixture.findingTuples).toHaveLength(19);
    for (const [scanner, advisoryId, packageName, installedVersion, severity] of fixture.findingTuples) {
      const matches = parsed.exceptions.filter((entry) =>
        entry.advisoryId === advisoryId
        && entry.packageName === packageName
        && entry.installedVersion === installedVersion
        && entry.severity === severity
        && entry.observedBy.includes(scanner)
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]!.reviewedAt).toBe(fixture.decision.reviewedAt);
      if (advisoryId !== "CVE-2026-19499") expect(matches[0]!.expiresAt).toBe(fixture.decision.expiresAt);
    }
  });
});
