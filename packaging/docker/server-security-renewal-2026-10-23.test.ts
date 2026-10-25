import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateExceptionPolicies, type ExceptionPolicySource } from "./check-vulnerability-exception-expiry.ts";
import {
  evaluateVulnerabilityPolicy,
  type EvaluateVulnerabilityPolicyInput,
  type VulnerabilityPolicyExceptionV1,
  type VulnerabilityPolicyV1,
} from "./vulnerability-policy.ts";

type PolicySource = Readonly<{ exceptions: readonly VulnerabilityPolicyExceptionV1[] }>;
type Architecture = "linux/amd64" | "linux/arm64";

const read = (path: string): PolicySource => JSON.parse(readFileSync(join(import.meta.dir, path), "utf8")) as PolicySource;
const beforeServer = read("fixtures/server-policy-before-security-renewal-2026-10-23.json");
const beforeBootstrap = read("fixtures/bootstrap-policy-before-security-renewal-2026-10-23.json");
// Keep this dated renewal test scoped to its original decisions. Later additions
// have their own regression fixtures and must not change the renewal accounting.
const currentServer = { exceptions: read("server-vulnerability-exceptions.input.json").exceptions.filter(entry =>
  beforeServer.exceptions.some(previous => decisionKey(previous) === decisionKey(entry))
) };
const currentBootstrap = read("bootstrap-vulnerability-policy.input.json");

function decisionKey(decision: VulnerabilityPolicyExceptionV1): string {
  return JSON.stringify({
    scannerAuthority: "observedBy" in decision ? decision.observedBy : [decision.scanner],
    advisoryId: decision.advisoryId,
    packageName: decision.packageName,
    installedVersion: decision.installedVersion,
    severity: decision.severity,
    unavailableFix: decision.unavailableFix,
  });
}

function stableDecision(decision: VulnerabilityPolicyExceptionV1): Record<string, unknown> {
  const { reviewedAt: _reviewedAt, expiresAt: _expiresAt, rationale: _rationale, ...stable } = decision;
  return stable;
}

function expirySources(): ExceptionPolicySource[] {
  return [
    { name: "server", path: "server-vulnerability-exceptions.input.json", value: currentServer },
    { name: "bootstrap", path: "bootstrap-vulnerability-policy.input.json", value: currentBootstrap },
  ];
}

function syntheticReplay(
  architecture: Architecture,
  decision: VulnerabilityPolicyExceptionV1,
  installedVersion = decision.installedVersion,
  fixedVersions: readonly string[] = [],
): EvaluateVulnerabilityPolicyInput {
  const digest = `sha256:${"a".repeat(64)}`;
  const reference = `registry.example/nautilo/server@${digest}`;
  const databaseSha = (letter: string) => letter.repeat(64);
  const policy: VulnerabilityPolicyV1 = {
    version: 1,
    binding: {
      image: { digest, reference },
      architecture,
      databases: { grype: databaseSha("b"), trivy: databaseSha("c") },
    },
    exceptions: [decision],
  };
  return {
    policy,
    manifest: {
      version: 1,
      sourceSha: "d".repeat(40),
      dockerfileSha256: `sha256:${"e".repeat(64)}`,
      baseImages: [{ role: "runtime", identity: `registry.example/base@sha256:${"f".repeat(64)}` }],
      architecture,
      image: { digest, reference, sizeBytes: 42 },
      tools: { grype: "synthetic-unit-replay", trivy: "synthetic-unit-replay" },
      databases: [{ name: "grype", identity: "synthetic-unit-replay", version: "1" }],
      capturedAt: "2026-10-23T00:00:00Z",
    },
    databaseIdentity: {
      version: 1,
      databases: {
        grype: { provider: "anchore", schemaVersion: "v6", path: "/tmp/grype.db", sha256: databaseSha("b") },
        trivy: { provider: "aquasecurity", schemaVersion: "2", path: "/tmp/trivy.db", sha256: databaseSha("c") },
      },
    },
    grype: {
      matches: [{
        vulnerability: { id: decision.advisoryId, severity: decision.severity, fix: { versions: fixedVersions } },
        artifact: { name: decision.packageName, version: installedVersion },
      }],
    },
    trivy: { Results: [] },
    evaluatedAt: "2026-10-23T00:00:00Z",
  };
}

