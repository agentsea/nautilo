import { describe, test, expect } from "bun:test";
import type { DirectDatabase, Task } from "@nautilo/db";
import type { LocalExecutionDelegation } from "@nautilo/types";
import { createTask, type TaskCreateInput } from "../../src/tasks/create-task";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  createHumanApiTaskCreationProvenance,
  getPlaintextTaskCreationAdmission,
  type TaskCreationAdmissionPort,
} from "../../src/tasks/task-creation-admission";

/**
 * Fake `db` satisfying only the chain `db.insert(tasks).values(input).returning()`
 * that the `createTask` store helper uses. Echoes the inserted row so we
 * can assert the computed `nextFireAt` / `status`.
 */
function fakeDb(readParent?: () => Task | undefined): { db: DirectDatabase; lastValues: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => {
      const parent = readParent?.();
      return parent ? [parent] : [];
    } }) }) }),
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
    id: "task-1",
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

const taskDeps = (db: DirectDatabase, observer: { kick(): void }) => ({
  db,
  observer,
  invocationAuthority: accepted(),
  provenance: createHumanApiTaskCreationProvenance({
    ownerId: "11111111-1111-1111-1111-111111111111",
  }),
  admission: getPlaintextTaskCreationAdmission(),
  assertInvocation: async () => {},
  assertServerFunding: async () => {},
});

describe("Task creation wrapper", () => {
  test("now-task: nextFireAt ≈ now and observer.kick() called", async () => {
    const { db } = fakeDb();
    let kicks = 0;
    const before = Date.now();
    const res = await createTask(
      taskDeps(db, { kick: () => void kicks++ }),
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
      taskDeps(db, { kick: () => void kicks++ }),
      baseInput({ scheduleKind: "one_shot", runAt }),
    );
    expect(res.nextFireAt!.toISOString()).toBe(runAt.toISOString());
    expect(kicks).toBe(0);
  });

  test("cron: nextFireAt computed via nextCronOccurrence, no kick", async () => {
    const { db } = fakeDb();
    let kicks = 0;
    const res = await createTask(
      taskDeps(db, { kick: () => void kicks++ }),
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
        taskDeps(db, { kick: () => {} }),
        baseInput({ depth: 5 }),
      ),
    ).rejects.toThrow(/depth cap exceeded/);
  });

  test("one_shot without runAt rejects", () => {
    const { db } = fakeDb();
    return expect(
      createTask(
        taskDeps(db, { kick: () => {} }),
        baseInput({ scheduleKind: "one_shot" }),
      ),
    ).rejects.toThrow(/requires runAt/);
  });

  test("requires accepted invocation authority before inserting", async () => {
    const { db, lastValues } = fakeDb();
    const { invocationAuthority: _invocationAuthority, ...deps } = taskDeps(
      db,
      { kick: () => {} },
    );
    try {
      await createTask(
        deps,
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
          provenance: createHumanApiTaskCreationProvenance({
            ownerId: "11111111-1111-1111-1111-111111111111",
          }),
          admission: getPlaintextTaskCreationAdmission(),
          assertInvocation: async () => {},
          assertServerFunding: async () => {},
        },
        baseInput(),
      );
      throw new Error("expected createTask to reject");
    } catch (error) {
      expect(String(error)).toContain("subject mismatch");
    }
    expect(lastValues()).toEqual({});
  });

  test("rejects structurally forged creation provenance before inserting", async () => {
    const { db, lastValues } = fakeDb();
    try {
      await createTask({
        ...taskDeps(db, { kick: () => {} }),
        provenance: {
          kind: "human_api",
          ownerId: "11111111-1111-1111-1111-111111111111",
          requestedParentTaskId: null,
        },
      }, baseInput());
      throw new Error("expected createTask to reject");
    } catch (error) {
      expect(String(error)).toContain("server-authored provenance");
    }
    expect(lastValues()).toEqual({});
  });

  test("keeps a prepared protected root dark before protected persistence exists", async () => {
    const { db, lastValues } = fakeDb();
    const protectedAdmission: TaskCreationAdmissionPort<unknown> = {
      admit: async () => ({ kind: "protected", prepared: Object.freeze({}) }),
    };
    try {
      await createTask({
        ...taskDeps(db, { kick: () => {} }),
        admission: protectedAdmission,
      }, baseInput());
      throw new Error("expected createTask to reject");
    } catch (error) {
      expect(error).toMatchObject({
        name: "TaskCreationUnavailableError",
        reason: "task_shape_unsupported",
      });
    }
    expect(lastValues()).toEqual({});
  });

  test("a revoked exact-target grant creates no Task", async () => {
    const { db, lastValues } = fakeDb();
    let checkedAgentId: string | undefined;
    expect(createTask({
      ...taskDeps(db, { kick: () => {} }),
      assertInvocation: async (input) => {
        checkedAgentId = input.agentId;
        throw new Error("invocation denied");
      },
    }, baseInput())).rejects.toThrow("invocation denied");
    expect(checkedAgentId).toBe("22222222-2222-2222-2222-222222222222");
    expect(lastValues()).toEqual({});
  });
});

