import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("every contributor Desktop test job provisions pinned FFmpeg before media tests", () => {
  for (const name of ["desktop-package.yml"]) {
    const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../../.github/workflows", name), "utf8")) as {
      jobs: Record<string, { steps?: { run?: string; if?: string }[] }>;
    };
    let testedJobs = 0;
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const tests = steps.findIndex(step => step.run?.includes("bun run --cwd apps/desktop test:unit"));
      if (tests < 0) continue;
      testedJobs++;
      const provision = steps.findIndex(step => step.run === "bun run --cwd apps/desktop vendor:ffmpeg" && step.if === undefined);
      const install = steps.findIndex(step => step.run === "bun install --frozen-lockfile");
      expect(install, `${name}/${id}: frozen dependencies`).toBeGreaterThanOrEqual(0);
      expect(provision, `${name}/${id}: provision after dependencies`).toBeGreaterThan(install);
      expect(provision, `${name}/${id}: provision before media tests`).toBeLessThan(tests);
    }
    expect(testedJobs, `${name}: keep real Desktop unit tests`).toBeGreaterThan(0);
  }
});


test("contributor packaging has read-only authority and cannot publish or access release credentials", () => {
  const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, "../../../.github/workflows/desktop-package.yml"), "utf8")) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, {
      environment?: unknown;
      permissions?: unknown;
      steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
    }>;
  };
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  for (const job of Object.values(workflow.jobs)) {
    expect(job.environment).toBeUndefined();
    expect(job.permissions).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|gh release|package:mac:signed|--publish always/);
    expect(job.steps.find((s) => s.run === "bun run --cwd apps/desktop package:mac")).toBeDefined();
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(JSON.stringify(job)).toContain("--expect-signature adhoc");
  }
});
