import { expect, test } from "bun:test";
import {
  PROTECTED_TASK_CANCELLED_RESULT,
  protectedTaskRunCancelledResultObjectId,
  protectedTaskRunMessageOperationId,
  protectedTaskRunOutputBindingId,
} from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2,
} from "@nautilo/lattice-bridge";
import {
  lockExactProtectedTaskTerminalMessageAllocation,
} from "../../src/routes/protected-task-terminal-message-allocation";
import type { ProtectedTaskTerminalMessageIntent } from
  "../../src/routes/protected-task-terminal-message-product";

const NOW = 1_940_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000751";
const RUN = "20000000-0000-4000-8000-000000000751";
const USER = "30000000-0000-4000-8000-000000000751";
const AGENT = "40000000-0000-4000-8000-000000000751";
const PRIVATE_NAMESPACE = "50000000-0000-4000-8000-000000000751";
const ROOM = "60000000-0000-4000-8000-000000000751";
const NAMESPACE = "70000000-0000-4000-8000-000000000751";
const SESSION = "80000000-0000-4000-8000-000000000751";
const MESSAGE_ID = 61;
const PAYLOAD_DIGEST = new Uint8Array(32).fill(0x71);
const OBJECT = deriveMessageCryptoObjectIdV2({
  sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
});

const intent: ProtectedTaskTerminalMessageIntent = Object.freeze({
  taskId: TASK, taskRunId: RUN, requesterUserId: USER, agentId: AGENT,
  contentNamespaceId: PRIVATE_NAMESPACE, representation: "protected",
  bindingId: protectedTaskRunOutputBindingId(RUN),
  resultObjectId: protectedTaskRunCancelledResultObjectId(TASK, RUN),
  resultRevision: 2, acceptedPolicyRevision: 7,
  terminalAt: new Date(NOW - 2_000), attachedAt: new Date(NOW - 1_000),
  destinationRoomId: ROOM, destinationNamespaceId: NAMESPACE,
  messageOperationId: protectedTaskRunMessageOperationId(RUN),
});

function exactRows() {
  return {
    message: {
      id: MESSAGE_ID, sessionId: SESSION, role: "assistant",
      content: null, toolCalls: null, toolName: null, fingerprint: null,
      humanTurnId: null, cryptoObjectId: null,
      createdAt: new Date(NOW), editedAt: null, editRevision: 0,
      transcriptOrigin: "subagent", parentThreadId: null, scopeId: null,
      subthreadRoomId: null, replyToMessageId: null, metadata: null,
    },
    lifecycle: {
      sequence: 81,
      sessionId: SESSION, messageId: MESSAGE_ID, editRevision: 0,
      roomId: ROOM, namespaceIdAtAllocation: NAMESPACE,
      cryptoObjectId: OBJECT, objectIdScheme: "message_v2",
      payloadVersion: 2, representationMode: "full_encryption",
      publicationPolicyRevision: 7,
      appendIdempotencyKey: intent.messageOperationId,
      allocationRequestDigest: PAYLOAD_DIGEST.slice(),
      authorRole: "assistant", keyClass: "ai",
      subthreadReplyClassification: "excluded",
      shadowOperationId: null, humanPeerShadowOperationId: null,
      sharedAgentShadowOperationId: null,
      sharedAgentShadowExecutionId: null, shadowTranscriptOrdinal: null,
      shadowReservedCreatedAt: null, shadowStreamId: null,
      shadowStreamStartDigest: null, shadowStreamTerminalDigest: null,
      shadowStreamedTextDigest: null, shadowDurableEventDigest: null,
      completion: "pending", disposition: "active", parityStatus: "pending",
      cryptoCompletedAt: null, leaseToken: null, leaseExpiresAt: null,
      failureCode: null, attemptCount: 0, nextAttemptAt: new Date(NOW),
      repairIdentityDigest: null, repairSourceRevision: null,
      repairSourceDigest: null, repairPublisherKind: null,
      repairPublisherId: null, repairPublisherHumanId: null,
      repairAttestationDigest: null, terminalOperationId: null,
      terminalOperationGroupId: null, terminalOperationType: null,
      terminalExpectedRevision: null, terminalRequestDigest: null,
      quarantineLeaseToken: null, deleteWasUnread: null,
      deleteOrphanedTurnId: null, deleteRootParentRoomId: null,
      deleteRootAnchorMessageId: null, deleteRootReplyCount: null,
      deleteRootLastReplyAt: null, deleteRootSummaryRevision: null,
      createdAt: new Date(NOW + 1), updatedAt: new Date(NOW + 1),
    },
  };
}

function transaction(rows: ReturnType<typeof exactRows>) {
  let query = 0;
  return {
    select: () => {
      const selected = query++ === 0
        ? [{ sessionId: rows.lifecycle.sessionId,
          messageId: rows.lifecycle.messageId }]
        : query === 2 ? [rows.message] : [rows.lifecycle];
      const promise = Promise.resolve(selected);
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: () => builder,
        for: () => promise,
        then: promise.then.bind(promise),
      };
      return builder;
    },
  };
}

