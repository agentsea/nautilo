import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVulnerabilityPolicy, type VulnerabilityPolicyV1 } from "./vulnerability-policy.ts";

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8"));

type FindingTuple = ["grype" | "trivy", string, string, string, "high" | "critical", boolean];

describe("September 16 server scanner inventory", () => {
  test("binds every retained high/critical tuple to its current exact decision", () => {
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
    expect(fixture.decision).toEqual({
      reviewedAt: "2026-09-16T18:45:00Z",
      expiresAt: "2026-10-01T00:00:00Z",
    });
    expect(fixture.findingTuples).toHaveLength(19);
    const retiredAdvisories = new Set(["CVE-2026-91724", "CVE-2026-91727"]);
    for (const [scanner, advisoryId, packageName, installedVersion, severity] of fixture.findingTuples) {
      const matches = parsed.exceptions.filter((entry) =>
        entry.advisoryId === advisoryId
        && entry.packageName === packageName
        && entry.installedVersion === installedVersion
        && entry.severity === severity
        && entry.observedBy.includes(scanner)
      );
      expect(matches).toHaveLength(retiredAdvisories.has(advisoryId) ? 0 : 1);
      if (retiredAdvisories.has(advisoryId)) continue;
      if (advisoryId === "CVE-2026-19499") {
        expect(matches[0]!.reviewedAt).toBe(fixture.decision.reviewedAt);
        expect(matches[0]!.expiresAt).toBe("2026-10-16T00:00:00Z");
      } else {
        expect(matches[0]!.reviewedAt).toBe("2026-09-17T00:00:00Z");
        expect(matches[0]!.expiresAt).toBe("2026-11-15T00:00:00Z");
      }
    }
  });
});
