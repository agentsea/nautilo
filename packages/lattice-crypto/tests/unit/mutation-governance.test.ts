import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCompleteMutationCoverage,
  assertNoMutationSuppression,
  parseMutationManifest,
  selectMutationScopes,
  selectMutationTarget,
} from "../../scripts/mutation-governance.ts";
import {
  deriveMutationSourceInventory,
  derivePackageTypeScriptSourceInventory,
} from
  "../../scripts/mutation-source-inventory.ts";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 3,
    minimumKilledPercentage: 80,
    perScopeWorkerBudget: 4,
    hostedMaxParallelScopes: 4,
    scopes: [{
      name: "alpha",
      tier: "critical",
      mutate: ["src/alpha.ts"],
      command: "bun test --bail=1 --timeout 60000 tests/unit/alpha.test.ts",
    }, {
      name: "beta",
      tier: "provider",
      mutate: ["src/beta.ts"],
      command: "bun test --bail=1 --timeout 60000 tests/integration/beta.test.ts",
    }],
    reviewedDuplicateTargets: [],
    reviewedExclusions: [{
      target: "src/excluded.ts",
      reason: "Binary-backed implementation is covered outside mutation testing.",
      compensatingCommands: ["test:integration"],
      compensatingTests: ["tests/integration/excluded.test.ts"],
    }],
    ...overrides,
  };
}

const existingFiles = new Set([
  "src/alpha.ts",
  "src/beta.ts",
  "src/excluded.ts",
  "tests/unit/alpha.test.ts",
  "tests/integration/beta.test.ts",
  "tests/integration/excluded.test.ts",
]);

function parse(value: unknown) {
  return parseMutationManifest(value, {
    fileExists: (path) => existingFiles.has(path),
  });
}

