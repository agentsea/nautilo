import { expect, test } from "bun:test";
import { PROTECTED_TASK_CANCELLED_RESULT } from "@nautilo/db";
import {
  deriveMessageCryptoObjectIdV2, encodeMessagePayloadV2,
  type ConversationRevisionLifecycle,
} from "@nautilo/lattice-bridge";
import type {
  NativeTaskTerminalMessageCurrentAuthority,
  NativeTaskTerminalMessageIntent,
  VerifiedStagedTaskTerminalMessagePublication,
} from "@nautilo/lattice-bridge/server";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  attachBackgroundAuthorizationRecipient,
  claimTaskRuntimeBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationPublicationReconciliation,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  createProtectedTaskTerminalMessagePlan,
} from "../../src/routes/protected-task-terminal-message-plan";
import type {
  ProtectedTaskTerminalMessageIntent,
} from "../../src/routes/protected-task-terminal-message-product";
import type { TerminalMessageRecoverySettlementInput } from
  "../../src/routes/protected-task-terminal-message-recovery";
import {
  createProtectedTaskTerminalMessageSettlement,
} from "../../src/routes/protected-task-terminal-message-settlement";

const NOW = 1_806_000_000_000;
const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const ROOM = "60000000-0000-4000-8000-000000000006";
const NAMESPACE = "70000000-0000-4000-8000-000000000007";
const PRIVATE_NAMESPACE = "80000000-0000-4000-8000-000000000008";
const DOMAIN = "90000000-0000-4000-8000-000000000009";
const SESSION = "a0000000-0000-4000-8000-00000000000a";
const DEVICE = "b0000000-0000-4000-8000-00000000000b";
const MESSAGE_ID = 17;

function productIntent(): ProtectedTaskTerminalMessageIntent {
  return Object.freeze({
    taskId: TASK, taskRunId: RUN, requesterUserId: USER, agentId: AGENT,
    contentNamespaceId: PRIVATE_NAMESPACE, representation: "protected",
    bindingId: `task-run-output:${RUN}`,
    resultObjectId: `task:v1:${"a".repeat(64)}`, resultRevision: 2,
    acceptedPolicyRevision: 7,
    terminalAt: new Date(NOW - 2_000), attachedAt: new Date(NOW - 1_000),
    destinationRoomId: ROOM, destinationNamespaceId: NAMESPACE,
    messageOperationId: `task-run-delivery-message:${RUN}`,
  });
}

function lifecycle(
  intent: ProtectedTaskTerminalMessageIntent,
  payloadDigest: Uint8Array,
): ConversationRevisionLifecycle {
  return Object.freeze({
    sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
    roomId: ROOM, namespaceIdAtAllocation: NAMESPACE,
    cryptoObjectId: deriveMessageCryptoObjectIdV2({
      sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
    }),
    objectIdScheme: "message_v2", representationMode: "full_encryption",
    publicationPolicyRevision: 7,
    appendIdempotencyKey: intent.messageOperationId,
    allocationRequestDigest: payloadDigest.slice(),
    authorRole: "assistant", keyClass: "ai",
    completion: "pending", disposition: "active",
  }) as ConversationRevisionLifecycle;
}

