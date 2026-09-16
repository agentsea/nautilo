import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateConfigEnvToInstanceEnv } from "../../src/paths";

describe("migrateConfigEnvToInstanceEnv (M091 rename)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("renames config.env to instance.env once; second call is no-op", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-rename-"));
    const from = join(dir, "config.env");
    const to = join(dir, "instance.env");
    writeFileSync(from, "K=v\n", { mode: 0o600 });

    const r1 = migrateConfigEnvToInstanceEnv(dir);
    expect(r1).toEqual({ renamed: true, from, to });
    expect(existsSync(from)).toBe(false);
    expect(existsSync(to)).toBe(true);

    const r2 = migrateConfigEnvToInstanceEnv(dir);
    expect(r2).toBeNull();
  });

  test("preserves file content and mode 0600 across rename (non-Windows)", () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-rename-"));
    const from = join(dir, "config.env");
    const body = "OPENAI_API_KEY=sk-x\n# c\n";
    writeFileSync(from, body, { mode: 0o600 });

    migrateConfigEnvToInstanceEnv(dir);
    const to = join(dir, "instance.env");
    expect(readFileSync(to, "utf8")).toBe(body);
    expect(statSync(to).mode & 0o777).toBe(0o600);
  });

  test("when instance.env already exists alongside config.env, does not touch either", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-rename-"));
    const configEnv = join(dir, "config.env");
    const instanceEnv = join(dir, "instance.env");
    writeFileSync(configEnv, "FROM_CONFIG=1\n", { mode: 0o600 });
    writeFileSync(instanceEnv, "FROM_INSTANCE=2\n", { mode: 0o600 });

    expect(migrateConfigEnvToInstanceEnv(dir)).toBeNull();
    expect(readFileSync(configEnv, "utf8")).toBe("FROM_CONFIG=1\n");
    expect(readFileSync(instanceEnv, "utf8")).toBe("FROM_INSTANCE=2\n");
  });
});