describe("October 23 server security renewal", () => {
  test("retires only the 40 Chromium decisions, renews 74 retained decisions, and preserves 10 later decisions", () => {
    const beforeByFamily = [beforeServer, beforeBootstrap] as const;
    const currentByFamily = [currentServer, currentBootstrap] as const;
    const beforeMaps = beforeByFamily.map(source => new Map(source.exceptions.map(decision => [decisionKey(decision), decision])));
    const currentMaps = currentByFamily.map(source => new Map(source.exceptions.map(decision => [decisionKey(decision), decision])));
    const retired = beforeByFamily.flatMap((source, family) =>
      source.exceptions.filter(decision => !currentMaps[family]!.has(decisionKey(decision)))
    );
    const retained = currentByFamily.flatMap((source, family) =>
      source.exceptions.map(decision => [beforeMaps[family]!.get(decisionKey(decision)), decision] as const)
    );
    const renewed = retained.filter(([previous, decision]) =>
      previous !== undefined && (previous.reviewedAt !== decision.reviewedAt || previous.expiresAt !== decision.expiresAt)
    );
    const unchanged = retained.filter(([previous, decision]) => previous !== undefined && JSON.stringify(previous) === JSON.stringify(decision));

    expect(beforeServer.exceptions).toHaveLength(122);
    expect(beforeBootstrap.exceptions).toHaveLength(2);
    expect(currentServer.exceptions).toHaveLength(82);
    expect(currentBootstrap.exceptions).toHaveLength(2);
    expect(currentMaps.map(entries => entries.size)).toEqual([82, 2]);
    expect(retired).toHaveLength(40);
    expect(retired.every(decision =>
      decision.packageName === "chromium-common" || decision.packageName === "chromium-headless-shell"
    )).toBe(true);
    expect(retired.filter(decision => decision.packageName === "chromium-common")).toHaveLength(20);
    expect(retired.filter(decision => decision.packageName === "chromium-headless-shell")).toHaveLength(20);
    expect(retained.every(([previous]) => previous !== undefined)).toBe(true);

    expect(renewed).toHaveLength(74);
    for (const [previous, decision] of renewed) {
      expect(previous).toBeDefined();
      expect(stableDecision(decision)).toEqual(stableDecision(previous!));
      expect(decision.reviewedAt).toBe("2026-10-23T00:00:00Z");
      expect(decision.expiresAt).toBe("2026-12-07T00:00:00Z");
    }

    expect(unchanged).toHaveLength(10);
    expect(unchanged.map(([, decision]) => decision.expiresAt).sort()).toEqual([
      ...Array<string>(8).fill("2026-12-21T00:00:00Z"),
      ...Array<string>(2).fill("2026-12-25T00:00:00Z"),
    ]);
  });

  test("starts the 14-day warning on November 23 and expires only renewed decisions on December 7", () => {
    expect(evaluateExceptionPolicies(expirySources(), "2026-11-22T23:59:59Z", 14)
      .flatMap(result => result.violations)).toEqual([]);

    const warning = evaluateExceptionPolicies(expirySources(), "2026-11-23T00:00:00Z", 14)
      .flatMap(result => result.violations);
    expect(warning).toHaveLength(74);
    expect(warning.every(violation => violation.code === "warning-window" && violation.daysRemaining === 14)).toBe(true);

    const expiry = evaluateExceptionPolicies(expirySources(), "2026-12-07T00:00:00Z", 14)
      .flatMap(result => result.violations);
    expect(expiry.filter(violation => violation.code === "expired")).toHaveLength(74);
    expect(expiry.filter(violation => violation.code === "warning-window")).toHaveLength(8);
  });

  test("keeps exact non-fixable matching and fail-closed fixable and unmatched behavior on both architectures", () => {
    const decision = currentServer.exceptions.find(entry =>
      "observedBy" in entry && entry.observedBy.includes("grype") && entry.unavailableFix === undefined
    );
    expect(decision).toBeDefined();

    for (const architecture of ["linux/amd64", "linux/arm64"] as const) {
      const exact = evaluateVulnerabilityPolicy(syntheticReplay(architecture, decision!));
      expect(exact.failures).toEqual([]);

      const fixable = evaluateVulnerabilityPolicy(syntheticReplay(architecture, decision!, decision!.installedVersion, ["fixed-version"]));
      expect(fixable.failures.map(failure => failure.code)).toContain("fixable-high-critical");

      const unmatched = evaluateVulnerabilityPolicy(syntheticReplay(architecture, decision!, `${decision!.installedVersion}-changed`));
      expect(unmatched.failures.map(failure => failure.code)).toContain("unmatched-high-critical");
    }
  });
});
