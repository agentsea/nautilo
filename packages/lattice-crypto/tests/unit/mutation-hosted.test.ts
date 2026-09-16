import { describe, expect, test } from "bun:test";
import type {
  MutationManifest,
  MutationScope,
} from "../../scripts/mutation-governance.ts";
import {
  aggregateHostedMutationEvidence,
  aggregateAvailableHostedMutationEvidence,
  collectHostedMutationArtifacts,
  createHostedMutationMatrix,
  createHostedMutationFailureEvidence,
  selectHostedMutationScope,
} from "../../scripts/mutation-hosted.ts";
import {
  runMutationScopes,
  type MutationEvidenceSummary,
} from "../../scripts/mutation-runner.ts";

const alphaTarget = "src/alpha.ts";
const betaTarget = "src/beta.ts";
const alphaTest = "tests/unit/alpha.test.ts";
const betaTest = "tests/unit/beta.test.ts";
const sources: Readonly<Record<string, string>> = {
  [alphaTarget]: "export const alpha = 1;\n",
  [betaTarget]: "export const beta = 2;\n",
};
const identity = {
  commit: "1236af7d6d19a068333d13b8297ceb3ea0180d0e",
  dirty: false,
};
const ledger = { formatVersion: 1, entries: [] };

function manifest(): MutationManifest {
  return {
    formatVersion: 3,
    minimumKilledPercentage: 80,
    perScopeWorkerBudget: 4,
    hostedMaxParallelScopes: 4,
    scopes: [{
      name: "alpha",
      tier: "critical",
      mutate: [alphaTarget],
      command: `bun test --bail=1 --timeout 60000 ${alphaTest}`,
    }, {
      name: "beta",
      tier: "provider",
      mutate: [betaTarget],
      command: `bun test --bail=1 --timeout 60000 ${betaTest}`,
    }],
    reviewedDuplicateTargets: [],
    reviewedExclusions: [],
  };
}

function killedReport(scope: MutationScope): unknown {
  const target = scope.mutate[0]!;
  return {
    schemaVersion: "1.0",
    framework: { name: "StrykerJS", version: "9.6.1" },
    thresholds: { high: 80, low: 80, break: null },
    config: {
      mutate: [target],
      testRunner: "command",
      commandRunner: { command: scope.command },
      coverageAnalysis: "off",
      ignoreStatic: false,
      incremental: false,
      ignorers: [],
      mutator: { excludedMutations: [] },
      concurrency: 4,
      timeoutMS: 30_000,
      timeoutFactor: 2,
      tempDirName: `.stryker-tmp/${scope.name}`,
      cleanTempDir: "always",
      thresholds: { high: 80, low: 80, break: null },
      jsonReporter: {
        fileName: `reports/mutation/${scope.name}.json`,
      },
    },
    files: {
      [target]: {
        language: "typescript",
        source: sources[target],
        mutants: Array.from({ length: 10 }, (_, index) => ({
          id: String(index),
          mutatorName: "StringLiteral",
          replacement: `replacement-${index}`,
          status: "Killed",
          location: {
            start: { line: 1, column: 22 },
            end: { line: 1, column: 23 },
          },
        })),
      },
    },
  };
}

const readSource = (path: string): string => sources[path]!;
const fileExists = (path: string): boolean =>
  path in sources || path === alphaTest || path === betaTest;

async function scopeEvidence(
  currentManifest: MutationManifest,
  scope: MutationScope,
  report: unknown,
): Promise<MutationEvidenceSummary> {
  return runMutationScopes({
    manifest: currentManifest,
    selectedScopes: [scope],
    ledgerValue: ledger,
    identity,
    partial: true,
  }, {
    executeScope: async () => 0,
    readReport: async () => report,
    readSource,
    fileExists,
    readRevisionIdentity: async () => identity,
  });
}

