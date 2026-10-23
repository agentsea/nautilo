import { describe, expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import type { TaskRuntimeExecutionEvidence } from "@nautilo/lattice-crypto";
import {
  verifyCryptoPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
  type CryptoPostgresConnection,
} from "@nautilo/lattice-bridge/server";
import type { ProtectedTaskRunningOccurrence } from "@nautilo/runtime";

import {
  createProtectedTaskHistoricalHumanReplySignerResolver,
  createProtectedTaskNativeReplyAuthorityResolver,
  type ProtectedTaskNativeReplyAuthorityInput,
  type ProtectedTaskNativeReplyMessageProjection,
} from "../../src/routes/protected-task-native-reply-authority";

const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  human: "50000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  sourceRoom: "70000000-0000-4000-8000-000000000007",
  room: "80000000-0000-4000-8000-000000000008",
  session: "90000000-0000-4000-8000-000000000009",
  namespace: "a0000000-0000-4000-8000-00000000000a",
  domain: "b0000000-0000-4000-8000-00000000000b",
});
const createdAt = new Date(2_000_000_000_000);
const objectId = "shared-human-reply-object";
const operationId = "shared-human-reply-operation";
const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

function occurrence(): ProtectedTaskRunningOccurrence {
  return {
    task: {
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.owner,
      agentId: ids.agent,
      callingRoomId: ids.sourceRoom,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: ids.namespace,
      contentRevision: 1,
      cryptoObjectId: "protected-task-object",
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: digest(1),
    },
    run: {
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId: `task:${ids.task}`,
      status: "running",
      startedAt: new Date(createdAt.getTime() - 1_000),
    },
  };
}

function evidence(): TaskRuntimeExecutionEvidence {
  return {
    purpose: "task.runtime.execution",
    requestId: "reply-request",
    workId: ids.run,
    claimId: "reply-claim",
    claimExpiresAt: createdAt.getTime() + 60_000,
    recipientExpiresAt: createdAt.getTime() + 60_000,
    expiresAt: createdAt.getTime() + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "reply-recipient",
    authorizationDigest: digest(2),
    policyRevision: 9,
    episodeId: "reply-episode",
    sourceRoomId: ids.sourceRoom,
    hostAuthorizationRevision: 3,
    recipientAuthorizationRevision: 4,
    operations: ["decrypt", "encrypt"],
    result: {
      taskId: ids.task,
      taskRunId: ids.run,
      contentRevision: 1,
      objectId: "task-result-object",
      signerAgentId: ids.agent,
      namespace: {
        namespaceId: ids.namespace,
        domainId: ids.domain,
        operations: ["encrypt"],
        expectedAccessRevision: 2,
        expectedPolicyRevision: 9,
      },
    },
    domainRequirements: [{
      domainId: ids.domain,
      sourceNamespaceId: ids.namespace,
      participantDigest: digest(3),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 2,
      authorizationRevision: 3,
      headDigest: digest(4),
      activeNamespaceBindingSetDigest: digest(5),
      activeNamespaceBindingCount: 1,
    }],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: ids.namespace,
      domainId: ids.domain,
      operations: ["decrypt"],
      expectedAccessRevision: 2,
      expectedPolicyRevision: 9,
    }],
  } as unknown as TaskRuntimeExecutionEvidence;
}

function projection(
  changes: Partial<ProtectedTaskNativeReplyMessageProjection> = {},
): ProtectedTaskNativeReplyMessageProjection {
  return {
    messageId: 41,
    sessionId: ids.session,
    editRevision: 0,
    role: "user",
    createdAt,
    cryptoObjectId: objectId,
    content: null,
    toolCalls: null,
    toolName: null,
    metadata: null,
    sessionOwnerId: ids.owner,
    sessionAgentId: ids.agent,
    roomId: ids.room,
    namespaceId: ids.namespace,
    lifecycleRoomId: ids.room,
    lifecycleNamespaceId: ids.namespace,
    lifecycleCryptoObjectId: objectId,
    objectIdScheme: "live_shadow_v1",
    representationMode: "full_encryption",
    publicationPolicyRevision: 9,
    payloadVersion: 2,
    keyClass: "ai",
    authorRole: "user",
    parityStatus: "client_authenticated",
    completion: "complete",
    disposition: "mapped",
    lifecycleOperationId: operationId,
    shadowOperationId: null,
    humanPeerShadowOperationId: null,
    sharedAgentShadowExecutionId: null,
    operationId,
    operationState: "published",
    operationSessionId: ids.session,
    operationRoomId: ids.room,
    operationMessageId: 41,
    operationMessageCreatedAt: createdAt,
    operationSubjectHumanId: ids.human,
    operationNamespaceId: ids.namespace,
    operationCryptoObjectId: objectId,
    operationTerminalAt: new Date(createdAt.getTime() + 1),
    actorId: ids.human,
    actorOwnerId: ids.owner,
    actorKind: "user",
    actorDisabledAt: null,
    ...changes,
  };
}

function runner(row: ProtectedTaskNativeReplyMessageProjection | null = null) {
  const transaction: ConversationProductCanonicalTransactionRunner["transaction"] =
    async use => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        for: () => Promise.resolve(row === null ? [] : [row]),
      };
      return use({ select: () => chain } as never, {} as never);
    };
  return { role: "nautilo", transaction } as
    ConversationProductCanonicalTransactionRunner;
}

