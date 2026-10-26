import { installTaskFundingPort, uninstallTaskFundingPort } from "../../src/task-funding-port";
import { describe, test, expect } from "bun:test";
import { rejects } from "node:assert/strict";
import type { DirectDatabase, Task } from "@nautilo/db";
import type { LocalExecutionDelegation } from "@nautilo/types";
import {
  createTask,
  prepareTaskCreation,
  type TaskCreateInput,
} from "../../src/tasks/create-task";
import { runWithAcceptedInvocationAuthority } from "../../src/job-manager";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import {
  createHumanApiTaskCreationProvenance,
  createAgentTurnTaskCreationProvenance,
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

const protectedAdmission = <Prepared>(
  prepared: Prepared,
): TaskCreationAdmissionPort<Prepared> => ({
  admit: async () => ({ kind: "protected", prepared }),
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

  test("Plain creation never calls the protected publisher", async () => {
    const { db } = fakeDb();
    let publications = 0;
    const result = await createTask({
      ...taskDeps(db, { kick() {} }),
      publishProtected: async () => {
        publications += 1;
        throw new Error("unexpected protected publication");
      },
      resolveProtectedIdentity: () => { throw new Error("unexpected protected identity"); },
    }, baseInput());
    expect(result.taskId).toBe("task-1");
    expect(publications).toBe(0);
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
    let publications = 0;
    try {
      await createTask({
        ...taskDeps(db, { kick: () => {} }),
        admission: protectedAdmission(Object.freeze({ plan: "protected" })),
        publishProtected: async () => {
          publications += 1;
          throw new Error("unexpected protected publication");
        },
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
    expect(publications).toBe(0);
  });

  test("keeps a prepared protected root dark before protected persistence exists", async () => {
    const { db, lastValues } = fakeDb();
    let captures = 0;
    try {
      await createTask({
        ...taskDeps(db, { kick: () => {} }),
        admission: protectedAdmission(Object.freeze({})),
        captureLocalExecution: async () => {
          captures += 1;
          return null;
        },
      }, baseInput());
      throw new Error("expected createTask to reject");
    } catch (error) {
      expect(error).toMatchObject({
        name: "TaskCreationUnavailableError",
        reason: "task_shape_unsupported",
      });
    }
    expect(lastValues()).toEqual({});
    expect(captures).toBe(0);
  });

  test("publishes a protected Task with the exact captured identity and no ordinary insert", async () => {
    const { db, lastValues } = fakeDb();
    const prepared = Object.freeze({ plan: "protected" as const });
    const delegation = Object.freeze({
      version: 1 as const,
      humanUserId: "11111111-1111-1111-1111-111111111111",
      agentId: "22222222-2222-2222-2222-222222222222",
      sourceRoomId: "33333333-3333-3333-3333-333333333333",
      sourceConversationId: "44444444-4444-4444-4444-444444444444",
      rootTaskId: "task-1",
      projectGrantId: "55555555-5555-5555-5555-555555555555",
      target: Object.freeze({
        instanceId: "instance",
        relayId: "relay",
        pairingGeneration: "pairing",
        serverOrigin: "https://server.example",
        serverFingerprint: "fingerprint",
      }),
      ceiling: "basic" as const,
      profile: null,
    }) satisfies LocalExecutionDelegation;
    let capturedTaskId: string | undefined;
    let publishedCandidate: Record<string, unknown> | undefined;
    const result = await createTask({
      ...taskDeps(db, { kick() {} }),
      admission: protectedAdmission(prepared),
      captureLocalExecution: async candidate => {
        capturedTaskId = candidate.id;
        return delegation;
      },
      publishProtected: async publication => {
        expect(publication.prepared).toBe(prepared);
        publishedCandidate = publication.candidate;
        return {
          taskId: publication.candidate.id,
          status: publication.candidate.status,
          nextFireAt: publication.candidate.nextFireAt,
        };
      },
    }, baseInput({
      callingRoomId: "33333333-3333-3333-3333-333333333333",
    }));
    expect(result.taskId).toBe("task-1");
    expect(capturedTaskId).toBe("task-1");
    expect(publishedCandidate).toMatchObject({
      id: "task-1",
      status: "pending",
      fundingMode: "legacy_server",
      localExecutionDelegation: delegation,
    });
    expect(publishedCandidate?.["nextFireAt"]).toBeInstanceOf(Date);
    expect(lastValues()).toEqual({});
  });

  test("publishes a foreign-owned Genie Task under the admitted requester identity", async () => {
    const { db, lastValues } = fakeDb();
    const input = baseInput({ ownerId: "foreign-room-owner" });
    const identity = { ownerId: input.requestorId, requestorId: input.requestorId, agentId: input.agentId };
    let capturedOwner: string | undefined;
    let publishedOwner: string | undefined;
    await createTask({
      ...taskDeps(db, { kick() {} }),
      provenance: createAgentTurnTaskCreationProvenance({ ownerId: input.ownerId,
        invocation: { ownerId: input.ownerId, roomId: "room", entrypoint: "foreground.main" } }),
      admission: { admit: () => Promise.resolve({ kind: "protected" as const,
        prepared: Object.freeze({}), canonicalTaskIdentity: identity }) },
      captureLocalExecution: candidate => { capturedOwner = candidate.ownerId; return Promise.resolve(null); },
      publishProtected: ({ candidate }) => {
        publishedOwner = candidate.ownerId;
        return Promise.resolve({ taskId: candidate.id, status: candidate.status, nextFireAt: candidate.nextFireAt });
      },
    }, input);
    expect(capturedOwner).toBe(input.requestorId);
    expect(publishedOwner).toBe(input.requestorId);
    expect(input.ownerId).toBe("foreign-room-owner");
    expect(lastValues()).toEqual({});
  });

  test("a failed protected publication leaves the observer asleep", async () => {
    const { db, lastValues } = fakeDb();
    let kicks = 0;
    await rejects(createTask({
      ...taskDeps(db, { kick: () => void kicks++ }),
      admission: protectedAdmission(Object.freeze({ plan: "protected" })),
      publishProtected: async () => { throw new Error("publication failed"); },
    }, baseInput()), /publication failed/);
    expect(kicks).toBe(0);
    expect(lastValues()).toEqual({});
  });

  test("a protected publisher cannot substitute the Task identity", async () => {
    const { db, lastValues } = fakeDb();
    let kicks = 0;
    await rejects(createTask({
      ...taskDeps(db, { kick: () => void kicks++ }),
      admission: protectedAdmission(Object.freeze({ plan: "protected" })),
      publishProtected: async ({ candidate }) => ({
        taskId: "different-task",
        status: candidate.status,
        nextFireAt: candidate.nextFireAt,
      }),
    }, baseInput()), /different Task identity/);
    expect(kicks).toBe(0);
    expect(lastValues()).toEqual({});
  });

  test("a revoked exact-target grant creates no Task", async () => {
    const { db, lastValues } = fakeDb();
    let checkedAgentId: string | undefined;
    let publications = 0;
    await rejects(createTask({
      ...taskDeps(db, { kick: () => {} }),
      admission: protectedAdmission(Object.freeze({ plan: "protected" })),
      publishProtected: async () => {
        publications += 1;
        throw new Error("unexpected protected publication");
      },
      assertInvocation: async (input) => {
        checkedAgentId = input.agentId;
        throw new Error("invocation denied");
      },
    }, baseInput()), /invocation denied/);
    expect(checkedAgentId).toBe("22222222-2222-2222-2222-222222222222");
    expect(lastValues()).toEqual({});
    expect(publications).toBe(0);
  });

  test("a denied funding source cannot reach protected publication", async () => {
    const { db, lastValues } = fakeDb();
    let publications = 0;
    await rejects(createTask({
      ...taskDeps(db, { kick() {} }),
      admission: protectedAdmission(Object.freeze({ plan: "protected" })),
      assertServerFunding: async () => { throw new Error("funding denied"); },
      publishProtected: async () => {
        publications += 1;
        throw new Error("unexpected protected publication");
      },
    }, baseInput()), /funding denied/);
    expect(publications).toBe(0);
    expect(lastValues()).toEqual({});
  });

  test("prepared protected creation completes global checks before the borrowed transaction", async () => {
    const { db, lastValues } = fakeDb();
    const input = baseInput({ metadata: { exact: "candidate" } });
    const provenance = createHumanApiTaskCreationProvenance({ ownerId: input.ownerId });
    const authority = accepted();
    const events: string[] = [];
    let transactionBorrowed = false;
    let publishedFunding: string | undefined;
    let checkedAgentId: string | undefined;
    let releaseInvocation!: () => void;
    let markInvocationStarted!: () => void;
    const invocationStarted = new Promise<void>(resolve => { markInvocationStarted = resolve; });
    const invocationReleased = new Promise<void>(resolve => { releaseInvocation = resolve; });

    await runWithAcceptedInvocationAuthority(authority, async () => {
      const pending = prepareTaskCreation(input, provenance, {
        assertInvocation: async candidate => {
          expect(transactionBorrowed).toBe(false);
          checkedAgentId = candidate.agentId;
          expect(candidate).toEqual({
            humanUserId: "11111111-1111-1111-1111-111111111111",
            origin: "task_create",
            agentId: "22222222-2222-2222-2222-222222222222",
          });
          events.push("invocation");
          markInvocationStarted();
          await invocationReleased;
        },
        prepareFunding: async (candidate, source) => {
          expect(transactionBorrowed).toBe(false);
          expect(candidate).not.toBe(input);
          expect(candidate.agentId).toBe("22222222-2222-2222-2222-222222222222");
          expect(candidate.metadata).toEqual({ exact: "candidate" });
          expect(source).toBe(provenance);
          events.push("funding");
          return false;
        },
        assertServerFunding: async (humanUserId, origin) => {
          expect(transactionBorrowed).toBe(false);
          expect([humanUserId, origin]).toEqual([input.requestorId, "task_create"]);
          events.push("server-funding");
        },
      });
      await invocationStarted;
      input.agentId = "22222222-2222-2222-2222-222222222299";
      input.metadata = { exact: "mutated-during-await" };
      releaseInvocation();
      const prepared = await pending;

      transactionBorrowed = true;
      await prepared.create({
        db,
        observer: { kick() {} },
        admission: {
          admit: async ({ candidate }) => {
            expect(transactionBorrowed).toBe(true);
            expect(candidate.agentId).toBe("22222222-2222-2222-2222-222222222222");
            expect(candidate.metadata).toEqual({ exact: "candidate" });
            events.push("admission");
            return { kind: "protected" as const, prepared: Object.freeze({}) };
          },
        },
        publishProtected: async ({ candidate }) => {
          expect(transactionBorrowed).toBe(true);
          expect(candidate.agentId).toBe("22222222-2222-2222-2222-222222222222");
          expect(candidate.metadata).toEqual({ exact: "candidate" });
          publishedFunding = candidate.fundingMode;
          events.push("publication");
          return { taskId: candidate.id, status: candidate.status, nextFireAt: candidate.nextFireAt };
        },
      });
    });

    expect(events).toEqual([
      "invocation",
      "funding",
      "server-funding",
      "admission",
      "publication",
    ]);
    expect(publishedFunding).toBe("legacy_server");
    expect(checkedAgentId).toBe("22222222-2222-2222-2222-222222222222");
    expect(lastValues()).toEqual({});
  });

  test("prepared creation rejects authority changes, security overrides, and replay before admission", async () => {
    const { db, lastValues } = fakeDb();
    const input = baseInput({ metadata: { exact: "candidate" } });
    const provenance = createHumanApiTaskCreationProvenance({ ownerId: input.ownerId });
    const authority = accepted();
    let admissions = 0;
    const deps = {
      db,
      observer: { kick() {} },
      admission: {
        admit: async () => {
          admissions += 1;
          return { kind: "protected" as const, prepared: Object.freeze({}) };
        },
      },
      publishProtected: async ({ candidate }: { candidate: { id: string; status: "pending"; nextFireAt: Date } }) =>
        ({ taskId: candidate.id, status: candidate.status, nextFireAt: candidate.nextFireAt }),
    };
    const prepare = () => prepareTaskCreation(input, provenance, {
      assertInvocation: async () => {},
      prepareFunding: async () => true,
      assertServerFunding: async () => { throw new Error("caller funding must not use server funding"); },
    });

    await runWithAcceptedInvocationAuthority(authority, async () => {
      const overridden = await prepare();
      await rejects(overridden.create({ ...deps,
        input: { ...input, agentId: "substituted" },
        provenance: createHumanApiTaskCreationProvenance({ ownerId: input.ownerId }),
        assertInvocation: async () => {},
      } as never), /does not accept security input overrides/u);
      await rejects(overridden.create(deps), /already consumed/u);

      const wrongAuthority = await prepare();
      await runWithAcceptedInvocationAuthority(
        createAcceptedInvocationAuthority(input.requestorId),
        () => rejects(wrongAuthority.create(deps), /authority changed/u),
      );
      await rejects(wrongAuthority.create(deps), /already consumed/u);

      const prepared = await prepare();
      await prepared.create(deps);
      await rejects(prepared.create(deps), /already consumed/u);
    });

    expect(admissions).toBe(1);
    expect(lastValues()).toEqual({});
  });

  test("Plain creation keeps invocation and server-funding checks", async () => {
    const { db } = fakeDb();
    const events: string[] = [];
    await createTask({
      ...taskDeps(db, { kick() {} }),
      assertInvocation: async () => { events.push("invocation"); },
      assertServerFunding: async () => { events.push("server-funding"); },
      admission: {
        admit: async input => {
          events.push("admission");
          return { kind: "ordinary" as const, candidate: input.candidate };
        },
      },
    }, baseInput());
    expect(events).toEqual(["invocation", "server-funding", "admission"]);
  });
});
test("protected retries use the checkpointed identity and schedule before local capture", async () => {
  const { db, lastValues } = fakeDb();
  const reference = new Date("2030-01-02T03:04:05.000Z");
  let captures = 0;
  const create = () => createTask({ ...taskDeps(db, { kick() {} }),
    admission: protectedAdmission("admitted"),
    resolveProtectedIdentity: ({ prepared }) => {
      expect(prepared).toBe("admitted");
      return { taskId: "same-task", scheduleReference: reference };
    },
    captureLocalExecution: async candidate => { expect(candidate.id).toBe("same-task"); captures += 1; return null; },
    publishProtected: async ({ candidate }) => {
      expect(candidate.id).toBe("same-task");
      expect(candidate.nextFireAt).toEqual(reference);
      return { taskId: candidate.id, status: "pending" as const, nextFireAt: candidate.nextFireAt };
    },
  }, baseInput({ id: undefined }));
  expect(await create()).toEqual(await create());
  expect(captures).toBe(2);
  expect(lastValues()).toEqual({});
});

test("a caller Task ID conflicting with the protected effect fails before capture or publication", async () => {
  const { db, lastValues } = fakeDb();
  await rejects(createTask({ ...taskDeps(db, { kick() {} }), admission: protectedAdmission("admitted"),
    resolveProtectedIdentity: () => ({ taskId: "trusted-task", scheduleReference: new Date(0) }),
    captureLocalExecution: () => { throw new Error("unexpected local capture"); },
    publishProtected: () => { throw new Error("unexpected publication"); },
  }, baseInput()), /source identity changed/u);
  expect(lastValues()).toEqual({});
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


test("persists the trusted subscription pin before a new Task enters the queue", async () => {
  const { db, lastValues } = fakeDb();
  const binding = { kind: "personal" as const, providerRoute: "openai-chatgpt", credentialId: "88888888-8888-4888-8888-888888888888", credentialRevision: 7 };
  const admission = { modelId: "openai:gpt-6.1-sol", binding };
  installTaskFundingPort({ prepareCreation: async () => admission, admit: async () => admission,
    openSession: async () => { throw new Error("Not used"); } });
  try {
    await createTask({ ...taskDeps(db, { kick: () => {} }), assertServerFunding: async () => { throw new Error("Must not charge server"); } },
      baseInput({ metadata: { bringBack: true } }));
    expect(lastValues()["fundingMode"]).toBe("caller");
    expect(lastValues()["metadata"]).toEqual({ bringBack: true, subscriptionFunding: binding });
  } finally { uninstallTaskFundingPort(); }
});