function lock(
  rows: ReturnType<typeof exactRows>,
  phase: "pristine" | "staged_or_mapped" = "pristine",
) {
  return lockExactProtectedTaskTerminalMessageAllocation({
    transaction: transaction(rows) as never,
    intent, sessionId: SESSION,
    expectedPayloadDigest: PAYLOAD_DIGEST,
    phase,
    expected: {
      messageId: MESSAGE_ID, revision: 0, objectId: OBJECT,
      createdAt: NOW, publicationPolicyRevision: 7,
    },
  });
}

test("locks the exact pristine fixed terminal Message allocation", async () => {
  const locked = await lock(exactRows());
  expect(locked).toMatchObject({
    createdAt: NOW,
    lifecycle: {
      sessionId: SESSION, messageId: MESSAGE_ID,
      cryptoObjectId: OBJECT, completion: "pending",
    },
  });
  expect(locked?.lifecycle.allocationRequestDigest).toEqual(PAYLOAD_DIGEST);
  expect(locked?.lifecycle.allocationRequestDigest).not.toBe(PAYLOAD_DIGEST);
});

for (const [field, value] of [
  ["metadata", { unsafe: true }],
  ["transcriptOrigin", "human"],
  ["cryptoObjectId", OBJECT],
] as const) {
  test(`rejects Message ${field} corruption`, async () => {
    const rows = exactRows();
    Object.assign(rows.message, { [field]: value });
    await Promise.resolve(expect(lock(rows)).rejects.toThrow(
      "allocation is not exact",
    ));
  });
}

for (const [field, value] of [
  ["payloadVersion", 1],
  ["allocationRequestDigest", new Uint8Array(32).fill(0x72)],
  ["repairIdentityDigest", new Uint8Array(32).fill(0x73)],
  ["attemptCount", 1],
  ["nextAttemptAt", null],
  ["shadowOperationId", "unexpected"],
] as const) {
  test(`rejects lifecycle ${field} corruption`, async () => {
    const rows = exactRows();
    Object.assign(rows.lifecycle, { [field]: value });
    await Promise.resolve(expect(lock(rows)).rejects.toThrow(
      "allocation is not exact",
    ));
  });
}

test("staged-or-mapped phase accepts only the exact completed successor", async () => {
  const rows = exactRows();
  Object.assign(rows.lifecycle, {
    completion: "complete", disposition: "mapped",
    parityStatus: "server_authenticated", cryptoCompletedAt: new Date(NOW + 1),
    nextAttemptAt: null, updatedAt: new Date(NOW + 2),
  });
  Object.assign(rows.message, { cryptoObjectId: OBJECT });
  expect(await lock(rows, "staged_or_mapped")).not.toBeNull();
  await Promise.resolve(expect(lock(rows, "pristine")).rejects.toThrow(
    "allocation is not exact",
  ));

  Object.assign(rows.lifecycle, { disposition: "quarantined" });
  await Promise.resolve(expect(lock(rows, "staged_or_mapped")).rejects.toThrow(
    "allocation is not exact",
  ));
});

test("rejects a replay at a different expected coordinate", async () => {
  const rows = exactRows();
  await Promise.resolve(expect(lockExactProtectedTaskTerminalMessageAllocation({
    transaction: transaction(rows) as never,
    intent, sessionId: SESSION, expectedPayloadDigest: PAYLOAD_DIGEST,
    phase: "pristine",
    expected: {
      messageId: MESSAGE_ID + 1, revision: 0, objectId: OBJECT,
      createdAt: NOW, publicationPolicyRevision: 7,
    },
  })).rejects.toThrow("allocation coordinate changed"));
});

test("rejects a durable operation allocated in a different Session", async () => {
  const rows = exactRows();
  const changedSession = "90000000-0000-4000-8000-000000000751";
  await Promise.resolve(expect(lockExactProtectedTaskTerminalMessageAllocation({
    transaction: transaction(rows) as never,
    intent, sessionId: changedSession, expectedPayloadDigest: PAYLOAD_DIGEST,
    phase: "staged_or_mapped",
  })).rejects.toThrow("allocation Session changed"));
});


test("Shadow completion requires verified parity while retaining its ordinary sibling", async () => {
  const rows = exactRows();
  Object.assign(rows.message, { content: PROTECTED_TASK_CANCELLED_RESULT, cryptoObjectId: OBJECT });
  Object.assign(rows.lifecycle, { representationMode: "shadow_encryption", publicationPolicyRevision: null,
    completion: "complete", disposition: "mapped", parityStatus: "server_verified",
    cryptoCompletedAt: new Date(NOW + 1), nextAttemptAt: null, updatedAt: new Date(NOW + 2) });
  const read = () => lockExactProtectedTaskTerminalMessageAllocation({
    transaction: transaction(rows) as never, intent: { ...intent, representation: "dual" },
    sessionId: SESSION, expectedPayloadDigest: PAYLOAD_DIGEST, phase: "staged_or_mapped",
  });
  expect(await read()).not.toBeNull();
  Object.assign(rows.lifecycle, { parityStatus: "server_authenticated" });
  const denied = await Promise.allSettled([read()]);
  expect(denied[0]?.status).toBe("rejected");
});
