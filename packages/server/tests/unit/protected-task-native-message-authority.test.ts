import { describe, expect, test } from "bun:test";

import type { PostgresJsBridgeConnection } from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { TaskRuntimeExecutionEvidence } from "@nautilo/lattice-crypto";
import { deriveMessageCryptoObjectIdV2 } from "@nautilo/lattice-bridge";
import type {
  ConversationProductCanonicalTransactionRunner,
  NativeTaskMessageAuthority,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskOccurrence,
} from "@nautilo/runtime";

import {
  createProtectedTaskNativeMessageAuthorityResolver,
  type ProtectedTaskNativeMessageAuthorityDependencies,
  type ProtectedTaskNativeMessageAuthorityInput,
} from "../../src/routes/protected-task-native-message-authority";

const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requestor: "50000000-0000-4000-8000-000000000005",
  human: "60000000-0000-4000-8000-000000000006",
  device: "70000000-0000-4000-8000-000000000007",
  agent: "80000000-0000-4000-8000-000000000008",
  sourceRoom: "90000000-0000-4000-8000-000000000009",
  room: "a0000000-0000-4000-8000-00000000000a",
  namespace: "b0000000-0000-4000-8000-00000000000b",
  contentNamespace: "c0000000-0000-4000-8000-00000000000c",
  domain: "d0000000-0000-4000-8000-00000000000d",
  session: "e0000000-0000-4000-8000-00000000000e",
});

const graphThreadId = `subagent:task:${ids.task}:${ids.run}`;
const humanTurnId = "task-segment-turn:1";
const requestId = `task-run-authorization:${ids.run}`;
const claimId = `task-run-claim:${ids.run}`;
const episodeId = `task-run:${ids.run}`;
const createdAt = 2_000_000_000_000;
const expiresAt = createdAt + 300_000;
const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const hex = (fill: number): string => fill.toString(16).padStart(2, "0").repeat(32);

const coordinates = Object.freeze({
  sessionId: ids.session,
  messageId: 41,
  revision: 0,
  taskId: ids.task,
  taskRunId: ids.run,
  roomId: ids.room,
  graphThreadId,
  humanTurnId,
  agentId: ids.agent,
  objectId: deriveMessageCryptoObjectIdV2({
    sessionId: ids.session,
    messageId: 41,
    revision: 0,
  }),
  role: "assistant" as const,
});

function evidence(): TaskRuntimeExecutionEvidence {
  return Object.freeze({
    purpose: "task.runtime.execution",
    requestId,
    workId: ids.run,
    claimId,
    claimExpiresAt: expiresAt,
    recipientExpiresAt: expiresAt,
    expiresAt,
    recipientGeneration: 2,
    recipientKeyId: `task-runtime:${ids.run}:2`,
    authorizationDigest: digest(1),
    policyRevision: 9,
    episodeId,
    sourceRoomId: ids.sourceRoom,
    hostAuthorizationRevision: 7,
    recipientAuthorizationRevision: 0,
    operations: Object.freeze(["decrypt", "encrypt"] as const),
    result: Object.freeze({
      taskId: ids.task,
      taskRunId: ids.run,
      contentRevision: 1 as const,
      objectId: `task-run-result:v1:${"a".repeat(64)}`,
      signerAgentId: ids.agent,
      namespace: Object.freeze({
        namespaceId: ids.contentNamespace,
        domainId: ids.domain,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: 4,
        expectedPolicyRevision: 9,
      }),
    }),
    domainRequirements: Object.freeze([
      Object.freeze({
        domainId: ids.domain,
        sourceNamespaceId: ids.contentNamespace,
        participantDigest: digest(2),
        participantCount: 2,
        keyClass: "ai" as const,
        domainKeyGeneration: 5,
        authorizationRevision: 6,
        headDigest: digest(3),
        activeNamespaceBindingSetDigest: digest(4),
        activeNamespaceBindingCount: 2,
      }),
    ]),
    namespaceRequirements: Object.freeze([
      Object.freeze({
        ordinal: 0,
        namespaceId: ids.namespace,
        domainId: ids.domain,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: 3,
        expectedPolicyRevision: 9,
      }),
    ]),
  }) as unknown as TaskRuntimeExecutionEvidence;
}

function occurrence(): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.requestor,
      agentId: ids.agent,
      callingRoomId: ids.sourceRoom,
      scheduleKind: "now" as const,
      contentRepresentation: "protected" as const,
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 3,
      cryptoObjectId: `task-definition:v1:${"b".repeat(64)}`,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: digest(5),
    }),
    run: Object.freeze({
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "awaiting" as const,
      startedAt: new Date(createdAt - 1_000),
    }),
  });
}