describe("M229 mutation governance", () => {
  test("lets repository tooling inspect an inert config without mutation environment", async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        !key.startsWith("LATTICE_MUTATION_")
      ),
    );
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        [
          'import config from "./stryker.config.mjs";',
          "console.log(JSON.stringify({",
          "  mutate: config.mutate,",
          "  command: config.commandRunner.command,",
          "  ignoreStatic: config.ignoreStatic,",
          "  incremental: config.incremental,",
          "  ignorers: config.ignorers,",
          "  excludedMutations: config.mutator.excludedMutations,",
          "  timeoutMS: config.timeoutMS,",
          "  timeoutFactor: config.timeoutFactor,",
          "}));",
        ].join("\n"),
      ],
      cwd: new URL("../..", import.meta.url).pathname,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      mutate: ["__LATTICE_MUTATION_ENVIRONMENT_REQUIRED__"],
      command: "exit 1",
      ignoreStatic: false,
      incremental: false,
      ignorers: [],
      excludedMutations: [],
      timeoutMS: 30_000,
      timeoutFactor: 2,
    });
  });

  test("rejects inline mutation suppression across every package source", () => {
    expect(() =>
      assertNoMutationSuppression([{
        path: "src/example.ts",
        source: "// Stryker disable next-line BlockStatement\ncleanup();\n",
      }])
    ).toThrow(
      "inline Stryker suppression is forbidden: src/example.ts:1",
    );

    const packageRoot = new URL("../..", import.meta.url).pathname;
    const packageSources = derivePackageTypeScriptSourceInventory(packageRoot)
      .map((path) => ({
        path,
        source: Bun.file(new URL(`../../${path}`, import.meta.url))
          .text(),
      }));
    return Promise.all(
      packageSources.map(async ({ path, source }) => ({
        path,
        source: await source,
      })),
    ).then((sources) => {
      expect(() => assertNoMutationSuppression(sources)).not.toThrow();
    });
  });

  test("accepts the checked-in mutation manifest and its complete file inventory", async () => {
    const value: unknown = await Bun.file(
      new URL("../../scripts/mutation-scopes.json", import.meta.url),
    ).json();
    const parsed = parseMutationManifest(value, {
      fileExists: (path) =>
        existsSync(new URL(`../../${path}`, import.meta.url)),
    });
    const eligible = deriveMutationSourceInventory(
      new URL("../..", import.meta.url).pathname,
    );
    expect(parsed.scopes).toHaveLength(30);
    expect(eligible).toHaveLength(127);
    expect(parsed.scopes.filter((scope) =>
      scope.name.startsWith("background-")
    ).map((scope) => ({
      name: scope.name,
      targets: scope.mutate,
    }))).toEqual([{
      name: "background-grant-response",
      targets: [
        "src/background/agent-background-grant-response-v1.ts",
        "src/background/agent-background-grant-response-v2.ts",
        "src/background/background-authorization-response-v1.ts",
      ],
    }, {
      name: "background-credential",
      targets: [
        "src/background/processor-credential-secret-v1.ts",
        "src/background/processor-credential-v1.ts",
        "src/background/processor-signer-authorization-v1.ts",
        "src/background/processor-authorization-v2.ts",
      ],
    }, {
      name: "background-transform",
      targets: [
        "src/background/one-run-processor-transform-v1.ts",
        "src/background/processor-object-signer-v1.ts",
        "src/background/one-run-processor-transform-v2.ts",
        "src/background/publication-reconciliation-v2.ts",
        "src/background/output-repair-v2.ts",
        "src/background/reflection-authority-reprojection-v2.ts",
      ],
    }, {
      name: "background-task-recipient",
      targets: [
        "src/background/task-runtime-recipient-registry-v1.ts",
      ],
    }, {
      name: "background-work-manifest",
      targets: [
        "src/background/work-descriptor-v1.ts",
        "src/background/work-descriptor-v2.ts",
        "src/format/object-access-manifest-v4.ts",
      ],
    }]);
    expect(parsed.scopes.filter((scope) =>
      scope.name.startsWith("storage-")
    ).map((scope) => ({
      command: scope.command,
      name: scope.name,
      targets: scope.mutate,
    }))).toEqual([{
      command: "bun test --bail=1 --timeout 60000 tests/unit/storage-v2.test.ts tests/integration/human-object-access-storage-coordinator.test.ts tests/integration/object-v2-storage-coordinator.test.ts tests/integration/agent-object-access-storage-coordinator.test.ts",
      name: "storage-in-memory-cas",
      targets: ["src/storage/in-memory-v2-store.ts"],
    }, {
      command: "bun test --bail=1 --timeout 60000 tests/unit/storage-v2.test.ts tests/integration/storage-adapter-support.test.ts",
      name: "storage-adapter-support",
      targets: ["src/storage/v2-adapter-support.ts"],
    }, {
      command: "bun test --bail=1 --timeout 60000 tests/unit/storage-v2.test.ts tests/integration/storage-adapter-support.test.ts tests/integration/object-v2-storage-coordinator.test.ts tests/integration/agent-object-access-storage-coordinator.test.ts",
      name: "storage-record-policy",
      targets: ["src/storage/v2-record-policy.ts"],
    }]);
    expect(() =>
      assertCompleteMutationCoverage(parsed, eligible)
    ).not.toThrow();
  });

  test("derives only runtime-reachable implementation modules", () => {
    const packageRoot = mkdtempSync(
      join(tmpdir(), "lattice-mutation-inventory-"),
    );
    try {
      mkdirSync(join(packageRoot, "src/group"), { recursive: true });
      const write = (path: string, source: string): void => {
        writeFileSync(join(packageRoot, path), source);
      };
      write("src/index.ts", `
        export { runtimeValue } from "./runtime-barrel.ts";
        export type { TypeOnly } from "./type-only-target.ts";
        import type { ImportedOnly } from "./import-type-target.ts";
        import { type MixedType, mixedValue } from "./mixed-target.ts";
        export { mixedValue };
        export type { ImportedOnly, MixedType };
        export { outsideValue } from "../outside.ts";
      `);
      write("src/wire.ts", `
        export { wireValue } from "./wire-leaf.ts";
        export type { WireType } from "./wire-type-only.ts";
      `);
      write(
        "src/runtime-barrel.ts",
        'export { runtimeValue } from "./runtime-leaf.ts";',
      );
      write("src/runtime-leaf.ts", "export const runtimeValue = 1;");
      write("src/wire-leaf.ts", "export const wireValue = 1;");
      write(
        "src/wire-type-only.ts",
        "export interface WireType { value: string }; "
          + "export const wireTypeOnlyRuntime = 1;",
      );
      write(
        "src/type-only-target.ts",
        "export interface TypeOnly { value: string }; "
          + "export const typeOnlyRuntime = 1;",
      );
      write(
        "src/import-type-target.ts",
        "export interface ImportedOnly { value: string }; "
          + "export const importTypeRuntime = 1;",
      );
      write(
        "src/mixed-target.ts",
        "export interface MixedType { value: string }; "
          + "export const mixedValue = 1;",
      );
      write("src/group/v2-dummy.ts", "export const dummyValue = 1;");
      write("outside.ts", "export const outsideValue = 1;");

      expect(deriveMutationSourceInventory(packageRoot)).toEqual([
        "src/group/v2-dummy.ts",
        "src/mixed-target.ts",
        "src/runtime-leaf.ts",
        "src/wire-leaf.ts",
      ]);
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  test("accepts an exact, complete manifest with existing targets and tests", () => {
    expect(parse(manifest()).scopes.map((scope) => scope.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("rejects schema drift and missing mutation or command files", () => {
    expect(() => parse({ ...manifest(), unexpected: true })).toThrow(
      "unexpected field",
    );
    expect(() =>
      parse(manifest({
        scopes: [{
          name: "alpha",
          tier: "critical",
          mutate: ["src/missing.ts"],
          command: "bun test --bail=1 --timeout 60000 tests/unit/alpha.test.ts",
        }],
      }))
    ).toThrow("does not exist");
    expect(() =>
      parse(manifest({
        scopes: [{
          name: "alpha",
          tier: "critical",
          mutate: ["src/alpha.ts"],
          command: "bun test --bail=1 --timeout 60000 tests/unit/missing.test.ts",
        }],
      }))
    ).toThrow("does not exist");
  });

  test("freezes the practical assurance floor and worker ceiling", () => {
    for (const minimumKilledPercentage of [79, 81, 90, 100]) {
      expect(() =>
        parse(manifest({ minimumKilledPercentage }))
      ).toThrow("minimumKilledPercentage must be 80");
    }
    for (const perScopeWorkerBudget of [0, 3, 5]) {
      expect(() =>
        parse(manifest({ perScopeWorkerBudget }))
      ).toThrow("perScopeWorkerBudget must be 4");
    }
    for (const hostedMaxParallelScopes of [0, 3, 5]) {
      expect(() =>
        parse(manifest({ hostedMaxParallelScopes }))
      ).toThrow("hostedMaxParallelScopes must be 4");
    }
  });

  test("requires every scope to declare a recognized assurance tier", () => {
    const [alpha] = manifest().scopes;
    expect(() =>
      parse(manifest({ scopes: [{ ...alpha, tier: "ordinary" }] }))
    ).toThrow("tier must be critical or provider");
    const { tier: _tier, ...withoutTier } = alpha!;
    expect(() =>
      parse(manifest({ scopes: [withoutTier] }))
    ).toThrow("missing field: tier");
  });

  test("rejects duplicate mutation targets without an exact reviewed policy", () => {
    const duplicateScopes = [{
      name: "alpha",
      tier: "critical",
      mutate: ["src/alpha.ts"],
      command: "bun test --bail=1 --timeout 60000 tests/unit/alpha.test.ts",
    }, {
      name: "beta",
      tier: "provider",
      mutate: ["src/alpha.ts"],
      command: "bun test --bail=1 --timeout 60000 tests/integration/beta.test.ts",
    }];
    expect(() => parse(manifest({ scopes: duplicateScopes }))).toThrow(
      "duplicate mutation target",
    );

    const parsed = parse(manifest({
      scopes: duplicateScopes,
      reviewedDuplicateTargets: [{
        target: "src/alpha.ts",
        scopes: ["alpha", "beta"],
        reason: "Both scopes exercise distinct state-machine boundaries.",
      }],
    }));
    expect(parsed.reviewedDuplicateTargets).toHaveLength(1);
    expect(() =>
      parse(manifest({
        scopes: duplicateScopes,
        reviewedDuplicateTargets: [{
          target: "src/alpha.ts",
          scopes: ["alpha", "beta"],
          reason: "Both scopes exercise distinct state-machine boundaries.",
        }, {
          target: "src/alpha.ts",
          scopes: ["alpha", "beta"],
          reason: "Duplicate policy must fail closed.",
        }],
      }))
    ).toThrow("reviewed duplicate policy targets must be unique");
  });

  test("rejects duplicate exclusions and mutation/exclusion overlap", () => {
    const exclusion = manifest().reviewedExclusions[0]!;
    expect(() =>
      parse(manifest({
        reviewedExclusions: [exclusion, exclusion],
      }))
    ).toThrow("reviewed exclusion targets must be unique");
    expect(() =>
      parse(manifest({
        reviewedExclusions: [{
          ...exclusion,
          target: "src/alpha.ts",
        }],
      }))
    ).toThrow(
      "mutation target cannot also be a reviewed exclusion: src/alpha.ts",
    );
  });

  test("requires every runtime-reachable target to be covered exactly by policy", () => {
    const parsed = parse(manifest());
    expect(() =>
      assertCompleteMutationCoverage(parsed, [
        "src/alpha.ts",
        "src/beta.ts",
        "src/excluded.ts",
      ])
    ).not.toThrow();
    expect(() =>
      assertCompleteMutationCoverage(parsed, [
        "src/alpha.ts",
        "src/beta.ts",
        "src/excluded.ts",
        "src/missing.ts",
      ])
    ).toThrow("eligible mutation targets are unclassified: src/missing.ts");
    expect(() =>
      assertCompleteMutationCoverage(parsed, [
        "src/alpha.ts",
        "src/excluded.ts",
      ])
    ).toThrow("mutation policy targets are not runtime-reachable: src/beta.ts");
  });

  test("rejects scope filtering under CI=true", () => {
    const parsed = parse(manifest());
    expect(() =>
      selectMutationScopes(parsed, {
        requestedScope: "alpha",
        ci: "true",
      })
    ).toThrow("cannot be used when CI=true");
    expect(
      selectMutationScopes(parsed, {
        requestedScope: "alpha",
        ci: undefined,
      }).map((scope) => scope.name),
    ).toEqual(["alpha"]);
  });

  test("selects one governed file or range for fast local mutation TDD", () => {
    const parsed = parse(manifest());
    expect(selectMutationTarget(parsed, {
      requestedTarget: "src/alpha.ts",
      requestedRange: undefined,
      ci: undefined,
    })).toEqual({
      scope: parsed.scopes[0]!,
      target: "src/alpha.ts",
      mutatePattern: "src/alpha.ts",
    });
    expect(selectMutationTarget(parsed, {
      requestedTarget: "src/alpha.ts",
      requestedRange: "40:1-85:20",
      ci: undefined,
    }).mutatePattern).toBe("src/alpha.ts:40:1-85:20");
    expect(() =>
      selectMutationTarget(parsed, {
        requestedTarget: "src/missing.ts",
        requestedRange: undefined,
        ci: undefined,
      })
    ).toThrow("Unknown lattice mutation target");
    expect(() =>
      selectMutationTarget(parsed, {
        requestedTarget: "src/alpha.ts",
        requestedRange: "40-",
        ci: undefined,
      })
    ).toThrow("LATTICE_MUTATION_RANGE_ONLY is invalid");
    expect(() =>
      selectMutationTarget(parsed, {
        requestedTarget: "src/alpha.ts",
        requestedRange: undefined,
        ci: "true",
      })
    ).toThrow("cannot be used when CI=true");
  });
});
