import { readPreparedConversationCryptoRevisionSnapshot } from "../../src/message/conversation-prepared-revision.ts";
import type { ConversationRepository } from "../../src/message/conversation-repository.ts";
import { withWakeEvidence } from "../fixtures/task-wake-foreground-evidence.ts";
import { type TaskRuntimeWakeForegroundEvidence } from "@nautilo/lattice-crypto";
import { type TaskRuntimeRunResultReadEvidence } from "@nautilo/lattice-crypto";
import { type DomainForegroundSecretEntry, authorizationRevision, agentId, agentRuntimeGeneration, namespaceId } from "@nautilo/lattice-crypto";
import { createTaskWakeForegroundAgentTurnSession, type TaskWakeForegroundAgentTurnSessionInput, type TaskWakeForegroundTranscriptPorts } from
  "../../src/server/message/live-shadow-agent-session.ts";
import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
  InMemoryLatticeStore,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import { decodeAgentLiveShadowStreamStartV2 } from "@nautilo/lattice-crypto/wire";
import {
  createLiveShadowAgentTurnSession,
  type LiveShadowAgentSessionFailureReason,
  type LiveShadowAgentSessionFailureStage,
} from "@nautilo/lattice-bridge/server";

const TIMING_NOW = 1_800_300_000_000;

function streamSession(input: Readonly<{
  now: () => number;
  authorizationDeadlineAt: number;
  reserveLiveShadowAgent: () => Promise<unknown>;
  onTerminalFailure?: (
    stage: LiveShadowAgentSessionFailureStage,
    reason: LiveShadowAgentSessionFailureReason,
  ) => void;
  onDiagnostic?: (stage: LiveShadowAgentSessionFailureStage, error: unknown) => void;
}>) {
  const crypto = new LatticeCrypto();
  const runtime = {
    agentId: "agent-m311-timing",
    generation: 4,
    keyClass: "runtime",
    key: new Uint8Array(32).fill(0x36),
  } as never;
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  return createLiveShadowAgentTurnSession({
    crypto,
    plan: {
      deadlineAt: TIMING_NOW + 30_000,
      operationId: "operation-m311-timing",
      policyRevision: 7,
      sessionId: "10000000-0000-4000-8000-000000000311",
      roomId: "20000000-0000-4000-8000-000000000311",
      namespaceId: "namespace-m311-timing",
      namespaceHeadDigest: new Uint8Array(32).fill(0x31),
      namespacePublicationDigest: new Uint8Array(32).fill(0x32),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x33),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x34),
      agentAuthorizationRevision: 5,
      agentSignerKeyId: signer.principal.signerKeyId,
      agentSignerPublicKey: signer.publicKey,
      hostAuthorizationRevision: 9,
    } as never,
    causalHumanUserId: "user-m311-timing",
    product: {
      reserveLiveShadowAgent: input.reserveLiveShadowAgent,
    } as never,
    conversation: {} as never,
    namespace: {
      namespaceId: "namespace-m311-timing",
      accessRevision: 2,
      headDigest: new Uint8Array(32).fill(0x31),
      publicationDigest: new Uint8Array(32).fill(0x32),
      publicationSetDigest: new Uint8Array(32).fill(0x33),
      audienceFingerprint: new Uint8Array(32).fill(0x34),
      keyGeneration: 3,
      aiKey: new Uint8Array(32).fill(0x35),
    },
    runtime,
    grantId: "grant-m311-timing",
    grantDigest: new Uint8Array(32).fill(0x37),
    authorizationDeadlineAt: input.authorizationDeadlineAt,
    resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
    ...(input.onTerminalFailure === undefined
      ? {}
      : { onTerminalFailure: input.onTerminalFailure }),
    ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
    now: input.now,
  });
}

function reservedAssistant() {
  return Object.freeze({
    status: "reserved" as const,
    allocation: Object.freeze({
      status: "allocated" as const,
      messageId: 311,
      revision: 0,
      roomId: "20000000-0000-4000-8000-000000000311",
      namespaceId: "namespace-m311-timing",
      keyClass: "ai" as const,
      authorRole: "assistant" as const,
      cryptoObjectId: "message:live-shadow:m311-timing",
    }),
    createdAt: TIMING_NOW + 31_000,
  });
}

