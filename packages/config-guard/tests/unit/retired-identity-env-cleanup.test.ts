import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stripForbiddenKeysFromInstanceEnv,
  stripRetiredIdentityEnvVars,
} from "../../src/paths";

describe("stripForbiddenKeysFromInstanceEnv (M091 unified strip)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("removes retired identity + AUTH_MODE + setup-time prefixes while preserving other lines; writes 0600 .bak-m091-stale-keys backup", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-strip-"));
    const path = join(dir, "instance.env");
    writeFileSync(
      path,
      [
        "# keep comments",
        "OPENAI_API_KEY=sk-test",
        "NAUTILO_OWNER_ID=old-owner",
        "AUTH_MODE=logto",
        "NAUTILO_BOOTSTRAP_PIN_BETA=123456",
        "export NAUTILO_DEFAULT_AGENT_ID=old-agent",
        "NAUTILO_OWNER_ACTOR_ID=old-actor",
        "ANTHROPIC_API_KEY=ant-test",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = stripForbiddenKeysFromInstanceEnv(path, {
      now: new Date("2026-05-12T10:41:51.000Z"),
      auditLogPath: join(dir, "audit.jsonl"),
    });

    expect(result.removedKeys).toEqual([
      "AUTH_MODE",
      "NAUTILO_BOOTSTRAP_PIN_BETA",
      "NAUTILO_DEFAULT_AGENT_ID",
      "NAUTILO_OWNER_ACTOR_ID",
      "NAUTILO_OWNER_ID",
    ]);
    expect(result.backupPath).toBe(
      join(dir, "instance.env.bak-m091-stale-keys-20260512T104151Z"),
    );
    expect(readFileSync(path, "utf8")).toBe(
      ["# keep comments", "OPENAI_API_KEY=sk-test", "ANTHROPIC_API_KEY=ant-test", ""].join(
        "\n",
      ),
    );
    expect(readFileSync(result.backupPath!, "utf8")).toContain("NAUTILO_OWNER_ID=old-owner");

    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    }
  });

  test("is idempotent when the file is already clean", () => {
    dir = mkdtempSync(join(tmpdir(), "nautilo-m091-strip-"));
    const path = join(dir, "instance.env");
    writeFileSync(path, "OPENAI_API_KEY=sk-test\n", { mode: 0o600 });

    expect(stripForbiddenKeysFromInstanceEnv(path)).toEqual({
      removedKeys: [],
      backupPath: null,
    });
    expect(readFileSync(path, "utf8")).toBe("OPENAI_API_KEY=sk-test\n");
  });
});

describe("stripRetiredIdentityEnvVars (back-compat alias)", () => {
  test("matches stripForbiddenKeysFromInstanceEnv on identical inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-retired-alias-"));
    try {
      const p1 = join(dir, "a.env");
      const p2 = join(dir, "b.env");
      const body = "NAUTILO_OWNER_ID=x\nOPENAI_API_KEY=k\n";
      writeFileSync(p1, body, { mode: 0o600 });
      writeFileSync(p2, body, { mode: 0o600 });
      const ts = new Date("2026-01-02T03:04:05.000Z");
      const audit = join(dir, "audit.jsonl");
      const a = stripRetiredIdentityEnvVars(p1, { now: ts, auditLogPath: audit });
      const b = stripForbiddenKeysFromInstanceEnv(p2, { now: ts, auditLogPath: audit });
      expect(readFileSync(p1, "utf8")).toBe(readFileSync(p2, "utf8"));
      expect(a.removedKeys).toEqual(b.removedKeys);
      expect(a.removedKeys).toEqual(["NAUTILO_OWNER_ID"]);
      expect(a.backupPath).toContain(".bak-m091-stale-keys-");
      expect(b.backupPath).toContain(".bak-m091-stale-keys-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
