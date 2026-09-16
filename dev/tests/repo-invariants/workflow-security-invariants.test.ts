import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const workflowsRoot = join(repositoryRoot, ".github/workflows");

type Workflow = {
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      uses?: string;
      steps?: Array<{ uses?: string }>;
    }
  >;
};

async function workflowSources(): Promise<
  Array<{ name: string; source: string }>
> {
  const names = (await readdir(workflowsRoot))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(join(workflowsRoot, name), "utf8"),
    })),
  );
}

describe("GitHub Actions workflow security", () => {
  test("defaults every workflow token to at most source read access", async () => {
    for (const { name, source } of await workflowSources()) {
      const workflow = Bun.YAML.parse(source) as Workflow;
      // An explicit empty map disables the token permissions altogether. Undefined
      // would inherit repository defaults and must still fail this contract.
      expect(
        [{}, { contents: "read" }],
        `${name} must explicitly disable token permissions or allow only contents: read`,
      ).toContainEqual(workflow.permissions);
    }
  });

  test("every external action is pinned to an immutable commit", async () => {
    for (const { name, source } of await workflowSources()) {
      const workflow = Bun.YAML.parse(source) as Workflow;
      const actionReferences = Object.values(workflow.jobs ?? {}).flatMap(
        (job) => [
          ...(job.uses === undefined ? [] : [job.uses]),
          ...(job.steps ?? []).flatMap((step) =>
            step.uses === undefined ? [] : [step.uses]
          ),
        ],
      );

      for (const reference of actionReferences) {
        if (reference.startsWith("./") || reference.startsWith("docker://")) {
          continue;
        }
        expect(
          reference,
          `${name} must pin ${reference} to a full commit SHA`,
        ).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
      }
    }
  });

  test("keeps supply-chain reporting writes narrow and firewall smoke read-only", async () => {
    const source = await readFile(
      join(workflowsRoot, "supply-chain.yml"),
      "utf8",
    );
    const workflow = Bun.YAML.parse(source) as Workflow;

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs?.socket?.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      issues: "write",
    });
    expect(workflow.jobs?.["firewall-smoke"]?.permissions).toBeUndefined();
  });

  test("cold contributor builds admit only source and Bun into the container", async () => {
    const source = await readFile(join(workflowsRoot, "contributor-build.yml"), "utf8");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("runs-on: ubuntu-24.04");
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("actions/cache");
    expect(source).not.toContain("pull_request_target");
    expect(source.match(/--mount /g)).toHaveLength(2);
    expect(source).toContain("dst=/source.tar,readonly");
    expect(source).toContain("dst=/usr/local/bin/bun,readonly");
    expect(source).toContain("docker run --rm --cap-drop ALL --security-opt no-new-privileges");
    expect(source).toContain("--user node --workdir /home/node");
    const container = source.slice(source.indexOf("docker run"), source.indexOf("2>&1 | tee"));
    expect(container).not.toMatch(/(?:--env|--env-file|--privileged|--volume|\s-v\s)/);
    expect(source).toContain("git archive HEAD");
  });
});
