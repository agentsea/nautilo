import { describe, expect, test } from "bun:test";

import {
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
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
