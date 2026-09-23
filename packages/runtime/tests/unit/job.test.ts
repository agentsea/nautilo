import { describe, test, expect, spyOn } from "bun:test";
import { Job } from "../../src/job";
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
    });

    await job.persist();
    expect(JSON.stringify(persisted[0]!.input)).not.toContain("sentinel");
    expect(persisted[0]!.input).toEqual(durableInputReference);
    expect(persisted[0]!.publicationPolicy).toEqual({
      expectedRevision: 11,
      representation: "protected_only",
    });

    await job.execute();
    expect(executedMessage).toBe("protected-task-input-sentinel");
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
    };
    const malformed = [
      { ...valid, taskId: "not-a-task-id" },
      { ...valid, inputObjectId: valid.resultObjectId },
      { ...valid, resultObjectId: valid.inputObjectId },
      { ...valid, authorizationRequestId: "contains spaces" },
      { ...valid, policyRevision: 0 },
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
      });
      expect(job.persist()).rejects.toThrow(
        "Protected Task durable Job reference is invalid",
      );
      expect(persistCalls).toBe(0);
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