const delegatedSource = {
  version: 1,
  humanUserId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
  sourceRoomId: "original-room", sourceConversationId: "original-thread",
  rootTaskId: "parent-task", projectGrantId: "task-project-grant",
  target: { instanceId: "", relayId: "relay", pairingGeneration: "pairing",
    serverOrigin: "https://server.example", serverFingerprint: "fingerprint" },
  ceiling: "basic", profile: null,
} satisfies LocalExecutionDelegation;
function parentTask(patch: Partial<Task> = {}): Task {
  return { ...baseInput(), id: "parent-task", parentTaskId: null, status: "completed",
    callingRoomId: "original-room", targetRoomId: "task-room", contentRevision: 0,
    localExecutionDelegation: delegatedSource, ...patch } as Task;
}
test("nested creation preserves the original source through its canonical parent Task Room", async () => {
  const { db, lastValues } = fakeDb(() => parentTask());
  await createTask({ ...taskDeps(db, { kick() {} }), captureLocalExecution: async () => delegatedSource },
    baseInput({ parentTaskId: "parent-task", callingRoomId: "task-room", depth: 1 }));
  expect(lastValues()["localExecutionDelegation"]).toEqual(delegatedSource);
});
test("resumed orphan parent accepts its original calling Room with persisted descriptor key order", async () => {
  // PostgreSQL JSONB returns a different key order from the initial capture.
  // The source port inherits that same persisted descriptor when resuming.
  const persisted: LocalExecutionDelegation = {
    profile: delegatedSource.profile,
    ceiling: delegatedSource.ceiling,
    projectGrantId: delegatedSource.projectGrantId,
    target: {
      serverFingerprint: delegatedSource.target.serverFingerprint,
      serverOrigin: delegatedSource.target.serverOrigin,
      pairingGeneration: delegatedSource.target.pairingGeneration,
      relayId: delegatedSource.target.relayId,
      instanceId: delegatedSource.target.instanceId,
    },
    rootTaskId: delegatedSource.rootTaskId,
    sourceConversationId: delegatedSource.sourceConversationId,
    sourceRoomId: delegatedSource.sourceRoomId,
    agentId: delegatedSource.agentId,
    humanUserId: delegatedSource.humanUserId,
    version: delegatedSource.version,
  };
  const inherited: LocalExecutionDelegation = { ...persisted, agentId: delegatedSource.agentId };
  const { db, lastValues } = fakeDb(() => parentTask({ status: "running", targetChat: "orphan",
    localExecutionDelegation: persisted }));
  await createTask({ ...taskDeps(db, { kick() {} }), captureLocalExecution: async () => inherited },
    baseInput({ parentTaskId: "parent-task", callingRoomId: "original-room", depth: 1 }));
  expect(lastValues()["localExecutionDelegation"]).toEqual(delegatedSource);
  expect(lastValues()["callingRoomId"]).toBe("original-room");
});
test("nested capture refuses missing, changed, cancelled or wrong-subject parents before insert", async () => {
  const { rejects } = await import("node:assert/strict");
  for (const parent of [undefined, parentTask({ status: "cancelled" }),
    parentTask({ targetRoomId: "other-room" }),
    parentTask({ agentId: "other-agent" }),
    parentTask({ localExecutionDelegation: null })]) {
    const { db, lastValues } = fakeDb(() => parent);
    await rejects(createTask({ ...taskDeps(db, { kick() {} }), captureLocalExecution: async () => delegatedSource },
      baseInput({ parentTaskId: "parent-task", callingRoomId: "task-room", depth: 1 })), /parent lineage/);
    expect(lastValues()).toEqual({});
  }
});
test("nested capture closes a definition change while parent reads were awaiting", async () => {
  const { rejects } = await import("node:assert/strict");
  let reads = 0;
  const { db, lastValues } = fakeDb(() => ++reads === 1 ? parentTask() : parentTask({ localExecutionDelegation: null }));
  await rejects(createTask({ ...taskDeps(db, { kick() {} }), captureLocalExecution: async () => delegatedSource },
    baseInput({ parentTaskId: "parent-task", callingRoomId: "task-room", depth: 1 })), /parent lineage/);
  expect(lastValues()).toEqual({});
});