describe("live Shadow Agent session failure", () => {
  test("passes the exact foreground Memory envelope to the bound factory", async () => {
    const envelope = Object.freeze({
      memoryMode: "namespace" as const,
      ownerId: "user-m320",
    }) as never;
    const repository = Object.freeze({}) as never;
    const access = Object.freeze({}) as never;
    const projection = Object.freeze({}) as never;
    const received: unknown[] = [];
    const session = createLiveShadowAgentTurnSession({
      crypto: new LatticeCrypto(),
      plan: {} as never,
      causalHumanUserId: "user-m320",
      product: {} as never,
      conversation: {} as never,
      namespace: {
        namespaceId: "namespace-m320",
        accessRevision: 1,
        headDigest: new Uint8Array(32),
        publicationDigest: new Uint8Array(32),
        publicationSetDigest: new Uint8Array(32),
        audienceFingerprint: new Uint8Array(32),
        keyGeneration: 1,
        aiKey: new Uint8Array(32),
      },
      runtime: {
        agentId: "agent-m320",
        generation: 1,
        keyClass: "runtime",
        key: new Uint8Array(32),
      } as never,
      grantId: "grant-m320",
      grantDigest: new Uint8Array(32),
      resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
      createForegroundMemoryRepository: async (value) => {
        received.push(value);
        return repository;
      },
      createForegroundMemoryAccessPort: async (value) => {
        received.push(value);
        return access;
      },
      createForegroundMemoryProjectionPort: async (value) => {
        received.push(value);
        return projection;
      },
    });

    expect(await session.createForegroundMemoryRepository?.(envelope))
      .toBe(repository);
    expect(await session.createForegroundMemoryAccessPort?.(envelope)).toBe(access);
    expect(await session.createForegroundMemoryProjectionPort?.(envelope)).toBe(projection);
    expect(received).toEqual([envelope, envelope, envelope]);
    session.destroy();
  });

  test("exposes the retained authorization expiry instead of the request deadline", () => {
    const session = createLiveShadowAgentTurnSession({
      crypto: new LatticeCrypto({
        bytes: (length) => new Uint8Array(length).fill(0x35),
      }),
      plan: { deadlineAt: 1_800_000_030_000 } as never,
      causalHumanUserId: "user-m311",
      product: {} as never,
      conversation: {} as never,
      namespace: {
        namespaceId: "namespace-m311",
        accessRevision: 1,
        headDigest: new Uint8Array(32),
        publicationDigest: new Uint8Array(32),
        publicationSetDigest: new Uint8Array(32),
        audienceFingerprint: new Uint8Array(32),
        keyGeneration: 1,
        aiKey: new Uint8Array(32),
      },
      runtime: {
        agentId: "agent-m311",
        generation: 1,
        keyClass: "runtime",
        key: new Uint8Array(32),
      } as never,
      grantId: "grant-m311",
      grantDigest: new Uint8Array(32),
      authorizationDeadlineAt: 1_800_000_300_000,
      resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
    });

    expect(session.authorizationDeadlineAt).toBe(1_800_000_300_000);
    session.destroy();
  });

  test("starts a fresh stream after the original plan expires", async () => {
    const now = TIMING_NOW + 31_000;
    const diagnostics: unknown[] = [];
    const session = streamSession({
      now: () => now,
      authorizationDeadlineAt: TIMING_NOW + 300_000,
      reserveLiveShadowAgent: async () => reservedAssistant(),
      onDiagnostic: (_stage, error) => diagnostics.push(error),
    });

    const result = await session.reserveAssistantStream({
      assistantMessageKey: "assistant-m311-after-plan",
      createdAt: now,
    });
    expect(diagnostics).toEqual([]);
    expect(result.status).toBe("protected");
    if (result.status !== "protected") throw new Error("expected protected stream");
    const start = decodeAgentLiveShadowStreamStartV2(result.value.startBytes);
    expect(start.issuedAt).toBe(unixTimestamp(TIMING_NOW + 31_000));
    expect(start.deadlineAt).toBe(unixTimestamp(TIMING_NOW + 61_000));
    expect(start.issuedAt).toBeGreaterThan(TIMING_NOW + 30_000);
    session.destroy();
  });

  test("bounds each fresh stream proof by the retained authorization", async () => {
    const now = TIMING_NOW + 31_000;
    const authorizationDeadlineAt = TIMING_NOW + 45_000;
    const diagnostics: unknown[] = [];
    const session = streamSession({
      now: () => now,
      authorizationDeadlineAt,
      reserveLiveShadowAgent: async () => reservedAssistant(),
      onDiagnostic: (_stage, error) => diagnostics.push(error),
    });

    const result = await session.reserveAssistantStream({
      assistantMessageKey: "assistant-m311-authority-bound",
      createdAt: now,
    });
    expect(diagnostics).toEqual([]);
    expect(result.status).toBe("protected");
    if (result.status !== "protected") throw new Error("expected protected stream");
    const start = decodeAgentLiveShadowStreamStartV2(result.value.startBytes);
    expect(start.issuedAt).toBe(unixTimestamp(now));
    expect(start.deadlineAt).toBe(unixTimestamp(authorizationDeadlineAt));
    expect(start.deadlineAt - start.issuedAt).toBe(14_000);
    session.destroy();
  });

  test("reports exact expiry after an asynchronous stream reservation", async () => {
    let now = TIMING_NOW + 1;
    let releaseReservation: ((value: ReturnType<typeof reservedAssistant>) => void)
      | undefined;
    const reservation = new Promise<ReturnType<typeof reservedAssistant>>(
      (resolve) => {
        releaseReservation = resolve;
      },
    );
    const failures: Array<Readonly<{
      stage: LiveShadowAgentSessionFailureStage;
      reason: LiveShadowAgentSessionFailureReason;
    }>> = [];
    let productCalls = 0;
    const authorizationDeadlineAt = TIMING_NOW + 300_000;
    const session = streamSession({
      now: () => now,
      authorizationDeadlineAt,
      reserveLiveShadowAgent: () => {
        productCalls += 1;
        return reservation;
      },
      onTerminalFailure: (stage, reason) => failures.push({ stage, reason }),
    });

    const pending = session.reserveAssistantStream({
      assistantMessageKey: "assistant-m311-expiry-race",
      createdAt: now,
    });
    expect(productCalls).toBe(1);
    now = authorizationDeadlineAt;
    releaseReservation?.(reservedAssistant());

    expect(await pending).toEqual({
      status: "ordinary_fallback",
      stage: "agent_input",
      reason: "deadline_expired",
    });
    expect(failures).toEqual([{
      stage: "agent_input",
      reason: "deadline_expired",
    }]);
    session.destroy();
  });

  test("reports only the first terminal failure", () => {
    const failures: Array<Readonly<{
      stage: LiveShadowAgentSessionFailureStage;
      reason: LiveShadowAgentSessionFailureReason;
    }>> = [];
    const session = createLiveShadowAgentTurnSession({
      crypto: new LatticeCrypto({
        bytes: (length) => new Uint8Array(length).fill(0x35),
      }),
      plan: {} as never,
      causalHumanUserId: "user-m305",
      product: {} as never,
      conversation: {} as never,
      namespace: {
        namespaceId: "namespace-m305",
        accessRevision: 1,
        headDigest: new Uint8Array(32),
        publicationDigest: new Uint8Array(32),
        publicationSetDigest: new Uint8Array(32),
        audienceFingerprint: new Uint8Array(32),
        keyGeneration: 1,
        aiKey: new Uint8Array(32),
      },
      runtime: {
        agentId: "agent-m305",
        generation: 1,
        keyClass: "runtime",
        key: new Uint8Array(32),
      } as never,
      grantId: "grant-m305",
      grantDigest: new Uint8Array(32),
      resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
      onTerminalFailure: (stage, reason) => failures.push({ stage, reason }),
    });

    session.fail("assistant_message", "protected_unavailable");
    session.fail("tool_result", "integrity_failure");

    expect(failures).toEqual([{
      stage: "assistant_message",
      reason: "protected_unavailable",
    }]);
    session.destroy();
  });

  test("stops before product work after retained authorization expiry", async () => {
    let productCalls = 0;
    const failures: Array<Readonly<{
      stage: LiveShadowAgentSessionFailureStage;
      reason: LiveShadowAgentSessionFailureReason;
    }>> = [];
    const session = createLiveShadowAgentTurnSession({
      crypto: new LatticeCrypto({
        bytes: (length) => new Uint8Array(length).fill(0x35),
      }),
      plan: { deadlineAt: 1_800_000_030_000 } as never,
      causalHumanUserId: "user-m311-expired",
      product: {
        reserveLiveShadowAgent: async () => {
          productCalls += 1;
          throw new Error("must not be reached");
        },
      } as never,
      conversation: {} as never,
      namespace: {
        namespaceId: "namespace-m311-expired",
        accessRevision: 1,
        headDigest: new Uint8Array(32),
        publicationDigest: new Uint8Array(32),
        publicationSetDigest: new Uint8Array(32),
        audienceFingerprint: new Uint8Array(32),
        keyGeneration: 1,
        aiKey: new Uint8Array(32),
      },
      runtime: {
        agentId: "agent-m311-expired",
        generation: 1,
        keyClass: "runtime",
        key: new Uint8Array(32),
      } as never,
      grantId: "grant-m311-expired",
      grantDigest: new Uint8Array(32),
      authorizationDeadlineAt: 1_800_000_300_000,
      resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
      onTerminalFailure: (stage, reason) => failures.push({ stage, reason }),
      now: () => 1_800_000_300_000,
    });

    expect(await session.publishMessage({
      payload: { role: "assistant", content: "must not persist" },
      stage: "assistant_message",
    })).toEqual({
      status: "ordinary_fallback",
      stage: "agent_input",
      reason: "deadline_expired",
    });
    expect(productCalls).toBe(0);
    expect(failures).toEqual([{
      stage: "agent_input",
      reason: "deadline_expired",
    }]);
    session.destroy();
  });
});


