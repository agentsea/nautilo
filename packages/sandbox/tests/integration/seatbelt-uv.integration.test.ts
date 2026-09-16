import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { buildSandboxExec } from "../../src/seatbelt";
import type { SandboxConfig } from "../../src/types";

function baseConfig(): SandboxConfig {
  return {
    mode: "enabled",
    writablePaths: [],
    projectPaths: [],
    passthroughEnv: [],
  };
}

function findOnPath(executable: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

describe("sandbox-exec + uv integration (Darwin only)", () => {
  const shouldRun = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

  if (!shouldRun) {
    test.skip("skipped outside Darwin sandbox-exec hosts", () => {});
    return;
  }

  test("uv can canonicalize /usr/bin/python3 when present", () => {
    const uv = findOnPath("uv");
    const python = "/usr/bin/python3";
    if (uv === null || !existsSync(python)) return;
    const uvReal = realpathSync(uv);
    const ws = mkdtempSync(join(tmpdir(), "sbpl-live-uv-system-python-"));
    const real = realpathSync(ws);
    const dataDir = join(ws, ".nautilo");
    mkdirSync(dataDir);

    const wrapped = buildSandboxExec({
      workspace: ws,
      dataDir,
      toolsBin: dirname(uvReal),
      config: baseConfig(),
      cwd: real,
      commandEnv: {},
      program: "/bin/sh",
      args: [
        "-c",
        `UV_CACHE_DIR="$PWD/.uvcache" ${JSON.stringify(uvReal)} venv --python /usr/bin/python3 .venv`,
      ],
    });

    const r = spawnSync(
      wrapped.program,
      [...wrapped.args],
      { cwd: wrapped.cwd, encoding: "utf8", env: wrapped.env ?? undefined },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Creating virtual environment");
  });
});
