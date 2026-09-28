import { describe, expect, test } from "bun:test";

import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
  CryptoPostgresHandle,
  NativeTaskMessageAuthority,
  PreparedNativeTaskMessage,
} from "@nautilo/lattice-bridge/server";

import {
  createProtectedTaskNativeMessagePublication,
  type ProtectedTaskNativeMessagePublicationInput,
  type ProtectedTaskNativeMessagePublicationRequest,
} from "../../src/routes/protected-task-native-message-publication";

const NOW = 2_000_000_000_000;
const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requestor: "50000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
  namespace: "80000000-0000-4000-8000-000000000008",
  contentNamespace: "90000000-0000-4000-8000-000000000009",
  session: "a0000000-0000-4000-8000-00000000000a",
});
const graphThreadId = `subagent:task:${ids.task}:${ids.run}`;
const fingerprint = "fp:v1:exact-message";

function input(
  representation: "dual" | "protected",
  signal: AbortSignal,
): ProtectedTaskNativeMessagePublicationInput {
  const productAuthority = Object.freeze({
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
    contentRevision: 1,
    requiredNamespaceFingerprint: new Uint8Array(32).fill(1),
    agentId: ids.agent,
    requestorId: ids.requestor,
    inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
    resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    executionSegment: 1,
    policyRevision: 4,
    representation,
    authorizationExpiresAt: NOW + 60_000,
    signal,
  });
  return {
    authority: {
      occurrence: {
        task: {
          id: ids.task,
          ownerId: ids.owner,
          requestorId: ids.requestor,
          agentId: ids.agent,
          callingRoomId: null,
          scheduleKind: "now",
          contentRepresentation: representation,
          contentNamespaceId: ids.contentNamespace,
          contentRevision: 1,
          cryptoObjectId: productAuthority.inputObjectId,
          cryptoAccessRevision: 0,
          cryptoRequiredNamespaceFingerprint:
            productAuthority.requiredNamespaceFingerprint,
        },
        run: {
          id: ids.run,
          taskId: ids.task,
          jobId: ids.job,
          graphThreadId,
          status: "awaiting",
          startedAt: new Date(NOW - 1_000),
        },
      },
      record: {} as ProtectedTaskNativeMessagePublicationInput["authority"]["record"],
      request: {} as ProtectedTaskNativeMessagePublicationInput["authority"]["request"],
      subject: {} as ProtectedTaskNativeMessagePublicationInput["authority"]["subject"],
      evidence: {} as ProtectedTaskNativeMessagePublicationInput["authority"]["evidence"],
      productAuthority,
      runner: {} as ConversationProductCanonicalTransactionRunner,
      restricted: {} as ProtectedTaskNativeMessagePublicationInput["authority"]["restricted"],
      crypto: {
        hash: () => new Uint8Array(32).fill(9),
      } as unknown as ProtectedTaskNativeMessagePublicationInput["authority"]["crypto"],
      serverScope: "https://server.example.test",
      now: () => NOW,
      signal,
    },
    humanTurnId: `task-segment-turn:${ids.run}:1`,
    productHandle: {} as ConversationProductPostgresHandle,
    cryptoHandle: {} as CryptoPostgresHandle,
    preparation: {} as ProtectedTaskNativeMessagePublicationInput["preparation"],
    resolveHistoricalAgentSignerAuthority: () => null,
    hasCurrentGrant: () => Promise.resolve(true),
  };
}

function request(signal: AbortSignal): ProtectedTaskNativeMessagePublicationRequest {
  return Object.freeze({
    identity: Object.freeze({
      taskId: ids.task,
      taskRunId: ids.run,
      graphThreadId,
      roomId: ids.room,
      humanTurnId: `task-segment-turn:${ids.run}:1`,
      agentId: ids.agent,
    }),
    idempotencyKey: `task-transcript:${ids.run}:${fingerprint}`,
    fingerprint,
    payload: Object.freeze({
      role: "assistant" as const,
      content: "confidential Task output",
      toolCalls: Object.freeze([{ name: "search", args: { query: "private" } }]),
      toolName: "search",
    }),
    signal,
  });
}

