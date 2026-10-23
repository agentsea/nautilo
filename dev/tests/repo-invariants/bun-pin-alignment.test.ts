import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "../../..");
const expectedVersion = "1.4.4";

async function read(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

async function manifest(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(relativePath)) as Record<string, unknown>;
}

describe("Bun pin alignment", () => {
  test("development and Desktop runtime sources select one Bun version", async () => {
    const root = await manifest("package.json") as {
      packageManager: string;
      engines: { bun: string };
      devDependencies: { "bun-types": string };
    };
    const cli = await manifest("apps/cli/package.json") as {
      engines: { bun: string };
    };
    const types = await manifest("packages/types/package.json") as {
      devDependencies: { "bun-types": string };
    };
    const fonts = await manifest("packages/fonts/package.json") as {
      devDependencies: { "bun-types": string };
    };
    const securitySmoke = await manifest("dev/tools/security-smoke/package.json") as {
      devDependencies: { "bun-types": string };
    };
    const desktopManifest = await manifest("apps/desktop/licenses/bun/manifest.json") as {
      version: string;
    };

    expect((await read(".bun-version")).trim()).toBe(expectedVersion);
    expect(root.packageManager).toBe(`bun@${expectedVersion}`);
    expect(root.engines.bun).toBe(expectedVersion);
    expect(root.devDependencies["bun-types"]).toBe(expectedVersion);
    expect(cli.engines.bun).toBe(expectedVersion);
    expect(types.devDependencies["bun-types"]).toBe(expectedVersion);
    expect(fonts.devDependencies["bun-types"]).toBe(expectedVersion);
    expect(securitySmoke.devDependencies["bun-types"]).toBe(expectedVersion);
    expect(desktopManifest.version).toBe(expectedVersion);
    expect(await read("apps/desktop/scripts/vendor-bun.ts")).toContain(
      `const BUN_VERSION = "${expectedVersion}";`,
    );
    for (const lockfile of [
      "bun.lock",
      "dev/tools/security-smoke/bun.lock",
      "packages/first-party-apps/video/bun.lock",
      "packages/first-party-apps/writer/bun.lock",
    ]) {
      const contents = await read(lockfile);
      expect(contents, lockfile).toContain(`bun-types@${expectedVersion}`);
      expect(contents, lockfile).not.toContain("bun-types@1.3.11");
    }
  });

  test("every Actions setup-bun step resolves to the repository pin", async () => {
    const workflowDirectory = join(repositoryRoot, ".github/workflows");
    const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
      name.endsWith(".yml")
    );

    for (const workflowName of workflowNames) {
      const workflow = Bun.YAML.parse(await read(`.github/workflows/${workflowName}`)) as {
        env?: { BUN_VERSION?: string };
        jobs?: Record<string, { steps?: Array<{
          uses?: string;
          with?: { "bun-version"?: string; "bun-version-file"?: string };
        }> }>;
      };
      for (const job of Object.values(workflow.jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith("oven-sh/setup-bun@")) continue;
          const versionFile = step.with?.["bun-version-file"];
          if (versionFile !== undefined) {
            expect(versionFile, workflowName).toBe(".bun-version");
            continue;
          }
          const selected = step.with?.["bun-version"];
          expect(selected, `${workflowName} setup-bun must select a version`).toBeDefined();
          if (selected === "${{ env.BUN_VERSION }}") {
            expect(workflow.env?.BUN_VERSION, workflowName).toBe(expectedVersion);
          } else {
            expect(selected, workflowName).toBe(expectedVersion);
          }
        }
      }
    }
  });
});
