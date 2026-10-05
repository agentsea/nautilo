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
test("Windows CI is triggered by its host, protocol, and Bun pin", () => {
  const workflow = Bun.YAML.parse(readFileSync(join(repositoryRoot, ".github/workflows/windows-desktop.yml"), "utf8")) as { on: { pull_request: { paths: string[] } } };
  for (const path of ["bin/nautilo-relay/src/desktop-host-main.ts", "packages/relay/src/desktop-host-protocol.ts", ".bun-version"]) {
    expect(workflow.on.pull_request.paths.some(pattern => new Bun.Glob(pattern).match(path))).toBe(true);
  }
});