const wakeDomain: DomainForegroundSecretEntry = {
  domainId: "wake-domain", sourceNamespaceId: "30000000-0000-4000-8000-000000000001", keyClass: "ai",
  participantCount: 1, participantDigest: new Uint8Array(32).fill(1), domainKeyGeneration: 1,
  authorizationRevision: authorizationRevision(1), headDigest: new Uint8Array(32).fill(2),
  domainKey: new Uint8Array(32).fill(3),
};
function wakeSessionInput(evidence: TaskRuntimeWakeForegroundEvidence): TaskWakeForegroundAgentTurnSessionInput & { ports: TaskWakeForegroundTranscriptPorts } {
  const crypto = new LatticeCrypto();
  const runtime = { agentId: agentId(evidence.signerAgentId), generation: agentRuntimeGeneration(1),
    keyClass: "runtime" as const, key: new Uint8Array(32).fill(9) };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const namespace = { namespaceId: "30000000-0000-4000-8000-000000000001", accessRevision: 1, keyGeneration: 1,
    headDigest: new Uint8Array(32).fill(10), publicationDigest: new Uint8Array(32).fill(11),
    publicationSetDigest: new Uint8Array(32).fill(12), audienceFingerprint: new Uint8Array(32).fill(13),
    aiKey: new Uint8Array(32).fill(14) };
  const ports: TaskWakeForegroundTranscriptPorts = {
    product: { reserveLiveShadowAgent: async () => ({ status: "reserved", createdAt: TIMING_NOW,
      allocation: { status: "allocated", messageId: 701, revision: 0, roomId: evidence.sourceRoomId,
        namespaceId: namespace.namespaceId, keyClass: "ai", authorRole: "assistant", cryptoObjectId: "wake-message-object" } }) } as never,
    conversation: {} as never, resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
  };
  return { crypto, evidence, runtime, namespace, representationMode: "full_encryption",
    publication: { operationId: evidence.invocation.operationId, roomId: evidence.sourceRoomId,
      sessionId: evidence.episodeId, namespaceId: namespaceId(namespace.namespaceId), deadlineAt: unixTimestamp(evidence.expiresAt),
      policyRevision: evidence.policyRevision, hostAuthorizationRevision: authorizationRevision(evidence.hostAuthorizationRevision),
      recipientAgentId: agentId(evidence.signerAgentId), agentAuthorizationRevision: authorizationRevision(3),
      agentSignerKeyId: signer.principal.signerKeyId, agentSignerPublicKey: signer.publicKey,
      namespaceHeadDigest: namespace.headDigest, namespacePublicationDigest: namespace.publicationDigest,
      namespacePublicationSetDigest: namespace.publicationSetDigest, namespaceAudienceFingerprint: namespace.audienceFingerprint },
    authorizationSignal: new AbortController().signal, grantId: evidence.requestId,
    grantDigest: Uint8Array.from(evidence.authorizationDigest), recipientKeyId: evidence.recipientKeyId,
    now: () => TIMING_NOW, ports, withCurrentTranscriptAuthority: use => use(ports),
  };
}
function withSessionWake<Value>(execute: (e: TaskRuntimeWakeForegroundEvidence, read: TaskRuntimeRunResultReadEvidence) => Promise<Value> | Value) {
  return withWakeEvidence({ now: TIMING_NOW, domain: wakeDomain, namespaceId: "30000000-0000-4000-8000-000000000001",
    accessRevision: 1, policyRevision: 7, signerAgentId: "60000000-0000-4000-8000-000000000001", execute });
}

