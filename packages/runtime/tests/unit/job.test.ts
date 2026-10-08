import { describe, test, expect, spyOn } from "bun:test";
import { Job, ProtectedTaskJobStartNotOwnedError } from "../../src/job";
import { assertProtectedTaskJobReferenceV1 } from "../../src/tasks/protected-task-job-reference";
import type { ServerEvent, JobStatus } from "@nautilo/types";
import type { JobPublicationPolicy, PersistJobPayload } from "@nautilo/db";
import { runWithLiveShadowTurnSession } from "../../src/conversation/live-shadow-turn-context";
import { eventBus } from "../../src/event-bus";

function mockPersist() {
  let id = 0;
  return async () => `mock-job-${++id}`;
}

function trackStatus() {
  const updates: { jobId: string; status: JobStatus }[] = [];
  return {
    updates,
    async fn(jobId: string, status: JobStatus) {
      updates.push({ jobId, status });
    },
  };
}

async function* yieldNothing(): AsyncGenerator<ServerEvent> {
  // completes immediately
}

const startProtectedTaskJob = async () => "started" as const;
const settleProtectedTaskJobTerminal = async (
  _jobId: string,
  _reference: unknown,
  requested: "completed" | "failed" | "cancelled",
) => ({ kind: "transitioned", status: requested } as const);

function protectedReference(suffix: string) {
  return {
    kind: "protected_task_run_v1" as const,
    taskId: "10000000-0000-4000-8000-000000000001",
    taskRunId: "20000000-0000-4000-8000-000000000002",
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: `task-run-authorization:${suffix}`,
    policyRevision: 11,
    executionSegment: 1,
  };
}

async function* yieldTokens(n: number, laneKey: string): AsyncGenerator<ServerEvent> {
  for (let i = 1; i <= n; i++) {
    yield {
      type: "message.tokens",
      laneKey,
      content: `token ${i}`,
      chunkSequence: i,
      done: i === n,
    };
  }
}

async function* throwAfter(n: number, laneKey: string): AsyncGenerator<ServerEvent> {
  for (let i = 1; i <= n; i++) {
    yield {
      type: "message.tokens",
      laneKey,
      content: `token ${i}`,
      chunkSequence: i,
      done: false,
    };
  }
  throw new Error("executor failure");
}

