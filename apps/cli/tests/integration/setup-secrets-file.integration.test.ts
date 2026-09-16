import { describe, test, expect, beforeAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const cliDist = join(import.meta.dirname, "..", "..", "dist", "index.js");

describe("nautilo setup --secrets-file (§13.4 integration)", () => {
  beforeAll(() => {
    if (!existsSync(cliDist)) {
      throw new Error(`missing ${cliDist}; run bun run build in apps/cli first`);
    }
  });

  test.skipIf(process.platform === "win32")("secrets file mode 0644 exits 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-sf-"));
    const secrets = join(dir, "bad.env");
    writeFileSync(secrets, "OPENAI_API_KEY=x\n");
    chmodSync(secrets, 0o644);
    const toml = join(dir, "setup.toml");
    writeFileSync(
      toml,
      [
        "schemaVersion = 1",
        "[admin]",
        'handle = "owner"',
        'displayName = "Owner"',
        'password = { value = "longenough1" }',
        'pin = { value = "654321" }',
        "[claim]",
        'inviteCode = { value = "tok" }',
      ].join("\n"),
    );
    chmodSync(toml, 0o600);
    const r = spawnSync(
      process.execPath,
      [cliDist, "setup", "--file", toml, "--secrets-file", secrets, "--server", "http://127.0.0.1:9"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(import.meta.dirname, "..", ".."),
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/mode 0600/);
  });

  test("non-loopback serverUrl exits 2 even with --secrets-file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-sf-"));
    const secrets = join(dir, "sec.env");
    writeFileSync(secrets, "OPENAI_API_KEY=x\n", { mode: 0o600 });
    try {
      chmodSync(secrets, 0o600);
    } catch {
      /* win32 */
    }
    const toml = join(dir, "setup.toml");
    writeFileSync(
      toml,
      [
        "schemaVersion = 1",
        'serverUrl = "http://example.com"',
        "[admin]",
        'handle = "owner"',
        'displayName = "Owner"',
        'password = { value = "longenough1" }',
        'pin = { value = "654321" }',
        "[claim]",
        'inviteCode = { value = "tok" }',
      ].join("\n"),
    );
    try {
      chmodSync(toml, 0o600);
    } catch {
      /* win32 */
    }
    const r = spawnSync(
      process.execPath,
      [cliDist, "setup", "--file", toml, "--secrets-file", secrets],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(import.meta.dirname, "..", ".."),
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("loopback");
  });
});
