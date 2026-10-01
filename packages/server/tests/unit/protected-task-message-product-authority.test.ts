import { describe, expect, test } from "bun:test";
import { deriveMessageCryptoObjectIdV2 } from "@nautilo/lattice-bridge";
import type {
  ConversationProductPublicationGuardInput,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  createProtectedTaskMessageProductGuard,
  type ProtectedTaskMessageProductAuthority,
} from "../../src/routes/protected-task-message-product-authority";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  session: "40000000-0000-4000-8000-000000000004",
  owner: "50000000-0000-4000-8000-000000000005",
  peer: "90000000-0000-4000-8000-000000000009",
  agent: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
  namespace: "80000000-0000-4000-8000-000000000008",
};
const inputObjectId = `task-definition:v1:${"a".repeat(64)}`;
const resultObjectId = `task-run-result:v1:${"b".repeat(64)}`;
const graphThreadId = `subagent:${ids.task}:${ids.run}`;

function authority(
  overrides: Partial<ProtectedTaskMessageProductAuthority> = {},
): ProtectedTaskMessageProductAuthority {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    jobId: ids.job,
    taskOwnerId: ids.owner,
    graphThreadId,
    sessionId: ids.session,
    sessionOwnerId: ids.owner,
    roomId: ids.room,
    namespaceId: ids.namespace,
    contentNamespaceId: ids.namespace,
    contentRevision: 2,
    requiredNamespaceFingerprint: new Uint8Array(32).fill(3),
    agentId: ids.agent,
    requestorId: ids.owner,
    inputObjectId,
    resultObjectId,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    executionSegment: 1,
    policyRevision: 9,
    representation: "protected",
    authorizationExpiresAt: 2000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function reference(expected: ProtectedTaskMessageProductAuthority) {
  return {
    kind: "protected_task_run_v1",
    taskId: expected.taskId,
    taskRunId: expected.taskRunId,
    inputObjectId: expected.inputObjectId,
    resultObjectId: expected.resultObjectId,
    authorizationRequestId: expected.authorizationRequestId,
    policyRevision: expected.policyRevision,
    executionSegment: expected.executionSegment,
  };
}

function rows(expected: ProtectedTaskMessageProductAuthority) {
  return [
    { id: ids.task, ownerId: ids.owner, requestorId: ids.owner,
      agentId: ids.agent, targetRoomId: ids.room,
      contentRepresentation: expected.representation,
      contentNamespaceId: expected.contentNamespaceId,
      contentRevision: expected.contentRevision,
      cryptoRequiredNamespaceFingerprint: expected.requiredNamespaceFingerprint,
      cryptoObjectId: inputObjectId,
      cryptoMappingState: "verified", lastError: null,
      status: "running", scheduleKind: "one_shot" },
    { id: ids.run, taskId: ids.task, jobId: ids.job,
      graphThreadId, status: "running", completedAt: null,
      resultText: null, lastError: null },
    { id: ids.job, ownerId: ids.owner, requestorId: ids.owner,
      laneKey: `task:${ids.task}`, type: "foreground", status: "running",
      result: null, message: null, input: reference(expected) },
    { id: ids.session, ownerId: expected.sessionOwnerId, agentId: ids.agent,
      threadId: graphThreadId, roomId: ids.room },
    { id: ids.room, namespaceId: ids.namespace },
    { id: "server", revision: 9, mode: expected.representation === "dual"
      ? "shadow_encryption" : "encrypted_only" },
  ];
}

function transaction(data: unknown[]): CanonicalTranscriptTx {
  const remaining = [...data];
  return {
    select() {
      const value = remaining.shift();
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        for: () => Promise.resolve(value === undefined ? [] : [value]),
      };
      return chain;
    },
  } as unknown as CanonicalTranscriptTx;
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error("Expected publication rejection");
}

const append: ConversationProductPublicationGuardInput = {
  action: "appendAllocated",
  sessionId: ids.session,
  messageId: 41,
  revision: 0,
  idempotencyKey: `task-transcript:${ids.run}:fp:v1:ai:${"c".repeat(64)}`,
  authorRole: "assistant",
  keyClass: "ai",
  publicationPolicy: { expectedRevision: 9, representation: "protected_only" },
};