describe("Job", () => {
  test("does not project generic input fields as trusted lifecycle identity", async () => {
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1",
        requestorId: "r1",
        laneKey: "room:identity-boundary",
        type: "foreground",
        input: { turnId: "untrusted-turn", agentId: "untrusted-agent" },
        executor: yieldNothing,
        persist: async () => "identity-boundary-job",
        updateStatus: async () => {},
      });
      await job.persist();
      await job.execute();

      const terminal = events.find((event) =>
        event.type === "job.status" && event.status === "completed"
      );
      expect(terminal).not.toHaveProperty("turnId");
      expect(terminal).not.toHaveProperty("authorAgentId");
    } finally {
      eventBus.off(listener);
    }
  });

  test("persists only a reviewed Full reference while executing transient content", async () => {
    const persisted: PersistJobPayload[] = [];
    const updates: Array<{ fields: unknown; policy: unknown }> = [];
    let executedMessage: unknown;
    const durableInputReference = {
      kind: "full_encryption_foreground_operation_v1" as const,
      operationId: "full-operation-m318",
      policyRevision: 7,
      roomId: "20000000-0000-4000-8000-000000000318",
    };
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "room:20000000-0000-4000-8000-000000000318",
      type: "foreground",
      input: {
        message: "full-input-sentinel",
        attachmentTextBlocks: ["attachment-sentinel"],
        roomRoster: [{ name: "roster-sentinel" }],
        roomId: "20000000-0000-4000-8000-000000000318",
      },
      durableInputReference,
      durableInputDisposition: "full",
      executor: async function* (input) {
        executedMessage = input["message"];
        yield* yieldNothing();
      },
      persist: async (payload) => {
        persisted.push(payload);
        return "job-full";
      },
      updateStatus: async (_id, _status, fields, policy) => {
        updates.push({ fields, policy });
      },
    });
    await job.persist();
    expect(JSON.stringify(persisted[0]!.input)).not.toContain("sentinel");
    expect(persisted[0]!.input).toEqual(durableInputReference);
    expect(persisted[0]!.publicationPolicy).toEqual({
      expectedRevision: 7, representation: "protected_only",
    });
    await job.execute();
    expect(executedMessage).toBe("full-input-sentinel");
    expect(updates.every((update) => update.fields === undefined)).toBeTrue();
    expect(updates.every((update) =>
      (update.policy as JobPublicationPolicy).expectedRevision === 7
    )).toBeTrue();
  });

  test("persists only a protected Task reference while executing transient content", async () => {
    // This is deliberately a low-level Job sink test. Production protected
    // Task execution must construct this transient input inside its authorized
    // callback; passing plaintext to Job before authorization is not an
    // execution-boundary contract and is not wired by this foundation.
    const persisted: PersistJobPayload[] = [];
    let executedMessage: unknown;
    const durableInputReference = {
      kind: "protected_task_run_v1" as const,
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      authorizationRequestId: "task-run-authorization:request-1",
      policyRevision: 11,
      executionSegment: 1,
    };
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "task:10000000-0000-4000-8000-000000000001",
      type: "foreground",
      input: {
        message: "protected-task-input-sentinel",
        expectedOutput: "protected-task-output-sentinel",
        metadata: { private: "protected-task-metadata-sentinel" },
      },
      durableInputReference,
      durableInputDisposition: "full",
      executor: async function* (input) {
        executedMessage = input["message"];
        yield* yieldNothing();
      },
      persist: async (payload) => {
        persisted.push(payload);
        return "job-protected-task";
      },
      updateStatus: async () => {},
      startProtectedTaskJob,
      settleProtectedTaskJobTerminal,
    });

    await job.persist();
    expect(JSON.stringify(persisted[0]!.input)).not.toContain("sentinel");
    expect(persisted[0]!.input).toEqual(durableInputReference);
    expect(persisted[0]!.publicationPolicy).toEqual({
      expectedRevision: 11,
      representation: "protected_only",
    });

    await job.executeProtectedTask(job.input, undefined, {
      awaitPublished: async () => true,
    });
    expect(executedMessage).toBe("protected-task-input-sentinel");
  });

  test("protected Task completion waits for a published result", async () => {
    const reference = {
      kind: "protected_task_run_v1" as const,
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      authorizationRequestId: "task-run-authorization:result-barrier",
      policyRevision: 11,
      executionSegment: 1,
    };
    for (const published of [false, true]) {
      const updates: JobStatus[] = [];
      const job = new Job({
        ownerId: "o1",
        requestorId: "r1",
        laneKey: `task:${reference.taskId}`,
        type: "foreground",
        input: {},
        durableInputReference: reference,
        durableInputDisposition: "full",
        executor: yieldNothing,
        persist: async () => `protected-result-${published}`,
        updateStatus: async (_id, status) => { updates.push(status); },
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal,
      });
      await job.persist();
      await job.executeProtectedTask({}, undefined, {
        awaitPublished: async () => published,
      });
      expect(job.status).toBe(published ? "completed" : "running");
      expect(updates).toEqual([]);
    }
  });

  test("rejects malformed protected Task references before persistence", async () => {
    const valid = {
      kind: "protected_task_run_v1" as const,
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      authorizationRequestId: "task-run-authorization:request-1",
      policyRevision: 11,
      executionSegment: 1,
    };
    const malformed = [
      { ...valid, taskId: "not-a-task-id" },
      { ...valid, inputObjectId: valid.resultObjectId },
      { ...valid, resultObjectId: valid.inputObjectId },
      { ...valid, authorizationRequestId: "contains spaces" },
      { ...valid, policyRevision: 0 },
      { ...valid, executionSegment: 0 },
      { ...valid, executionSegment: 1.5 },
      { ...valid, executionSegment: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, prompt: "must-not-be-durable" },
    ];

    for (const durableInputReference of malformed) {
      let persistCalls = 0;
      const job = new Job({
        ownerId: "o1",
        requestorId: "r1",
        laneKey: null,
        type: "foreground",
        input: { message: "must-not-persist" },
        durableInputDisposition: "full",
        durableInputReference: durableInputReference as typeof valid,
        executor: yieldNothing,
        persist: async () => {
          persistCalls += 1;
          return "unexpected";
        },
        updateStatus: async () => {},
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal,
      });
      expect(job.persist()).rejects.toThrow(
        "Protected Task durable Job reference is invalid",
      );
      expect(persistCalls).toBe(0);
    }
  });

  test("resumed protected Task Jobs require one exact resume binding", () => {
    const initial = {
      kind: "protected_task_run_v1",
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      authorizationRequestId: "task-run-authorization:request-1",
      policyRevision: 11,
      executionSegment: 1,
    };
    expect(() => assertProtectedTaskJobReferenceV1(initial)).not.toThrow();
    expect(() => assertProtectedTaskJobReferenceV1({
      ...initial,
      executionSegment: 2,
      resumeAcceptanceId: "await-reply-acceptance:1",
    })).not.toThrow();
    expect(() => assertProtectedTaskJobReferenceV1({
      ...initial,
      executionSegment: 2,
      resumeContinuationFingerprint: "A".repeat(43),
    })).not.toThrow();
    for (const invalid of [
      { ...initial, executionSegment: 2 },
      { ...initial, resumeAcceptanceId: "await-reply-acceptance:1" },
      { ...initial, resumeContinuationFingerprint: "A".repeat(43) },
      { ...initial, executionSegment: 2, resumeAcceptanceId: "contains spaces" },
      {
        ...initial,
        executionSegment: 2,
        resumeAcceptanceId: "await-reply-acceptance:1",
        resumeContinuationFingerprint: "A".repeat(43),
      },
      { ...initial, executionSegment: 2, resumeAcceptanceId: undefined },
      { ...initial, executionSegment: 2, resumeContinuationFingerprint: undefined },
      { ...initial, executionSegment: 2, resumeContinuationFingerprint: "A".repeat(42) },
      {
        ...initial,
        executionSegment: 2,
        resumeContinuationFingerprint: `${"A".repeat(42)}B`,
      },
    ]) {
      expect(() => assertProtectedTaskJobReferenceV1(invalid)).toThrow(
        "Protected Task durable Job reference is invalid",
      );
    }
  });

  test("Full cancellation never publishes or persists caller text", async () => {
    const sentinel = "FULL_CANCEL_SENTINEL_DO_NOT_DISCLOSE";
    const updates: unknown[] = [];
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: null, type: "foreground",
        input: { message: sentinel }, durableInputDisposition: "full",
        durableInputReference: {
          kind: "full_encryption_foreground_operation_v1",
          operationId: "cancel-operation", policyRevision: 9,
          roomId: "20000000-0000-4000-8000-000000000318",
        },
        executor: yieldNothing, persist: async () => "job-full-cancel",
        updateStatus: async (...args) => { updates.push(args); },
      });
      await job.persist();
      await job.cancel(sentinel);
      expect(JSON.stringify({ updates, events })).not.toContain(sentinel);
      expect(events.at(-1)).toMatchObject({
        type: "job.status", status: "cancelled",
        message: "Protected operation cancelled",
      });
    } finally {
      eventBus.off(listener);
    }
  });

  test("Full executor failures never publish, persist, or log exception text", async () => {
    const sentinel = "FULL_EXCEPTION_SENTINEL_DO_NOT_DISCLOSE";
    const updates: unknown[] = [];
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: null, type: "foreground",
        input: { message: sentinel }, durableInputDisposition: "full",
        durableInputReference: {
          kind: "full_encryption_foreground_operation_v1",
          operationId: "failure-operation", policyRevision: 9,
          roomId: "20000000-0000-4000-8000-000000000318",
        },
        executor: async function* () {
          yield* ([] as ServerEvent[]);
          throw new Error(sentinel);
        },
        persist: async () => "job-full-failure",
        updateStatus: async (...args) => { updates.push(args); },
      });
      await job.persist();
      await job.execute();
      expect(JSON.stringify({ updates, events, logs: errorSpy.mock.calls }))
        .not.toContain(sentinel);
      expect(events.at(-1)).toMatchObject({
        type: "job.status", status: "failed",
      });
      expect((events.at(-1) as { message?: string }).message)
        .toStartWith("Protected operation failed [");
    } finally {
      eventBus.off(listener);
      errorSpy.mockRestore();
    }
  });

  test("protected Task executor failures collapse before every Job sink", async () => {
    const sentinel = "PROTECTED_TASK_PROVIDER_ERROR_SENTINEL";
    const persisted: PersistJobPayload[] = [];
    const updates: unknown[] = [];
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1",
        requestorId: "r1",
        laneKey: "task:10000000-0000-4000-8000-000000000001",
        type: "foreground",
        input: {
          taskId: "10000000-0000-4000-8000-000000000001",
          taskRunId: "20000000-0000-4000-8000-000000000002",
        },
        durableInputDisposition: "full",
        durableInputReference: {
          kind: "protected_task_run_v1",
          taskId: "10000000-0000-4000-8000-000000000001",
          taskRunId: "20000000-0000-4000-8000-000000000002",
          inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
          resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
          authorizationRequestId: "task-run-authorization:failure-test",
          policyRevision: 9,
          executionSegment: 1,
        },
        executor: async function* () {
          yield* ([] as ServerEvent[]);
          throw new Error(sentinel);
        },
        persist: async (payload) => {
          persisted.push(payload);
          return "protected-task-failure";
        },
        updateStatus: async (...args) => {
          updates.push(args);
        },
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal,
      });
      await job.persist();
      await job.executeProtectedTask(
        { message: sentinel },
        new AbortController().signal,
      );
      expect(JSON.stringify({ persisted, updates, events, logs: errorSpy.mock.calls }))
        .not.toContain(sentinel);
      expect(events.at(-1)).toMatchObject({
        type: "job.status",
        status: "failed",
        message: "Protected operation failed [MDL007]",
      });
      expect(updates.every((update) => (update as unknown[])[2] === undefined)).toBeTrue();
    } finally {
      eventBus.off(listener);
      errorSpy.mockRestore();
    }
  });

  test("protected Task late failure adopts durable completion without a false failure event or log", async () => {
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: "task:late-failure",
        type: "foreground", input: {}, durableInputDisposition: "full",
        durableInputReference: protectedReference("late-failure"),
        executor: yieldNothing, persist: async () => "protected-late-failure",
        updateStatus: async () => { throw new Error("generic sink used"); },
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal: async () => ({
          kind: "existing_terminal", status: "completed",
        }),
      });
      await job.persist();
      await job.fail(new Error("must-not-log-as-failure"));

      expect(job.status).toBe("completed");
      const jobEvents = events.filter((event) =>
        event.type === "job.status" && event.jobId === job.id
      );
      expect(jobEvents).toHaveLength(1);
      expect(jobEvents[0]).toMatchObject({ status: "completed" });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("failed");
    } finally {
      eventBus.off(listener);
      errorSpy.mockRestore();
    }
  });

  test("protected Task cancellation aborts promptly and adopts durable completion", async () => {
    const executorEntered = Promise.withResolvers<AbortSignal>();
    const terminalEntered = Promise.withResolvers<void>();
    const allowTerminal = Promise.withResolvers<void>();
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: "task:late-cancel",
        type: "foreground", input: {}, durableInputDisposition: "full",
        durableInputReference: protectedReference("late-cancel"),
        executor: async function* (_input, _id, _lane, signal) {
          executorEntered.resolve(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
          signal.throwIfAborted();
          yield* [];
        },
        persist: async () => "protected-late-cancel",
        updateStatus: async () => { throw new Error("generic sink used"); },
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal: async () => {
          terminalEntered.resolve();
          await allowTerminal.promise;
          return { kind: "existing_terminal", status: "completed" };
        },
      });
      await job.persist();
      const execution = job.executeProtectedTask({}, undefined, {
        awaitPublished: async () => false,
      });
      const signal = await executorEntered.promise;
      const cancellation = job.cancel();
      await terminalEntered.promise;
      expect(signal.aborted).toBeTrue();
      allowTerminal.resolve();
      await Promise.all([execution, cancellation]);

      expect(job.status).toBe("completed");
      expect(events.some((event) =>
        event.type === "job.status"
        && event.jobId === job.id
        && event.status === "cancelled"
      )).toBeFalse();
    } finally {
      eventBus.off(listener);
    }
  });

  test("protected Task terminal races emit only the durable winner", async () => {
    const terminalEntered = Promise.withResolvers<void>();
    const allowTerminal = Promise.withResolvers<void>();
    const requests: string[] = [];
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: "task:terminal-race",
        type: "foreground", input: {}, durableInputDisposition: "full",
        durableInputReference: protectedReference("terminal-race"),
        executor: yieldNothing, persist: async () => "protected-terminal-race",
        updateStatus: async () => { throw new Error("generic sink used"); },
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal: async (_id, _reference, requested) => {
          requests.push(requested);
          terminalEntered.resolve();
          await allowTerminal.promise;
          return { kind: "transitioned", status: requested };
        },
      });
      await job.persist();
      const failure = job.fail(new Error("winner"));
      await terminalEntered.promise;
      const cancellation = job.cancel();
      allowTerminal.resolve();
      await Promise.all([failure, cancellation]);

      expect(requests).toEqual(["failed"]);
      expect(job.status).toBe("failed");
      expect(events.filter((event) =>
        event.type === "job.status" && event.jobId === job.id
      )).toHaveLength(1);
    } finally {
      eventBus.off(listener);
    }
  });

  test("protected Task terminal settlement fails closed when missing or rejected", async () => {
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    eventBus.on(listener);
    try {
      for (const disposition of ["missing", "rejected"] as const) {
        const job = new Job({
          ownerId: "o1", requestorId: "r1", laneKey: null,
          type: "foreground", input: {}, durableInputDisposition: "full",
          durableInputReference: protectedReference(`terminal-${disposition}`),
          executor: yieldNothing, persist: async () => `protected-${disposition}`,
          updateStatus: async () => { throw new Error("generic sink used"); },
          startProtectedTaskJob,
          ...(disposition === "rejected"
            ? { settleProtectedTaskJobTerminal: async () => ({ kind: "rejected" as const }) }
            : {}),
        });
        await job.persist();
        const error = await job.cancel().then(
          () => undefined,
          (value: unknown) => value,
        );
        expect(error).toBeInstanceOf(Error);
        expect(job.status).toBe("queued");
        expect(events.some((event) =>
          event.type === "job.status" && event.jobId === job.id
        )).toBeFalse();
      }
    } finally {
      eventBus.off(listener);
    }
  });

  test("protected Task terminal settlement replays one lost response and emits once", async () => {
    let calls = 0;
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: null,
        type: "foreground", input: {}, durableInputDisposition: "full",
        durableInputReference: protectedReference("lost-terminal-response"),
        executor: yieldNothing, persist: async () => "protected-lost-response",
        updateStatus: async () => { throw new Error("generic sink used"); },
        startProtectedTaskJob,
        settleProtectedTaskJobTerminal: async (_id, _reference, requested) => {
          calls += 1;
          if (calls === 1) throw new Error("response lost");
          return { kind: "existing_terminal", status: requested };
        },
      });
      await job.persist();
      await job.fail(new Error("terminal failure"));
      await job.fail(new Error("duplicate observation"));

      expect(calls).toBe(2);
      expect(job.status).toBe("failed");
      expect(events.filter((event) =>
        event.type === "job.status" && event.jobId === job.id
      )).toHaveLength(1);
    } finally {
      eventBus.off(listener);
    }
  });

  test("protected Task start rejection and unknown response never execute or persist failure", async () => {
    const reference = {
      kind: "protected_task_run_v1" as const,
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      authorizationRequestId: "task-run-authorization:start-rejection",
      policyRevision: 9,
      executionSegment: 1,
    };
    for (const disposition of ["rejected", "unknown"] as const) {
      let executed = 0;
      const updates: JobStatus[] = [];
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: `task:${reference.taskId}`,
        type: "foreground", input: {}, durableInputDisposition: "full",
        durableInputReference: reference,
        executor: async function* () { executed += 1; yield* []; },
        persist: async () => `protected-start-${disposition}`,
        updateStatus: async (_id, status) => { updates.push(status); },
        startProtectedTaskJob: async () => {
          if (disposition === "unknown") throw new Error("response lost");
          return "rejected";
        },
        settleProtectedTaskJobTerminal,
      });
      await job.persist();
      const error = await job.executeProtectedTask({}).then(
        () => undefined,
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(ProtectedTaskJobStartNotOwnedError);
      expect((error as ProtectedTaskJobStartNotOwnedError).disposition)
        .toBe(disposition);
      expect(executed).toBe(0);
      expect(updates).toEqual([]);
      expect(job.status).toBe("queued");
    }
  });

  test("protected Task start cannot revive either side of a local cancellation race", async () => {
    const reference = {
      kind: "protected_task_run_v1" as const,
      taskId: "10000000-0000-4000-8000-000000000001",
      taskRunId: "20000000-0000-4000-8000-000000000002",
      inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      authorizationRequestId: "task-run-authorization:start-cancel",
      policyRevision: 9,
      executionSegment: 1,
    };

    for (const startResult of ["rejected", "started"] as const) {
      const startEntered = Promise.withResolvers<void>();
      const releaseStart = Promise.withResolvers<void>();
      let executed = 0;
      const updates: JobStatus[] = [];
      const job = new Job({
        ownerId: "o1", requestorId: "r1", laneKey: `task:${reference.taskId}`,
        type: "foreground", input: {}, durableInputDisposition: "full",
        durableInputReference: reference,
        executor: async function* () { executed += 1; yield* []; },
        persist: async () => `protected-cancel-${startResult}`,
        updateStatus: async (_id, status) => { updates.push(status); },
        startProtectedTaskJob: async () => {
          startEntered.resolve();
          await releaseStart.promise;
          return startResult;
        },
        settleProtectedTaskJobTerminal,
      });
      await job.persist();
      const execution = job.executeProtectedTask({});
      await startEntered.promise;
      await job.cancel();
      releaseStart.resolve();
      if (startResult === "rejected") {
        const error = await execution.then(
          () => undefined,
          (value: unknown) => value,
        );
        expect(error).toBeInstanceOf(ProtectedTaskJobStartNotOwnedError);
      } else {
        await execution;
      }
      expect(executed).toBe(0);
      expect(updates).toEqual([]);
      expect(job.status).toBe("cancelled");
    }
  });

  test("candidate failure uses the Full sink and cannot rewrite an already terminal Job", async () => {
    const updates: JobStatus[] = [];
    const job = new Job({ ownerId: "o1", requestorId: "r1", laneKey: null,
      type: "foreground", input: { message: "transient" },
      durableInputDisposition: "full", durableInputReference: {
        kind: "full_encryption_foreground_operation_v1",
        operationId: "candidate-terminal", policyRevision: 9,
        roomId: "20000000-0000-4000-8000-000000000318",
      }, executor: yieldNothing, persist: async () => "job-candidate-terminal",
      updateStatus: async (_id, status) => { updates.push(status); } });
    await job.persist();
    await job.fail(new Error("candidate secret"));
    expect(job.status).toBe("failed");
    expect(updates).toEqual(["failed"]);
    await job.fail(new Error("later secret"));
    await job.cancel("cancel secret");
    expect(updates).toEqual(["failed"]);
  });

  test("ephemeral Full resume sinks redact failures without a fabricated durable reference", async () => {
    const sentinel = "FULL_EPHEMERAL_RESUME_SENTINEL_DO_NOT_DISCLOSE";
    const events: ServerEvent[] = [];
    const listener = (event: ServerEvent) => events.push(event);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    eventBus.on(listener);
    try {
      const job = new Job({
        ownerId: "",
        requestorId: "",
        laneKey: "room:ephemeral-full-resume",
        type: "foreground",
        input: {},
        ephemeralSinkDisposition: "full",
        executor: async function* () {
          yield* ([] as ServerEvent[]);
          throw new Error(sentinel);
        },
        persist: async (payload) => {
          expect(payload.input).toEqual({});
          expect(payload.publicationPolicy).toBeUndefined();
          return "ephemeral-full-resume";
        },
        updateStatus: async () => {},
      });
      await job.persist();
      await job.execute();
      expect(JSON.stringify({ events, logs: errorSpy.mock.calls }))
        .not.toContain(sentinel);
      expect(events.at(-1)).toMatchObject({
        type: "job.status",
        status: "failed",
        message: "Protected operation failed [MDL007]",
      });
    } finally {
      eventBus.off(listener);
      errorSpy.mockRestore();
    }
  });

  test("rejects an untrusted malformed Full reference", async () => {
    const job = new Job({
      ownerId: "o1", requestorId: "r1", laneKey: null, type: "foreground",
      input: { message: "must-not-persist" }, executor: yieldNothing,
      durableInputDisposition: "full",
      persist: mockPersist(), updateStatus: async () => {},
    });
    expect(job.persist()).rejects.toThrow("requires a trusted durable reference");
  });
  test("throws if id accessed before persist", () => {
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: yieldNothing,
      persist: mockPersist(),
      updateStatus: async () => {},
    });

    expect(() => job.id).toThrow("not yet persisted");
  });

  test("persist assigns an id", async () => {
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: yieldNothing,
      persist: mockPersist(),
      updateStatus: async () => {},
    });

    await job.persist();
    expect(job.id).toBe("mock-job-1");
  });

  test("execute transitions queued → running → completed", async () => {
    const tracker = trackStatus();
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: (_input, _id, lk) => yieldTokens(2, lk ?? "default"),
      persist: mockPersist(),
      updateStatus: tracker.fn,
    });

    await job.persist();
    expect(job.status).toBe("queued");

    await job.execute();
    expect(job.status).toBe("completed");

    const statuses = tracker.updates.map((u) => u.status);
    expect(statuses).toEqual(["running", "completed"]);
  });

  test("execute transitions to failed on executor error", async () => {
    const tracker = trackStatus();
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: (_input, _id, lk) => throwAfter(1, lk ?? "default"),
      persist: mockPersist(),
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.execute();

    expect(job.status).toBe("failed");
    const statuses = tracker.updates.map((u) => u.status);
    expect(statuses).toEqual(["running", "failed"]);
  });

  test("authorization cancellation aborts the running Job before more work", async () => {
    const tracker = trackStatus();
    const authorization = new AbortController();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: async function* (_input, _id, _laneKey, signal) {
        yield* yieldNothing();
        started();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
      persist: mockPersist(),
      updateStatus: tracker.fn,
    });

    await job.persist();
    const execution = job.execute(authorization.signal);
    await didStart;
    authorization.abort();
    await execution;

    expect(job.status).toBe("cancelled");
    expect(tracker.updates.map((update) => update.status)).toEqual([
      "running",
      "cancelled",
    ]);
  });

  test("cancel before execute sets cancelled", async () => {
    const tracker = trackStatus();
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: yieldNothing,
      persist: mockPersist(),
      updateStatus: tracker.fn,
    });

    await job.persist();
    await job.cancel();

    expect(job.status).toBe("cancelled");
    expect(job.isTerminal()).toBe(true);
  });

  test("isRunning and isTerminal report correctly", async () => {
    const job = new Job({
      ownerId: "o1",
      requestorId: "r1",
      laneKey: "lane:1",
      type: "foreground",
      input: {},
      executor: yieldNothing,
      persist: mockPersist(),
      updateStatus: async () => {},
    });

    expect(job.isRunning()).toBe(true); // queued
    expect(job.isTerminal()).toBe(false);

    await job.persist();
    await job.execute();

    expect(job.isRunning()).toBe(false);
    expect(job.isTerminal()).toBe(true); // completed
  });
});


test("Stop terminalizes the owned protected session before the executor settles", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const failures: string[] = [];
  const job = new Job({
    ownerId: "owner", requestorId: "requester", laneKey: null,
    type: "foreground", input: {}, persist: mockPersist(),
    updateStatus: trackStatus().fn,
    executor: async function* () {
      started.resolve();
      await finish.promise;
      yield* yieldTokens(1, "cancelled-lane");
    },
  });
  await job.persist();
  const running = runWithLiveShadowTurnSession({
    operationId: "cancel-execution", capability: {} as never,
    session: { fail: (_stage: string, reason: string) => failures.push(reason) } as never,
    enforcementPolicy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 1 },
    work: () => job.execute(),
  });
  await started.promise;
  await job.cancel();
  expect(failures).toEqual(["cancelled"]);
  expect(job.status).toBe("cancelled");
  finish.resolve();
  await running;
  await job.cancel();
  expect(failures).toEqual(["cancelled"]);
});
