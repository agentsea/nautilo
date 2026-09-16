import { describe, test, expect } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import { createTask, type TaskCreateInput } from "../../src/tasks/create-task";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";

/**
 * Fake `db` satisfying only the chain `db.insert(tasks).values(input).returning()`
 * that the M141 `createTask` store helper uses. Echoes the inserted row so we
 * can assert the computed `nextFireAt` / `status`.
 */
function fakeDb(): { db: DirectDatabase; lastValues: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured = v;
        return {
          returning: async () => [{ id: "task-1", ...v }],
        };
      },
    }),
  } as unknown as DirectDatabase;
  return { db, lastValues: () => captured };
}

const baseInput = (over: Partial<TaskCreateInput> = {}): TaskCreateInput =>
  ({
    ownerId: "11111111-1111-1111-1111-111111111111",
    requestorId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    prompt: "do the thing",
    scheduleKind: "now",
    timezone: "UTC",
    depth: 0,
    ...over,
  }) as TaskCreateInput;

const accepted = () =>
  createAcceptedInvocationAuthority("11111111-1111-1111-1111-111111111111");

describe("M142 — createTask wrapper", () => {
  test("now-task: nextFireAt ≈ now and observer.kick() called", async () => {
    const { db } = fakeDb();
    let kicks = 0;
    const before = Date.now();
    const res = await createTask(
      { db, observer: { kick: () => void kicks++ }, invocationAuthority: accepted() },
      baseInput({ scheduleKind: "now" }),
    );
    expect(res.taskId).toBe("task-1");
    expect(res.status).toBe("pending");
    expect(res.nextFireAt).toBeInstanceOf(Date);
    expect(res.nextFireAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(res.nextFireAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(kicks).toBe(1);
  });

  test("one_shot: nextFireAt = runAt, no kick", async () => {
    const { db } = fakeDb();
    let kicks = 0;
    const runAt = new Date("2030-01-01T00:00:00Z");
    const res = await createTask(
      { db, observer: { kick: () => void kicks++ }, invocationAuthority: accepted() },
      baseInput({ scheduleKind: "one_shot", runAt }),
    );
    expect(res.nextFireAt!.toISOString()).toBe(runAt.toISOString());
    expect(kicks).toBe(0);
  });

  test("cron: nextFireAt computed via nextCronOccurrence, no kick", async () => {
    const { db } = fakeDb();
    let kicks = 0;
    const res = await createTask(
      { db, observer: { kick: () => void kicks++ }, invocationAuthority: accepted() },
      baseInput({ scheduleKind: "cron", cron: "0 9 * * *", timezone: "UTC" }),
    );
    // Next 09:00 UTC strictly after now.
    expect(res.nextFireAt!.getUTCHours()).toBe(9);
    expect(res.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
    expect(kicks).toBe(0);
  });

  test("depth >= MAX_SUBAGENT_DEPTH rejects", () => {
    const { db } = fakeDb();
    return expect(
      createTask(
        { db, observer: { kick: () => {} } },
        baseInput({ depth: 5 }),
      ),
    ).rejects.toThrow(/depth cap exceeded/);
  });

  test("one_shot without runAt rejects", () => {
    const { db } = fakeDb();
    return expect(
      createTask(
        { db, observer: { kick: () => {} } },
        baseInput({ scheduleKind: "one_shot" }),
      ),
    ).rejects.toThrow(/requires runAt/);
  });

  test("requires accepted invocation authority before inserting", async () => {
    const { db, lastValues } = fakeDb();
    try {
      await createTask(
        { db, observer: { kick: () => {} } },
        baseInput(),
      );
      throw new Error("expected createTask to reject");
    } catch (error) {
      expect(String(error)).toContain("accepted invocation authority");
    }
    expect(lastValues()).toEqual({});
  });

  test("rejects accepted authority bound to another Human", async () => {
    const { db, lastValues } = fakeDb();
    try {
      await createTask(
        {
          db,
          observer: { kick: () => {} },
          invocationAuthority: createAcceptedInvocationAuthority(
            "99999999-9999-9999-9999-999999999999",
          ),
        },
        baseInput(),
      );
      throw new Error("expected createTask to reject");
    } catch (error) {
      expect(String(error)).toContain("subject mismatch");
    }
    expect(lastValues()).toEqual({});
  });
});
