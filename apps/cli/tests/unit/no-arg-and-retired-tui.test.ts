import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(THIS_DIR, "../../src/index.ts");
const TUI_PACKAGE_PATH = resolve(THIS_DIR, "../../../tui/package.json");
const TUI_ENTRYPOINT_PATH = resolve(THIS_DIR, "../../../tui/src/index.tsx");

describe("nautilo administrator command surface", () => {
  test("$0 prints help and the retired TUI has no command or runtime", async () => {
    const src = await Bun.file(INDEX_PATH).text();
    expect(src).not.toContain('"tui"');
    expect(src).not.toContain("runtime-tui");
    expect(src).not.toContain("runTui");
    // Ignored tool caches can preserve the retired directory in an existing
    // worktree. Pin the product surfaces whose presence would make it live.
    expect(existsSync(TUI_PACKAGE_PATH)).toBe(false);
    expect(existsSync(TUI_ENTRYPOINT_PATH)).toBe(false);
    expect(src).toMatch(/\$0[\s\S]*?showHelp/);
    expect(src).toContain("Print administrator command help.");
  });

  test("tui is rejected as an unknown command", async () => {
    const proc = Bun.spawn([process.execPath, INDEX_PATH, "tui"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Unknown argument: tui");
  });
});
