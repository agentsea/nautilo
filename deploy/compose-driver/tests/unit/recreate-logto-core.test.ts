import { describe, expect, test } from "bun:test";

import {
  LOGTO_CORE_SERVICE,
  buildLocalLogtoCoreRecreateArgs,
  buildRemoteLogtoCoreRecreateRequest,
  runLogtoCoreRecreate,
} from "../../src/recreateLogtoCore.ts";
import { buildRemoteComposeCommand } from "../../src/remote-compose-command.ts";

describe("buildLocalLogtoCoreRecreateArgs", () => {
  test("targets logto with force-recreate and no-deps", () => {
    const args = buildLocalLogtoCoreRecreateArgs(["compose"], [
      "--project-name",
      "nautilo",
      "-f",
      "docker-compose.yml",
      "--env-file",
      "deploy.compose.env",
      "--profile",
      "auth",
      "--profile",
      "app",
    ]);
    expect(args).toContain("up");
    expect(args).toContain("-d");
    expect(args).toContain("--force-recreate");
    expect(args).toContain("--no-deps");
    expect(args.at(-1)).toBe(LOGTO_CORE_SERVICE);
    expect(args).not.toContain("logto-postgres");
    expect(args).not.toContain("--no-build");
  });

  test("registry mode adds --no-build", () => {
    const args = buildLocalLogtoCoreRecreateArgs(["compose"], ["--profile", "auth"], {
      registryMode: true,
    });
    expect(args).toContain("--no-build");
  });
});

describe("buildRemoteLogtoCoreRecreateRequest", () => {
  test("recreates only logto without deps", () => {
    const request = buildRemoteLogtoCoreRecreateRequest();
    expect(request).toEqual({
      verb: "up",
      service: "logto",
      noBuild: true,
      noDeps: true,
      forceRecreate: true,
    });
  });

  test("remote compose script includes auth profile and force-recreate logto", () => {
    const built = buildRemoteComposeCommand({
      remoteRoot: "/opt/nautilo",
      projectName: "nautilo",
      overlays: { volumes: true, registry: true, server: true },
      profiles: ["auth", "app"],
      request: buildRemoteLogtoCoreRecreateRequest(),
    });
    const script = built.args[1];
    expect(script).toContain("--profile auth");
    expect(script).toContain("--profile app");
    expect(script.endsWith(" up -d --no-build --no-deps --force-recreate logto")).toBe(
      true,
    );
    expect(script).not.toContain("logto-postgres");
  });
});

describe("runLogtoCoreRecreate logging", () => {
  test("logs recreate without touching logto-postgres", async () => {
    const logs: string[] = [];
    await runLogtoCoreRecreate(
      {
        transport: "local_compose",
        composeBin: "docker",
        composeArgs: ["compose"],
        composeProjectArgs: ["--project-name", "nautilo"],
      },
      {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        log: (msg) => logs.push(msg),
      },
    );
    expect(logs.some((l) => l.includes("logto-postgres untouched"))).toBe(true);
  });
});
