import { describe, expect, test } from "bun:test";
import type {
  ConversationProductCanonicalTransactionRunner,
  ConversationProductPostgresHandle,
  NativeTaskNamespaceSource,
  PostgresHumanDeviceSignerHistory,
} from "@nautilo/lattice-bridge/server";

import {
  createProtectedTaskNativeTranscriptPublisher,
} from "../../src/routes/protected-task-native-transcript-composition";

const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requestor: "50000000-0000-4000-8000-000000000005",
  agent: "60000000-0000-4000-8000-000000000006",
  room: "70000000-0000-4000-8000-000000000007",
  roomNamespace: "80000000-0000-4000-8000-000000000008",
  contentNamespace: "90000000-0000-4000-8000-000000000009",
  session: "a0000000-0000-4000-8000-00000000000a",
});
const NOW = 2_000_000_000_000;
const graphThreadId = `subagent:task:${ids.task}:${ids.run}`;
const inputObjectId = "task-definition:v1:input";
const resultObjectId = "task-run-result:v1:result";

type Factory = ReturnType<typeof createProtectedTaskNativeTranscriptPublisher>;
type Segment = Parameters<Factory>[0];

function segment(
  runner: ConversationProductCanonicalTransactionRunner,
  signal: AbortSignal,
): Segment {
  const occurrence = Object.freeze({
    task: Object.freeze({
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.requestor,
      agentId: ids.agent,
      callingRoomId: null,
      scheduleKind: "now" as const,
      contentRepresentation: "dual" as const,
      contentNamespaceId: ids.contentNamespace,
      contentRevision: 1,
      cryptoObjectId: inputObjectId,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(3),
    }),
    run: Object.freeze({
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "running" as const,
      startedAt: new Date(NOW - 1_000),
    }),
  });
  const reference = Object.freeze({
    kind: "protected_task_run_v1" as const,
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId,
    resultObjectId,
    authorizationRequestId: "request-1",
    policyRevision: 4,
    executionSegment: 1,
  });
  const current = {
    runner,
    restricted: Object.freeze({}),
    crypto: Object.freeze({}),
    serverScope: "https://server.example.test",
    subject: Object.freeze({ userId: ids.requestor }),
    occurrence,
    reference,
    evidence: Object.freeze({
      requestId: reference.authorizationRequestId,
      policyRevision: reference.policyRevision,
      expiresAt: NOW + 60_000,
      result: Object.freeze({ objectId: resultObjectId }),
    }),
    jobId: ids.job,
    executionRoomId: ids.room,
    signal,
    now: () => NOW,
  } as unknown as Segment["current"];
  return Object.freeze({
    occurrence,
    record: Object.freeze({}),
    request: Object.freeze({}),
    current,
    humanTurnId: `task-segment-turn:${ids.run}:1`,
    assertCurrentTaskAuthority: () => Promise.resolve(),
    domains: Object.freeze([]),
    signer: Object.freeze({
      runtime: Object.freeze({ agentId: ids.agent }),
      signerPublication: Object.freeze({ agentId: ids.agent }),
      agentAuthorizationRevision: 9,
    }),
    resolveHistoricalSignerPublicationManager: async () => null,
  }) as unknown as Segment;
}

function product(runner: ConversationProductCanonicalTransactionRunner) {
  return Object.freeze({
    handle: Object.freeze({ role: "nautilo" }) as
      ConversationProductPostgresHandle,
    canonicalRunner: runner,
  });
}