function input(assertCurrentTaskAuthority = async () => {}):
ProtectedTaskNativeReplyAuthorityInput {
  return {
    occurrence: occurrence(),
    policy: { mode: "encrypted_only", shadowBehavior: "strict", revision: 9 },
    evidence: evidence(),
    acceptedBy: { userId: ids.owner, humanActorId: ids.human },
    message: {
      roomId: ids.room,
      sessionId: ids.session,
      messageId: "41",
      editRevision: 0,
      cryptoObjectId: objectId,
      namespaceId: ids.namespace,
      sourceUserId: ids.owner,
    },
    runner: runner(),
    restricted: {} as PostgresJsBridgeConnection,
    signal: new AbortController().signal,
    assertCurrentTaskAuthority,
  };
}

describe("protected Task native Human reply authority", () => {
  test("returns the exact current Message and crypto-head projection", async () => {
    let taskChecks = 0;
    const current = input(async () => { taskChecks += 1; });
    const resolver = createProtectedTaskNativeReplyAuthorityResolver(current, {
      assertEvidence: () => {},
      readProductProjection: async () => projection(),
      readCryptoAccessRevision: async () => 7,
    });
    expect(await resolver.readCurrent()).toEqual({
      mode: "encrypted_only",
      taskId: ids.task,
      taskRunId: ids.run,
      sourceRoomId: ids.sourceRoom,
      roomId: ids.room,
      sessionId: ids.session,
      messageId: 41,
      revision: 0,
      sourceUserId: ids.owner,
      sourceHumanActorId: ids.human,
      agentId: ids.agent,
      createdAt: createdAt.getTime(),
      objectId,
      cryptoAccessRevision: 7,
      namespaceId: ids.namespace,
      domainId: ids.domain,
      expectedAccessRevision: 2,
      expectedPolicyRevision: 9,
    });
    expect(taskChecks).toBe(2);
  });

  test("uses the schema projection and rejects changed Message ownership", async () => {
    const exact = input();
    expect(await createProtectedTaskNativeReplyAuthorityResolver(
      { ...exact, runner: runner(projection()) },
      { assertEvidence: () => {}, readCryptoAccessRevision: async () => 0 },
    ).readCurrent()).not.toBeNull();
    expect(await createProtectedTaskNativeReplyAuthorityResolver(
      { ...exact, runner: runner(projection({ actorOwnerId: ids.human })) },
      { assertEvidence: () => {}, readCryptoAccessRevision: async () => 0 },
    ).readCurrent()).toBeNull();
  });

  test("returns unavailable when Message, crypto, or Task authority is revoked", async () => {
    for (const unavailable of ["message", "crypto", "task"] as const) {
      let checks = 0;
      const current = input(async () => {
        checks += 1;
        if (unavailable === "task" && checks === 2) throw new TypeError("revoked");
      });
      const resolver = createProtectedTaskNativeReplyAuthorityResolver(current, {
        assertEvidence: () => {},
        readProductProjection: async () =>
          unavailable === "message" ? null : projection(),
        readCryptoAccessRevision: async () =>
          unavailable === "crypto" ? null : 0,
      });
      expect(await resolver.readCurrent()).toBeNull();
    }
  });

  test("resolves a Human-v2 signer only through the accepted actor", async () => {
    const signingPublicKey = digest(8);
    const seenParameters: unknown[][] = [];
    const query = async <Row extends PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly unknown[] = [],
    ): Promise<readonly Row[]> => {
      if (statement.includes("current_user::text")) {
        return [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }] as unknown as Row[];
      }
      seenParameters.push([...parameters]);
      return (parameters.includes(ids.human) ? [{
        human_id: ids.human,
        signing_public_key: signingPublicKey,
        revision: 5,
      }] : []) as unknown as Row[];
    };
    const connection: CryptoPostgresConnection = {
      query,
      transaction: async use => use({ query }),
    };
    const handle = await verifyCryptoPostgresHandle(connection);
    const resolve = createProtectedTaskHistoricalHumanReplySignerResolver(
      handle,
    );
    const context = {
      purpose: "verify-historical-human-object-access-genesis" as const,
      objectId,
      payloadHash: digest(9),
      envelopes: [],
      committerDeviceId: "human-device",
      hostAuthorizationRevision: 4,
    };
    expect(await resolve({
      sourceHumanActorId: ids.human,
      context,
    })).toEqual({ ...context, committerSigningPublicKey: signingPublicKey });
    expect(await resolve({
      sourceHumanActorId: ids.owner,
      context,
    })).toBeNull();
    expect(seenParameters.some(values => values.includes(ids.human))).toBeTrue();
  });
});


test("Full reply authority reads a retained dual definition with the exact current policy", async () => {
  const base = input();
  const current = { ...base, occurrence: { ...base.occurrence,
    task: { ...base.occurrence.task, contentRepresentation: "dual" as const } } };
  const deps = { assertEvidence: () => {}, readProductProjection: async () => projection(),
    readCryptoAccessRevision: async () => 7 };
  expect(await createProtectedTaskNativeReplyAuthorityResolver(current, deps).readCurrent()).not.toBeNull();
  expect(() => createProtectedTaskNativeReplyAuthorityResolver({ ...current,
    policy: { ...current.policy, revision: 10 } }, deps)).toThrow("policy is unavailable");
});