function expected(): NativeTaskMessageAuthority {
  return Object.freeze({
    ...coordinates,
    mode: "encrypted_only",
    serverId: "https://server.example.test",
    requestId,
    sourceRoomId: ids.sourceRoom,
    episodeId,
    hostAuthorizationRevision: 7,
    recipientAuthorizationRevision: 0,
    claimId,
    authorizationDigest: hex(1),
    policyRevision: 9,
    createdAt,
    namespaceId: ids.namespace,
    namespaceAccessRevision: 3,
    namespaceKeyGeneration: 8,
    namespaceBindingDigest: hex(6),
    bundleRevision: 4,
    retainedAuthoritySetDigest: hex(7),
    domainId: ids.domain,
    domainKeyGeneration: 5,
    domainAuthorizationRevision: 6,
    domainHeadDigest: hex(3),
    participantDigest: hex(2),
    participantCount: 2,
    activeNamespaceBindingSetDigest: hex(4),
    activeNamespaceBindingCount: 2,
    runtimeGeneration: 11,
    agentAuthorizationRevision: 12,
    signerKeyId: "runtime-signer:11",
  });
}

function input(): ProtectedTaskNativeMessageAuthorityInput {
  const value = evidence();
  const abort = new AbortController();
  const currentOccurrence = occurrence();
  return Object.freeze({
    occurrence: currentOccurrence,
    record: {
      snapshot: {
        state: "running",
        claimId,
        requestId,
        workId: ids.run,
      },
      expectedPolicyRevision: 9,
    } as BackgroundAuthorizationTaskRuntimeRecordV3,
    request: {
      requestId,
      workId: ids.run,
      episodeId,
      sourceRoomId: ids.sourceRoom,
    } as ProtectedTaskNativeMessageAuthorityInput["request"],
    subject: Object.freeze({
      userId: ids.requestor,
      humanActorId: ids.human,
      deviceId: ids.device,
    }),
    evidence: value,
    coordinates,
    createdAt,
    productAuthority: Object.freeze({
      taskId: ids.task,
      taskRunId: ids.run,
      jobId: ids.job,
      taskOwnerId: ids.owner,
      graphThreadId,
      sessionId: ids.session,
      sessionOwnerId: ids.owner,
      roomId: ids.room,
      namespaceId: ids.namespace,
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 3,
      requiredNamespaceFingerprint: digest(5),
      agentId: ids.agent,
      requestorId: ids.requestor,
      inputObjectId: currentOccurrence.task.cryptoObjectId,
      resultObjectId: value.result.objectId,
      authorizationRequestId: requestId,
      executionSegment: 1,
      policyRevision: 9,
      representation: "protected",
      authorizationExpiresAt: expiresAt,
      signal: abort.signal,
    }),
    runner: {} as ConversationProductCanonicalTransactionRunner,
    restricted: {} as PostgresJsBridgeConnection,
    crypto: new LatticeCrypto(),
    serverScope: "https://server.example.test",
    now: () => createdAt,
    signal: abort.signal,
  });
}

function dependencies(
  changes: Readonly<{
    product?: boolean;
    grant?: "current" | "missing" | "changed";
    namespace?: "current" | "missing" | "changed";
    signer?: "current" | "missing" | "changed";
    evidence?: "current" | "invalid";
  }> = {},
): ProtectedTaskNativeMessageAuthorityDependencies {
  const authority = expected();
  return Object.freeze({
    assertEvidence: () => {
      if (changes.evidence === "invalid") throw new TypeError("invalid");
    },
    validateProduct: async () => changes.product ?? true,
    withCurrentAuthority: async current => {
      if (changes.grant === "missing") return null;
      const held = {
        foreground: {
          authorizationId: requestId,
          policyRevision: 9,
          sessionId: episodeId,
          roomId: ids.sourceRoom,
          subjectHumanId: ids.human,
          committerDeviceId: ids.device,
          hostAuthorizationRevision: 7,
          recipientKind: "runtime",
          recipientPrincipalId: "nautilo_task_runtime",
          recipientAuthorizationRevision: 0,
          recipientRuntimeGeneration: 2,
          recipientKeyId: `task-runtime:${ids.run}:2`,
          domains: [{
            domainId: ids.domain,
            sourceNamespaceId: ids.contentNamespace,
            keyClass: "ai",
            domainKeyGeneration: 5,
            authorizationRevision: 6,
            participantDigest: digest(
              changes.grant === "changed" ? 9 : 2,
            ),
            participantCount: 2,
            headDigest: digest(3),
            activeNamespaceBindingSetDigest: digest(4),
            activeNamespaceBindingCount: 2,
          }],
        },
        namespaceRequirements: [{
          ordinal: 0,
          namespaceId: ids.namespace,
          domainId: ids.domain,
          operations: ["encrypt"],
          expectedAccessRevision: 3,
          expectedPolicyRevision: 9,
        }],
      } as never;
      return current.use(held);
    },
    inspectNamespace: async () => changes.namespace === "missing" ? null : ({
      namespaceId: ids.namespace,
      namespaceAccessRevision: 3,
      namespaceKeyGeneration: 8,
      namespaceBindingDigest: changes.namespace === "changed" ? hex(9) : hex(6),
      bundleRevision: 4,
      retainedAuthoritySetDigest: hex(7),
      domainId: ids.domain,
      domainKeyGeneration: 5,
      domainAuthorizationRevision: 6,
      domainHeadDigest: hex(3),
    }),
    inspectSigner: async () => changes.signer === "missing" ? null : ({
      runtimeGeneration: 11,
      agentAuthorizationRevision: 12,
      signerKeyId: changes.signer === "changed"
        ? "runtime-signer:other"
        : authority.signerKeyId,
    }),
  });
}

