import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cliRoot = join(import.meta.dirname, "..", "..");
const cliDist = join(cliRoot, "dist", "index.js");
const packagedComposeTemplate = join(
  cliRoot,
  "dist",
  "deploy",
  "compose-driver",
  "templates",
  "docker-compose.yml",
);
const packagedPostgresInit = join(cliRoot, "dist", "infra", "postgres-init.sh");
const packagedHostProbe = join(cliRoot, "dist", "host-bundle-probe.cjs");

function spawnCli(args: string[]) {
  return spawnSync(process.execPath, [cliDist, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("nautilo --version", () => {
  beforeAll(() => {
    if (!existsSync(cliDist)) {
      throw new Error(`missing ${cliDist}; run bun run build in apps/cli first`);
    }
  });

  test("build copies compose deploy runtime assets into dist", () => {
    expect(existsSync(packagedComposeTemplate)).toBe(true);
    expect(existsSync(packagedPostgresInit)).toBe(true);
    expect(existsSync(packagedHostProbe)).toBe(true);
  });

  test("--version matches package.json versions", () => {
    const cliPkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const apiPkg = JSON.parse(
      readFileSync(join(cliRoot, "..", "..", "packages", "api-client", "package.json"), "utf8"),
    ) as { version: string };
    const expected = `nautilo ${cliPkg.version} (api ${apiPkg.version})`;
    const r = spawnCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(expected);
    const h = spawnCli(["--help"]);
    expect(h.status).toBe(0);
    expect(h.stdout).toContain(expected);
  }, 15000);
});
