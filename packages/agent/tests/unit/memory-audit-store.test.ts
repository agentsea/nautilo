import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  emitMemoryAudit,
  setMemoryAuditSink,
  withMemoryAudit,
  type MemoryAuditSinkInput,
} from "../../src/store/memory-write-access";

describe("memory store audit sink", () => {
  const auditRows: MemoryAuditSinkInput[] = [];
  const sink = mock((evt: MemoryAuditSinkInput) => {
    auditRows.push(evt);
  });

  beforeEach(() => {
    auditRows.length = 0;
    sink.mockClear();
    setMemoryAuditSink(sink);
  });

  afterEach(() => {
    setMemoryAuditSink(null);
  });

  test("emitMemoryAudit forwards edit events to the sink", () => {
    emitMemoryAudit({
      kind: "memory.edit",
      memoryId: "mem-1",
      action: "replace",
      outcome: "success",
      actorId: "user-1",
      ip: "127.0.0.1",
    });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]).toMatchObject({
      kind: "memory.edit",
      memoryId: "mem-1",
      action: "replace",
      outcome: "success",
    });
  });

  test("withMemoryAudit emits failure rows from store mutators", async () => {
    let threw = false;
    try {
      await withMemoryAudit(
        { kind: "memory.delete", memoryId: "mem-2", mode: "archive" },
        { actorId: "user-2", ip: "" },
        async () => {
          throw new Error("boom");
        },
      );
    } catch (err) {
      threw = err instanceof Error && err.message === "boom";
    }
    expect(threw).toBe(true);
    expect(auditRows.some((r) => r.outcome === "failure" && r.memoryId === "mem-2")).toBe(true);
  });
});