function productRows(
  changedMessage: Readonly<Record<string, unknown>> = {},
): unknown[] {
  const value = input();
  const product = value.productAuthority;
  const lifecycle = {
    sessionId: ids.session,
    messageId: coordinates.messageId,
    editRevision: 0,
    roomId: ids.room,
    namespaceIdAtAllocation: ids.namespace,
    cryptoObjectId: coordinates.objectId,
    objectIdScheme: "message_v2",
    representationMode: "full_encryption",
    publicationPolicyRevision: 9,
    keyClass: "ai",
    authorRole: "assistant",
    appendIdempotencyKey:
      `task-transcript:${ids.run}:fp:v1:ai:${"d".repeat(64)}`,
    shadowOperationId: null,
    humanPeerShadowOperationId: null,
    sharedAgentShadowOperationId: null,
    sharedAgentShadowExecutionId: null,
    failureCode: null,
    completion: "pending",
    disposition: "active",
  };
  return [
    {
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.requestor,
      agentId: ids.agent,
      targetRoomId: ids.room,
      contentRepresentation: "protected",
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 3,
      cryptoRequiredNamespaceFingerprint: digest(5),
      cryptoObjectId: product.inputObjectId,
      cryptoMappingState: "verified",
      lastError: null,
      status: "running",
      scheduleKind: "now",
    },
    {
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "running",
      completedAt: null,
      resultText: null,
      lastError: null,
    },
    {
      id: ids.job,
      ownerId: ids.requestor,
      requestorId: ids.requestor,
      laneKey: `task:${ids.task}`,
      type: "foreground",
      status: "running",
      result: null,
      message: null,
      input: {
        kind: "protected_task_run_v1",
        taskId: ids.task,
        taskRunId: ids.run,
        inputObjectId: product.inputObjectId,
        resultObjectId: product.resultObjectId,
        authorizationRequestId: requestId,
        policyRevision: 9,
        executionSegment: 1,
      },
    },
    {
      id: ids.session,
      ownerId: ids.owner,
      agentId: ids.agent,
      threadId: graphThreadId,
      roomId: ids.room,
    },
    { id: ids.room, namespaceId: ids.namespace },
    { id: "server", revision: 9, mode: "encrypted_only" },
    lifecycle,
    {
      id: coordinates.messageId,
      sessionId: ids.session,
      editRevision: 0,
      role: "assistant",
      createdAt: new Date(createdAt),
      cryptoObjectId: null,
      humanTurnId: null,
      transcriptOrigin: "subagent",
      content: null,
      toolCalls: null,
      toolName: null,
      metadata: null,
      ...changedMessage,
    },
    lifecycle,
  ];
}

function runner(rows: unknown[]): ConversationProductCanonicalTransactionRunner {
  const transaction: ConversationProductCanonicalTransactionRunner["transaction"] =
    async (use) => {
      const remaining = [...rows];
      const tx = {
        select() {
          const row = remaining.shift();
          const chain = {
            from: () => chain,
            where: () => chain,
            limit: () => chain,
            for: () => Promise.resolve(row === undefined ? [] : [row]),
            then: (resolve: (rows: unknown[]) => unknown) =>
              Promise.resolve(row === undefined ? [] : [row]).then(resolve),
          };
          return chain;
        },
      };
      return use(tx as never, {} as never);
    };
  return {
    role: "nautilo",
    transaction,
  } as unknown as ConversationProductCanonicalTransactionRunner;
}