test.each(["shadow_encryption", "full_encryption"] as const)("wake session seals %s stream with no V4 Human plan and closes after proof", async representationMode => {
  let session: ReturnType<typeof createTaskWakeForegroundAgentTurnSession> | undefined;
  let owned: TaskWakeForegroundAgentTurnSessionInput | undefined;
  await withSessionWake(async evidence => {
    owned = { ...wakeSessionInput(evidence), representationMode };
    session = createTaskWakeForegroundAgentTurnSession(owned);
    expect(session.sharedAgentRealtimePlanBytes!()).toBeNull();
    const start = await session.reserveAssistantStream({ assistantMessageKey: "wake-assistant", createdAt: TIMING_NOW });
    expect(start.status).toBe("protected");
    if (start.status !== "protected") throw new Error("wake stream refused");
    const decoded = decodeAgentLiveShadowStreamStartV2(start.value.startBytes);
    expect(decoded.operationId).toBe(evidence.invocation.operationId);
    expect(decoded.roomId).toBe(evidence.sourceRoomId);
    expect(decoded.sessionId).toBe(evidence.episodeId);
    expect(session.sealAssistantStreamChunk({ reservation: start.value.reservation,
      ordinaryChunk: new TextEncoder().encode("wake result"), done: true,
      finalPayload: { role: "assistant", content: "wake result" } }).status).toBe("protected");
  });
  expect((await session!.reserveAssistantStream({ assistantMessageKey: "escaped", createdAt: TIMING_NOW })).status).toBe("ordinary_fallback");
  session!.destroy();
  expect(owned!.runtime.key.every(b => b === 0)).toBe(true);
  expect(owned!.namespace.aiKey.every(b => b === 0)).toBe(true);
});

