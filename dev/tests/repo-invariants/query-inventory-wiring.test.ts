import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

async function read(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

type Workflow = {
  jobs: Record<string, {
    steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
  }>;
};

type Lefthook = {
  "pre-commit"?: {
    commands?: Record<string, { run: string }>;
  };
  "pre-push": {
    jobs: Array<{
      name?: string;
      run?: string;
      group?: {
        jobs?: Array<{ name?: string; run?: string }>;
      };
    }>;
  };
};

describe("query inventory enforcement wiring", () => {
  test("requires strict private review locally and exact-commit review in public CI", async () => {
    const gates = await read("dev/scripts/ci-gates.sh");
    const hooks = Bun.YAML.parse(await read("lefthook.yml")) as Lefthook;
    const workflow = Bun.YAML.parse(await read(".github/workflows/ci.yml")) as Workflow;

    expect(gates).toMatch(
      /query-inventory\)\s+if \[\[ "\$\{GITHUB_ACTIONS:-\}" == "true" \]\]; then\s+run_cmd query-inventory bun run --cwd packages\/query-invariants check:ci --base "\$\{LIMIT_REVIEW_BASE:\?exact base required\}" --head "\$\{LIMIT_REVIEW_HEAD:\?exact head required\}" --repository "\$\{GITHUB_REPOSITORY:\?repository required\}"\s+else\s+run_cmd query-inventory bun run db:query-inventory:check\s+fi\s+;;/,
    );
    expect(gates).toMatch(
      /lint\)\s+run_gate lint-eslint\s+run_gate test-invariants\s+run_gate query-inventory\s+run_gate limit-invariants\s+run_gate lint-unused\s+;;/,
    );
    const prePushJobs = hooks["pre-push"].jobs.flatMap((job) =>
      job.group?.jobs ?? [job]
    );
    expect(prePushJobs).toContainEqual({
      name: "query-inventory",
      run: "bash dev/scripts/ci-gates.sh query-inventory",
    });
    expect(hooks["pre-commit"]?.commands?.["query-inventory"]).toBeUndefined();
    expect(workflow.jobs["lint"]?.steps).toContainEqual({
      name: "Query inventory",
      env: {
        GITHUB_TOKEN: "${{ github.token }}",
        LIMIT_REVIEW_BASE: "${{ github.event.pull_request.base.sha }}",
        LIMIT_REVIEW_HEAD: "${{ github.event.pull_request.head.sha }}",
      },
      run: "bash dev/scripts/ci-gates.sh query-inventory",
    });
  });
});
