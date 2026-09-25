import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createModerationAuditSink } from "../../src/lib/moderation-recovery";
import { readSecurityAuditLog } from "../../src/lib/security-audit-log";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "moderation-audit-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const event = { operationId: "operation", requesterUserId: "human", subjectId: "subject",
  action: "ban" as const, roomId: null, createdAt: "2026-01-01T00:00:00.000Z" };

describe("durable moderation audit projection", () => {
  test("retry after a lost checkpoint writes once, including across rotation and compression", async () => {
    const path = join(dir, "audit.log");
    await createModerationAuditSink(path)(event);
    renameSync(path, `${path}.1`);
    writeFileSync(`${path}.2.gz`, gzipSync(readFileSync(`${path}.1`)));
    rmSync(`${path}.1`);
    await createModerationAuditSink(path)(event);
    const result = readSecurityAuditLog(path, { kinds: ["moderation_action"], correlationId: event.operationId });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({ kind: "moderation_action", ts: event.createdAt,
      correlationId: event.operationId, requesterUserId: event.requesterUserId,
      subjectId: event.subjectId, action: "ban", roomId: null, actorId: null, ip: "unknown", userAgent: undefined });
  });

  test("operation id collision cannot acknowledge a different decision", async () => {
    const sink = createModerationAuditSink(join(dir, "audit.log"));
    await sink(event);
    await Promise.resolve(expect(sink({ ...event, action: "kick" })).rejects.toThrow("operation conflict"));
  });

  test("strict redaction ignores extra private fields supplied by an internal caller", async () => {
    const path = join(dir, "audit.log");
    const input = { ...event, reason: "private reason", privateNote: "private note", identityDigest: "secret digest" };
    await createModerationAuditSink(path)(input);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("private"); expect(raw).not.toContain("digest");
  });

  test("unreadable compressed history and interrupted writes fail closed without another append", async () => {
    const path = join(dir, "audit.log");
    const sink = createModerationAuditSink(path);
    writeFileSync(`${path}.1.gz`, "corrupt compression");
    await Promise.resolve(expect(sink(event)).rejects.toThrow());
    rmSync(`${path}.1.gz`);
    writeFileSync(path, '{"kind":"moderation_action"');
    const before = readFileSync(path, "utf8");
    await Promise.resolve(expect(sink(event)).rejects.toThrow("malformed"));
    expect(readFileSync(path, "utf8")).toBe(before);
    writeFileSync(path, JSON.stringify({ kind: "other" }));
    await Promise.resolve(expect(sink(event)).rejects.toThrow("incomplete append"));
  });
});