describe("M229 hosted mutation orchestration", () => {
  test("keeps the monthly workflow aligned with governed hosted limits", async () => {
    const workflow = await Bun.file(
      new URL(
        "../../../../.github/workflows/lattice-mutation-assurance.yml",
        import.meta.url,
      ),
    ).text();
    expect(workflow).toContain("max-parallel: 4");
    expect(workflow).toContain(
      "LATTICE_MUTATION_HOSTED_SCOPE: ${{ matrix.scope }}",
    );
    expect(workflow).toContain(
      "run: bun run --cwd packages/lattice-crypto test:mutation:hosted-aggregate",
    );
    expect(workflow).toContain("lattice-mutation-aggregate:");
    expect(workflow).toContain("if: always()");
  });

  test("derives the complete matrix and explicit aggregate worker ceiling", () => {
    expect(createHostedMutationMatrix(manifest())).toEqual({
      scope: ["alpha", "beta"],
      maxParallelScopes: 4,
      perScopeWorkers: 4,
      maximumHostedWorkers: 16,
    });
  });

  test("selects exactly one governed scope only in trusted GitHub Actions", () => {
    const currentManifest = manifest();
    expect(selectHostedMutationScope(currentManifest, {
      requestedScope: "alpha",
      ci: "true",
      githubActions: "true",
      githubSha: identity.commit,
      identity,
    })).toBe(currentManifest.scopes[0]!);

    for (const invalid of [{
      ci: undefined,
      githubActions: "true",
      githubSha: identity.commit,
    }, {
      ci: "true",
      githubActions: undefined,
      githubSha: identity.commit,
    }, {
      ci: "true",
      githubActions: "true",
      githubSha: "2236af7d6d19a068333d13b8297ceb3ea0180d0e",
    }]) {
      expect(() =>
        selectHostedMutationScope(currentManifest, {
          requestedScope: "alpha",
          ...invalid,
          identity,
        })
      ).toThrow();
    }
    expect(() =>
      selectHostedMutationScope(currentManifest, {
        requestedScope: "missing",
        ci: "true",
        githubActions: "true",
        githubSha: identity.commit,
        identity,
      })
    ).toThrow("Unknown hosted lattice mutation scope");
  });

  test("aggregates exact same-revision scope evidence into the full policy", async () => {
    const currentManifest = manifest();
    const reports = Object.fromEntries(
      currentManifest.scopes.map((scope) => [scope.name, killedReport(scope)]),
    );
    const artifacts = await Promise.all(currentManifest.scopes.map(
      async (scope) => ({
        scopeName: scope.name,
        report: reports[scope.name],
        evidence: await scopeEvidence(
          currentManifest,
          scope,
          reports[scope.name],
        ),
      }),
    ));

    const summary = aggregateHostedMutationEvidence({
      manifest: currentManifest,
      ledgerValue: ledger,
      identity,
      artifacts,
    }, { readSource, fileExists });

    expect(summary).toMatchObject({
      status: "passed",
      policyPassed: true,
      fullScopeComplete: true,
      completedScopes: ["alpha", "beta"],
      revision: identity,
      completionRevision: identity,
    });
  });

  test("fails closed on missing, duplicate, stale, dirty, or corrupt evidence", async () => {
    const currentManifest = manifest();
    const alpha = currentManifest.scopes[0]!;
    const beta = currentManifest.scopes[1]!;
    const alphaReport = killedReport(alpha);
    const betaReport = killedReport(beta);
    const alphaEvidence = await scopeEvidence(
      currentManifest,
      alpha,
      alphaReport,
    );
    const betaEvidence = await scopeEvidence(
      currentManifest,
      beta,
      betaReport,
    );
    const valid = [{
      scopeName: "alpha",
      report: alphaReport,
      evidence: alphaEvidence,
    }, {
      scopeName: "beta",
      report: betaReport,
      evidence: betaEvidence,
    }];

    expect(() =>
      aggregateHostedMutationEvidence({
        manifest: currentManifest,
        ledgerValue: ledger,
        identity,
        artifacts: valid.slice(0, 1),
      }, { readSource, fileExists })
    ).toThrow("missing hosted mutation evidence: beta");
    expect(() =>
      aggregateHostedMutationEvidence({
        manifest: currentManifest,
        ledgerValue: ledger,
        identity,
        artifacts: [valid[0]!, valid[0]!],
      }, { readSource, fileExists })
    ).toThrow("duplicate hosted mutation evidence: alpha");
    expect(() =>
      aggregateHostedMutationEvidence({
        manifest: currentManifest,
        ledgerValue: ledger,
        identity,
        artifacts: [{
          ...valid[0]!,
          evidence: {
            ...alphaEvidence,
            revision: { ...identity, dirty: true },
          },
        }, valid[1]!],
      }, { readSource, fileExists })
    ).toThrow("does not match the aggregate revision");
    expect(() =>
      aggregateHostedMutationEvidence({
        manifest: currentManifest,
        ledgerValue: ledger,
        identity,
        artifacts: [{
          ...valid[0]!,
          evidence: {
            ...alphaEvidence,
            manifestFingerprint: "sha256:stale",
          },
        }, valid[1]!],
      }, { readSource, fileExists })
    ).toThrow("manifest fingerprint is stale");
    expect(() =>
      aggregateHostedMutationEvidence({
        manifest: currentManifest,
        ledgerValue: ledger,
        identity,
        artifacts: [{ ...valid[0]!, evidence: null }, valid[1]!],
      }, { readSource, fileExists })
    ).toThrow("evidence is not an object");
  });

  test("retains deterministic aggregate evidence when a scope artifact is missing", () => {
    const currentManifest = manifest();
    expect(createHostedMutationFailureEvidence({
      manifest: currentManifest,
      identity,
      completedScopes: ["alpha"],
      failure: "hosted mutation aggregation failed: beta report is missing",
    }, { readSource })).toMatchObject({
      status: "failed",
      policyPassed: false,
      fullScopeComplete: false,
      completedScopes: ["alpha"],
      missingScopes: ["beta"],
      failures: [
        "hosted mutation aggregation failed: beta report is missing",
      ],
      maximumHostedWorkers: 16,
      revision: identity,
    });
  });

  test("collects every available scope after an earlier artifact is missing", async () => {
    const currentManifest = manifest();
    const beta = currentManifest.scopes[1]!;
    const betaReport = killedReport(beta);
    const betaEvidence = await scopeEvidence(
      currentManifest,
      beta,
      betaReport,
    );
    const available: Readonly<Record<string, unknown>> = {
      "beta.json": betaReport,
      "beta.evidence.json": betaEvidence,
    };

    const collected = await collectHostedMutationArtifacts(
      currentManifest,
      async (fileName) => {
        if (!(fileName in available)) {
          throw new Error(`missing ${fileName}`);
        }
        return available[fileName];
      },
    );

    expect(collected.artifacts.map((artifact) => artifact.scopeName)).toEqual([
      "beta",
    ]);
    expect(collected.failures).toEqual([
      "alpha report is unavailable or unreadable: missing alpha.json",
      "alpha evidence is unavailable or unreadable: missing alpha.evidence.json",
    ]);

    const summary = aggregateAvailableHostedMutationEvidence({
      manifest: currentManifest,
      ledgerValue: ledger,
      identity,
      artifacts: collected.artifacts,
      failures: collected.failures,
    }, { readSource, fileExists });
    expect(summary).toMatchObject({
      status: "failed",
      policyPassed: false,
      fullScopeComplete: false,
      completedScopes: ["beta"],
      missingScopes: ["alpha"],
      failures: collected.failures,
      scopes: [{ name: "beta", policyPassed: true }],
    });
  });
});