function runningRecord(input: Readonly<{
  intent: ProtectedTaskTerminalMessageIntent;
  payloadDigest: Uint8Array;
  responseBytes: Uint8Array;
  authorizationDigest: Uint8Array;
}>): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const life = lifecycle(input.intent, input.payloadDigest);
  const plan = createProtectedTaskTerminalMessagePlan({
    intent: input.intent,
    allocation: {
      sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
      objectId: life.cryptoObjectId, createdAt: NOW - 500,
      publicationPolicyRevision: 7,
    },
    lifecycle: life,
    namespaceAuthority: {
      sourceRoomId: ROOM, sourceNamespaceId: PRIVATE_NAMESPACE,
      facts: [{ namespaceId: NAMESPACE, domainId: DOMAIN,
        expectedAccessRevision: 4, expectedPolicyRevision: 7,
        expectedDomainEpoch: 5, expectedAuthorizationRevision: 11 }],
    },
    crypto: new LatticeCrypto(), now: NOW, recipientTtlMs: 60_000,
  });
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const recipient = {
    recipientGeneration: 0,
    recipientKeyId: `task-delivery-runtime:${RUN}:0`,
    recipientPublicKey: Buffer.from(new Uint8Array(65).fill(7))
      .toString("base64url"),
    descriptorDigest: Buffer.from(new LatticeCrypto().hash(descriptorBytes))
      .toString("hex"),
    expiresAt: NOW + 60_000,
  };
  const awaiting = attachBackgroundAuthorizationRecipient(
    plan.initialRecord.snapshot, { ...recipient, now: NOW + 1 },
  );
  const ready = markBackgroundAuthorizationGrantReady(awaiting, {
    ...recipient, kind: "runtime",
    requestId: plan.initialRecord.snapshot.requestId,
    responseDigest: Buffer.from(input.authorizationDigest).toString("hex"),
    credentialDigest: "22".repeat(32), issuingHumanId: HUMAN,
    issuingDeviceId: DEVICE, now: NOW + 2,
  });
  const claimed = claimTaskRuntimeBackgroundAuthorizationRequest(ready, {
    claimId: "terminal-message-claim", now: NOW + 3,
    requestDeadlineAt: NOW + 10,
    authorizationExpiresAt: NOW + 10,
  });
  return {
    ...plan.initialRecord, descriptorBytes,
    acceptedMaterial: {
      credentialId: "terminal-message-credential",
      responseBytes: input.responseBytes.slice(),
      authorizationExpiresAt: NOW + 10,
      issuingDeviceAuthorizationRevision: 3,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(10),
    },
    snapshot: markBackgroundAuthorizationRunning(
      claimed, NOW + 4,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
}

function fixture(input: Readonly<{
  pruned?: boolean;
  completed?: boolean;
  reconciliation?: boolean;
  failedCas?: boolean;
  row?: BackgroundAuthorizationRecord;
}> = {}) {
  const crypto = new LatticeCrypto();
  const intent = productIntent();
  const encoded = encodeMessagePayloadV2({
    role: "assistant", content: PROTECTED_TASK_CANCELLED_RESULT,
  });
  const payloadDigest = crypto.hash(encoded);
  encoded.fill(0);
  const responseBytes = new Uint8Array([8, 9]);
  const authorizationDigest = crypto.hash(responseBytes);
  let row: BackgroundAuthorizationRecord | null = input.pruned
    ? null
    : input.row ?? runningRecord({
      intent, payloadDigest, responseBytes, authorizationDigest,
    });
  if (input.completed && row !== null
    && row.snapshot.formatVersion === 3
    && row.snapshot.credentialSubject.kind === "runtime") {
    row = {
      ...row,
      snapshot: completeBackgroundAuthorizationRequest(
        row.snapshot, NOW + 100,
      ),
      finishedAt: NOW + 100,
    };
  }
  if (input.reconciliation && row !== null
    && row.snapshot.formatVersion === 3
    && row.snapshot.credentialSubject.kind === "runtime") {
    row = {
      ...row,
      snapshot: markBackgroundAuthorizationPublicationReconciliation(
        row.snapshot, NOW + 5,
      ),
    };
  }
  const nativeIntent: NativeTaskTerminalMessageIntent = Object.freeze({
    taskId: TASK, taskRunId: RUN, bindingId: intent.bindingId,
    messageOperationId: intent.messageOperationId,
    sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
    objectId: deriveMessageCryptoObjectIdV2({
      sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
    }),
    roomId: ROOM, namespaceId: NAMESPACE, domainId: DOMAIN,
    mode: "encrypted_only", acceptedPolicyRevision: 7,
    publicationPolicyRevision: 7, signerAgentId: AGENT,
    payloadDigest: Buffer.from(payloadDigest).toString("hex"),
    role: "assistant", createdAt: NOW - 500,
    requestId: `task-run-delivery-message-authorization:${RUN}`,
  });
  const current: NativeTaskTerminalMessageCurrentAuthority = Object.freeze({
    taskId: TASK, taskRunId: RUN, bindingId: intent.bindingId,
    messageOperationId: intent.messageOperationId,
    sessionId: SESSION, messageId: MESSAGE_ID, revision: 0,
    objectId: nativeIntent.objectId, roomId: ROOM, namespaceId: NAMESPACE,
    domainId: DOMAIN, mode: "encrypted_only", acceptedPolicyRevision: 7,
    currentPolicyRevision: 8, namespaceAccessRevision: 4,
  });
  const authentic = new WeakMap<object, string>();
  const register = (
    value: Omit<VerifiedStagedTaskTerminalMessagePublication, never>,
  ) => {
    const proof = Object.freeze(value) as VerifiedStagedTaskTerminalMessagePublication;
    authentic.set(proof, JSON.stringify(proof));
    return proof;
  };
  const proof = register({
    intent: nativeIntent, requestId: nativeIntent.requestId,
    recipientGeneration: 0, claimId: "terminal-message-claim",
    authorizationDigest: authorizationDigest.slice(),
    genesisManifestHash: new Uint8Array(32).fill(2),
    authorityFingerprint: new Uint8Array(32).fill(3),
  } as VerifiedStagedTaskTerminalMessagePublication);
  let cas = 0;
  let assertions = 0;
  const cleanup: Array<() => void> = [];
  const deleted: string[] = [];
  const settlement = createProtectedTaskTerminalMessageSettlement({
    now: () => NOW + 100,
    recipients: { delete: (requestId, generation) => {
      deleted.push(`${requestId}:${generation}`);
      return true;
    } },
    repository: () => ({
      get: async () => row,
      compareAndSwap: async operation => {
        cas += 1;
        if (input.failedCas) return { status: "stale" as const, current: row };
        row = operation.next;
        return { status: "updated" as const, record: operation.next };
      },
    }),
  }, {
    assertStaged: candidate => {
      assertions += 1;
      if (authentic.get(candidate) !== JSON.stringify(candidate)) {
        throw new TypeError("forged staged proof");
      }
    },
  });
  const context = (changes: Partial<TerminalMessageRecoverySettlementInput> = {}) => ({
    intent, proof, currentAuthority: current, requesterHumanId: HUMAN,
    transaction: {} as CanonicalTranscriptTx, restricted: {} as never,
    deferRecipientCleanup: (release: () => void) => cleanup.push(release),
    ...changes,
  });
  return {
    settlement, context, register, proof, current, intent,
    get row() { return row; },
    get cas() { return cas; },
    get assertions() { return assertions; },
    cleanup, deleted,
  };
}

test("expired running publication completes and defers recipient cleanup", async () => {
  const value = fixture();
  expect(await value.settlement(value.context())).toBe(true);
  expect(value.row).toMatchObject({
    snapshot: { state: "completed", updatedAt: NOW + 100 },
    finishedAt: NOW + 100,
  });
  expect(value.cas).toBe(1);
  expect(value.assertions).toBe(2);
  expect(value.deleted).toEqual([]);
  expect(value.cleanup).toHaveLength(1);
  value.cleanup[0]!();
  expect(value.deleted).toEqual([
    `task-run-delivery-message-authorization:${RUN}:0`,
  ]);
});

test.each([{ pruned: true }, { completed: true }])(
  "pruned or completed replay settles without mutation %#",
  async options => {
    const value = fixture(options);
    expect(await value.settlement(value.context())).toBe(true);
    expect(value.cas).toBe(0);
    expect(value.cleanup).toHaveLength(1);
    expect(value.deleted).toEqual([]);
  },
);

test("publication reconciliation completes from the retained receipt", async () => {
  const value = fixture({ reconciliation: true });
  expect(await value.settlement(value.context())).toBe(true);
  expect(value.row).toMatchObject({
    snapshot: { state: "completed" }, finishedAt: NOW + 100,
  });
  expect(value.cas).toBe(1);
  expect(value.cleanup).toHaveLength(1);
});

test.each([
  "work", "generation", "claim", "hash", "issuer", "policy", "object",
] as const)("mismatched %s cannot settle or release custody", async kind => {
  const value = fixture();
  let context = value.context();
  if (kind === "work") {
    const row = value.row!;
    const changed = fixture({ row: {
      ...row, workKind: "task.execute", purpose: "task.execute",
    } });
    expect(await changed.settlement(changed.context())).toBe(false);
    expect(changed.cas).toBe(0);
    expect(changed.cleanup).toEqual([]);
    return;
  }
  if (kind === "issuer") context = value.context({ requesterHumanId: USER });
  else {
    const changedIntent = { ...value.proof.intent };
    const changed = {
      ...value.proof,
      intent: changedIntent,
      authorizationDigest: value.proof.authorizationDigest.slice(),
    };
    if (kind === "generation") changed.recipientGeneration = 1;
    if (kind === "claim") changed.claimId = "another-claim";
    if (kind === "hash") changed.authorizationDigest.fill(9);
    if (kind === "policy") changedIntent.publicationPolicyRevision = 8;
    if (kind === "object") changedIntent.objectId = deriveMessageCryptoObjectIdV2({
      sessionId: SESSION, messageId: MESSAGE_ID + 1, revision: 0,
    });
    context = value.context({ proof: value.register(changed as never) });
  }
  expect(await value.settlement(context)).toBe(false);
  expect(value.cas).toBe(0);
  expect(value.cleanup).toEqual([]);
  expect(value.deleted).toEqual([]);
});

test("claimed and failed-CAS records never clean up custody", async () => {
  const base = fixture();
  const running = base.row as BackgroundAuthorizationTaskRuntimeRecordV3;
  const claimed = fixture({ row: {
    ...running,
    snapshot: { ...running.snapshot, state: "claimed" },
  } as BackgroundAuthorizationTaskRuntimeRecordV3 });
  expect(await claimed.settlement(claimed.context())).toBe(false);
  expect(claimed.cleanup).toEqual([]);

  const failed = fixture({ failedCas: true });
  expect(await failed.settlement(failed.context())).toBe(false);
  expect(failed.cas).toBe(1);
  expect(failed.cleanup).toEqual([]);
  expect(failed.deleted).toEqual([]);
});
