import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

async function read(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, {
    "runs-on": string;
    "timeout-minutes": number;
    steps: Array<{
      if?: string;
      name?: string;
      run?: string;
      uses?: string;
      with?: Record<string, string | number | boolean>;
    }>;
  }>;
};

describe("official skill evaluation repository wiring", () => {
  test("runs only nightly or manually with exact tooling and retained evidence", async () => {
    const rootPackage = JSON.parse(await read("package.json")) as {
      scripts: Record<string, string>;
    };
    const workflow = Bun.YAML.parse(
      await read(".github/workflows/official-skill-evaluation.yml"),
    ) as Workflow;

    expect(rootPackage.scripts["eval:official-skills"]).toBe(
      "bun dev/evals/official-skills/evaluate.ts",
    );
    expect(workflow.on).toEqual({
      schedule: [{ cron: "0 2 * * *" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.env).toEqual({
      BUN_VERSION: "1.3.11",
      PYTHON_VERSION: "3.13.7",
      UV_VERSION: "0.7.3",
    });

    const job = workflow.jobs["evaluate"];
    expect(job).toBeDefined();
    if (!job) throw new Error("official skill evaluation job is missing");
    expect(job).toMatchObject({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
    });
    expect(job.steps).toContainEqual({
      uses: "actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065",
      with: {
        "python-version": "${{ env.PYTHON_VERSION }}",
      },
    });
    expect(job.steps).toContainEqual({
      uses: "astral-sh/setup-uv@37802adc94f370d6bfd71619e3f0bf239e1f3b78",
      with: {
        version: "${{ env.UV_VERSION }}",
        "enable-cache": false,
      },
    });
    expect(job.steps).toContainEqual({
      name: "Run official skill evaluation",
      run: "bun run eval:official-skills",
    });
    expect(job.steps).toContainEqual({
      if: "always()",
      name: "Retain evaluation reports",
      uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      with: {
        name: "official-skill-evaluation-${{ github.run_id }}",
        path: "dev/evals/official-skills/.results/",
        "if-no-files-found": "warn",
        "retention-days": 14,
      },
    });
  });
});
