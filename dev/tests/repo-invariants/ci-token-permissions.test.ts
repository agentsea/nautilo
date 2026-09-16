import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");

type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string> }>;
};

describe("ordinary CI token permissions", () => {
  test("grants source read access and no job-level write exceptions", async () => {
    const source = await readFile(
      join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as Workflow;

    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(
        job.permissions,
        `${jobName} must not widen the ordinary CI workflow token`,
      ).toBeUndefined();
    }
  });
});