test.each(["read-proof", "forgery", "private", "room", "session", "operation", "policy", "host", "agent", "signer", "recipient", "digest", "deadline", "access", "plain", "grant"])("wake session rejects %s substitution before any product effect", async reason => {
  await withSessionWake((evidence, read) => {
    const input = wakeSessionInput(evidence);
    const publication = { ...input.publication };
    let effects = 0;
    if (reason === "private") publication.namespaceId = namespaceId("private-result");
    if (reason === "room") publication.roomId = "another-room";
    if (reason === "session") publication.sessionId = "another-session";
    if (reason === "operation") publication.operationId = "another-operation";
    if (reason === "policy") publication.policyRevision += 1;
    if (reason === "host") publication.hostAuthorizationRevision = authorizationRevision(publication.hostAuthorizationRevision + 1);
    if (reason === "agent") publication.recipientAgentId = agentId("another-agent");
    if (reason === "signer") publication.agentSignerPublicKey = new Uint8Array(32);
    if (reason === "deadline") publication.deadlineAt = unixTimestamp(publication.deadlineAt + 1);
    expect(() => createTaskWakeForegroundAgentTurnSession({ ...input, publication,
      representationMode: reason === "plain" ? "plain" as never : input.representationMode,
      evidence: reason === "read-proof" ? read as never : reason === "forgery" ? { ...evidence } : evidence,
      grantId: reason === "grant" ? "another-grant" : input.grantId,
      recipientKeyId: reason === "recipient" ? "another-recipient" : input.recipientKeyId!,
      grantDigest: reason === "digest" ? new Uint8Array(32) : input.grantDigest,
      namespace: reason === "access" ? { ...input.namespace, accessRevision: 2 } : input.namespace,
      withCurrentTranscriptAuthority: async () => { effects += 1; throw new Error("unexpected sink"); },
    })).toThrow();
    expect(effects).toBe(0);
  });
});

