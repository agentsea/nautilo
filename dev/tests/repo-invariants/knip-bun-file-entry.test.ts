import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Knip accepts an explicit Bun test file without scanning it as a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "nautilo-knip-file-"));
  const knip = resolve(import.meta.dir, "../../../node_modules/knip/bin/knip.js");
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "knip-file-fixture", private: true, type: "module",
      scripts: { test: "bun test example.test.js" },
    }));
    writeFileSync(join(root, "example.test.js"), "console.log('fixture');\n");
    const result = spawnSync("node", [knip, "--directory", root, "--no-progress"], {
      cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
