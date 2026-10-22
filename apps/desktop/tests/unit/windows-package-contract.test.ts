import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const desktopRoot = join(import.meta.dir, "../..");
const repositoryRoot = join(desktopRoot, "../..");
type Resource = { from?: string; to?: string; filter?: string[] };
test("Windows package produces and includes the mandatory Relay Host", () => {
  const config = Bun.YAML.parse(readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8")) as { extraResources?: Resource[]; win?: { extraResources?: Resource[] } };
  const resources = [...(config.extraResources ?? []), ...(config.win?.extraResources ?? [])];
  expect(resources.find(resource => resource.to === "tools-relay-host")).toEqual({ from: "vendor/relay-host", to: "tools-relay-host", filter: ["nautilo-relay-host.js", "manifest.json"] });
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const command = pkg.scripts["package:win"]!;
  expect(command.indexOf("vendor:relay-host")).toBeGreaterThanOrEqual(0);
  expect(command.indexOf("vendor:relay-host")).toBeLessThan(command.indexOf("electron-builder"));
});
test("Windows CI runs nightly and remains manually dispatchable", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(repositoryRoot, ".github/workflows/windows-desktop.yml"), "utf8")) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: null };
  };
  expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(workflow.on.schedule).toEqual([{ cron: "17 4 * * *" }]);
  expect(workflow.on.workflow_dispatch).toBeNull();
});

test("hosted Windows runs the complete repository invariant entry point", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(repositoryRoot, ".github/workflows/windows-desktop.yml"), "utf8")) as {
    jobs: Record<string, { steps: { run?: string; if?: unknown }[] }>;
  };
  const step = workflow.jobs["windows-x64"]!.steps.find(step => step.run === "bun run test:invariants");
  expect(step).toBeDefined();
  expect(step!.if).toBeUndefined();
});

test("Windows validation retains the portable regression suites for its changed runtime contracts", () => {
  const gate = readFileSync(join(repositoryRoot, "dev/scripts/windows-unit-gate.ts"), "utf8");
  for (const path of [
    "apps/desktop/tests/unit/relay-binary-resolution.test.ts",
    "apps/desktop/tests/unit/desktop-license-payload.test.ts",
    "bin/nautilo-dev/tests/unit/migrate-add-agent-role.test.ts",
    "bin/nautilo-dev/tests/unit/bootstrap-claim-invite.test.ts",
    "packages/server/tests/unit/agent-browser-server-vendor.test.ts",
    "packages/server/tests/unit/seed-first-party-apps.test.ts",
    "packages/server/tests/unit/runtime-dependency-snapshot.test.ts",
  ]) {
    expect(gate, `Windows unit gate must run ${path}`).toContain(`"${path}"`);
  }
});