describe("protected Task Message product guard", () => {
  test("accepts an exact running Task transcript append", async () => {
    const expected = authority();
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    await guard.assertPublicationAllowed(transaction(rows(expected)), append);
  });

  test("allows the accepted peer Session owner to differ from Task owner", async () => {
    const expected = authority({ sessionOwnerId: ids.peer });
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    await guard.assertPublicationAllowed(transaction(rows(expected)), append);
  });

  test("rejects unrelated append identity before product access", async () => {
    const expected = authority();
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    const invalid = { ...append, idempotencyKey: "other-message" };
    expect(await rejected(guard.assertPublicationAllowed(
      transaction([]), invalid,
    ))).toContain("authority changed");
  });

  test("rejects a moved Room and expired grant", async () => {
    const expected = authority();
    const moved: unknown[] = rows(expected);
    moved[0] = { ...(moved[0] as Record<string, unknown>), targetRoomId: ids.namespace };
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    expect(await rejected(guard.assertPublicationAllowed(
      transaction(moved), append,
    ))).toContain("authority changed");
    const expired = createProtectedTaskMessageProductGuard(expected, () => 2000);
    expect(await rejected(expired.assertPublicationAllowed(
      transaction([]), append,
    ))).toContain("authority changed");
  });

  test("rejects a changed Task source revision", async () => {
    const expected = authority();
    const changed: unknown[] = rows(expected);
    changed[0] = {
      ...(changed[0] as Record<string, unknown>),
      contentRevision: expected.contentRevision + 1,
    };
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    expect(await rejected(guard.assertPublicationAllowed(
      transaction(changed), append,
    ))).toContain("authority changed");
  });

  test("checks the exact mapped lifecycle before crypto completion", async () => {
    const expected = authority();
    const coordinates = {
      action: "markCryptoComplete" as const,
      sessionId: ids.session,
      messageId: 41,
      revision: 0,
    };
    const lifecycle = {
      sessionId: ids.session, messageId: 41, editRevision: 0,
      roomId: ids.room, namespaceIdAtAllocation: ids.namespace,
      objectIdScheme: "message_v2",
      cryptoObjectId: deriveMessageCryptoObjectIdV2(coordinates),
      representationMode: "full_encryption", publicationPolicyRevision: 9,
      keyClass: "ai", authorRole: "assistant",
      appendIdempotencyKey: append.action === "appendAllocated"
        ? append.idempotencyKey : "",
    };
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    await guard.assertPublicationAllowed(
      transaction([...rows(expected), lifecycle]), coordinates,
    );
    expect(await rejected(guard.assertPublicationAllowed(
      transaction([...rows(expected), { ...lifecycle, roomId: ids.namespace }]),
      coordinates,
    ))).toContain("authority changed");
  });

  test("accepts a Shadow lifecycle with the canonical null policy revision", async () => {
    const expected = authority({ representation: "dual" });
    const coordinates = {
      action: "markCryptoComplete" as const,
      sessionId: ids.session,
      messageId: 41,
      revision: 0,
    };
    const lifecycle = {
      sessionId: ids.session, messageId: 41, editRevision: 0,
      roomId: ids.room, namespaceIdAtAllocation: ids.namespace,
      objectIdScheme: "message_v2",
      cryptoObjectId: deriveMessageCryptoObjectIdV2(coordinates),
      representationMode: "shadow_encryption", publicationPolicyRevision: null,
      keyClass: "ai", authorRole: "assistant",
      appendIdempotencyKey: append.action === "appendAllocated"
        ? append.idempotencyKey : "",
    };
    const guard = createProtectedTaskMessageProductGuard(expected, () => 1000);
    await guard.assertPublicationAllowed(
      transaction([...rows(expected), lifecycle]), coordinates,
    );
    expect(await rejected(guard.assertPublicationAllowed(
      transaction([...rows(expected), { ...lifecycle, publicationPolicyRevision: 9 }]),
      coordinates,
    ))).toContain("authority changed");
  });
});
