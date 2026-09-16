import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cliRoot = join(import.meta.dirname, "..", "..");
const cliDist = join(cliRoot, "dist", "index.js");

function spawnCli(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliDist, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: process.env["HOME"] ?? "/tmp", ...environment },
  });
}

beforeAll(() => {
  if (!existsSync(cliDist)) {
    throw new Error(`missing ${cliDist}; run bun run build in apps/cli first`);
  }
});

describe("packaged host plan parser and help", () => {
  test("documents the read-only Railway and provider-selection surface without secret flags", () => {
    const result = spawnCli(["host", "plan", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--backend");
    expect(result.stdout).toContain("--all-providers");
    expect(result.stdout).toContain("--include-provider");
    expect(result.stdout).toContain("--exclude-provider");
    expect(result.stdout).toContain("--allow-core-degraded");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).not.toContain("api-key");
    expect(result.stdout).not.toContain("railway-token");
    expect(result.stdout).not.toContain("password");
  });

  test("preserves existing Compose command help beside the new host namespace", () => {
    const rootHelp = spawnCli(["--help"]);
    const hostHelp = spawnCli(["host", "--help"]);
    const hostAdoptHelp = spawnCli(["host", "adopt", "--help"]);
    const hostDeployHelp = spawnCli(["host", "deploy", "--help"]);
    const hostUpgradeHelp = spawnCli(["host", "upgrade", "--help"]);
    const hostResumeHelp = spawnCli(["host", "resume", "--help"]);
    const hostDestroyHelp = spawnCli(["host", "destroy", "--help"]);
    const deployHelp = spawnCli(["deploy", "--help"]);
    const upgradeHelp = spawnCli(["upgrade", "--help"]);

    expect(rootHelp.status).toBe(0);
    expect(rootHelp.stdout).toContain("host");
    expect(hostHelp.stdout).toContain("inspect");
    expect(hostHelp.stdout).toContain("adopt");
    expect(hostAdoptHelp.status).toBe(0);
    expect(hostAdoptHelp.stdout).toContain("nautilo host adopt --backend railway");
    expect(hostAdoptHelp.stdout).toContain("never change Railway");
    expect(hostAdoptHelp.stdout).toContain("--yes");
    expect(hostAdoptHelp.stdout).toContain("nautilo host adopt --backend railway \\\n  --yes");
    expect(hostAdoptHelp.stdout).toContain("Run without --yes to verify only");
    expect(hostAdoptHelp.stdout).not.toContain("project-id");
    expect(hostDeployHelp.status).toBe(0);
    expect(hostDeployHelp.stdout).toContain("nautilo host deploy --backend railway --yes");
    expect(hostUpgradeHelp.status).toBe(0);
    expect(hostUpgradeHelp.stdout).toContain("--recovery-config");
    expect(hostUpgradeHelp.stdout).toContain("--yes");
    expect(hostUpgradeHelp.stdout.replace(/\s+/g, " ")).toContain("command stays attached while durable checkpoints advance");
    expect(hostUpgradeHelp.stdout).toContain("nautilo host upgrade --backend railway \\\n  --recovery-config <absolute-path> --yes");
    expect(hostResumeHelp.status).toBe(0);
    expect(hostResumeHelp.stdout).toContain("--recovery-config");
    expect(hostResumeHelp.stdout).toContain("--discard-replacement");
    expect(hostResumeHelp.stdout).toContain("nautilo host resume --backend railway --recovery-config <absolute-path>");
    expect(hostResumeHelp.stdout.replace(/\s+/g, " ")).toContain("command stays attached while safe checkpoints advance");
    expect(hostResumeHelp.stdout.replace(/\s+/g, " ").toLowerCase()).toContain("ordinary resume needs no confirmation");
    expect(hostDestroyHelp.status).toBe(0);
    expect(hostDestroyHelp.stdout).toContain("nautilo host destroy --backend railway --launch <launch-id> \\\n  --confirm-project <project-id>");
    expect(rootHelp.stdout).toContain("deploy");
    expect(rootHelp.stdout).toContain("upgrade");
    expect(deployHelp.status).toBe(0);
    expect(deployHelp.stdout).toContain("Deploy the active Docker Compose profile");
    expect(deployHelp.stdout).toContain("nautilo deploy --image <digest>");
    expect(deployHelp.stdout).not.toContain("from-registry");
    expect(upgradeHelp.status).toBe(0);
    expect(upgradeHelp.stdout).toContain("Safe upgrade: drain -> stop -> consistent backup");
  // This is a packaged-surface contract, not a latency assertion. It starts
  // six independent CLI processes and can exceed Bun's five-second default
  // while the monorepo pre-push gate is running package suites in parallel.
  // Keep this aligned with the repository's unit-test ceiling: the assertions
  // still fail immediately on incorrect output or a nonzero process exit.
  }, 60_000);

  test("strict packaged parsing rejects a raw Railway token without echoing its value", () => {
    const secret = "must-not-appear-in-output";
    const result = spawnCli([
      "host",
      "plan",
      "--backend",
      "railway",
      "--railway-token",
      secret,
      "--json",
    ], { NAUTILO_RAILWAY_OAUTH_PERSISTENCE: "memory" });

    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(result.stderr).toContain("Unknown arguments: railway-token");
  });

  test("packaged JSON planning uses the official client but never starts interactive Railway authorization", () => {
    const result = spawnCli([
      "host",
      "plan",
      "--backend",
      "railway",
      "--json",
    ], { NAUTILO_RAILWAY_OAUTH_PERSISTENCE: "memory" });

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout) as {
      readonly error: { readonly reason: string; readonly nextAction: string };
    };
    expect(payload.error).toMatchObject({
      reason: "reauthorization-required",
      nextAction: "run-in-interactive-terminal",
    });
  });
});
