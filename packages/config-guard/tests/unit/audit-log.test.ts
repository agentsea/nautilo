import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { appendAuditEntry, readAuditLog } from "../../src/audit-log";

describe("audit-log", () => {
  let dir: string | undefined;
  let logPath: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
      logPath = undefined;
    }
  });

  test("append and readAuditLog round-trip", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-audit-"));
    logPath = join(dir, "audit.jsonl");
    await appendAuditEntry(logPath, {
      ts: "2026-01-01T00:00:00Z",
      actor: "test",
      reason: "unit",
      ops: [{ type: "set", key: "A" }],
      result: "rejected",
      error: "bad",
    });
    await appendAuditEntry(logPath, {
      ts: "2026-01-01T00:00:01Z",
      actor: "test",
      reason: "unit2",
      ops: [{ type: "set", key: "B" }],
      result: "applied",
      snapshot: "snap-1",
    });
    const lines = await readFile(logPath, "utf-8");
    expect(lines.trim().split("\n").length).toBe(2);

    const last1 = await readAuditLog(logPath, 1);
    expect(last1.length).toBe(1);
    expect(last1[0]?.result).toBe("applied");
    expect(last1[0]?.ops[0]?.key).toBe("B");

    const all = await readAuditLog(logPath, 100);
    expect(all.length).toBe(2);
    expect(all[0]?.result).toBe("rejected");
  });

  test("readAuditLog on missing file returns empty array", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-audit-"));
    const missing = join(dir, "nope.jsonl");
    const rows = await readAuditLog(missing, 10);
    expect(rows).toEqual([]);
  });

  test("readAuditLog with limit 0 returns empty array", async () => {
    dir = await mkdtemp(join(tmpdir(), "cg-audit-"));
    logPath = join(dir, "audit.jsonl");
    await appendAuditEntry(logPath, {
      ts: "2026-01-01T00:00:00Z",
      actor: "test",
      reason: "unit",
      ops: [{ type: "set", key: "A" }],
      result: "applied",
    });
    const rows = await readAuditLog(logPath, 0);
    expect(rows).toEqual([]);
  });
});
