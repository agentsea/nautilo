import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
} from "../../src/ComposeDriver.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import {
  AMBIGUOUS_SERVER_REFUSAL,
  DIRECT_TRANSPORT_BASELINE_REFUSAL,
  STALE_TOPOLOGY_WITHOUT_SERVER_REFUSAL,
} from "../../src/direct-transport-baseline.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function makeDeps(exec: ExecFn): ComposeDriverDeps {
  const repoRoot = mktmp("m215-upgrade-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template\n");
  const infraDir = join(repoRoot, "infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");
  const localRoot = mktmp("m215-upgrade-home-");
  const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    fs: nodeFs,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    resolveInstanceRootDir: () => localRoot,
    resolveLocalInstanceRootDir: () => localRoot,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ensureForgotPasswordWebhookSecret: async () => "fake_webhook_secret",
  };
}

const profile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

describe("M215 upgrade baseline refusal", () => {
  test("full upgrade refuses pre-M212 server env before stop/backup/deploy", async () => {
    let sawStop = false;
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (
        cmd === "sh" &&
        joined.includes("com.docker.compose.service=nautilo-server") &&
        joined.includes("validate_db_url")
      ) {
        return { code: 48, stdout: "", stderr: DIRECT_TRANSPORT_BASELINE_REFUSAL };
      }
      if (joined.includes(" stop ") || joined.includes("stop nautilo-server")) {
        sawStop = true;
      }
      if (cmd === "docker" && args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "inspect") {
        return { code: 0, stdout: "nautilo-server:local-dev\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile, { scope: "full" })).rejects.toThrow(
      /M212 direct-PostgreSQL transport baseline/,
    );
    expect(sawStop).toBe(false);
  });

  test("full upgrade refuses stale retired topology before stop when no server exists", async () => {
    let sawStop = false;
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (
        cmd === "sh" &&
        joined.includes("count_retired") &&
        joined.includes("com.docker.compose.service=nautilo-server")
      ) {
        return { code: 48, stdout: "", stderr: STALE_TOPOLOGY_WITHOUT_SERVER_REFUSAL };
      }
      if (joined.includes(" stop ") || joined.includes("stop nautilo-server")) {
        sawStop = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile, { scope: "full" })).rejects.toThrow(
      /not a fresh deploy/,
    );
    expect(sawStop).toBe(false);
  });

  test("full upgrade refuses ambiguous servers before stop", async () => {
    let sawStop = false;
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (
        cmd === "sh" &&
        joined.includes("ambiguous_refusal") &&
        joined.includes("com.docker.compose.service=nautilo-server")
      ) {
        return { code: 48, stdout: "", stderr: AMBIGUOUS_SERVER_REFUSAL };
      }
      if (joined.includes(" stop ") || joined.includes("stop nautilo-server")) {
        sawStop = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile, { scope: "full" })).rejects.toThrow(
      /multiple project-labelled nautilo-server containers/,
    );
    expect(sawStop).toBe(false);
  });
});