test("wake session reasserts callback scope after awaited reservation and history access", async () => {
  let effects = 0;
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence); const controller = new AbortController();
    const session = createTaskWakeForegroundAgentTurnSession({ ...input, authorizationSignal: controller.signal,
      withCurrentTranscriptAuthority: use => use({ ...input.ports,
        product: { reserveLiveShadowAgent: async () => { controller.abort(); return { status: "conflict" }; } } as never,
      }),
      protectForegroundHistory: async () => { effects += 1; return { status: "unavailable" } as never; },
    });
    const failed = await session.reserveAssistantStream({ assistantMessageKey: "wake", createdAt: TIMING_NOW })
      .then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    const history = await session.protectForegroundHistory!({ messageIds: [1] }).then(() => null, (error: unknown) => error);
    expect(history).toBeInstanceOf(Error);
    expect(effects).toBe(0);
    session.destroy();
  });
});

test.each(["shadow_encryption", "full_encryption"] as const)("wake publishes %s only through the current resolver and product sinks", async representationMode => {
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence); const writes: string[] = []; const payloads: Record<string, unknown>[] = [];
    const session = createTaskWakeForegroundAgentTurnSession({ ...input, representationMode,
      withCurrentTranscriptAuthority: use => use({ ...input.ports,
      product: { ...input.ports.product,
        publishReservedLiveShadowAgent: async (request: Record<string, unknown>) => { writes.push("publish"); payloads.push(request); return { status: "allocated" }; },
        recordLiveShadowAgentEvidence: async () => { writes.push("evidence"); return "applied"; },
      } as never,
      conversation: { completeRevision: async (request: Parameters<ConversationRepository["completeRevision"]>[0]) => {
        const snapshot = readPreparedConversationCryptoRevisionSnapshot(request.prepared);
        if (snapshot.kind !== "agent-v3-device-wrapped-live-shadow") throw new Error("wrong crypto kind");
        expect(await snapshot.value.resolveCurrentAuthorization(snapshot.value.access.authority)).not.toBeNull();
        writes.push("complete"); return { status: "mapped" };
      } } as never,
      resolveCurrentDeviceWrappedAgentObjectAuthorization: context => {
        writes.push("authority");
        return { context, grantAuthorized: true, namespaceAuthorized: true, agentAuthorized: true,
          hostAllowsOperation: true, currentRuntime: { agentId: input.runtime.agentId,
            runtimeGeneration: input.runtime.generation, authorizationRevision: authorizationRevision(3) },
          signerPublicKey: input.publication.agentSignerPublicKey };
      },
      }),
    });
    try {
      const result = await session.publishMessage({ stage: "assistant_message", payload: { role: "assistant", content: "wake response" } });
      expect(result.status).toBe("protected");
      expect(writes).toEqual(["publish", "authority", "complete", "evidence"]);
      expect(payloads[0]!["content"]).toBe(representationMode === "full_encryption" ? null : "wake response");
      expect(payloads[0]!["humanTurnId"]).toBeNull();
      expect(payloads[0]!["notificationContext"]).toMatchObject({
        causalHumanUserId: null, causalHumanTurnId: null,
      });
      expect(payloads[0]!["operationId"]).toBe(evidence.invocation.operationId);
    } finally { session.destroy(); }
  });
});

test("wake publication retains a denied current resolver at the crypto completion boundary", async () => {
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence); let writes = 0; let checks = 0;
    const session = createTaskWakeForegroundAgentTurnSession({ ...input,
      withCurrentTranscriptAuthority: use => use({ ...input.ports,
      product: { ...input.ports.product, publishReservedLiveShadowAgent: async () => ({ status: "allocated" }),
        recordLiveShadowAgentEvidence: async () => { writes += 1; return "applied"; } } as never,
      conversation: { completeRevision: async (request: Parameters<ConversationRepository["completeRevision"]>[0]) => {
        const snapshot = readPreparedConversationCryptoRevisionSnapshot(request.prepared);
        if (snapshot.kind !== "agent-v3-device-wrapped-live-shadow") throw new Error("wrong crypto kind");
        expect(await snapshot.value.resolveCurrentAuthorization(snapshot.value.access.authority)).toBeNull();
        checks += 1; return { status: "orphaned" };
      } } as never,
      resolveCurrentDeviceWrappedAgentObjectAuthorization: () => null,
      }),
    });
    try {
      expect((await session.publishMessage({ stage: "assistant_message", payload: { role: "assistant", content: "wake response" } })).status).toBe("ordinary_fallback");
      expect(writes).toBe(0);
      expect(checks).toBe(1);
    } finally { session.destroy(); }
  });
});


