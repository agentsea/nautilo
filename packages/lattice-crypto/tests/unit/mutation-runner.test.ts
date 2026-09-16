import { describe, expect, test } from "bun:test";
import type {
  MutationManifest,
  MutationScope,
} from "../../scripts/mutation-governance.ts";
import {
  mutationGateExitCode,
  runMutationScopes,
  type ScopeExecution,
} from "../../scripts/mutation-runner.ts";

const alphaTarget = "src/alpha.ts";
const betaTarget = "src/beta.ts";
const alphaTest = "tests/unit/alpha.test.ts";
const betaTest = "tests/unit/beta.test.ts";
const sources: Readonly<Record<string, string>> = {
  [alphaTarget]: "export const alpha = 1;\n",
  [betaTarget]: "export const beta = 2;\n",
};

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

function mutant(
  id: string,
  status: "Killed" | "RuntimeError",
  replacement: string,
) {
  return {
    id,
    mutatorName: "StringLiteral",
    replacement,
    status,
    location: {
      start: { line: 1, column: 22 },
      end: { line: 1, column: 23 },
    },
  };
}

function report(
  scope: MutationScope,
  mutants: readonly Record<string, unknown>[],
) {
  const target = scope.mutate[0]!;
  return {
    schemaVersion: "1.0",
    framework: {
      name: "StrykerJS",
      version: "9.6.1",
    },
    thresholds: {
      high: 80,
      low: 80,
      break: null,
    },
    config: {
      mutate: [target],
      testRunner: "command",
      commandRunner: {
        command: scope.command,
      },
      coverageAnalysis: "off",
      ignoreStatic: false,
      incremental: false,
      ignorers: [],
      mutator: {
        excludedMutations: [],
      },
      concurrency: 4,
      timeoutMS: 30_000,
      timeoutFactor: 2,
      tempDirName: `.stryker-tmp/${scope.name}`,
      cleanTempDir: "always",
      thresholds: {
        high: 80,
        low: 80,
        break: null,
      },
      jsonReporter: {
        fileName: `reports/mutation/${scope.name}.json`,
      },
    },
    files: {
      [target]: {
        language: "typescript",
        source: sources[target],
        mutants,
      },
    },
  };
}

function killedReport(scope: MutationScope) {
  return report(
    scope,
    Array.from(
      { length: 10 },
      (_, index) => mutant(String(index), "Killed", `replacement-${index}`),
    ),
  );
}

function dependencies(
  reports: Readonly<Record<string, unknown>>,
  exitCodes: Readonly<Record<string, number>> = {},
  finalIdentity = identity,
) {
  const executions: ScopeExecution[] = [];
  return {
    executions,
    dependencies: {
      executeScope: async (execution: ScopeExecution): Promise<number> => {
        executions.push(execution);
        return exitCodes[execution.scope.name] ?? 0;
      },
      readReport: async (scope: MutationScope): Promise<unknown> => {
        if (!(scope.name in reports)) {
          throw new Error(`missing fake report ${scope.name}`);
        }
        return reports[scope.name];
      },
      readSource: (path: string): string => sources[path]!,
      fileExists: (path: string): boolean =>
        path in sources || path === alphaTest || path === betaTest,
      readRevisionIdentity: async () => finalIdentity,
    },
  };
}

const ledger = {
  formatVersion: 1,
  entries: [],
};

const identity = {
  commit: "1236af7d6d19a068333d13b8297ceb3ea0180d0e",
  dirty: false,
};