describe("protected Task native transcript composition", () => {
  test("binds a content-free Agent Session to the execution Room Namespace", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const signal = new AbortController().signal;
    const current = segment(runner, signal);
    const sourceBytes = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ];
    let namespaceOpen = false;
    let published = 0;
    let validatedAuthority: Record<string, unknown> | null = null;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      ensureSession: async options => {
        expect(options).toEqual({
          threadId: graphThreadId,
          ownerId: ids.owner,
          personaId: "owner",
          agentId: ids.agent,
          roomId: ids.room,
          title: "Task transcript",
        });
        return ids.session;
      },
      loadSessionFacts: async (actualRunner, expected) => {
        expect(actualRunner).toBe(runner);
        expect(expected).toEqual({
          sessionId: ids.session,
          graphThreadId,
          ownerId: ids.owner,
          agentId: ids.agent,
          roomId: ids.room,
        });
        return Object.freeze({
          sessionId: ids.session,
          namespaceId: ids.roomNamespace,
        });
      },
      validateProductAuthority: async (actualRunner, authority) => {
        expect(actualRunner).toBe(runner);
        validatedAuthority = authority as unknown as Record<string, unknown>;
      },
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
      withNamespaceSource: async (request, use) => {
        expect(request.namespaceId).toBe(ids.roomNamespace);
        expect(request.requiredOperations).toEqual(["decrypt", "encrypt"]);
        namespaceOpen = true;
        const source = {
          bindingBytes: sourceBytes[0]!,
          expectedBindingDigest: new Uint8Array([5]),
          issuerSigningPublicKey: sourceBytes[1]!,
        } as unknown as NativeTaskNamespaceSource;
        try {
          return await use(source);
        } finally {
          namespaceOpen = false;
          sourceBytes.forEach(bytes => bytes.fill(0));
        }
      },
      createPublication: publication => {
        expect(namespaceOpen).toBe(true);
        expect(publication.preparation.namespace.bindingBytes)
          .toBe(sourceBytes[0]!);
        expect(publication.authority.productAuthority.namespaceId)
          .toBe(ids.roomNamespace);
        expect(publication.authority.productAuthority.contentNamespaceId)
          .toBe(ids.contentNamespace);
        return async request => {
          expect(namespaceOpen).toBe(true);
          expect(request.signal).toBe(signal);
          published += 1;
        };
      },
    });

    const publish = await create(current);
    expect(validatedAuthority).toMatchObject({
      sessionId: ids.session,
      sessionOwnerId: ids.owner,
      roomId: ids.room,
      namespaceId: ids.roomNamespace,
      contentNamespaceId: ids.contentNamespace,
    });
    await publish(Object.freeze({
      identity: Object.freeze({
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        roomId: ids.room,
        humanTurnId: current.humanTurnId,
        agentId: ids.agent,
      }),
      idempotencyKey: `task-transcript:${ids.run}:fp:v1:test`,
      fingerprint: "fp:v1:test",
      payload: Object.freeze({ role: "assistant", content: "secret" }),
      signal,
    }));
    expect(published).toBe(1);
    expect(namespaceOpen).toBe(false);
    expect(sourceBytes).toEqual([new Uint8Array(2), new Uint8Array(2)]);
  });

  test("refuses a mismatched existing Session before product or Namespace use", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const current = segment(runner, new AbortController().signal);
    let productValidations = 0;
    let namespaceUses = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      ensureSession: async () => ids.session,
      loadSessionFacts: async () => null,
      validateProductAuthority: async () => {
        productValidations += 1;
      },
      withNamespaceSource: async () => {
        namespaceUses += 1;
        throw new Error("must not open Namespace");
      },
    });
    await Promise.resolve(expect(create(current)).rejects.toThrow(
      "transcript Session is unavailable",
    ));
    expect(productValidations).toBe(0);
    expect(namespaceUses).toBe(0);
  });

  test("rejects an expired grant before creating a Session", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    const expired = {
      ...active,
      current: {
        ...active.current,
        evidence: { ...active.current.evidence, expiresAt: NOW },
      },
    } as Segment;
    let sessionUses = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      ensureSession: async () => {
        sessionUses += 1;
        return ids.session;
      },
    });
    await Promise.resolve(expect(create(expired)).rejects.toThrow(
      "transcript identity is unavailable",
    ));
    expect(sessionUses).toBe(0);
  });

  test("stops a stale execution Room Namespace before opening its secrets", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    let namespaceUses = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      ensureSession: async () => ids.session,
      loadSessionFacts: async () => Object.freeze({
        sessionId: ids.session,
        namespaceId: ids.roomNamespace,
      }),
      validateProductAuthority: async () => {
        throw new TypeError("Room Namespace changed");
      },
      withNamespaceSource: async () => {
        namespaceUses += 1;
        throw new Error("must not open Namespace");
      },
    });
    await Promise.resolve(expect(create(active)).rejects.toThrow(
      "Room Namespace changed",
    ));
    expect(namespaceUses).toBe(0);
  });

  test("denied Namespace authority never constructs a publication", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    let publications = 0;
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      ensureSession: async () => ids.session,
      loadSessionFacts: async () => Object.freeze({
        sessionId: ids.session,
        namespaceId: ids.roomNamespace,
      }),
      validateProductAuthority: async () => undefined,
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
      withNamespaceSource: async request => {
        expect(request.requiredOperations).toEqual(["decrypt", "encrypt"]);
        throw new TypeError("Namespace grant is unavailable");
      },
      createPublication: () => {
        publications += 1;
        return async () => undefined;
      },
    });
    const publish = await create(active);
    await Promise.resolve(expect(publish({
      identity: {
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        roomId: ids.room,
        humanTurnId: active.humanTurnId,
        agentId: ids.agent,
      },
      idempotencyKey: `task-transcript:${ids.run}:fp:v1:denied`,
      fingerprint: "fp:v1:denied",
      payload: { role: "assistant", content: "secret" },
      signal: active.current.signal,
    })).rejects.toThrow("Namespace grant is unavailable"));
    expect(publications).toBe(0);
  });

  test("keeps overlapping publication sources separate and wipes each one", async () => {
    const runner = Object.freeze({ role: "nautilo" }) as unknown as
      ConversationProductCanonicalTransactionRunner;
    const active = segment(runner, new AbortController().signal);
    const buffers: Uint8Array[] = [];
    let entered = 0;
    let releasePublications: (() => void) | undefined;
    let reportEntered: (() => void) | undefined;
    const publicationGate = new Promise<void>(resolve => {
      releasePublications = resolve;
    });
    const bothEntered = new Promise<void>(resolve => {
      reportEntered = resolve;
    });
    const create = createProtectedTaskNativeTranscriptPublisher({
      product: product(runner),
    }, {
      ensureSession: async () => ids.session,
      loadSessionFacts: async () => Object.freeze({
        sessionId: ids.session,
        namespaceId: ids.roomNamespace,
      }),
      validateProductAuthority: async () => undefined,
      verifyCryptoHandle: async () => Object.freeze({}) as never,
      createSignerHistory: () => Object.freeze({
        resolveAgentRuntimeSignerManager: async () => null,
      }) as unknown as PostgresHumanDeviceSignerHistory,
      withNamespaceSource: async (_request, use) => {
        const bytes = new Uint8Array([buffers.length + 1]);
        buffers.push(bytes);
        try {
          return await use({
            bindingBytes: bytes,
            expectedBindingDigest: new Uint8Array([7]),
            issuerSigningPublicKey: new Uint8Array([8]),
          } as unknown as NativeTaskNamespaceSource);
        } finally {
          bytes.fill(0);
        }
      },
      createPublication: publication => {
        const bytes = publication.preparation.namespace.bindingBytes;
        return async () => {
          expect(bytes[0]).toBeGreaterThan(0);
          entered += 1;
          if (entered === 2) reportEntered?.();
          await publicationGate;
          expect(bytes[0]).toBeGreaterThan(0);
        };
      },
    });
    const publish = await create(active);
    const request = (fingerprint: string) => ({
      identity: {
        taskId: ids.task,
        taskRunId: ids.run,
        graphThreadId,
        roomId: ids.room,
        humanTurnId: active.humanTurnId,
        agentId: ids.agent,
      },
      idempotencyKey: `task-transcript:${ids.run}:${fingerprint}`,
      fingerprint,
      payload: { role: "assistant" as const, content: "secret" },
      signal: active.current.signal,
    });
    const first = publish(request("fp:v1:first"));
    const second = publish(request("fp:v1:second"));
    await bothEntered;
    expect(buffers).toHaveLength(2);
    expect(buffers[0]).not.toBe(buffers[1]);
    expect(buffers.map(bytes => bytes[0])).toEqual([1, 2]);
    releasePublications?.();
    await Promise.all([first, second]);
    expect(buffers.map(bytes => bytes[0])).toEqual([0, 0]);
  });
});
