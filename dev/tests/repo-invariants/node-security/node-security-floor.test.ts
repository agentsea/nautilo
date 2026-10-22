import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const read = (path: string): string => readFileSync(join(repositoryRoot, path), "utf8");
const contributorNode = read(".nvmrc").trim().replace(/^v/u, "");

type Workflow = {
  jobs: Record<string, {
    steps?: { uses?: string; with?: { "node-version"?: string }; run?: string }[];
  }>;
};

function isPatchedNode(version: string): boolean {
  return /^\d+\.\d+\.\d+$/u.test(version)
    && Bun.semver.satisfies(version, ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27");
}

test("contributor and CLI Node requirements exclude vulnerable releases", () => {
  expect(isPatchedNode(contributorNode)).toBe(true);
  expect(Bun.semver.satisfies(contributorNode, ">=24.22.1 <25")).toBe(true);
  for (const path of ["package.json", "apps/cli/package.json"]) {
    const manifest = JSON.parse(read(path)) as { engines: { node: string } };
    expect(Bun.semver.satisfies(contributorNode, manifest.engines.node), path).toBe(true);
    for (const vulnerable of ["24.0.0", "24.18.0", "24.22.0"]) {
      expect(Bun.semver.satisfies(vulnerable, manifest.engines.node), path).toBe(false);
    }
    expect(Bun.semver.satisfies("25.0.0", manifest.engines.node), path).toBe(false);
  }
});

test("every explicitly provisioned workflow Node uses a patched exact version", () => {
  const versions: string[] = [];
  const imageVersions: string[] = [];
  for (const file of readdirSync(join(repositoryRoot, ".github/workflows"))) {
    if (!/\.ya?ml$/u.test(file)) continue;
    const workflow = Bun.YAML.parse(read(`.github/workflows/${file}`)) as Workflow;
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/setup-node@")) {
          const version = step.with?.["node-version"] ?? "";
          expect(isPatchedNode(version), `${file}: ${version}`).toBe(true);
          versions.push(version);
        }
        for (const match of (step.run ?? "").matchAll(/\bnode:([^\s]+)/gu)) {
          const image = /^(\d+\.\d+\.\d+)-bookworm@sha256:[a-f0-9]{64}$/u.exec(match[1]!);
          expect(image, file).not.toBeNull();
          expect(isPatchedNode(image?.[1] ?? ""), file).toBe(true);
          imageVersions.push(image?.[1] ?? "");
        }
      }
    }
  }
  expect(versions.sort()).toEqual(["22.23.4", "22.23.4", contributorNode].sort());
  expect(imageVersions).toEqual([contributorNode]);
});
