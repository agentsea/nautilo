import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
} from "../../src/ComposeDriver.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

interface ExecCall {
  cmd: string;
  args: string[];
}

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function makeFakeExec(
  responder: (call: ExecCall) => ExecResult = () => ({ code: 0, stdout: "", stderr: "" }),
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    const call: ExecCall = { cmd, args };
    calls.push(call);
    return responder(call);
  };
  return { exec, calls };
}

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("dep-refresh-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template marker\n");
  const infraDir = join(repoRoot, "infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");
  const { exec } = makeFakeExec();
  const fakeFetch = (async () =>
    new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  const localRoot = mktmp("dep-refresh-home-");
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    ensureRemotePairingPepper: async () => "a".repeat(64),
    ensurePushTokenEncryptionKey: async () => "b".repeat(64),
    resolveSourceBuildSha: async () => "c".repeat(40),
    fs: nodeFs,
    now: () => new Date("2026-07-14T12:00:00.000Z"),
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
    ...over,
  };
}

const leProfile: ComposeDriverProfile = {
  name: "local-le",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
  domain: "nautilo.example.com",
  https: "letsencrypt",
  acme_email: "ops@example.com",
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

function forceRecreateCalls(calls: ExecCall[]): ExecCall[] {
  return calls.filter(
    (c) =>
      c.cmd === "docker" &&
      c.args.includes("up") &&
      c.args.includes("--force-recreate") &&
      c.args.includes("--no-deps") &&
      c.args.includes("caddy"),
  );
}

describe("D427 3.1.2 ComposeDriver.deploy dependency proxy refresh (M215)", () => {
  test("full source deploy force-recreates caddy after the main up (LE)", async () => {
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec, enableDependencyRefresh: true }));
    await driver.deploy(leProfile);

    const recreate = forceRecreateCalls(calls);
    const recreated = recreate.map((c) => c.args[c.args.length - 1]);
    expect(recreated).toEqual(["caddy"]);
    for (const c of recreate) {
      expect(c.args).toContain("--force-recreate");
      expect(c.args).toContain("--no-deps");
    }
    const mainUp = calls.findIndex(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("up") &&
        c.args.includes("--build") &&
        !c.args.includes("--force-recreate"),
    );
    const firstRecreate = calls.findIndex((c) => c.args.includes("--force-recreate"));
    expect(mainUp).toBeGreaterThanOrEqual(0);
    expect(firstRecreate).toBeGreaterThan(mainUp);
  });

  test("enableDependencyRefresh=false (default for legacy tests) → no force-recreate calls", async () => {
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.deploy(leProfile);
    expect(forceRecreateCalls(calls)).toHaveLength(0);
  });

  test("non-letsencrypt full deploy does not recreate caddy (not in stack)", async () => {
    const plainProfile: ComposeDriverProfile = {
      name: "local-default",
      transport: "local",
      lifecycle: "compose",
      from_source: true,
    };
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec, enableDependencyRefresh: true }));
    await driver.deploy(plainProfile);
    expect(forceRecreateCalls(calls)).toHaveLength(0);
  });
});
