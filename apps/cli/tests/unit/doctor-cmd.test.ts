import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const cliDist = join(import.meta.dirname, "..", "..", "dist", "index.js");

function spawnCli(
  args: string[],
  extraEnv?: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliDist, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("nautilo doctor (M091 Phase 7)", () => {
  beforeAll(() => {
    if (!existsSync(cliDist)) {
      throw new Error(`missing ${cliDist}; run bun run build in apps/cli first`);
    }
  });

  test("doctor without subcommand exits 2", () => {
    const r = spawnCli(["doctor"]);
    expect(r.status).toBe(2);
    const combined = `${r.stderr}\n${r.stdout}`;
    expect(combined).toMatch(/Specify a doctor subcommand/i);
  });

  test("doctor migrate-config --dry-run --home <tmp> with no secrets.env exits 0", () => {
    const home = join(tmpdir(), `ndoc-mig-${Date.now()}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const r = spawnCli(["doctor", "migrate-config", "--dry-run", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op-no-secrets-file");
  });

  test("doctor purge-consumed-bootstrap --dry-run --home <tmp> exits 0", () => {
    const home = join(tmpdir(), `ndoc-purge-${Date.now()}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const r = spawnCli(["doctor", "purge-consumed-bootstrap", "--dry-run", "--home", home]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("purgedCount=0");
  });
});
