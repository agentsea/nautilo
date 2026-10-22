import { describe, expect, test } from "bun:test";

import { createProtectedTaskActivationParkedIntegrityInspector } from
  "../../src/routes/protected-task-activation-parked-integrity";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
};
const digest = new Uint8Array(32).fill(7);
const transaction = {} as never;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "execution" as const,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    graphThreadId: "thread-1",
    executionSegment: 1,
    acceptedPolicyRevision: 7,
    transcript: {
      contract: "protected_message_associations_v1" as const,
      expectedAssociationCount: 2,
      orderedDigest: digest,
    },
    checkpoint: {
      contract: "encrypted_langgraph_v1" as const,
      expectedCheckpointCount: 1,
      checkpointOrderedDigest: digest,
      expectedBlobCount: 2,
      blobOrderedDigest: digest,
      expectedPendingWriteCount: 0,
      pendingWriteOrderedDigest: digest,
    },
    ...overrides,
  };
}

function wakeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    kind: "wake_continuation" as const,
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    segment: 1,
    acceptedPolicyRevision: 7,
    checkpointThreadId: `protected-task-wake:${ids.job}`,
    checkpoint: {
      contract: "encrypted_langgraph_v1" as const,
      expectedCheckpointCount: 1,
      checkpointOrderedDigest: digest,
      expectedBlobCount: 2,
      blobOrderedDigest: digest,
      expectedPendingWriteCount: 0,
      pendingWriteOrderedDigest: digest,
    },
    ...overrides,
  };
}

function request(expectedJobs = 1n) {
  return {
    transaction,
    policyRevision: 8,
    expectedJobs,
    now: new Date("2042-06-07T08:00:00.000Z"),
  };
}

function matchingPorts(overrides: Record<string, unknown> = {}) {
  return {
    list: async () => ({ candidates: [candidate()], nextCursor: null }),
    readTranscript: async () => ({
      contract: "protected_message_associations_v1",
      expectedAssociationCount: 2,
      orderedDigest: digest,
    }),
    readPhysical: async () => ({
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1,
      checkpointOrderedDigest: digest,
      expectedBlobCount: 2,
      blobOrderedDigest: digest,
      expectedPendingWriteCount: 0,
      pendingWriteOrderedDigest: digest,
    }),
    ...overrides,
  };
}

describe("protected Task activation parked integrity", () => {
  test("checks transcript and physical manifest for every bounded page", async () => {
    const cursors: Array<string | undefined> = [];
    let transcriptReads = 0;
    let physicalReads = 0;
    const ports = matchingPorts({
      list: async (_transaction: unknown, input: { afterJobId?: string }) => {
        cursors.push(input.afterJobId);
        return input.afterJobId === undefined
          ? { candidates: [candidate()], nextCursor: ids.job }
          : { candidates: [candidate({ jobId: "60000000-0000-4000-8000-000000000006" })], nextCursor: null };
      },
      readTranscript: async () => {
        transcriptReads += 1;
        return matchingPorts().readTranscript();
      },
      readPhysical: async () => {
        physicalReads += 1;
        return matchingPorts().readPhysical();
      },
    });
    const inspect = createProtectedTaskActivationParkedIntegrityInspector(
      { createDedicatedPool: (() => ({})) as never },
      ports as never,
    );
    expect(await inspect(request(2n))).toEqual({
      status: "verified",
      verifiedJobs: 2n,
    });
    expect(cursors).toEqual([undefined, ids.job]);
    expect(transcriptReads).toBe(2);
    expect(physicalReads).toBe(2);
  });

  test("fails closed on transcript or physical drift and read failure", async () => {
    for (const ports of [
      matchingPorts({ readTranscript: async () => ({
        contract: "protected_message_associations_v1",
        expectedAssociationCount: 3,
        orderedDigest: digest,
      }) }),
      matchingPorts({ readPhysical: async () => ({
        ...(await matchingPorts().readPhysical()),
        expectedCheckpointCount: 2,
      }) }),
      matchingPorts({ readPhysical: async () => { throw new Error("offline"); } }),
    ]) {
      const inspect = createProtectedTaskActivationParkedIntegrityInspector(
        { createDedicatedPool: (() => ({})) as never },
        ports as never,
      );
      expect(await inspect(request())).toEqual({
        status: "unavailable",
        verifiedJobs: 0n,
      });
    }
  });

  test("validates a wake continuation on its dedicated thread without transcript reads", async () => {
    let transcriptReads = 0;
    const physicalThreads: string[] = [];
    const inspect = createProtectedTaskActivationParkedIntegrityInspector(
      { createDedicatedPool: (() => ({})) as never },
      matchingPorts({
        list: async () => ({ candidates: [wakeCandidate()], nextCursor: null }),
        readTranscript: async () => {
          transcriptReads += 1;
          return matchingPorts().readTranscript();
        },
        readPhysical: async (input: { logicalThreadId: string }) => {
          physicalThreads.push(input.logicalThreadId);
          return matchingPorts().readPhysical();
        },
      }) as never,
    );
    expect(await inspect(request())).toEqual({
      status: "verified",
      verifiedJobs: 1n,
    });
    expect(transcriptReads).toBe(0);
    expect(physicalThreads).toEqual([`protected-task-wake:${ids.job}`]);
  });

  test("rejects future policy and denominator disagreement", async () => {
    const future = createProtectedTaskActivationParkedIntegrityInspector(
      { createDedicatedPool: (() => ({})) as never },
      matchingPorts({
        list: async () => ({
          candidates: [candidate({ acceptedPolicyRevision: 9 })],
          nextCursor: null,
        }),
      }) as never,
    );
    expect(await future(request())).toEqual({
      status: "unavailable",
      verifiedJobs: 0n,
    });
    const empty = createProtectedTaskActivationParkedIntegrityInspector(
      { createDedicatedPool: (() => ({})) as never },
      matchingPorts({
        list: async () => ({ candidates: [], nextCursor: null }),
      }) as never,
    );
    expect(await empty(request())).toEqual({
      status: "unavailable",
      verifiedJobs: 0n,
    });
  });
});
