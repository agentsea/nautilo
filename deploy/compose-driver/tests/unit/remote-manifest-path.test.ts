import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ComposeDriver } from "../../src/ComposeDriver.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

test.each(["/opt/nautilo-prod", "/home/deployer/instance with spaces"])("remote manifest reads retain POSIX paths on every operator OS: %s", async (remoteRoot) => {
  const profile: ComposeDriverProfile = {
    name: "remote-path", transport: "remote", lifecycle: "compose",
    instance_id: "prod", from_source: false,
    ssh: { host: "example.invalid", user: "deployer" },
  };
  const manifestPath = `${remoteRoot}/deployment-manifest.json`;
  const manifest = JSON.stringify({
    version: 1, instanceId: "prod", composeProjectName: "nautilo-prod",
    lifecycle: "compose", image: { mode: "registry", reference: "fixture:stable" },
    remoteRoot, https: "off",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  });
  const calls: Array<{ command: string; args: string[] }> = [];
  const driver = new ComposeDriver({
    exec: async (command, args) => {
      calls.push({ command, args });
      return command === "cat" && args[0] === manifestPath
        ? { code: 0, stdout: manifest, stderr: "" }
        : { code: 1, stdout: "", stderr: "fixture unavailable" };
    },
    fs, fetch: globalThis.fetch,
    runBootstrap: async () => { throw new Error("Read-only inspection must not bootstrap"); },
    now: () => new Date("2026-01-01T00:00:00Z"),
    templateDir: import.meta.dir,
    resolveInstanceRootDir: () => remoteRoot,
  });

  const report = await driver.authPlan(profile);
  expect(calls[0]).toEqual({ command: "cat", args: [manifestPath] });
  expect(calls.some(call => call.command === "sh")).toBe(true);
  expect(report.reasons.join(" ")).not.toContain("Unable to inspect the persisted remote auth stamp");
});
