import { describe, expect, mock, test } from "bun:test";
import type { JobExecutor } from "../../src/job";
import type { CreateProtectedTaskJobInput } from
  "../../src/tasks/protected-task-execution-candidate";
import {
  createProtectedTaskOccurrenceCoordinator,
  type ClaimedProtectedTaskOccurrence,
} from "../../src/tasks/protected-task-occurrence-coordinator";
import type { ProtectedTaskOccurrence } from "../../src/tasks/task-observer";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const REQUESTOR_ID = "20000000-0000-4000-8000-000000000002";
const AGENT_ID = "30000000-0000-4000-8000-000000000003";
const ROOM_ID = "40000000-0000-4000-8000-000000000004";
const TASK_ID = "50000000-0000-4000-8000-000000000005";
const RUN_ID = "60000000-0000-4000-8000-000000000006";
const THREAD_ID = `subagent:${TASK_ID}:${RUN_ID}`;
const INPUT_OBJECT_ID = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT_ID = `task-run-result:v1:${"b".repeat(64)}`;

function occurrence(): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: TASK_ID,
      ownerId: OWNER_ID,
      requestorId: REQUESTOR_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
      contentRepresentation: "protected" as const,
      contentNamespaceId: "namespace-1",
      contentRevision: 2,
      cryptoObjectId: INPUT_OBJECT_ID,
      cryptoAccessRevision: 4,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(7),
    }),
    run: Object.freeze({
      id: RUN_ID,
      taskId: TASK_ID,
      jobId: null,
      graphThreadId: THREAD_ID,
      status: "awaiting" as const,
      startedAt: new Date(1_000),
    }),
  });
}

function claimed(
  onIneligible = mock(() => {}),
): ClaimedProtectedTaskOccurrence {
  const executor: JobExecutor = async function* () { yield* []; };
  return Object.freeze({
    reference: Object.freeze({
      kind: "protected_task_run_v1" as const,
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      inputObjectId: INPUT_OBJECT_ID,
      resultObjectId: RESULT_OBJECT_ID,
      authorizationRequestId: `task-run-authorization:${RUN_ID}`,
      policyRevision: 7,
    }),
    scheduling: Object.freeze({
      ownerId: OWNER_ID,
      requestorId: REQUESTOR_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      callingRoomId: ROOM_ID,
      graphThreadId: THREAD_ID,
    }),
    executor,
    candidate: Object.freeze({
      run: async <T>(work: (
        input: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<T>) => work(
        { message: "transient" },
        new AbortController().signal,
      ),
      onIneligible,
    }),
  });
}

describe("protected Task occurrence coordinator", () => {
  test("keeps an occurrence awaiting without dispatch until authority is claimed", async () => {
    const createProtectedTaskJob = mock(async (_input: CreateProtectedTaskJobInput) =>
      ({ id: "v1", virtualJobId: "v1" }));
    const coordinator = createProtectedTaskOccurrenceCoordinator({
      authorization: {
        prepareOrClaimExact: async () => ({ status: "awaiting_authorization" }),
      },
      jobManager: { createProtectedTaskJob },
      kick: () => {},
    });

    await coordinator.observeProtectedTaskOccurrence(occurrence());

    expect(createProtectedTaskJob).not.toHaveBeenCalled();
  });

  test("dispatches one exact content-free Job after the durable claim", async () => {
    const dispatch = claimed();
    const createProtectedTaskJob = mock(async (_input: CreateProtectedTaskJobInput) =>
      ({ id: "v1", virtualJobId: "v1" }));
    const coordinator = createProtectedTaskOccurrenceCoordinator({
      authorization: {
        prepareOrClaimExact: async () => ({ status: "claimed", dispatch }),
      },
      jobManager: { createProtectedTaskJob },
      kick: () => {},
    });

    await coordinator.observeProtectedTaskOccurrence(occurrence());

    expect(createProtectedTaskJob).toHaveBeenCalledTimes(1);
    expect(createProtectedTaskJob.mock.calls[0]![0]).toEqual(dispatch);
    expect(JSON.stringify(createProtectedTaskJob.mock.calls[0]![0]))
      .not.toContain("transient");
  });

  test("coalesces concurrent observations before the durable claim resolves", async () => {
    const gate = Promise.withResolvers<void>();
    const prepareOrClaimExact = mock(async () => {
      await gate.promise;
      return { status: "already_claimed" as const };
    });
    const coordinator = createProtectedTaskOccurrenceCoordinator({
      authorization: { prepareOrClaimExact },
      jobManager: {
        createProtectedTaskJob: async () => ({ id: "v1", virtualJobId: "v1" }),
      },
      kick: () => {},
    });

    const first = coordinator.observeProtectedTaskOccurrence(occurrence());
    const second = coordinator.observeProtectedTaskOccurrence(occurrence());
    gate.resolve();
    await Promise.all([first, second]);

    expect(prepareOrClaimExact).toHaveBeenCalledTimes(1);
  });

  test("rejects a claimed dispatch bound to another occurrence", async () => {
    const onIneligible = mock(() => {});
    const dispatch = claimed(onIneligible);
    const createProtectedTaskJob = mock(async (_input: CreateProtectedTaskJobInput) =>
      ({ id: "v1", virtualJobId: "v1" }));
    const coordinator = createProtectedTaskOccurrenceCoordinator({
      authorization: {
        prepareOrClaimExact: async () => ({
          status: "claimed",
          dispatch: {
            ...dispatch,
            reference: { ...dispatch.reference, taskRunId: "70000000-0000-4000-8000-000000000007" },
          },
        }),
      },
      jobManager: { createProtectedTaskJob },
      kick: () => {},
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(coordinator.observeProtectedTaskOccurrence(occurrence()))
      .rejects.toThrow("exact occurrence");
    expect(createProtectedTaskJob).not.toHaveBeenCalled();
    expect(onIneligible).toHaveBeenCalledTimes(1);
  });

  test("wakes normal observer recovery automatically after grant acceptance", () => {
    const kick = mock(() => {});
    const coordinator = createProtectedTaskOccurrenceCoordinator({
      authorization: {
        prepareOrClaimExact: async () => ({ status: "inactive" }),
      },
      jobManager: {
        createProtectedTaskJob: async () => ({ id: "v1", virtualJobId: "v1" }),
      },
      kick,
    });

    coordinator.authorizationAccepted();

    expect(kick).toHaveBeenCalledTimes(1);
  });
});