function nonProductDependencies(): Partial<
  ProtectedTaskNativeMessageAuthorityDependencies
> {
  const current = dependencies();
  return {
    assertEvidence: current.assertEvidence,
    withCurrentAuthority: current.withCurrentAuthority,
    inspectNamespace: current.inspectNamespace,
    inspectSigner: current.inspectSigner,
  };
}

describe("protected Task native Message current authority", () => {
  test("returns a detached exact projection when every authority is current", async () => {
    const resolve = createProtectedTaskNativeMessageAuthorityResolver(
      input(),
      dependencies(),
    );
    const projection = expected();
    const result = await resolve(projection);
    expect(result).toEqual(projection);
    expect(result).not.toBe(projection);
  });

  test("composes the product guard with the exact allocated Message row", async () => {
    const current = input();
    const resolve = createProtectedTaskNativeMessageAuthorityResolver(
      { ...current, runner: runner(productRows()) },
      nonProductDependencies(),
    );
    expect(await resolve(expected())).toEqual(expected());

    const stale = createProtectedTaskNativeMessageAuthorityResolver(
      {
        ...current,
        runner: runner(productRows({ transcriptOrigin: "main" })),
      },
      nonProductDependencies(),
    );
    expect(await stale(expected())).toBeNull();
  });

  test("accepts canonical Shadow lifecycle policy metadata", async () => {
    const current = input();
    const shadowInput = {
      ...current,
      occurrence: {
        ...current.occurrence,
        task: { ...current.occurrence.task, contentRepresentation: "dual" as const },
      },
      productAuthority: {
        ...current.productAuthority,
        representation: "dual" as const,
      },
    };
    const rows = productRows();
    rows[0] = { ...(rows[0] as Record<string, unknown>), contentRepresentation: "dual" };
    rows[5] = { ...(rows[5] as Record<string, unknown>), mode: "shadow_encryption" };
    for (const index of [6, 8]) {
      rows[index] = {
        ...(rows[index] as Record<string, unknown>),
        representationMode: "shadow_encryption",
        publicationPolicyRevision: null,
      };
    }
    const projection = { ...expected(), mode: "shadow_encryption" as const };
    const resolve = createProtectedTaskNativeMessageAuthorityResolver(
      { ...shadowInput, runner: runner(rows) },
      nonProductDependencies(),
    );
    expect(await resolve(projection)).toEqual(projection);
  });

  test("rejects substituted message or grant coordinates before publication", async () => {
    const resolve = createProtectedTaskNativeMessageAuthorityResolver(
      input(),
      dependencies(),
    );
    expect(await resolve({ ...expected(), messageId: 42 })).toBeNull();
    expect(await resolve({ ...expected(), claimId: "other-claim" })).toBeNull();
    const current = input();
    const changedProduct = createProtectedTaskNativeMessageAuthorityResolver(
      {
        ...current,
        productAuthority: {
          ...current.productAuthority,
          contentRevision: current.productAuthority.contentRevision + 1,
        },
      },
      dependencies(),
    );
    expect(await changedProduct(expected())).toBeNull();
  });

  test("fails closed when product or accepted recipient authority changed", async () => {
    expect(await createProtectedTaskNativeMessageAuthorityResolver(
      input(),
      dependencies({ product: false }),
    )(expected())).toBeNull();
    expect(await createProtectedTaskNativeMessageAuthorityResolver(
      input(),
      dependencies({ grant: "changed" }),
    )(expected())).toBeNull();
    expect(await createProtectedTaskNativeMessageAuthorityResolver(
      input(),
      dependencies({ grant: "missing" }),
    )(expected())).toBeNull();
  });

  test("fails closed when Namespace, Domain, signer or evidence changed", async () => {
    for (const changed of [
      dependencies({ namespace: "changed" }),
      dependencies({ namespace: "missing" }),
      dependencies({ signer: "changed" }),
      dependencies({ signer: "missing" }),
      dependencies({ evidence: "invalid" }),
    ]) {
      const resolve = createProtectedTaskNativeMessageAuthorityResolver(
        input(),
        changed,
      );
      expect(await resolve(expected())).toBeNull();
    }
  });

  test("propagates cancellation without consulting current authority", async () => {
    const current = input();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const aborted = {
      ...current,
      signal: controller.signal,
      productAuthority: {
        ...current.productAuthority,
        signal: controller.signal,
      },
    };
    const resolve = createProtectedTaskNativeMessageAuthorityResolver(
      aborted,
      dependencies(),
    );
    await Promise.resolve(
      expect(resolve(expected())).rejects.toThrow("cancelled"),
    );
  });
});
