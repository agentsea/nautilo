/**
 * D418 3.2.1 — live Linux bubblewrap proof for protected file + directory
 * masks. This is deliberately an integration test: argv shape alone cannot
 * establish that bwrap's later file/directory mounts hide the original data.
 *
 * Skips where bwrap/user namespaces are unavailable. Packaged Linux CI must
 * provide bwrap and executes this proof; a host without the capability is
 * covered by the detector + guarded-shell preflight refusal tests.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBubblewrap } from "../../src/bubblewrap";

const hasUsableBwrap =
  process.platform === "linux" &&
  spawnSync("bwrap", ["--version"], { encoding: "utf8" }).status === 0;

describe("D418 protected paths — live bubblewrap", () => {
  if (!hasUsableBwrap) {
    test.skip("requires usable Linux bubblewrap", () => {});
    return;
  }

  test("a trusted empty file mask hides file data and tmpfs hides protected directories", () => {
    const workspace = mkdtempSync(join(tmpdir(), "bwrap-protected-ws-"));
    const readRoot = mkdtempSync(join(tmpdir(), "bwrap-protected-read-"));
    const protectedDir = join(readRoot, "private-dir");
    const protectedFile = join(readRoot, "private-file");
    const publicFile = join(readRoot, "public-file");
    const mask = join(workspace, ".trusted-empty-mask");
    mkdirSync(protectedDir, { recursive: true });
    writeFileSync(join(protectedDir, "secret"), "directory-secret");
    writeFileSync(protectedFile, "file-secret");
    writeFileSync(publicFile, "public");
    writeFileSync(mask, "");

    const wrapped = buildBubblewrap({
      workspace,
      dataDir: join(workspace, "data"),
      toolsBin: "/usr/bin",
      procSupported: true,
      fileMaskSupported: true,
      config: {
        mode: "enabled",
        writablePaths: [],
        projectPaths: [],
        readOnlyPaths: [readRoot],
        passthroughEnv: [],
        protectedPaths: [protectedDir, protectedFile],
        protectedFileMaskPath: mask,
      },
      cwd: workspace,
      commandEnv: {},
      program: "/bin/sh",
      args: [
        "-c",
        `test ! -e "${protectedDir}/secret" && ` +
          `test "$(cat "${protectedFile}")" = "" && ` +
          `test "$(cat "${publicFile}")" = "public"`,
      ],
    });

    const result = spawnSync(wrapped.program, [...wrapped.args], {
      cwd: wrapped.cwd,
      env: wrapped.env ?? undefined,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
});
