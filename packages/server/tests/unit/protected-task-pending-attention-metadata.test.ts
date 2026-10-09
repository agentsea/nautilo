import { describe, expect, test } from "bun:test";

import type {
  ProtectedTaskPendingAttentionCursor,
} from "@nautilo/db";

import {
  createProtectedTaskPendingAttentionMetadata,
  decodeProtectedTaskPendingAttentionCursor,
  encodeProtectedTaskPendingAttentionCursor,
  sameProtectedTaskPendingAttentionCandidate,
} from "../../src/routes/protected-task-pending-attention-metadata";

import { candidate, ids, startedAt } from "../fixtures/protected-task-pending-attention";

function physical(value = candidate().checkpointManifest) {
  return {
    contract: "encrypted_langgraph_v1" as const,
    expectedCheckpointCount: value.expectedCheckpointCount,
    checkpointOrderedDigest: value.checkpointOrderedDigest.slice(),
    expectedBlobCount: value.expectedBlobCount,
    blobOrderedDigest: value.blobOrderedDigest.slice(),
    expectedPendingWriteCount: value.expectedPendingWriteCount,
    pendingWriteOrderedDigest: value.pendingWriteOrderedDigest.slice(),
  };
}

describe("protected Task pending-attention metadata", () => {
  test("cursor round-trips canonically and rejects alternate encodings", () => {
    const cursor: ProtectedTaskPendingAttentionCursor = {
      startedAt,
      taskRunId: ids.run,
    };
    const encoded = encodeProtectedTaskPendingAttentionCursor(cursor);
    expect(decodeProtectedTaskPendingAttentionCursor(encoded)).toEqual(cursor);
    expect(decodeProtectedTaskPendingAttentionCursor(`${encoded}=`)).toBeNull();
    expect(decodeProtectedTaskPendingAttentionCursor(Buffer.from(JSON.stringify({
      version: 1,
      taskRunId: ids.run,
      startedAt: startedAt.toISOString(),
      extra: true,
    })).toString("base64url"))).toBeNull();
  });

  test("exact comparison binds routing, content and the full ordered park set", () => {
    const expected = candidate();
    expect(sameProtectedTaskPendingAttentionCandidate(expected, candidate()))
      .toBe(true);
    expect(sameProtectedTaskPendingAttentionCandidate(expected, candidate({
      occurrence: {
        ...expected.occurrence,
        task: { ...expected.occurrence.task, contentRevision: 8 },
      },
    }))).toBe(false);
    expect(sameProtectedTaskPendingAttentionCandidate(expected, candidate({
      priorJob: {
        ...expected.priorJob,
        interrupts: [...expected.priorJob.interrupts].reverse(),
      },
    }))).toBe(false);
    expect(sameProtectedTaskPendingAttentionCandidate(expected, candidate({
      stableRoutingDigest: new Uint8Array(32).fill(9),
    }))).toBe(false);
    expect(sameProtectedTaskPendingAttentionCandidate(expected, candidate({
      priorJob: {
        ...expected.priorJob,
        reference: { ...expected.priorJob.reference, policyRevision: 4 },
      },
    }))).toBe(false);
  });

  test("list keeps the raw page cursor while omitting physically stale rows", async () => {
    const first = candidate();
    const second = candidate({
      occurrence: {
        ...candidate().occurrence,
        run: {
          ...candidate().occurrence.run,
          id: "20000000-0000-4000-8000-000000000012",
          graphThreadId: "thread:stale",
        },
      },
    });
    const nextCursor = { startedAt, taskRunId: second.occurrence.run.id };
    const seenThreads: string[] = [];
    const service = createProtectedTaskPendingAttentionMetadata({
      db: {} as never,
      createDedicatedPool: (() => ({})) as never,
    }, {
      list: (async () => ({ candidates: [first, second], nextCursor })) as never,
      read: (async () => null) as never,
      readManifest: (async ({ logicalThreadId }: {
        logicalThreadId: string;
      }) => {
        seenThreads.push(logicalThreadId);
        return logicalThreadId === first.occurrence.run.graphThreadId
          ? physical()
          : { ...physical(), expectedBlobCount: 99 };
      }) as never,
    });

    const page = await service.list({
      viewer: { userId: ids.requestor, humanActorId: ids.actor },
      limit: 2,
    });
    expect(page.candidates).toEqual([first]);
    expect(decodeProtectedTaskPendingAttentionCursor(page.nextCursor!))
      .toEqual(nextCursor);
    expect(seenThreads).toEqual([
      first.occurrence.run.graphThreadId,
      second.occurrence.run.graphThreadId,
    ]);
  });

  test("exact read revalidates the detached candidate and physical manifest", async () => {
    const expected = candidate();
    let manifestReads = 0;
    let current = candidate();
    const service = createProtectedTaskPendingAttentionMetadata({
      db: {} as never,
      createDedicatedPool: (() => ({})) as never,
    }, {
      list: (async () => ({ candidates: [], nextCursor: null })) as never,
      read: (async () => current) as never,
      readManifest: (async () => {
        manifestReads += 1;
        return physical();
      }) as never,
    });
    const input = {
      viewer: { userId: ids.requestor, humanActorId: ids.actor },
      taskId: ids.task,
      taskRunId: ids.run,
      expected,
    };

    expect(await service.readCurrent(input)).toEqual(expected);
    expect(manifestReads).toBe(1);
    current = candidate({
      occurrence: {
        ...expected.occurrence,
        task: { ...expected.occurrence.task, targetRoomId: null },
      },
    });
    expect(await service.readCurrent(input)).toBeNull();
    expect(manifestReads).toBe(1);
    current = candidate();
    const stalePhysical = createProtectedTaskPendingAttentionMetadata({
      db: {} as never,
      createDedicatedPool: (() => ({})) as never,
    }, {
      list: (async () => ({ candidates: [], nextCursor: null })) as never,
      read: (async () => current) as never,
      readManifest: (async () => ({
        ...physical(),
        pendingWriteOrderedDigest: new Uint8Array(32).fill(10),
      })) as never,
    });
    expect(await stalePhysical.readCurrent(input)).toBeNull();
  });
});