test("wake history rejects a value when authority aborts during its callback", async () => {
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence); const controller = new AbortController(); let calls = 0;
    const session = createTaskWakeForegroundAgentTurnSession({ ...input, authorizationSignal: controller.signal,
      protectForegroundHistory: async () => { calls += 1; controller.abort(); return { status: "unavailable" } as never; },
    });
    try {
      const result = await session.protectForegroundHistory!({ messageIds: [1] }).then(() => null, (error: unknown) => error);
      expect(result).toBeInstanceOf(Error); expect(calls).toBe(1);
    } finally { session.destroy(); }
  });
});


function scopedWakeTranscript(input: ReturnType<typeof wakeSessionInput>, mode:
  "success" | "denied" | "evidence_conflict" | "commit_failure" | "expiry" = "success") {
  let currentTime = TIMING_NOW;
  let active = false;
  let entries = 0;
  const committed: string[] = [];
  const rolledBack: string[] = [];
  // The crypto transaction commits independently while product authority stays held.
  const durableCrypto = new InMemoryLatticeStore();
  let committedObjectId: string | null = null;
  let escapedResolver: (() => Promise<unknown>) | undefined;
  let preparedOutcome: { ordinaryPayloadBytes: Uint8Array } | undefined;
  const withCurrentTranscriptAuthority: TaskWakeForegroundAgentTurnSessionInput["withCurrentTranscriptAuthority"] = async use => {
    const phase = ++entries;
    if (phase === 2 && mode === "denied") throw new Error("current Room authority denied");
    active = true;
    const writes: string[] = [];
    const check = () => { expect(active).toBe(true); };
    try {
      const result = await use({
        product: {
          reserveLiveShadowAgent: async (request: unknown) => {
            check(); expect(phase).toBe(1); writes.push("reserve");
            return input.ports.product.reserveLiveShadowAgent(request as never);
          },
          publishReservedLiveShadowAgent: async () => {
            check(); expect(phase).toBe(2); writes.push("publish"); return { status: "allocated" };
          },
          recordLiveShadowAgentEvidence: async () => {
            check(); expect(phase).toBe(2); writes.push("evidence");
            if (mode === "expiry") currentTime = input.evidence.expiresAt;
            return mode === "evidence_conflict" ? "conflict" : "applied";
          },
        } as never,
        conversation: {
          completeRevision: async (request: Parameters<ConversationRepository["completeRevision"]>[0]) => {
            check(); expect(phase).toBe(2);
            const snapshot = readPreparedConversationCryptoRevisionSnapshot(request.prepared);
            if (snapshot.kind !== "agent-v3-device-wrapped-live-shadow") throw new Error("wrong revision");
            escapedResolver = async () => snapshot.value.resolveCurrentAuthorization(snapshot.value.access.authority);
            expect(await escapedResolver()).not.toBeNull();
            await durableCrypto.putObject(snapshot.value.object);
            await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis({
              crypto: input.crypto, storage: durableCrypto, prepared: snapshot.value.access,
              resolveCurrentAuthorization: snapshot.value.resolveCurrentAuthorization,
            });
            committedObjectId = snapshot.value.objectId;
            // Product's FK mapping can proceed only after the complete ciphertext is visible.
            expect(await durableCrypto.getObject(committedObjectId)).not.toBeNull();
            expect(await durableCrypto.getObjectAccessState(committedObjectId)).not.toBeNull();
            writes.push("complete"); return { status: "mapped" };
          },
        } as never,
        resolveCurrentDeviceWrappedAgentObjectAuthorization: context => {
          check(); expect(phase).toBe(2);
          return { context, grantAuthorized: true, namespaceAuthorized: true, agentAuthorized: true,
            hostAllowsOperation: true, currentRuntime: { agentId: input.runtime.agentId,
              runtimeGeneration: input.runtime.generation, authorizationRevision: authorizationRevision(3) },
            signerPublicKey: input.publication.agentSignerPublicKey };
        },
      });
      if (phase === 2 && mode === "commit_failure") {
        preparedOutcome = (result as { value: { ordinaryPayloadBytes: Uint8Array } }).value;
        throw new Error("transaction commit rejected");
      }
      committed.push(...writes);
      return result;
    } catch (error) { rolledBack.push(...writes); throw error; }
    finally { active = false; }
  };
  return { withCurrentTranscriptAuthority, now: () => currentTime, committed, rolledBack,
    isActive: () => active, entries: () => entries,
    escape: async () => escapedResolver!(), outcome: () => preparedOutcome,
    cryptoCommitted: async () => committedObjectId !== null
      && await durableCrypto.getObject(committedObjectId) !== null
      && await durableCrypto.getObjectAccessState(committedObjectId) !== null };
}

