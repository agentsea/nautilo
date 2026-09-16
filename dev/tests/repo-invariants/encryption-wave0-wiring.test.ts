import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

async function read(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

type Workflow = {
  jobs: Record<string, {
    container?: {
      image: string;
      options?: string;
    };
    if?: string;
    needs?: string[];
    steps?: Array<{
      env?: Record<string, string>;
      name?: string;
      run?: string;
      uses?: string;
    }>;
    strategy?: {
      "fail-fast"?: boolean;
      "max-parallel"?: number;
    };
    "timeout-minutes"?: number;
  }>;
};

type Lefthook = {
  "pre-push": {
    jobs: Array<{
      name?: string;
      run?: string;
      group?: {
        jobs: Array<{ name: string; run: string }>;
      };
    }>;
  };
};

describe("Encryption Wave 0 repository wiring", () => {
  test("assurance is explicit, absent from developer gates, and runs nightly or manually", async () => {
    const rootPackage = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    const gates = await read("dev/scripts/ci-gates.sh");
    const hooks = Bun.YAML.parse(await read("lefthook.yml")) as Lefthook;
    const workflowText = await read(".github/workflows/ci.yml");
    const workflow = Bun.YAML.parse(workflowText) as Workflow;
    const assuranceWorkflowText = await read(
      ".github/workflows/encryption-assurance.yml",
    );
    const assuranceWorkflow = Bun.YAML.parse(assuranceWorkflowText) as {
      on: Record<string, unknown>;
      jobs: Workflow["jobs"];
    };
    const mutationWorkflow = Bun.YAML.parse(
      await read(".github/workflows/lattice-mutation-assurance.yml"),
    ) as {
      on: Record<string, unknown>;
      jobs: Workflow["jobs"];
    };
    const latticeBridgePackage = JSON.parse(
      await read("packages/lattice-bridge/package.json"),
    ) as { devDependencies: { playwright: string } };

    expect(rootPackage.scripts["encryption:check"]).toBe(
      "bun run --cwd packages/encryption-invariants check",
    );
    expect(rootPackage.scripts["encryption:assurance"]).toBe(
      "bash dev/scripts/ci-gates.sh encryption-assurance",
    );
    expect(rootPackage.scripts["encryption:indicators"]).toBe(
      "bash dev/scripts/ci-gates.sh encryption-indicators",
    );
    expect(gates).toMatch(
      /test-invariants\)\s+run_cmd test-invariants bun run test:invariants\s+;;/,
    );
    expect(gates).toMatch(
      /encryption-indicators\)\s+run_cmd encryption-check bun run encryption:check\s+run_cmd encryption-decision-coverage bun run --cwd packages\/encryption-invariants test:coverage\s+run_cmd encryption-integration bun run --cwd packages\/encryption-invariants test:integration\s+run_cmd encryption-property bun run --cwd packages\/encryption-invariants test:property\s+;;\s+encryption-assurance\)\s+run_gate encryption-indicators\s+run_cmd encryption-mutation bun run --cwd packages\/encryption-invariants test:mutation\s+;;/,
    );
    expect(gates).toMatch(
      /all\)\s+run_gate lint\s+run_gate typecheck\s+run_gate unit\s+;;/,
    );

    const hookJobs = hooks["pre-push"].jobs.flatMap((job) =>
      job.group?.jobs ?? (job.name && job.run ? [{ name: job.name, run: job.run }] : [])
    );
    expect(hookJobs).toContainEqual({
      name: "test-invariants",
      run: "bash dev/scripts/ci-gates.sh test-invariants",
    });
    expect(hookJobs.map((job) => job.name)).not.toContain("encryption-assurance");

    expect(workflow.jobs["lint"]?.steps).toContainEqual({
      name: "Test harness invariants",
      run: "bash dev/scripts/ci-gates.sh test-invariants",
    });
    expect(workflow.jobs["encryption-assurance"]).toBeUndefined();
    expect(workflow.jobs["dev-stack-secret-recovery"]).toBeUndefined();
    expect(workflow.jobs["desktop-smoke"]).toBeUndefined();
    expect(workflow.jobs["ci"]?.needs).toEqual([
      "lint",
      "typecheck",
      "test",
      "db-migration-integration",
    ]);
    expect(workflow.jobs["lattice-browser-integration"]).toBeUndefined();
    expect(workflow.jobs["lattice-storage-integration"]).toBeUndefined();
    const aggregateCheck = workflow.jobs["ci"]?.steps?.find(
      (step) => step.name === "Verify all checks passed",
    )?.run;
    expect(aggregateCheck).not.toContain("encryption-assurance");
    expect(aggregateCheck).toContain('needs.db-migration-integration.result');
    expect(aggregateCheck).not.toContain("dev-stack-secret-recovery");
    expect(aggregateCheck).not.toContain("desktop-smoke");
    expect(aggregateCheck).not.toContain("lattice-storage-integration");

    expect(assuranceWorkflow.on).toEqual({
      schedule: [{ cron: "0 1 * * *" }],
      workflow_dispatch: null,
    });
    expect(Object.keys(assuranceWorkflow.jobs).sort()).toEqual([
      "encryption-assurance",
      "lattice-browser-integration",
      "lattice-storage-integration",
    ]);
    expect(mutationWorkflow.on).toEqual({
      schedule: [{ cron: "0 3 1 * *" }],
      workflow_dispatch: null,
    });
    expect(Object.keys(mutationWorkflow.jobs).sort()).toEqual([
      "encryption-mutation",
      "lattice-mutation-aggregate",
      "lattice-mutation-plan",
      "lattice-mutation-scope",
    ]);
    expect(
      assuranceWorkflow.jobs["encryption-assurance"]?.steps,
    ).toContainEqual({
      name: "Run encryption indicators",
      run: "bun run encryption:indicators",
    });
    expect(
      assuranceWorkflow.jobs["encryption-assurance"]?.["timeout-minutes"],
    ).toBe(30);
    expect(assuranceWorkflow.jobs["lattice-browser-integration"]).toMatchObject({
      container: {
        image:
          `mcr.microsoft.com/playwright:v${latticeBridgePackage.devDependencies.playwright}-noble`
          + "@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
        options: "--ipc=host",
      },
      "timeout-minutes": 30,
    });
    expect(
      assuranceWorkflow.jobs["lattice-browser-integration"]?.steps
        ?.map((step) => step.name),
    ).not.toContain("Install Playwright browsers");
    const browserSteps =
      assuranceWorkflow.jobs["lattice-browser-integration"]?.steps ?? [];
    const installUnzipIndex = browserSteps.findIndex(
      (step) => step.name === "Install Bun bootstrap dependency",
    );
    const setupBunIndex = browserSteps.findIndex(
      (step) => step.uses?.startsWith("oven-sh/setup-bun@") === true,
    );
    expect(browserSteps[installUnzipIndex]).toEqual({
      name: "Install Bun bootstrap dependency",
      run: "apt-get update && apt-get install --yes --no-install-recommends unzip",
    });
    expect(installUnzipIndex).toBeGreaterThan(-1);
    expect(setupBunIndex).toBeGreaterThan(installUnzipIndex);
    expect(
      assuranceWorkflow.jobs["lattice-browser-integration"]?.steps,
    ).toContainEqual({
      env: {
        HOME: "/root",
      },
      name: "Test browser client vault",
      run: "bun run --cwd packages/lattice-bridge test:browser",
    });
    expect(
      assuranceWorkflow.jobs["lattice-storage-integration"]?.steps,
    ).toContainEqual({
      name: "Test disposable Postgres lattice storage",
      run: "bun run --cwd packages/lattice-bridge test:integration",
    });
    expect(
      assuranceWorkflow.jobs["lattice-storage-integration"]?.[
        "timeout-minutes"
      ],
    ).toBe(15);
    expect(
      mutationWorkflow.jobs["lattice-mutation-plan"]?.steps,
    ).toContainEqual({
      id: "matrix",
      name: "Derive governed scope matrix",
      run:
        'value="$(bun run --silent --cwd packages/lattice-crypto '
        + 'mutation:hosted-matrix)"\n'
        + 'echo "value=${value}" >> "${GITHUB_OUTPUT}"\n',
    });
    expect(
      mutationWorkflow.jobs["lattice-mutation-scope"]?.steps,
    ).toContainEqual({
      env: {
        LATTICE_MUTATION_HOSTED_SCOPE: "${{ matrix.scope }}",
      },
      name: "Run governed lattice mutation scope",
      run: "bun run --cwd packages/lattice-crypto test:mutation",
    });
    expect(mutationWorkflow.jobs["lattice-mutation-scope"]).toMatchObject({
      "timeout-minutes": 240,
      strategy: {
        "fail-fast": false,
        "max-parallel": 4,
      },
    });
    expect(
      mutationWorkflow.jobs["lattice-mutation-aggregate"],
    ).toMatchObject({
      if: "always()",
      needs: ["lattice-mutation-plan", "lattice-mutation-scope"],
      "timeout-minutes": 15,
    });
    expect(
      mutationWorkflow.jobs["lattice-mutation-aggregate"]?.steps,
    ).toContainEqual({
      name: "Aggregate complete lattice mutation assurance",
      run:
        "bun run --cwd packages/lattice-crypto "
        + "test:mutation:hosted-aggregate",
    });
    expect(
      mutationWorkflow.jobs["encryption-mutation"]?.steps,
    ).toContainEqual({
      name: "Run encryption invariant mutation assurance",
      run: "bun run --cwd packages/encryption-invariants test:mutation",
    });
    expect(mutationWorkflow.jobs["encryption-mutation"]?.["timeout-minutes"])
      .toBe(240);
  });

  test("Desktop smoke stays PR-only and D475 stays manual-only after server publication moves out", async () => {
    const desktopWorkflow = await read(
      ".github/workflows/desktop-smoke.yml",
    );
    const workflowDirectory = join(repositoryRoot, ".github/workflows");
    const workflowTexts = await Promise.all(
      (await readdir(workflowDirectory))
        .filter((name) => name.endsWith(".yml"))
        .map((name) => read(`.github/workflows/${name}`)),
    );
    const devToolsPackage = JSON.parse(
      await read("bin/nautilo-dev/package.json"),
    ) as { scripts: Record<string, string> };

    expect(desktopWorkflow).toMatch(/^\s*pull_request:/mu);
    expect(desktopWorkflow).not.toMatch(/^\s*push:/mu);
    expect(desktopWorkflow).toMatch(/^\s*workflow_dispatch:/mu);
    expect(workflowTexts.join("\n")).not.toContain(
      "test:integration:d475",
    );
    expect(workflowTexts.join("\n")).not.toContain(
      "dev-stack-secret-recovery",
    );
    expect(devToolsPackage.scripts["test:integration:d475"]).toBe(
      "NAUTILO_D475_LIVE=1 bun test --timeout 240000 "
      + "tests/integration/d475-persisted-role-drift.test.ts",
    );
  });

  test("mutation assurance is pinned by the repository runtime and covers every pure fail-closed decision", async () => {
    const config = await import(
      "../../../packages/encryption-invariants/stryker.config.mjs"
    ) as {
      default: {
        mutate: string[];
        commandRunner: { command: string };
        concurrency: number;
      };
    };

    expect(config.default.mutate).toEqual([
      "src/activation.ts",
      "src/model.ts",
      "src/registry.ts",
      "src/report-verification.ts",
      "src/node/activation-inventory-decisions.ts",
      "src/node/dto-declaration-audit.ts",
      "src/node/source-alarm-review.ts",
    ]);
    expect(config.default.commandRunner.command).toBe(
      "bun test --timeout 30000 tests/unit tests/property tests/integration/dto-inventory-declarations.test.ts tests/integration/source-alarm-review.test.ts",
    );
    expect(config.default.commandRunner.command).not.toContain("bunx");
    expect(config.default.concurrency).toBe(4);

    const generatedIgnores = (await read(
      "packages/encryption-invariants/.gitignore",
    )).split(/\r?\n/).filter(Boolean);
    expect(generatedIgnores).toEqual(["reports/", ".stryker-tmp/"]);
  });

  test("the default package entry is browser-safe and Node scanners stay behind the node export", async () => {
    const packageJson = JSON.parse(
      await read("packages/encryption-invariants/package.json"),
    ) as {
      exports: Record<string, string>;
    };
    const defaultEntry = await read("packages/encryption-invariants/src/index.ts");

    expect(packageJson.exports["."]).toBe("./src/index.ts");
    expect(packageJson.exports["./node"]).toBe("./src/node/index.ts");
    expect(defaultEntry).not.toContain("./node/");
    expect(defaultEntry).not.toMatch(/node:(?:fs|path|os|crypto)/);
  });

  test("no stale compose activation promise remains", async () => {
    expect(await read("infra/compose/nautilo.yml")).not.toContain("CRYPTO_MODE");
  });
});