describe("M229 mutation runner", () => {
  test("continues after a policy-red scope and evaluates the complete run", async () => {
    const currentManifest = manifest();
    const alpha = currentManifest.scopes[0]!;
    const beta = currentManifest.scopes[1]!;
    const firstRed = report(alpha, [
      ...Array.from(
        { length: 9 },
        (_, index) => mutant(String(index), "Killed", `replacement-${index}`),
      ),
      mutant("error", "RuntimeError", "broken"),
    ]);
    const { executions, dependencies: fake } = dependencies({
      alpha: firstRed,
      beta: killedReport(beta),
    });

    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity,
      partial: false,
    }, fake);

    expect(executions.map((execution) => execution.scope.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(executions).toEqual([
      {
        scope: alpha,
        workerBudget: 4,
        reportPath: "reports/mutation/alpha.json",
        tempDirectory: ".stryker-tmp/alpha",
      },
      {
        scope: beta,
        workerBudget: 4,
        reportPath: "reports/mutation/beta.json",
        tempDirectory: ".stryker-tmp/beta",
      },
    ]);
    expect(summary).toMatchObject({
      status: "failed",
      policyPassed: false,
      fullScopeComplete: true,
      completedScopes: ["alpha", "beta"],
      revision: identity,
      targetInventory: [alphaTarget, betaTarget],
    });
    expect(summary.manifestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(summary.targetSourceFingerprint).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
  });

  test("fails immediately on a child crash and returns a deterministic summary", async () => {
    const currentManifest = manifest();
    const beta = currentManifest.scopes[1]!;
    const { executions, dependencies: fake } = dependencies({
      alpha: killedReport(currentManifest.scopes[0]!),
      beta: killedReport(beta),
    }, {
      alpha: 2,
    });

    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity,
      partial: false,
    }, fake);

    expect(summary).toMatchObject({
      status: "failed",
      policyPassed: false,
      fullScopeComplete: false,
      completedScopes: [],
      missingScopes: ["alpha", "beta"],
      failures: ["mutation scope alpha crashed with exit code 2"],
    });
    expect(executions).toHaveLength(1);
  });

  test("fails closed with evidence on a missing or corrupt scope report", async () => {
    const currentManifest = manifest();
    for (const reports of [
      {},
      { alpha: { schemaVersion: "broken" } },
    ]) {
      const { dependencies: fake } = dependencies(reports);
      const summary = await runMutationScopes({
        manifest: currentManifest,
        selectedScopes: [currentManifest.scopes[0]!],
        ledgerValue: ledger,
        identity,
        partial: true,
      }, fake);
      expect(summary).toMatchObject({
        status: "failed",
        policyPassed: false,
        fullScopeComplete: false,
        completedScopes: [],
        missingScopes: ["alpha", "beta"],
      });
      expect(summary.failures[0]).toMatch(
        /^mutation scope alpha (report unavailable or unreadable|failed policy validation:)/u,
      );
    }
  });

  test("marks an exact focused run partial and never as the full gate", async () => {
    const currentManifest = manifest();
    const alpha = currentManifest.scopes[0]!;
    const focusedIdentity = { ...identity, dirty: true };
    const { dependencies: fake } = dependencies(
      { alpha: killedReport(alpha) },
      {},
      focusedIdentity,
    );

    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: [alpha],
      ledgerValue: ledger,
      identity: focusedIdentity,
      partial: true,
    }, fake);

    expect(summary).toMatchObject({
      status: "partial",
      policyPassed: true,
      fullScopeComplete: false,
      completedScopes: ["alpha"],
      missingScopes: ["beta"],
      revision: focusedIdentity,
    });
  });

  test("does not accept a dirty full run as release evidence", async () => {
    const currentManifest = manifest();
    const reports = {
      alpha: killedReport(currentManifest.scopes[0]!),
      beta: killedReport(currentManifest.scopes[1]!),
    };
    const dirtyIdentity = { ...identity, dirty: true };
    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity: dirtyIdentity,
      partial: false,
    }, dependencies(reports, {}, dirtyIdentity).dependencies);

    expect(summary).toMatchObject({
      status: "failed",
      policyPassed: false,
      fullScopeComplete: true,
      failures: ["full mutation run source tree is dirty"],
    });
  });

  test("fails closed when revision identity changes during execution", async () => {
    const currentManifest = manifest();
    const reports = {
      alpha: killedReport(currentManifest.scopes[0]!),
      beta: killedReport(currentManifest.scopes[1]!),
    };
    const finalIdentity = {
      commit: "2236af7d6d19a068333d13b8297ceb3ea0180d0e",
      dirty: false,
    };
    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity,
      partial: false,
    }, dependencies(reports, {}, finalIdentity).dependencies);

    expect(summary).toMatchObject({
      status: "failed",
      policyPassed: false,
      revision: identity,
      completionRevision: finalIdentity,
    });
    expect(summary.failures).toContain(
      "mutation revision identity changed during execution",
    );
  });

  test("fails closed when target bytes change during execution", async () => {
    const currentManifest = manifest();
    const reports = {
      alpha: killedReport(currentManifest.scopes[0]!),
      beta: killedReport(currentManifest.scopes[1]!),
    };
    const fake = dependencies(reports).dependencies;
    let sourceReads = 0;
    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity,
      partial: false,
    }, {
      ...fake,
      readSource: (path): string => {
        sourceReads += 1;
        const original = sources[path]!;
        return sourceReads > 6 ? `${original}// changed\n` : original;
      },
    });

    expect(summary).toMatchObject({
      status: "failed",
      policyPassed: false,
      revision: identity,
      completionRevision: identity,
    });
    expect(summary.targetSourceFingerprint).not.toBe(
      summary.completionTargetSourceFingerprint,
    );
    expect(summary.failures).toContain(
      "mutation target source changed during execution",
    );
  });

  test("focused policy-red evidence exits nonzero while remaining partial", async () => {
    const currentManifest = manifest();
    const alpha = currentManifest.scopes[0]!;
    const redReport = report(alpha, [
      ...Array.from(
        { length: 9 },
        (_, index) => mutant(String(index), "Killed", `replacement-${index}`),
      ),
      mutant("error", "RuntimeError", "broken"),
    ]);
    const summary = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: [alpha],
      ledgerValue: ledger,
      identity,
      partial: true,
    }, dependencies({ alpha: redReport }).dependencies);

    expect(summary.status).toBe("partial");
    expect(summary.policyPassed).toBe(false);
    expect(mutationGateExitCode(summary)).toBe(1);
  });

  test("produces byte-stable summaries from identical evidence", async () => {
    const currentManifest = manifest();
    const reports = {
      alpha: killedReport(currentManifest.scopes[0]!),
      beta: killedReport(currentManifest.scopes[1]!),
    };
    const first = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity,
      partial: false,
    }, dependencies(reports).dependencies);
    const second = await runMutationScopes({
      manifest: currentManifest,
      selectedScopes: currentManifest.scopes,
      ledgerValue: ledger,
      identity,
      partial: false,
    }, dependencies(reports).dependencies);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain(
      "/Users/tester/Projects",
    );
  });
});