test("wake allocates before inference and uses one fresh callback for all publication sinks", async () => {
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence); const sinks = scopedWakeTranscript(input);
    const session = createTaskWakeForegroundAgentTurnSession({ ...input, ...sinks });
    try {
      const start = await session.reserveAssistantStream({ assistantMessageKey: "wake", createdAt: TIMING_NOW });
      if (start.status !== "protected") throw new Error("reservation denied");
      expect(sinks.isActive()).toBe(false);
      expect(sinks.committed).toEqual(["reserve"]);
      const payload = { role: "assistant" as const, content: "wake response" };
      session.sealAssistantStreamChunk({ reservation: start.value.reservation,
        ordinaryChunk: new TextEncoder().encode(payload.content), done: true, finalPayload: payload });
      expect(sinks.isActive()).toBe(false);
      const result = await session.publishMessage({ stage: "assistant_message", payload, reservation: start.value.reservation });
      expect(result.status).toBe("protected");
      expect(sinks.entries()).toBe(2);
      expect(sinks.committed).toEqual(["reserve", "publish", "complete", "evidence"]);
      expect(sinks.rolledBack).toEqual([]);
      expect(await sinks.cryptoCommitted()).toBe(true);
      expect(await sinks.escape().catch((error: unknown) => error)).toBeInstanceOf(TypeError);
      expect((await session.publishMessage({ stage: "assistant_message", payload,
        reservation: start.value.reservation })).status).toBe("protected");
      expect(sinks.entries()).toBe(2);
    } finally { session.destroy(); }
  });
});

for (const mode of ["denied", "evidence_conflict", "commit_failure", "expiry"] as const) {
  test(`wake publication ${mode} preserves reservation but reports no committed Message`, async () => {
    await withSessionWake(async evidence => {
      const input = wakeSessionInput(evidence); const sinks = scopedWakeTranscript(input, mode);
      const session = createTaskWakeForegroundAgentTurnSession({ ...input, ...sinks, representationMode: "shadow_encryption" });
      try {
        const request = { stage: "assistant_message" as const, payload: { role: "assistant" as const, content: "wake response" } };
        const result = await session.publishMessage(request);
        expect(result.status).toBe("ordinary_fallback");
        expect("ordinaryPublication" in result).toBe(false);
        expect(sinks.committed).toEqual(["reserve"]);
        expect(sinks.rolledBack).toEqual(mode === "denied" ? [] : ["publish", "complete", "evidence"]);
        expect(await sinks.cryptoCommitted()).toBe(mode !== "denied");
        if (mode === "commit_failure") expect(sinks.outcome()!.ordinaryPayloadBytes.every(b => b === 0)).toBe(true);
        expect((await session.publishMessage(request)).status).toBe("ordinary_fallback");
        expect(sinks.entries()).toBe(2);
      } finally { session.destroy(); }
    });
  });
}

test("wake rejects a retained sink callback after its owner returns", async () => {
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence);
    let escaped: (() => Promise<unknown>) | undefined;
    const session = createTaskWakeForegroundAgentTurnSession({ ...input,
      withCurrentTranscriptAuthority: async use => {
        escaped = () => use(input.ports);
        return use(input.ports);
      },
    });
    try {
      expect((await session.reserveAssistantStream({ assistantMessageKey: "wake", createdAt: TIMING_NOW })).status).toBe("protected");
      expect(await escaped!().catch((error: unknown) => error)).toBeInstanceOf(TypeError);
    } finally { session.destroy(); }
  });
});

test("wake expiry while waiting for current authority refuses the reservation before any sink", async () => {
  await withSessionWake(async evidence => {
    const input = wakeSessionInput(evidence); let currentTime = TIMING_NOW; let writes = 0;
    const session = createTaskWakeForegroundAgentTurnSession({ ...input, now: () => currentTime,
      withCurrentTranscriptAuthority: async use => {
        currentTime = evidence.expiresAt;
        return use({ ...input.ports, product: { reserveLiveShadowAgent: async () => { writes += 1; } } as never });
      },
    });
    try {
      expect(await session.reserveAssistantStream({ assistantMessageKey: "wake", createdAt: TIMING_NOW })
        .catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(writes).toBe(0);
    } finally { session.destroy(); }
  });
});