function harness(
  representation: "dual" | "protected",
  replay: "pending" | "mapped" = "pending",
) {
  const controller = new AbortController();
  const source = input(representation, controller.signal);
  const calls: string[] = [];
  let appended: Record<string, unknown> | null = null;
  let marked: Record<string, unknown> | null = null;
  let mapped: Record<string, unknown> | null = null;
  let authorityChecks = 0;
  const lifecycle = {
    sessionId: ids.session,
    messageId: 17,
    revision: 0,
    roomId: ids.room,
    namespaceIdAtAllocation: ids.namespace,
    keyClass: "ai",
    authorRole: "assistant",
    cryptoObjectId: "message:v2:exact",
    objectIdScheme: "message_v2",
    representationMode: representation === "protected"
      ? "full_encryption"
      : "shadow_encryption",
    publicationPolicyRevision: representation === "protected" ? 4 : null,
    appendIdempotencyKey: `task-transcript:${ids.run}:${fingerprint}`,
    allocationRequestDigest: new Uint8Array(32).fill(9),
    completion: replay === "mapped" ? "complete" : "pending",
    disposition: replay === "mapped" ? "mapped" : "active",
    parityStatus: replay === "mapped"
      ? representation === "protected"
        ? "server_authenticated"
        : "server_verified"
      : "pending",
  };
  const publisher = createProtectedTaskNativeMessagePublication(source, {
    createProduct: (_handle, _runner, guard) => {
      expect(guard).toBeDefined();
      return {
        appendAllocated: async value => {
          calls.push("append");
          appended = value as unknown as Record<string, unknown>;
          return {
            status: replay === "mapped" ? "replayed" : "allocated",
            lifecycle,
          } as never;
        },
        markCryptoComplete: value => {
          calls.push("mark");
          marked = value as unknown as Record<string, unknown>;
          return Promise.resolve("applied");
        },
        compareAndSwapCryptoMapping: value => {
          calls.push("map");
          mapped = value as unknown as Record<string, unknown>;
          return Promise.resolve("applied");
        },
      };
    },
    readCreatedAt: () => {
      calls.push("created-at");
      return Promise.resolve(NOW);
    },
    createAuthorityResolver: () => expected => {
      authorityChecks += 1;
      calls.push("authority");
      return Promise.resolve({ ...expected });
    },
    prepare: async value => {
      calls.push("prepare");
      const expected = {
        ...value.coordinates,
        mode: value.mode,
        createdAt: value.createdAt,
      } as unknown as NativeTaskMessageAuthority;
      await value.resolveCurrentAuthority(expected);
      await value.resolveCurrentAuthority(expected);
      return Object.freeze({}) as PreparedNativeTaskMessage;
    },
    createCompletion: value => ({
      complete: async () => {
        calls.push("complete");
        const expected = {
          sessionId: ids.session,
          messageId: 17,
          revision: 0,
          taskId: ids.task,
          taskRunId: ids.run,
          roomId: ids.room,
          graphThreadId,
          humanTurnId: `task-segment-turn:${ids.run}:1`,
          agentId: ids.agent,
          objectId: lifecycle.cryptoObjectId,
          role: "assistant",
          mode: representation === "protected"
            ? "encrypted_only"
            : "shadow_encryption",
          createdAt: NOW,
        } as unknown as NativeTaskMessageAuthority;
        await value.resolveCurrentAuthority(expected);
        await value.resolveCurrentAuthority(expected);
        return "created";
      },
    }),
  });
  return {
    controller,
    source,
    publisher,
    calls,
    authorityChecks: () => authorityChecks,
    appended: () => appended,
    marked: () => marked,
    mapped: () => mapped,
  };
}

describe("protected Task native Message publication", () => {
  test("publishes Full transcript content without a durable plaintext sibling", async () => {
    const value = harness("protected");
    await value.publisher(request(value.controller.signal));

    expect(value.calls).toEqual([
      "append", "created-at", "prepare", "authority", "authority",
      "complete", "authority", "authority", "authority", "mark",
      "authority", "map",
    ]);
    expect(value.authorityChecks()).toBe(6);
    expect(value.appended()).toMatchObject({
      content: null,
      toolCalls: null,
      toolName: null,
      metadata: null,
      transcriptOrigin: "subagent",
      publicationPolicy: {
        expectedRevision: 4,
        representation: "protected_only",
      },
    });
    expect(value.marked()).toMatchObject({
      parityStatus: "server_authenticated",
      cryptoObjectId: "message:v2:exact",
    });
    expect(value.mapped()).toMatchObject({
      expectedNamespaceId: ids.namespace,
      cryptoObjectId: "message:v2:exact",
    });
  });

  test("preserves the ordinary sibling only for dual publication", async () => {
    const value = harness("dual");
    await value.publisher(request(value.controller.signal));

    expect(value.appended()).toMatchObject({
      content: "confidential Task output",
      toolCalls: JSON.stringify([{ name: "search", args: { query: "private" } }]),
      toolName: "search",
      publicationPolicy: {
        expectedRevision: 4,
        representation: "ordinary_and_protected",
      },
    });
    expect(value.marked()).toMatchObject({ parityStatus: "server_verified" });
  });

  test("accepts an exact mapped replay without re-encrypting random bytes", async () => {
    const value = harness("protected", "mapped");
    await value.publisher(request(value.controller.signal));

    expect(value.calls).toEqual(["append", "mark"]);
    expect(value.marked()).toMatchObject({
      parityStatus: "server_authenticated",
      cryptoObjectId: "message:v2:exact",
    });
    expect(value.mapped()).toBeNull();
    expect(value.authorityChecks()).toBe(0);
  });

  test("does not allocate when the exact grant is already stale", async () => {
    const value = harness("protected");
    const publisher = createProtectedTaskNativeMessagePublication({
      ...value.source,
      hasCurrentGrant: () => Promise.resolve(false),
    }, {
      createProduct: () => ({
        appendAllocated: () => {
          throw new Error("must not allocate");
        },
        markCryptoComplete: () => Promise.resolve("applied"),
        compareAndSwapCryptoMapping: () => Promise.resolve("applied"),
      }),
    });
    expect(await publisher(request(value.controller.signal)).then(
      () => null,
      (error: unknown) => error,
    )).toBeInstanceOf(TypeError);
  });

  test("rejects identity substitution before the first durable phase", async () => {
    const value = harness("protected");
    const candidate = request(value.controller.signal);
    expect(await value.publisher({
      ...candidate,
      identity: { ...candidate.identity, roomId: ids.contentNamespace },
    }).then(() => null, (error: unknown) => error)).toBeInstanceOf(TypeError);
    expect(value.calls).toEqual([]);
  });
});
