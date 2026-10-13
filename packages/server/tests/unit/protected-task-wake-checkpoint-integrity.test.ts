import { expect, test } from "bun:test";
import type { ProtectedTaskWakeContinuationReceipt } from "@nautilo/db";
import { verifyProtectedTaskWakeCheckpointIntegrity } from
  "../../src/routes/protected-task-wake-checkpoint-integrity";

const WAKE_JOB = "20000000-0000-4000-8000-000000000001";

function receipt(): ProtectedTaskWakeContinuationReceipt {
  return {
    wakeJobId: WAKE_JOB,
    segment: 1,
    taskId: "20000000-0000-4000-8000-000000000002",
    taskRunId: "20000000-0000-4000-8000-000000000003",
    bindingId: "task-run-output:20000000-0000-4000-8000-000000000003",
    wakeOperationId: "task-run-delivery-wake:20000000-0000-4000-8000-000000000003",
    priorRecipientGeneration: 0,
    wakeAuthorizationRequestId: `task-wake-authorization:${WAKE_JOB}`,
    additionalAuthorizationRequestId: "projection:authorization",
    interruptId: "projection:interrupt",
    operationId: "projection:operation",
    requestDigest: new Uint8Array(32).fill(1),
    semanticAuthorityRequirements: [],
    requiredAuthorityDigest: new Uint8Array(32).fill(2),
    retainedSourceNamespaceIds: ["20000000-0000-4000-8000-000000000004"],
    sourceEnvelopeDigest: new Uint8Array(32).fill(3),
    initialPolicyRevision: 7,
    initialAgentAuthorizationRevision: 4,
    destinationRoomId: "20000000-0000-4000-8000-000000000005",
    destinationNamespaceId: "20000000-0000-4000-8000-000000000006",
    destinationAuthorityDigest: new Uint8Array(32).fill(4),
    checkpointThreadId: `protected-task-wake:${WAKE_JOB}`,
    checkpointContract: "encrypted_langgraph_v1",
    expectedCheckpointCount: 3,
    checkpointOrderedDigest: new Uint8Array(32).fill(5),
    expectedBlobCount: 2,
    blobOrderedDigest: new Uint8Array(32).fill(6),
    expectedPendingWriteCount: 1,
    pendingWriteOrderedDigest: new Uint8Array(32).fill(7),
    sealedAt: new Date("2026-10-13T10:00:00.000Z"),
  };
}

test("verifies the dedicated wake thread and every physical checkpoint manifest field", async () => {
  const expected = receipt();
  let readInput: unknown;
  expect(await verifyProtectedTaskWakeCheckpointIntegrity(expected, async input => {
    readInput = input;
    return {
      contract: expected.checkpointContract,
      expectedCheckpointCount: expected.expectedCheckpointCount,
      checkpointOrderedDigest: Uint8Array.from(expected.checkpointOrderedDigest),
      expectedBlobCount: expected.expectedBlobCount,
      blobOrderedDigest: Uint8Array.from(expected.blobOrderedDigest),
      expectedPendingWriteCount: expected.expectedPendingWriteCount,
      pendingWriteOrderedDigest: Uint8Array.from(expected.pendingWriteOrderedDigest),
    };
  })).toBe(true);
  expect(readInput).toMatchObject({ logicalThreadId: `protected-task-wake:${WAKE_JOB}` });
});

test("refuses a non-dedicated thread without touching checkpoint storage", async () => {
  let reads = 0;
  expect(await verifyProtectedTaskWakeCheckpointIntegrity({ ...receipt(), checkpointThreadId: "wake:shared" }, async () => {
    reads += 1;
    throw new Error("must not read");
  })).toBe(false);
  expect(reads).toBe(0);
});

function manifestFor(expected: ProtectedTaskWakeContinuationReceipt) {
  return {
    contract: expected.checkpointContract,
    expectedCheckpointCount: expected.expectedCheckpointCount,
    checkpointOrderedDigest: Uint8Array.from(expected.checkpointOrderedDigest),
    expectedBlobCount: expected.expectedBlobCount,
    blobOrderedDigest: Uint8Array.from(expected.blobOrderedDigest),
    expectedPendingWriteCount: expected.expectedPendingWriteCount,
    pendingWriteOrderedDigest: Uint8Array.from(expected.pendingWriteOrderedDigest),
  };
}

for (const [field, tamper] of [
  ["contract", (value: ReturnType<typeof manifestFor>) => { Object.assign(value, { contract: "none_v1" }); }],
  ["expectedCheckpointCount", (value: ReturnType<typeof manifestFor>) => { value.expectedCheckpointCount += 1; }],
  ["checkpointOrderedDigest", (value: ReturnType<typeof manifestFor>) => {
    value.checkpointOrderedDigest[0] = (value.checkpointOrderedDigest[0] ?? 0) ^ 1;
  }],
  ["expectedBlobCount", (value: ReturnType<typeof manifestFor>) => { value.expectedBlobCount += 1; }],
  ["blobOrderedDigest", (value: ReturnType<typeof manifestFor>) => {
    value.blobOrderedDigest[0] = (value.blobOrderedDigest[0] ?? 0) ^ 1;
  }],
  ["expectedPendingWriteCount", (value: ReturnType<typeof manifestFor>) => { value.expectedPendingWriteCount += 1; }],
  ["pendingWriteOrderedDigest", (value: ReturnType<typeof manifestFor>) => {
    value.pendingWriteOrderedDigest[0] = (value.pendingWriteOrderedDigest[0] ?? 0) ^ 1;
  }],
] as const) test(`refuses checkpoint manifest tampering in ${field}`, async () => {
  const expected = receipt();
  const manifest = manifestFor(expected);
  tamper(manifest);
  expect(await verifyProtectedTaskWakeCheckpointIntegrity(expected, async () => manifest as never)).toBe(false);
});
