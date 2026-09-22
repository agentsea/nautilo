/**
 * D174 — `POST /api/rooms/:roomId/messages` agent-mediated routing (B1 fix).
 *
 * D211 follow-up note: each test now constructs its OWN mock instances
 * for `createForegroundJob`, `loadRoomRoster`, `buildEnvelopeForRoom`,
 * and `getRoomDetailForMember` instead of sharing module-level mocks.
 * Pre-fix, these were `const mock = mock(...)` at module scope and
 * reused across the two tests in this file. Bun's parallel test
 * runner reuses module instances across files in the same batch; if
 * any other test file (or a re-run of the second test in this file)
 * touches the same handler entry points after the first test's
 * `mockClear()`, `toHaveBeenCalledTimes(1)` reads stale call counts
 * and fails non-deterministically. Per-test mocks isolate the
 * call-count surface to the test that owns the assertions.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { RoomDetailPayload } from "@nautilo/trust";
import {
  accessRevision,
  agentRuntimeGeneration,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  LatticeCrypto,
  deriveAgentRuntimeObjectSignerPublic,
  decodeHumanAiReadableLiveShadowMessagePlan,
  encodeHumanAiReadableLiveShadowMessageRequest,
} from "@nautilo/lattice-crypto";
import {
  encodeHumanAiReadableLiveShadowMessagePlanV1,
  encodeHumanAiReadableLiveShadowMessagePlanV2,
  encodeHumanAiReadableLiveShadowMessageRequestV2,
  encodeHumanPeerLiveShadowMessagePlanV1,
  encodeLiveShadowMessagePlanV4,
  encodeSharedAgentLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  getBootstrapDefaultAgentId,
  setBootstrapDefaultAgentId,
  type MemoryAccessEnvelope,
  type RoomParticipant,
} from "@nautilo/trust";

// D211 — stub the @nautilo/trust capability helper reached by
// `dispatchRoomMessageSend()` so this unit test never opens a real
// Postgres connection. The response-mode gate is deliberately retained as a
// spy: strict 1-human/1-agent dispatch must not consult it at all.
import * as actualTrust from "@nautilo/trust";

const shouldFireLLMTurn = mock(async () => ({
  fire: false,
  reason: "inactive",
  effectiveMode: "inactive",
}));
let invocationCapabilityEnabled = true;
let manageRoomsCapabilityEnabled = true;

mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  shouldFireLLMTurn,
  assertCanInvokeAgent: async (input: actualTrust.AgentInvocationAdmissionInput) => {
    if (!invocationCapabilityEnabled) {
      throw new actualTrust.AgentInvocationDeniedError(input);
    }
  },
  userHasCapability: async (_userId: string, capability: string) =>
    capability === "manage_rooms" && manageRoomsCapabilityEnabled,
  // M133 — the room-message route gates on the caller being a verified
  // non-guest member (`read_memories`). Stub so this stays a DB-free unit
  // test of routing/envelope logic.
  getUserCapabilities: async (_userId: string): Promise<string[]> => [
    "read_memories",
    ...(invocationCapabilityEnabled ? ["invoke_agents"] : []),
  ],
}));

// D298 — `dispatchRoomMessageSend()` now gates archived rooms via
// `roomIsArchived()` / `roomRowExists()` in peer-broadcast, which use the
// singleton `db` handle (not `createDirectDb`). Stub so this file stays a
// DB-free unit test of routing/envelope logic.
import * as actualPeerBroadcast from "../../src/messaging/peer-broadcast";

const peerBroadcastHumanMessage = mock(async () => ({
  messageId: 73,
  attachments: [],
  coalesced: true,
  humanTurnId: "11111111-1111-4111-8111-111111111111",
}));
const finalizeProtectedHumanPeerMessage = mock(async () => ({
  messageId: 73, attachments: [], coalesced: true,
  humanTurnId: "human_peer_operation_m295_route",
}));

mock.module("../../src/messaging/peer-broadcast", () => ({
  ...actualPeerBroadcast,
  roomIsArchived: async () => false,
  roomRowExists: async () => false,
  peerBroadcastHumanMessage,
  finalizeProtectedHumanPeerMessage,
}));

const hasAwaitingTaskReply = mock(async () => false);
const maybeResumeAwaitingTask = mock(async () => undefined);
mock.module("../../src/messaging/await-resume", () => ({
  hasAwaitingTaskReply,
  maybeResumeAwaitingTask,
}));

import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { roomsRoutes, type RoomsRouteService } from "../../src/routes/rooms";
import type { ChatRoutesDeps } from "../../src/routes/chat";
import {
  MaintenanceDrainError,
  permissiveMaintenanceGate,
  setMaintenanceGate,
  eventBus,
  type MaintenanceGate,
} from "@nautilo/runtime";
import { setRelayRegistry } from "@nautilo/agent";
import { LiveShadowRecipientRegistry } from "@nautilo/lattice-bridge/server";
import {
  installProductionLiveShadowMessageComposition,
  uninstallProductionLiveShadowMessageComposition,
  type ProductionLiveShadowMessageComposition,
} from "../../src/routes/live-shadow-message-composition";

bootstrapTestDbInstance();

const R1_ID = "a1111111-1111-4111-8111-111111111111";
const DEFAULT_ROOM_ID = "b2222222-2222-4222-8222-222222222222";
const BOOTSTRAP_AGENT_ID = "c3333333-3333-4333-8333-333333333333";
const CUSTOM_AGENT_ID = "d4444444-4444-4444-8444-444444444444";
const SENDER_USER_ID = "e5555555-5555-4555-8555-555555555555";
const SENDER_ACTOR_ID = "f6666666-6666-4666-8666-666666666666";

function fullForegroundPlan(operationId: string, sessionId: string): Uint8Array {
  const crypto = new LatticeCrypto(seededRng(318_111));
  const runtime = { agentId: agentId(CUSTOM_AGENT_ID), keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(2), key: new Uint8Array(32).fill(0x71) };
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  return encodeLiveShadowMessagePlanV4({
    formatVersion: 4, purpose: "message.live_shadow_plan", operationId,
    policyRevision: 4, sessionId, roomId: R1_ID, humanMessageId: 41,
    revision: 0, createdAt: unixTimestamp(1_800_300_000_000),
    subjectHumanId: humanId(SENDER_ACTOR_ID), committerDeviceId: cryptoDeviceId("device_full_route"),
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: authorizationRevision(7),
    recipientAgentId: runtime.agentId, agentAuthorizationRevision: authorizationRevision(5),
    agentRuntimeGeneration: runtime.generation, agentSignerKeyId: signer.principal.signerKeyId,
    agentSignerPublicKey: signer.publicKey, namespaceId: namespaceId("11111111-2222-4333-8444-555555555555"),
    namespaceAccessRevision: accessRevision(2), namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: new Uint8Array(32).fill(1), namespacePublicationDigest: new Uint8Array(32).fill(2),
    namespacePublicationSetDigest: new Uint8Array(32).fill(3), namespaceAudienceFingerprint: new Uint8Array(32).fill(4),
    grantDomainId: "grant_full_route", grantDomainParticipantDigest: new Uint8Array(32).fill(5),
    grantDomainKeyGeneration: 1, grantDomainHeadDigest: new Uint8Array(32).fill(6),
    grantDomainPublicationDigest: new Uint8Array(32).fill(7),
    grantDomainAuthorizationRevision: authorizationRevision(3),
    namespaceBundleGrantDomainAuthorizationRevision: authorizationRevision(3),
    namespaceBundleRevision: 1, namespaceBundleDigest: new Uint8Array(32).fill(8),
    authorization: { disposition: "authorization_reusable", sessionReference: "full-route-session",
      authorizationDigest: new Uint8Array(32).fill(9) }, attemptCoordinate: "full-route-attempt",
    issuedAt: unixTimestamp(1_800_300_000_000), deadlineAt: unixTimestamp(1_800_300_030_000),
  });
}

function fullHumanAiReadablePlan(
  operationId: string,
  sessionId: string,
  mentionEveryone = false,
): Uint8Array {
  return encodeHumanAiReadableLiveShadowMessagePlanV1({
    formatVersion: 1, purpose: "message.human_ai_readable_live_shadow_plan",
    operationId, clientIdempotencyKey: `client:${operationId}`, policyRevision: 4,
    sessionId, roomId: R1_ID, humanMessageId: 73, revision: 0,
    transcriptOrdinal: 1, role: "user", createdAt: unixTimestamp(1_800_300_000_000),
    subjectHumanId: humanId(SENDER_ACTOR_ID), committerDeviceId: cryptoDeviceId("device_full_group"),
    committerDeviceSigningKeyGeneration: 1, hostAuthorizationRevision: authorizationRevision(7),
    namespaceId: namespaceId("11111111-2222-4333-8444-555555555555"), keyClass: "ai",
    namespaceAccessRevision: accessRevision(2), namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: new Uint8Array(32).fill(1), namespacePublicationDigest: new Uint8Array(32).fill(2),
    namespacePublicationSetDigest: new Uint8Array(32).fill(3), namespaceAudienceFingerprint: new Uint8Array(32).fill(4),
    attemptCoordinate: `attempt:${operationId}`, issuedAt: unixTimestamp(1_800_300_000_000),
    deadlineAt: unixTimestamp(1_800_300_030_000),
    ...(mentionEveryone ? { mentionEveryone: true as const } : {}),
  });
}

function humanPeerPlan(
  operationId: string,
  mentionEveryone = false,
  roomId = R1_ID,
): Uint8Array {
  return encodeHumanPeerLiveShadowMessagePlanV1({
    formatVersion: 1,
    purpose: "message.human_peer_live_shadow_plan",
    operationId,
    clientIdempotencyKey: `client:${operationId}`,
    policyRevision: 4,
    sessionId: "22222222-3333-4444-8555-666666666666",
    roomId,
    humanMessageId: 73,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt: unixTimestamp(1_800_300_000_000),
    subjectHumanId: humanId(SENDER_ACTOR_ID),
    committerDeviceId: cryptoDeviceId("device_peer_everyone"),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    namespaceId: namespaceId("11111111-2222-4333-8444-555555555555"),
    keyClass: "human",
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: new Uint8Array(32).fill(1),
    namespacePublicationDigest: new Uint8Array(32).fill(2),
    namespacePublicationSetDigest: new Uint8Array(32).fill(3),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(4),
    attemptCoordinate: `attempt:${operationId}`,
    issuedAt: unixTimestamp(1_800_300_000_000),
    deadlineAt: unixTimestamp(1_800_300_030_000),
    ...(mentionEveryone ? { mentionEveryone: true as const } : {}),
  });
}

function humanAiReadableRequestBytes(planBytes: Uint8Array): Uint8Array {
  const plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
  const crypto = new LatticeCrypto(seededRng(322_001));
  try {
    return encodeHumanAiReadableLiveShadowMessageRequest({
      formatVersion: plan.formatVersion,
      purpose: "message.human_ai_readable_live_shadow_publish",
      normalizationVersion: 1,
      subjectHumanId: plan.subjectHumanId,
      operationId: plan.operationId,
      clientIdempotencyKey: plan.clientIdempotencyKey,
      policyRevision: plan.policyRevision,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      messageId: plan.humanMessageId,
      revision: 0,
      transcriptOrdinal: plan.transcriptOrdinal,
      role: "user",
      createdAt: plan.createdAt,
      cryptoObjectId: objectId(`message:test:${plan.operationId}`),
      namespaceId: plan.namespaceId,
      keyClass: "ai",
      namespaceAccessRevision: plan.namespaceAccessRevision,
      namespaceKeyGeneration: plan.namespaceKeyGeneration,
      namespaceHeadDigest: plan.namespaceHeadDigest,
      namespacePublicationDigest: plan.namespacePublicationDigest,
      namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
      namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
      planDigest: crypto.hash(planBytes),
      plaintextPayloadDigest: new Uint8Array(32).fill(0x21),
      encryptedPayloadDigest: new Uint8Array(32).fill(0x22),
      manifestDigest: new Uint8Array(32).fill(0x23),
      envelopeDigest: new Uint8Array(32).fill(0x24),
      issuedAt: plan.issuedAt,
      deadlineAt: plan.deadlineAt,
      committerDeviceId: plan.committerDeviceId,
      committerDeviceSigningKeyGeneration:
        plan.committerDeviceSigningKeyGeneration,
      hostAuthorizationRevision: plan.hostAuthorizationRevision,
      signature: new Uint8Array(64).fill(0x31),
    });
  } finally {
    for (const field of Object.values(plan)) {
      if (field instanceof Uint8Array) field.fill(0);
    }
  }
}

function fullHumanAiReadableV2Pair(operationId: string): {
  planBytes: Uint8Array;
  requestBytes: Uint8Array;
} {
  const planBytes = encodeHumanAiReadableLiveShadowMessagePlanV2({
    formatVersion: 2,
    purpose: "message.human_ai_readable_live_shadow_plan",
    operationId,
    clientIdempotencyKey: `client:${operationId}`,
    policyRevision: 4,
    sessionId: "22222222-3333-4444-8555-666666666666",
    roomId: R1_ID,
    humanMessageId: 73,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt: unixTimestamp(1_800_300_000_000),
    subjectHumanId: humanId(SENDER_ACTOR_ID),
    committerDeviceId: cryptoDeviceId("device_full_group_v2"),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(7),
    namespaceId: namespaceId("11111111-2222-4333-8444-555555555555"),
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(2),
    namespaceKeyGeneration: namespaceGeneration(3),
    namespaceHeadDigest: new Uint8Array(32).fill(1),
    namespacePublicationDigest: new Uint8Array(32).fill(2),
    namespacePublicationSetDigest: new Uint8Array(32).fill(3),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(4),
    attemptCoordinate: `attempt:${operationId}`,
    issuedAt: unixTimestamp(1_800_300_000_000),
    deadlineAt: unixTimestamp(1_800_300_300_000),
    mentionEveryone: true,
  });
  const plan = decodeHumanAiReadableLiveShadowMessagePlan(planBytes);
  const crypto = new LatticeCrypto(seededRng(322_002));
  try {
    return {
      planBytes,
      requestBytes: encodeHumanAiReadableLiveShadowMessageRequestV2({
        formatVersion: 2,
        purpose: "message.human_ai_readable_live_shadow_publish",
        normalizationVersion: 1,
        subjectHumanId: plan.subjectHumanId,
        operationId: plan.operationId,
        clientIdempotencyKey: plan.clientIdempotencyKey,
        policyRevision: plan.policyRevision,
        sessionId: plan.sessionId,
        roomId: plan.roomId,
        messageId: plan.humanMessageId,
        revision: 0,
        transcriptOrdinal: plan.transcriptOrdinal,
        role: "user",
        createdAt: plan.createdAt,
        cryptoObjectId: objectId(`message:test:${plan.operationId}`),
        namespaceId: plan.namespaceId,
        keyClass: "ai",
        namespaceAccessRevision: plan.namespaceAccessRevision,
        namespaceKeyGeneration: plan.namespaceKeyGeneration,
        namespaceHeadDigest: plan.namespaceHeadDigest,
        namespacePublicationDigest: plan.namespacePublicationDigest,
        namespacePublicationSetDigest: plan.namespacePublicationSetDigest,
        namespaceAudienceFingerprint: plan.namespaceAudienceFingerprint,
        planDigest: crypto.hash(planBytes),
        plaintextPayloadDigest: new Uint8Array(32).fill(0x21),
        encryptedPayloadDigest: new Uint8Array(32).fill(0x22),
        manifestDigest: new Uint8Array(32).fill(0x23),
        envelopeDigest: new Uint8Array(32).fill(0x24),
        issuedAt: plan.issuedAt,
        deadlineAt: plan.deadlineAt,
        committerDeviceId: plan.committerDeviceId,
        committerDeviceSigningKeyGeneration: plan.committerDeviceSigningKeyGeneration,
        hostAuthorizationRevision: plan.hostAuthorizationRevision,
        signature: new Uint8Array(64).fill(0x31),
      }),
    };
  } finally {
    for (const field of Object.values(plan)) {
      if (field instanceof Uint8Array) field.fill(0);
    }
  }
}
const CUSTOM_AGENT_ACTOR_ID = "a7777777-7777-4777-8777-777777777777";
const AGENT_OWNER_USER_ID = "a8888888-8888-4888-8888-888888888888";
const DIRECT_SUBTHREAD_ROOM_ID = "b9999999-9999-4999-8999-999999999999";
const SUBTHREAD_PARENT_ROOM_ID = "c9999999-9999-4999-8999-999999999999";
const SUBTHREAD_ANCHOR_MESSAGE_ID = 426;

const ORIGINAL_BOOTSTRAP_AGENT = getBootstrapDefaultAgentId();
const TEST_FALLBACK_POLICY = Object.freeze({
  mode: "plaintext_only" as const,
  shadowBehavior: "fallback" as const,
  revision: 1,
  shadowEncryptionStartedAt: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const enforceFallbackStrictShadowBoundary: NonNullable<
  ChatRoutesDeps["enforceStrictShadowBoundary"]
> = async (input) => Object.freeze({
  policy: TEST_FALLBACK_POLICY,
  result: Object.freeze({
    disposition: "ordinary" as const,
    decision: Object.freeze({
      boundaryId: input.boundaryId,
      family: "test",
      operation: "test",
      actorClass: "human" as const,
      state: input.state,
      reason: input.reason,
      retryable: input.retryable,
      policyRevision: TEST_FALLBACK_POLICY.revision,
    }),
  }),
});

type TestMocks = {
  createForegroundJob: ReturnType<typeof mock>;
  loadRoomRoster: ReturnType<typeof mock>;
  buildEnvelopeForRoom: ReturnType<typeof mock>;
  getRoomDetailForMember: ReturnType<typeof mock>;
  humanPairIsBlocked: ReturnType<typeof mock>;
};

function makeTestMocks(): TestMocks {
  return {
    createForegroundJob: mock(
      (_memOwner: string, _sessionUserId: string, _laneKey: string, _input: Record<string, unknown>) =>
        Promise.resolve({ id: "job-b1-test", virtualJobId: "job-b1-test" }),
    ),
    loadRoomRoster: mock((_roomId: string) => Promise.resolve<RoomParticipant[]>([])),
    buildEnvelopeForRoom: mock(
      (actorId: string, _laneKey: string, agentId: string, roomId: string) =>
        Promise.resolve<MemoryAccessEnvelope>({
          ownerId: actorId === CUSTOM_AGENT_ACTOR_ID ? AGENT_OWNER_USER_ID : SENDER_USER_ID,
          actorId,
          agentId,
          roomId,
          readableNamespaces: [`readable:${roomId}`],
          mutableNamespaces: [`readable:${roomId}`],
          writableNamespaces: [`writable:${roomId}`],
          toolPolicy: {},
        }),
    ),
    getRoomDetailForMember: mock(
      (_roomId: string, _requesterActorId: string) => Promise.resolve<RoomDetailPayload | null>(null),
    ),
    humanPairIsBlocked: mock(async () => false),
  };
}

function r1Detail(): RoomDetailPayload {
  return {
    id: R1_ID,
    label: "Custom agent room",
    type: "private",
    graphThreadId: `room:${R1_ID}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    conductorMode: "standard",
    members: [
      {
        actorId: SENDER_ACTOR_ID,
        kind: "user",
        displayName: "Sender",
        userId: SENDER_USER_ID,
        roomRole: "admin",
      },
      {
        actorId: CUSTOM_AGENT_ACTOR_ID,
        kind: "agent",
        displayName: "Custom Agent X",
        agentId: CUSTOM_AGENT_ID,
        agentOwnerUserId: AGENT_OWNER_USER_ID,
        roomRole: "member",
      },
    ],
  };
}

function r1Roster(): RoomParticipant[] {
  return [
    {
      actorId: SENDER_ACTOR_ID,
      kind: "user",
      displayName: "Sender",
      userId: SENDER_USER_ID,
      roomRole: "admin",
    },
    {
      actorId: CUSTOM_AGENT_ACTOR_ID,
      kind: "agent",
      displayName: "Custom Agent X",
      agentId: CUSTOM_AGENT_ID,
      agentOwnerUserId: AGENT_OWNER_USER_ID,
      roomRole: "member",
    },
  ];
}

function directSubthreadDetail(): RoomDetailPayload {
  return {
    ...r1Detail(),
    id: DIRECT_SUBTHREAD_ROOM_ID,
    label: "Custom agent thread",
    graphThreadId: `room:${DIRECT_SUBTHREAD_ROOM_ID}`,
    kind: "subthread",
    parentRoomId: SUBTHREAD_PARENT_ROOM_ID,
    threadRootMessageId: SUBTHREAD_ANCHOR_MESSAGE_ID,
  };
}

function defaultGenieDetail(): RoomDetailPayload {
  return {
    id: DEFAULT_ROOM_ID,
    label: "Genie",
    type: "private",
    graphThreadId: "app:default",
    createdAt: "2026-01-01T00:00:00.000Z",
    kind: "private",
    parentRoomId: null,
    threadRootMessageId: null,
    conductorMode: "standard",
    members: [
      {
        actorId: SENDER_ACTOR_ID,
        kind: "user",
        displayName: "Sender",
        userId: SENDER_USER_ID,
        roomRole: "admin",
      },
      {
        actorId: "99999999-9999-4999-8999-999999999999",
        kind: "agent",
        displayName: "Genie",
        agentId: BOOTSTRAP_AGENT_ID,
        roomRole: "member",
      },
    ],
  };
}

function mixedRoomDetail(): RoomDetailPayload {
  return {
    ...r1Detail(),
    kind: "group",
    members: [
      ...r1Detail().members,
      {
        actorId: "b7777777-1111-4111-8111-111111111111",
        kind: "user",
        displayName: "Second Human",
        userId: "b8888888-1111-4111-8111-111111111111",
        roomRole: "member",
      },
    ],
  };
}

function humanOnlyRoomDetail(): RoomDetailPayload {
  return {
    ...r1Detail(),
    kind: "group",
    members: [
      r1Detail().members[0]!,
      {
        actorId: "b7777777-1111-4111-8111-111111111111",
        kind: "user",
        displayName: "Second Human",
        userId: "b8888888-1111-4111-8111-111111111111",
        roomRole: "member",
      },
    ],
  };
}

async function makeMessagingApp(
  mocks: TestMocks,
  envelope: { ownerId: string; agentId: string; roomId: string },
  policyContext: { actorRole: string; laneKey: string; graphThreadId: string },
  chatOverrides: Partial<ChatRoutesDeps> = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("policyContext", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("rbacProjection", null);

  // This routing harness models an already authenticated browser request.
  // Preserve that production precondition now that the large protected-send
  // route rejects a missing bearer before parsing its bounded JSON body.
  app.addHook("onRequest", async (request) => {
    request.headers.authorization ??= "Bearer test-session";
  });

  const service: RoomsRouteService = {
    listRoomsForActor: async () => [],
    getRoomDetailForMember: mocks.getRoomDetailForMember as RoomsRouteService["getRoomDetailForMember"],
    createRoomForOwner: async () => r1Detail(),
    renamePrivateRoomForOwner: async () => null,
    listManageableRoomsForUser: async () => [],
    getRoomDetailForManager: async () => null,
    humanPairIsBlocked: mocks.humanPairIsBlocked,
  };
  roomsRoutes(app, service);

  const chatDeps = {
    createForegroundJob: mocks.createForegroundJob,
    loadRoomRoster: mocks.loadRoomRoster,
    buildEnvelopeForRoom: mocks.buildEnvelopeForRoom,
    currentStrictShadowPolicy: async () => TEST_FALLBACK_POLICY,
    enforceStrictShadowBoundary: enforceFallbackStrictShadowBoundary,
    ...chatOverrides,
  } as unknown as ChatRoutesDeps;
  (app as FastifyInstance & { nautiloChatDeps?: ChatRoutesDeps }).nautiloChatDeps = chatDeps;

  app.addHook("preHandler", async (request) => {
    (request as { policyContext?: typeof policyContext }).policyContext = policyContext;
    (request as { memoryEnvelope?: typeof envelope }).memoryEnvelope = envelope;
    (request as { sessionActorId?: string }).sessionActorId = SENDER_ACTOR_ID;
    (request as { sessionUserId?: string }).sessionUserId = SENDER_USER_ID;
    request.rbacProjection = {
      highestRole: "guest",
      capabilitySlugs: invocationCapabilityEnabled ? ["invoke_agents"] : [],
      groupChips: [],
    };
  });

  await app.ready();
  return app;
}

function jobInputFromLastCall(mocks: TestMocks): Record<string, unknown> {
  const callArgs = mocks.createForegroundJob.mock.calls.at(-1) as unknown[] | undefined;
  expect(callArgs).toBeDefined();
  return callArgs![3] as Record<string, unknown>;
}

function jobLaneKeyFromLastCall(mocks: TestMocks): string {
  const callArgs = mocks.createForegroundJob.mock.calls.at(-1) as unknown[] | undefined;
  expect(callArgs).toBeDefined();
  return callArgs![2] as string;
}

beforeAll(() => {
  setBootstrapDefaultAgentId(BOOTSTRAP_AGENT_ID);
});

afterAll(() => {
  setBootstrapDefaultAgentId(ORIGINAL_BOOTSTRAP_AGENT);
  mock.restore();
});

describe("POST /api/rooms/:roomId/messages agent-mediated routing", () => {
  test("rejects an ordinary everyone notification without manage_rooms before side effects", async () => {
    manageRoomsCapabilityEnabled = false;
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "Hello everyone", mentionEveryone: true },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json<Record<string, unknown>>()).toEqual({
        error: "manage_rooms_required",
        code: "manage_rooms_required",
        capability: "manage_rooms",
        message: "The manage_rooms permission is required to notify everyone in this room.",
      });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      manageRoomsCapabilityEnabled = true;
      await app.close();
    }
  });

  test("routes an audience-only strict DM as Human history without directly waking its Genie", async () => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "Hello everyone", mentionEveryone: true },
      });
      expect(response.statusCode).toBe(202);
      expect(peerBroadcastHumanMessage).toHaveBeenCalledWith(
        expect.objectContaining({ mentionEveryone: true }),
      );
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("rejects a malformed everyone intent at HTTP ingress", async () => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "Hello", mentionEveryone: "true" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "invalid_mention_everyone",
      });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("ignores an unsigned outer everyone flag when the Full signed plan omits it", async () => {
    invocationCapabilityEnabled = false;
    peerBroadcastHumanMessage.mockClear();
    finalizeProtectedHumanPeerMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const operationId = "full-human-ai-unsigned-everyone";
    const planBytes = fullHumanAiReadablePlan(
      operationId,
      "22222222-3333-4444-8555-666666666666",
    );
    const requestBytes = humanAiReadableRequestBytes(planBytes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          mentionEveryone: true,
          clientActionSessionId: "browser:unsigned-everyone",
          liveShadow: {
            requestVersion: 2,
            representationMode: "full_encryption",
            status: "prepared",
            operationId,
            authorizationScheme: "human_ai_readable_v1",
            planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
            signedRequestBytesBase64url:
              Buffer.from(requestBytes).toString("base64url"),
            encryptedPayloadBytesBase64url: "BA",
            accessManifestBytesBase64url: "BQ",
            namespaceEnvelopeBytesBase64url: "Bg",
          },
        },
      });
      expect(response.statusCode).toBe(403);
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(finalizeProtectedHumanPeerMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      planBytes.fill(0);
      requestBytes.fill(0);
      invocationCapabilityEnabled = true;
      await app.close();
    }
  });

  test.each(["direct", "human_peer", "group"] as const)("keeps ordinary fallback for a diagnostic-only failed %s plan", async (topology) => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    const detail = topology === "direct" ? r1Detail()
      : topology === "human_peer" ? humanOnlyRoomDetail() : mixedRoomDetail();
    mocks.getRoomDetailForMember.mockImplementation(async () => detail);
    mocks.loadRoomRoster.mockImplementation(async () => detail.members);
    const observations: Array<{ state: string; reason: string }> = [];
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      {
        enforceStrictShadowBoundary: async (input) => {
          observations.push(input);
          return enforceFallbackStrictShadowBoundary(input);
        },
      },
    );
    try {
      const response = await app.inject({
        method: "POST", url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          content: "ordinary fallback remains policy-owned",
          liveShadow: { requestVersion: 1, status: "plan_unavailable", reason: "namespace_unavailable" },
        },
      });
      expect(response.statusCode).toBe(topology === "human_peer" ? 201 : 202);
      expect(observations.some((entry) => entry.state === "waiting_for_authority"
        && entry.reason === "namespace_authority_converging")).toBeTrue();
      expect(observations.some((entry) => entry.state === "verified")).toBeFalse();
      expect(response.json<{ liveShadow?: unknown }>().liveShadow).toBeUndefined();
      if (topology === "direct") expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      else expect(peerBroadcastHumanMessage).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  test.each(["direct", "human_peer", "group"] as const)("withholds failed plans before %s persistence, without inventing an operation", async (topology) => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    const detail = topology === "direct" ? r1Detail()
      : topology === "human_peer" ? humanOnlyRoomDetail() : mixedRoomDetail();
    mocks.getRoomDetailForMember.mockImplementation(async () => detail);
    mocks.loadRoomRoster.mockImplementation(async () => detail.members);
    const enforceBoundary: NonNullable<ChatRoutesDeps["enforceStrictShadowBoundary"]> = async (input) => {
      const observed = await enforceFallbackStrictShadowBoundary(input);
      return {
        ...observed,
        result: {
          ...observed.result,
          disposition: input.state === "waiting_for_authority" ? "withhold" : "reject",
        },
      };
    };
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      { enforceStrictShadowBoundary: enforceBoundary },
    );
    try {
      for (const [reason, expectedReason, retryable] of [
        ["namespace_unavailable", "namespace_authority_converging", true],
        ["recipient_sync_required", "namespace_authority_converging", true],
        ["request_failed", "publication_failure", false],
        ["invalid_plan", "integrity_failure", false],
        ["room_topology_unsupported", "unsupported_operation", false],
      ] as const) {
        const response = await app.inject({
          method: "POST", url: `/api/rooms/${R1_ID}/messages`,
          payload: {
            content: "failed planning must not authorize plaintext",
            liveShadow: { requestVersion: 1, status: "plan_unavailable", reason },
          },
        });
        expect(response.statusCode).toBe(retryable ? 425 : 409);
        expect(response.json()).toMatchObject({
          error: "strict_shadow_protected_content_required",
          reason: expectedReason, retryable,
        });
      }
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test.each(["human_peer", "group"] as const)("preserves typed unavailable reasons before %s persistence", async (topology) => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async () =>
      topology === "human_peer" ? humanOnlyRoomDetail() : mixedRoomDetail(),
    );
    const enforceBoundary: NonNullable<ChatRoutesDeps["enforceStrictShadowBoundary"]> = async (input) => {
      const observed = await enforceFallbackStrictShadowBoundary(input);
      return {
        ...observed,
        result: {
          ...observed.result,
          disposition: input.state === "waiting_for_authority" ? "withhold" : "reject",
        },
      };
    };
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      { enforceStrictShadowBoundary: enforceBoundary },
    );
    try {
      for (const [clientReason, expectedReason, retryable] of [
        ["namespace_unavailable", "namespace_authority_converging", true],
        ["domain_unavailable", "domain_authority_converging", true],
        ["profile_unavailable", "device_not_enrolled", false],
        ["plan_stale", "stale_authority", false],
        ["journal_unavailable", "publication_failure", false],
        ["journal_full", "publication_failure", false],
        ["profile_invalid", "integrity_failure", false],
      ] as const) {
        const response = await app.inject({
          method: "POST", url: `/api/rooms/${R1_ID}/messages`,
          payload: {
            content: "must not persist unavailable protected input",
            liveShadow: {
              requestVersion: 1, status: "client_unavailable",
              operationId: `client-unavailable-${clientReason}`,
              planBytesBase64url: "AQ", reason: clientReason,
            },
          },
        });
        expect(response.statusCode).toBe(retryable ? 425 : 409);
        expect(response.json()).toMatchObject({
          error: "strict_shadow_protected_content_required",
          reason: expectedReason, retryable,
        });
      }
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("M305 rejects an unknown protected-send shape before every room topology", async () => {
    for (const detail of [r1Detail(), humanOnlyRoomDetail(), mixedRoomDetail()]) {
      peerBroadcastHumanMessage.mockClear();
      const mocks = makeTestMocks();
      mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
        roomId === R1_ID ? detail : null,
      );
      mocks.loadRoomRoster.mockImplementation(async () => detail.members);
      const app = await makeMessagingApp(
        mocks,
        { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
        { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/rooms/${R1_ID}/messages`,
          headers: { "content-type": "application/json" },
          payload: {
            content: "must not downgrade",
            liveShadow: {
              status: "future_policy_version",
              secretBytesBase64url: "c2VjcmV0",
            },
          },
        });

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
          error: "invalid_live_shadow_attempt",
          code: "invalid_live_shadow_attempt",
        });
        expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
        expect(mocks.createForegroundJob).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  test("rejects a substituted Human-AI-readable scheme before every room topology", async () => {
    const operationId = "substituted-human-ai-readable-format";
    const planBytes = fullHumanAiReadablePlan(
      operationId,
      "22222222-3333-4444-8555-666666666666",
    );
    const requestBytes = humanAiReadableRequestBytes(planBytes);
    try {
      for (const detail of [r1Detail(), humanOnlyRoomDetail(), mixedRoomDetail()]) {
        peerBroadcastHumanMessage.mockClear();
        const mocks = makeTestMocks();
        mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
          roomId === R1_ID ? detail : null,
        );
        mocks.loadRoomRoster.mockImplementation(async () => detail.members);
        const app = await makeMessagingApp(
          mocks,
          { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
          { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
        );
        try {
          const response = await app.inject({
            method: "POST",
            url: `/api/rooms/${R1_ID}/messages`,
            payload: {
              content: "must not downgrade",
              liveShadow: {
                requestVersion: 1,
                status: "prepared",
                operationId,
                // Both framed payloads are V1; substituting the V2 label must
                // fail before any topology can select plaintext persistence.
                authorizationScheme: "human_ai_readable_v2",
                planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
                signedRequestBytesBase64url:
                  Buffer.from(requestBytes).toString("base64url"),
                ordinaryPayloadBytesBase64url: "AQ",
                encryptedPayloadBytesBase64url: "Ag",
                accessManifestBytesBase64url: "Aw",
                namespaceEnvelopeBytesBase64url: "BA",
              },
            },
          });

          expect(response.statusCode).toBe(400);
          expect(JSON.parse(response.body)).toEqual({
            error: "invalid_live_shadow_attempt",
            code: "invalid_live_shadow_attempt",
          });
          expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
          expect(mocks.createForegroundJob).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      }
    } finally {
      planBytes.fill(0);
      requestBytes.fill(0);
    }
  });

  test("D566 keeps authenticated chat independent of denied optional mobile provenance", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        headers: {
          "content-type": "application/json",
          // A previously paired installation can retain a proof after the
          // server binding is revoked or replaced. Any denied proof follows
          // this same admission result and must be discarded, never trusted.
          "x-nautilo-mobile-origin": "{}",
        },
        payload: { content: "chat survives stale pairing" },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, jobId: "job-b1-test" });
      expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      expect(jobInputFromLastCall(mocks)).not.toHaveProperty("verifiedOrdinaryOrigin");
    } finally {
      await app.close();
    }
  });

  test("M297 rejects a blocked exact two-Human send before persistence or realtime", async () => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? humanOnlyRoomDetail() : null,
    );
    mocks.humanPairIsBlocked.mockImplementation(async () => true);
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "must not persist" },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: "direct_human_interaction_blocked",
        code: "direct_human_interaction_blocked",
      });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test.each([false, true])("M295 publishes one same-row Human-peer sibling without an Agent job or second ordinary append (Full=%s)", async (full) => {
    peerBroadcastHumanMessage.mockClear();
    finalizeProtectedHumanPeerMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? humanOnlyRoomDetail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const operationId = "human_peer_operation_m295_route";
    const namespace = "11111111-2222-4333-8444-555555555555";
    const planBytes = encodeHumanPeerLiveShadowMessagePlanV1({
      formatVersion: 1,
      purpose: "message.human_peer_live_shadow_plan",
      operationId,
      clientIdempotencyKey: "human_peer_client_m295_route",
      policyRevision: 4,
      sessionId: "22222222-3333-4444-8555-666666666666",
      roomId: R1_ID,
      humanMessageId: 73,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(1_800_300_000_000),
      subjectHumanId: humanId(SENDER_ACTOR_ID),
      committerDeviceId: cryptoDeviceId("device_m295_route"),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(namespace),
      keyClass: "human",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: new Uint8Array(32).fill(0x21),
      namespacePublicationDigest: new Uint8Array(32).fill(0x22),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x23),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x24),
      attemptCoordinate: "human_peer_attempt_m295_route",
      issuedAt: unixTimestamp(1_800_300_000_000),
      deadlineAt: unixTimestamp(1_800_300_030_000),
    });
    const encodedPlan = Buffer.from(planBytes).toString("base64url");
    const encodedRequest = "Ag";
    const encodedByte = Buffer.from([1]).toString("base64url");
    const protectedMessage = {
      dtoVersion: 2 as const,
      projection: {
        messageId: "73",
        sessionId: "22222222-3333-4444-8555-666666666666",
        roomId: R1_ID,
        namespaceId: namespace,
        role: "user" as const,
        createdAt: new Date(1_800_300_000_000).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted" as const,
        cryptoObjectId: `message:live-shadow:v1:${"a".repeat(64)}`,
        payloadVersion: 2 as const,
        keyClass: "human" as const,
        encryptedPayloadBytesBase64url: encodedByte,
        accessManifestBytesBase64url: encodedByte,
        namespaceEnvelopeBytesBase64url: encodedByte,
      },
    };
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(),
      plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(new Error("not used")),
      admitHumanPeer: () => Promise.resolve({
        status: "human_verified" as const,
        operationId,
        messageId: 73,
        ...(full ? { representationMode: "full_encryption" as const } : {
          content: "Protected hello",
        }),
        protectedMessage,
        protectedMessageDigest: new Uint8Array(32).fill(0x31),
        senderDeviceSigningPublicKey: new Uint8Array(32).fill(0x32),
      }),
      recordHumanPeerPublished: () => Promise.resolve("published" as const),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () =>
        Promise.reject(new Error("not used")),
      recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("must not run")),
      shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          ...(full ? {} : { content: "Protected hello" }),
          liveShadow: {
            requestVersion: full ? 2 : 1,
            ...(full ? { representationMode: "full_encryption" } : {}),
            status: "prepared",
            operationId,
            authorizationScheme: "human_peer_v1",
            planBytesBase64url: encodedPlan,
            signedRequestBytesBase64url: encodedRequest,
            ...(full ? {} : { ordinaryPayloadBytesBase64url: encodedByte }),
            encryptedPayloadBytesBase64url: encodedByte,
            accessManifestBytesBase64url: encodedByte,
            namespaceEnvelopeBytesBase64url: encodedByte,
          },
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        messageId: 73,
        accepted: true,
        liveShadow: {
          status: "human_verified",
          operationId,
        },
      });
      expect(peerBroadcastHumanMessage).toHaveBeenCalledTimes(full ? 0 : 1);
      expect(finalizeProtectedHumanPeerMessage).toHaveBeenCalledTimes(full ? 1 : 0);
      const peerCall = peerBroadcastHumanMessage.mock.calls[0] as
        unknown as readonly unknown[] | undefined;
      if (!full) expect(peerCall?.[0]).toMatchObject({ persistedMessage: {
        messageId: 73, content: "Protected hello", fingerprint: operationId,
        humanTurnId: operationId,
      } });
      else expect((finalizeProtectedHumanPeerMessage.mock.calls as unknown as [[unknown]])[0]?.[0]).toMatchObject({
        messageId: 73, operationId,
      });
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
      await app.close();
    }
  });

  test("M296 protects incapable-Human mixed-Room text without starting Agent work", async () => {
    invocationCapabilityEnabled = false;
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? mixedRoomDetail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const operationId = "shared_agent_operation_m296_route";
    const namespace = "11111111-2222-4333-8444-555555555555";
    const planBytes = encodeSharedAgentLiveShadowMessagePlanV1({
      formatVersion: 1,
      purpose: "message.shared_agent_live_shadow_plan",
      operationId,
      clientIdempotencyKey: "shared_agent_client_m296_route",
      policyRevision: 4,
      sessionId: "22222222-3333-4444-8555-666666666666",
      roomId: R1_ID,
      recipientAgentId: agentId(CUSTOM_AGENT_ID),
      humanMessageId: 73,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(1_800_300_000_000),
      subjectHumanId: humanId(SENDER_ACTOR_ID),
      committerDeviceId: cryptoDeviceId("device_m296_route"),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(namespace),
      keyClass: "ai",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: new Uint8Array(32).fill(0x41),
      namespacePublicationDigest: new Uint8Array(32).fill(0x42),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x43),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x44),
      attemptCoordinate: "shared_agent_attempt_m296_route",
      issuedAt: unixTimestamp(1_800_300_000_000),
      deadlineAt: unixTimestamp(1_800_300_030_000),
    });
    const encodedPlan = Buffer.from(planBytes).toString("base64url");
    const encodedByte = Buffer.from([1]).toString("base64url");
    const protectedMessage = {
      dtoVersion: 2 as const,
      projection: {
        messageId: "73",
        sessionId: "22222222-3333-4444-8555-666666666666",
        roomId: R1_ID,
        namespaceId: namespace,
        role: "user" as const,
        createdAt: new Date(1_800_300_000_000).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted" as const,
        cryptoObjectId: `message:live-shadow:v1:${"b".repeat(64)}`,
        payloadVersion: 2 as const,
        keyClass: "ai" as const,
        encryptedPayloadBytesBase64url: encodedByte,
        accessManifestBytesBase64url: encodedByte,
        namespaceEnvelopeBytesBase64url: encodedByte,
      },
    };
    const published = mock(async () => "published" as const);
    const conductor = mock(async () => "recorded" as const);
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(),
      plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(new Error("not used")),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () =>
        Promise.reject(new Error("not used")),
      admitSharedAgent: () => Promise.resolve({
        status: "human_verified" as const,
        operationId,
        messageId: 73,
        content: "Protected shared hello",
        protectedMessage,
        protectedMessageDigest: new Uint8Array(32).fill(0x51),
        senderDeviceSigningPublicKey: new Uint8Array(32).fill(0x52),
      }),
      recordSharedAgentPublished: published,
      recordSharedAgentConductorResolution: conductor,
      recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("must not run")),
      shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          content: "Protected shared hello",
          // The signed legacy plan has no everyone intent. The untrusted
          // outer flag must be overwritten by the verified admission result.
          mentionEveryone: true,
          liveShadow: {
            requestVersion: 1,
            status: "prepared",
            operationId,
            authorizationScheme: "shared_agent_v1",
            planBytesBase64url: encodedPlan,
            signedRequestBytesBase64url: encodedByte,
            ordinaryPayloadBytesBase64url: encodedByte,
            encryptedPayloadBytesBase64url: encodedByte,
            accessManifestBytesBase64url: encodedByte,
            namespaceEnvelopeBytesBase64url: encodedByte,
          },
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        messageId: 73,
        accepted: true,
        liveShadow: { status: "human_verified", operationId },
      });
      expect(peerBroadcastHumanMessage).toHaveBeenCalledTimes(1);
      expect(peerBroadcastHumanMessage).toHaveBeenCalledWith(
        expect.objectContaining({ mentionEveryone: false }),
      );
      expect(published).toHaveBeenCalledTimes(1);
      expect(conductor).toHaveBeenCalledWith(expect.objectContaining({
        operationIds: [operationId],
        state: "not_selected",
        reason: "invocation_not_permitted",
      }));
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      planBytes.fill(0);
      invocationCapabilityEnabled = true;
      uninstallProductionLiveShadowMessageComposition(app);
      await app.close();
    }
  });

  test("M298 carries a protected direct Human turn into one Runtime-authorized Agent job", async () => {
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const operationId = "shared_agent_operation_m298_direct";
    const executionId = "10000000-0000-4000-8000-000000000298";
    const sessionId = "22222222-3333-4444-8555-666666666666";
    const namespace = "11111111-2222-4333-8444-555555555555";
    const deviceId = "device_m298_direct";
    const planBytes = encodeHumanAiReadableLiveShadowMessagePlanV1({
      formatVersion: 1,
      purpose: "message.human_ai_readable_live_shadow_plan",
      operationId,
      clientIdempotencyKey: "shared_agent_client_m298_direct",
      policyRevision: 4,
      sessionId,
      roomId: R1_ID,
      humanMessageId: 73,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(1_800_300_000_000),
      subjectHumanId: humanId(SENDER_ACTOR_ID),
      committerDeviceId: cryptoDeviceId(deviceId),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(namespace),
      keyClass: "ai",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: new Uint8Array(32).fill(0x61),
      namespacePublicationDigest: new Uint8Array(32).fill(0x62),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x63),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x64),
      attemptCoordinate: "shared_agent_attempt_m298_direct",
      issuedAt: unixTimestamp(1_800_300_000_000),
      deadlineAt: unixTimestamp(1_800_300_030_000),
    });
    const encodedPlan = Buffer.from(planBytes).toString("base64url");
    const requestBytes = humanAiReadableRequestBytes(planBytes);
    const encodedRequest = Buffer.from(requestBytes).toString("base64url");
    const encodedByte = Buffer.from([1]).toString("base64url");
    const protectedMessage = {
      dtoVersion: 2 as const,
      projection: {
        messageId: "73",
        sessionId,
        roomId: R1_ID,
        namespaceId: namespace,
        role: "user" as const,
        createdAt: new Date(1_800_300_000_000).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted" as const,
        cryptoObjectId: `message:live-shadow:v1:${"c".repeat(64)}`,
        payloadVersion: 2 as const,
        keyClass: "ai" as const,
        encryptedPayloadBytesBase64url: encodedByte,
        accessManifestBytesBase64url: encodedByte,
        namespaceEnvelopeBytesBase64url: encodedByte,
      },
    };
    const published = mock(async () => "published" as const);
    const reserveRuntime = mock(async () => ({
      invocationId: "runtime-invocation:m298-direct",
      roomId: R1_ID,
      invokingHumanId: SENDER_ACTOR_ID,
      invokingDeviceId: deviceId,
      clientActionSessionId: "browser:m298-direct",
      policyRevision: 4,
      inputSetDigest: new Uint8Array(32).fill(0x65),
      inputs: [{ operationId, messageId: 73 }],
      deadlineAt: Date.now() + 30_000,
    }));
    const planInvocation = mock(async () => ({
      status: "authorized" as const,
      invocationId: "runtime-invocation:m298-direct",
      deadlineAt: Date.now() + 30_000,
      sessionReference: "runtime-session:m298-direct",
      authorizationDigest: new Uint8Array(32).fill(0x66),
      scope: {
        subjectHumanId: SENDER_ACTOR_ID,
        issuingDeviceId: deviceId,
        recipientKind: "nautilo_foreground_runtime" as const,
        browserSessionId: "browser:m298-direct",
        topLevelRoomId: R1_ID,
        policyRevision: 4,
        hostAuthorizationRevision: 7,
        namespaceIds: [namespace],
        grantDomainIds: ["grant-domain:m298-direct"],
        domainAuthoritySetDigest: new Uint8Array(32).fill(0x67),
      },
    }));
    const attachRuntime = mock(async () => ({
      invocationId: "runtime-invocation:m298-direct",
      executions: [{ executionId, sessionId, agentId: CUSTOM_AGENT_ID }],
    }));
    const planExecution = mock(async () => ({
      status: "authorized" as const,
      executionId,
      executionKind: "turn" as const,
      planBytes: new Uint8Array([1]),
      executionDeadlineAt: 1_800_300_300_000,
      sessionReference: "runtime-session:m298-direct",
      authorizationDigest: new Uint8Array(32).fill(0x66),
      scope: {
        subjectHumanId: SENDER_ACTOR_ID,
        issuingDeviceId: deviceId,
        recipientKind: "nautilo_foreground_runtime" as const,
        browserSessionId: "browser:m298-direct",
        topLevelRoomId: R1_ID,
        policyRevision: 4,
        hostAuthorizationRevision: 7,
        namespaceIds: [namespace],
        grantDomainIds: ["grant-domain:m298-direct"],
        domainAuthoritySetDigest: new Uint8Array(32).fill(0x67),
      },
    }));
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(),
      plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(new Error("not used")),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () =>
        Promise.reject(new Error("not used")),
      admitSharedAgent: () => Promise.resolve({
        status: "human_verified" as const,
        operationId,
        messageId: 73,
        content: "Protected direct hello",
        protectedMessage,
        protectedMessageDigest: new Uint8Array(32).fill(0x68),
        senderDeviceSigningPublicKey: new Uint8Array(32).fill(0x69),
      }),
      recordSharedAgentPublished: published,
      reserveSharedAgentRuntimeInvocation: reserveRuntime,
      planRuntimeInvocationAuthorization: planInvocation,
      attachSharedAgentRuntimeInvocationExecutions: attachRuntime,
      planSharedAgentExecutionAuthorization: planExecution,
      recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("deferred into Agent job")),
      shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          content: "Protected direct hello",
          clientActionSessionId: "browser:m298-direct",
          liveShadow: {
            requestVersion: 1,
            status: "prepared",
            operationId,
            authorizationScheme: "human_ai_readable_v1",
            planBytesBase64url: encodedPlan,
            signedRequestBytesBase64url: encodedRequest,
            ordinaryPayloadBytesBase64url: encodedByte,
            encryptedPayloadBytesBase64url: encodedByte,
            accessManifestBytesBase64url: encodedByte,
            namespaceEnvelopeBytesBase64url: encodedByte,
          },
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        accepted: true,
        liveShadow: { status: "human_verified", operationId },
      });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(published).toHaveBeenCalledTimes(1);
      expect(reserveRuntime).toHaveBeenCalledWith(expect.objectContaining({
        operationIds: [operationId],
      }));
      expect(attachRuntime).toHaveBeenCalledWith(expect.objectContaining({
        operationIds: [operationId],
        agents: [{
          agentId: CUSTOM_AGENT_ID,
          agentThreadId: `room:${R1_ID}`,
        }],
      }));
      expect(planExecution).toHaveBeenCalledWith(expect.objectContaining({
        executionId,
        agentId: CUSTOM_AGENT_ID,
      }));
      expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      expect(jobInputFromLastCall(mocks)).toMatchObject({
        message: "Protected direct hello",
        // Transcript causality remains the admitted Human operation. The
        // distinct Agent execution id is held only by the opaque protected
        // turn candidate and must not replace the durable Human turn id.
        turnId: operationId,
        humanAlreadyPersisted: true,
        currentMessageId: 73,
      });
      const createJobCall = mocks.createForegroundJob.mock.calls.at(-1) as
        | unknown[]
        | undefined;
      expect(createJobCall?.[6]).toMatchObject({
        coalescing: "separate",
        contention: "fork",
      });
      expect(createJobCall?.[6]).toHaveProperty("executor");
      const candidate = createJobCall?.[8] as
        | { onMainTurn?: unknown; onIneligible?: unknown }
        | undefined;
      expect(typeof candidate?.onMainTurn).toBe("function");
      expect(typeof candidate?.onIneligible).toBe("function");
      expect(JSON.stringify(createJobCall?.[3])).not.toContain(
        "runtime-session:m298-direct",
      );
    } finally {
      planBytes.fill(0);
      requestBytes.fill(0);
      uninstallProductionLiveShadowMessageComposition(app);
      await app.close();
    }
  });

  test("carries a Full Human-AI-readable direct turn transiently without an ordinary sibling", async () => {
    peerBroadcastHumanMessage.mockClear();
    const sentinel = "FULL_DIRECT_SHARED_TRANSIENT_SENTINEL";
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    eventBus.on(listener as never);
    const mocks = makeTestMocks();
    const detail = r1Detail();
    detail.members = detail.members.map((member) => member.kind === "agent"
      ? { ...member, handle: "fullsharedagent" } : member);
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) => roomId === R1_ID ? detail : null);
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const fullPolicy = Object.freeze({ ...TEST_FALLBACK_POLICY,
      mode: "encrypted_only" as const, shadowBehavior: "strict" as const, revision: 4 });
    const enforceFull: NonNullable<ChatRoutesDeps["enforceStrictShadowBoundary"]> = async (input) => ({
      policy: fullPolicy, result: { disposition: input.state === "verified" ? "protected" : "reject",
        decision: { boundaryId: input.boundaryId, family: "test", operation: "test",
          actorClass: "human", state: input.state, reason: input.reason,
          retryable: input.retryable, policyRevision: 4 } },
    });
    const app = await makeMessagingApp(mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      { currentStrictShadowPolicy: async () => fullPolicy,
        enforceStrictShadowBoundary: enforceFull });
    const operationId = "full-human-ai-direct";
    const executionId = "10000000-0000-4000-8000-000000000299";
    const sessionId = "22222222-3333-4444-8555-666666666666";
    const namespace = "11111111-2222-4333-8444-555555555555";
    const deviceId = "device_full_human_ai_direct";
    const planBytes = fullHumanAiReadablePlan(operationId, sessionId);
    const requestBytes = humanAiReadableRequestBytes(planBytes);
    const protectedMessage = { dtoVersion: 2 as const, projection: { messageId: "73", sessionId,
      roomId: R1_ID, namespaceId: namespace, role: "user" as const,
      createdAt: new Date(1_800_300_000_000).toISOString(), editRevision: 0 },
      protectedPayload: { status: "encrypted" as const,
        cryptoObjectId: `message:live-shadow:v1:${"f".repeat(64)}`, payloadVersion: 2 as const,
        keyClass: "ai" as const, encryptedPayloadBytesBase64url: "BA",
        accessManifestBytesBase64url: "BQ", namespaceEnvelopeBytesBase64url: "Bg" } };
    const published = mock(async () => "published" as const);
    const reserveRuntime = mock(async () => ({ invocationId: "runtime-invocation:full-direct",
      roomId: R1_ID, invokingHumanId: SENDER_ACTOR_ID, invokingDeviceId: deviceId,
      clientActionSessionId: "browser:full-direct", policyRevision: 4,
      inputSetDigest: new Uint8Array(32).fill(0x65), inputs: [{ operationId, messageId: 73 }],
      deadlineAt: Date.now() + 30_000 }));
    const runtimeCapability = { status: "authorized" as const,
      sessionReference: "runtime-session:full-direct",
      authorizationDigest: new Uint8Array(32).fill(0x66), scope: {
        subjectHumanId: SENDER_ACTOR_ID, issuingDeviceId: deviceId,
        recipientKind: "nautilo_foreground_runtime" as const,
        browserSessionId: "browser:full-direct", topLevelRoomId: R1_ID, policyRevision: 4,
        hostAuthorizationRevision: 7, namespaceIds: [namespace],
        grantDomainIds: ["grant-domain:full-direct"],
        domainAuthoritySetDigest: new Uint8Array(32).fill(0x67) } };
    const planInvocation = mock(async () => ({ ...runtimeCapability,
      invocationId: "runtime-invocation:full-direct", deadlineAt: Date.now() + 30_000 }));
    const attachRuntime = mock(async () => ({ invocationId: "runtime-invocation:full-direct",
      executions: [{ executionId, sessionId, agentId: CUSTOM_AGENT_ID }] }));
    const planExecution = mock(async () => ({ ...runtimeCapability, executionId,
      executionKind: "turn" as const, planBytes: new Uint8Array([1]),
      executionDeadlineAt: 1_800_300_300_000 }));
    let runtimeInput: unknown;
    let durableReference: unknown;
    mocks.createForegroundJob.mockImplementation(async (...args: unknown[]) => {
      const input = args[3] as Record<string, unknown>;
      const candidate = args[8] as import("@nautilo/runtime").ForegroundTurnCandidate;
      expect(input["message"]).toBe("");
      durableReference = candidate.durableJobInputReference;
      candidate.onMainTurn(input["turnId"] as string);
      runtimeInput = await candidate.runMainTurn!(input["turnId"] as string,
        async (override) => override?.message);
      return { id: "job-full-direct", virtualJobId: "job-full-direct" };
    });
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(), plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(new Error("not used")),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      admitSharedAgent: async (input) => {
        expect(input).toMatchObject({ operationId, representationMode: "full_encryption" });
        expect(input).not.toHaveProperty("expectedContent");
        expect(input).not.toHaveProperty("ordinaryPayloadBytes");
        return { status: "human_verified", representationMode: "full_encryption", operationId,
          messageId: 73, protectedMessage, protectedMessageDigest: new Uint8Array(32).fill(5),
          senderDeviceSigningPublicKey: new Uint8Array(32).fill(6) };
      },
      recordSharedAgentPublished: published,
      reserveSharedAgentRuntimeInvocation: reserveRuntime,
      planRuntimeInvocationAuthorization: planInvocation,
      attachSharedAgentRuntimeInvocationExecutions: attachRuntime,
      planSharedAgentExecutionAuthorization: planExecution,
      recordFallback: () => Promise.resolve(true), bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(), recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: async (input) => {
        expect(input).toMatchObject({ representationMode: "full_encryption" });
        expect(input).not.toHaveProperty("expectedMergedHumanContent");
        return { status: "executed", value: await input.work(null as never, sentinel) };
      }, shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({ method: "POST", url: `/api/rooms/${R1_ID}/messages`, payload: {
        clientActionSessionId: "browser:full-direct", liveShadow: { requestVersion: 2,
          representationMode: "full_encryption", status: "prepared", operationId,
          authorizationScheme: "human_ai_readable_v1",
          planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          signedRequestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
          encryptedPayloadBytesBase64url: "BA", accessManifestBytesBase64url: "BQ",
          namespaceEnvelopeBytesBase64url: "Bg" },
      } });
      expect(response.statusCode).toBe(202);
      expect(runtimeInput).toBe(sentinel);
      expect(durableReference).toEqual({ kind: "full_encryption_foreground_operation_v1",
        operationId: executionId, policyRevision: 4, roomId: R1_ID });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(published).toHaveBeenCalledTimes(1);
      expect(attachRuntime).toHaveBeenCalledWith(expect.objectContaining({ agents: [{
        agentId: CUSTOM_AGENT_ID, agentThreadId: `room:${R1_ID}` }] }));
      expect(shouldFireLLMTurn).not.toHaveBeenCalled();
      const fullEvent = events.find((event) => (event as { operationId?: string }).operationId === operationId);
      expect(fullEvent).toMatchObject({ wireVersion: 2, type: "message.shared_agent_shadow", operationId });
      expect(fullEvent).not.toHaveProperty("ordinaryPayloadBytesBase64url");
      const responseBody: unknown = response.json();
      expect(JSON.stringify({ response: responseBody, event: fullEvent,
        durableReference, jobInput: jobInputFromLastCall(mocks) })).not.toContain(sentinel);
    } finally {
      eventBus.off(listener as never); planBytes.fill(0); requestBytes.fill(0);
      uninstallProductionLiveShadowMessageComposition(app); await app.close();
    }
  });

  test("replays a durably job-bound live Shadow send without a second Agent run", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const operationId = "live-shadow:m282:response-loss";
    const jobId = "00000000-0000-4000-8000-000000000099";
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(),
      plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.resolve({
        status: "human_replayed",
        operationId,
        messageId: 41,
        content: "already accepted",
        jobId,
        protectedMessage: {
          dtoVersion: 2,
          projection: {
            messageId: "41",
            sessionId: "00000000-0000-4000-8000-000000000010",
            roomId: R1_ID,
            namespaceId: "00000000-0000-4000-8000-000000000011",
            role: "user",
            createdAt: "2027-01-15T08:00:00.000Z",
            editRevision: 0,
          },
          protectedPayload: {
            status: "encrypted",
            cryptoObjectId: "message:live-shadow:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            payloadVersion: 2,
            keyClass: "ai",
            encryptedPayloadBytesBase64url: "AQ",
            accessManifestBytesBase64url: "Ag",
            namespaceEnvelopeBytesBase64url: "Aw",
          },
        },
      }),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("must not run")),
      shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          content: "already accepted",
          clientActionSessionId: "browser:m282",
          liveShadow: {
            requestVersion: 1,
            status: "prepared",
            operationId,
            planBytesBase64url: "AQ",
            signedRequestBytesBase64url: "Ag",
            ordinaryPayloadBytesBase64url: "Aw",
            encryptedPayloadBytesBase64url: "BA",
            accessManifestBytesBase64url: "BQ",
            namespaceEnvelopeBytesBase64url: "Bg",
            grantBytesBase64url: "Bw",
          },
        },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        accepted: true,
        jobId,
        liveShadow: { status: "human_verified", operationId },
      });
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
      await app.close();
    }
  });

  test("replays a canonical Full V4 1H1A receipt without ordinary input or a second Agent run", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) => roomId === R1_ID ? r1Detail() : null);
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` });
    const operationId = "full-v4-response-loss";
    const sessionId = "00000000-0000-4000-8000-000000000010";
    const planBytes = fullForegroundPlan(operationId, sessionId);
    const admitPrepared = mock(async (input) => {
      expect(input).toMatchObject({ operationId, representationMode: "full_encryption" });
      expect(input).not.toHaveProperty("ordinaryPayloadBytes");
      expect(input).not.toHaveProperty("expectedContent");
      return {
        status: "human_replayed" as const, operationId, messageId: 41,
        content: "opened only after admission", jobId: "00000000-0000-4000-8000-000000000099",
        protectedMessage: { dtoVersion: 2 as const, projection: { messageId: "41", sessionId,
          roomId: R1_ID, namespaceId: "11111111-2222-4333-8444-555555555555", role: "user" as const,
          createdAt: new Date(1_800_300_000_000).toISOString(), editRevision: 0 },
          protectedPayload: { status: "encrypted" as const, cryptoObjectId: `message:live-shadow:v1:${"a".repeat(64)}`,
            payloadVersion: 2 as const, keyClass: "ai" as const, encryptedPayloadBytesBase64url: "BA",
            accessManifestBytesBase64url: "BQ", namespaceEnvelopeBytesBase64url: "Bg" } },
      };
    });
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(), plan: () => Promise.reject(new Error("not used")),
      admitPrepared, admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      recordFallback: () => Promise.resolve(true), bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(), recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("must not run")), shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({ method: "POST", url: `/api/rooms/${R1_ID}/messages`, payload: {
        clientActionSessionId: "browser:full-v4", liveShadow: { requestVersion: 2, status: "prepared",
          representationMode: "full_encryption", operationId, planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          signedRequestBytesBase64url: "Ag", encryptedPayloadBytesBase64url: "BA",
          accessManifestBytesBase64url: "BQ", namespaceEnvelopeBytesBase64url: "Bg", grantBytesBase64url: "Bw" },
      } });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, jobId: "00000000-0000-4000-8000-000000000099",
        liveShadow: { status: "human_verified", operationId } });
      expect(admitPrepared).toHaveBeenCalledTimes(1);
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally { planBytes.fill(0); uninstallProductionLiveShadowMessageComposition(app); await app.close(); }
  });

  test("queues a first Full V4 turn with transient runtime text and a content-free durable reference", async () => {
    maybeResumeAwaitingTask.mockClear();
    hasAwaitingTaskReply.mockClear();
    const sentinel = "FULL_FIRST_TURN_TRANSIENT_SENTINEL";
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    eventBus.on(listener as never);
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const mocks = makeTestMocks();
    // Real enrolled Agents have handles. The previous handle-less fixture
    // skipped mention parsing and hid a crash on protected-only input.
    const fullDetail = r1Detail();
    fullDetail.members = fullDetail.members.map((member) => member.kind === "agent"
      ? { ...member, handle: "fullqaagent" } : member);
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) => roomId === R1_ID ? fullDetail : null);
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    let runtimeInput: unknown;
    let durableReference: unknown;
    mocks.createForegroundJob.mockImplementation(async (...args: unknown[]) => {
      const input = args[3] as Record<string, unknown>;
      const candidate = args[8] as import("@nautilo/runtime").ForegroundTurnCandidate;
      expect(input["message"]).toBe(sentinel);
      durableReference = candidate.durableJobInputReference;
      candidate.onMainTurn(input["turnId"] as string);
      runtimeInput = await candidate.runMainTurn!(input["turnId"] as string,
        async (override) => override?.message);
      return { id: "job-full-first", virtualJobId: "job-full-first" };
    });
    const fullPolicy = Object.freeze({ ...TEST_FALLBACK_POLICY,
      mode: "encrypted_only" as const, shadowBehavior: "strict" as const, revision: 4 });
    const enforceFull: NonNullable<ChatRoutesDeps["enforceStrictShadowBoundary"]> = async (input) => ({
      policy: fullPolicy, result: { disposition: input.state === "verified" ? "protected" : "reject",
        decision: { boundaryId: input.boundaryId, family: "test", operation: "test",
          actorClass: "human", state: input.state, reason: input.reason,
          retryable: input.retryable, policyRevision: 4 } },
    });
    const app = await makeMessagingApp(mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      { currentStrictShadowPolicy: async () => fullPolicy,
        enforceStrictShadowBoundary: enforceFull });
    const operationId = "full-v4-first-turn";
    const sessionId = "00000000-0000-4000-8000-000000000011";
    const planBytes = fullForegroundPlan(operationId, sessionId);
    const capability = { kind: "foreground_session" as const, sessionReference: "full-first-session",
      authorizationDigest: new Uint8Array(32).fill(4), scope: {
        subjectHumanId: SENDER_ACTOR_ID, issuingDeviceId: "device_full_route",
        recipientAgentId: CUSTOM_AGENT_ID, sessionId, roomId: R1_ID, policyRevision: 4,
        hostAuthorizationRevision: 7, agentAuthorizationRevision: 5,
        namespaceIds: ["11111111-2222-4333-8444-555555555555"], grantDomainIds: ["grant_full_route"],
        domainAuthoritySetDigest: new Uint8Array(32).fill(5),
      } };
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(), plan: () => Promise.reject(new Error("not used")),
      admitPrepared: async () => ({ status: "human_verified", operationId, messageId: 41, content: sentinel,
        capability, protectedMessage: { dtoVersion: 2, projection: { messageId: "41", sessionId,
          roomId: R1_ID, namespaceId: "11111111-2222-4333-8444-555555555555", role: "user",
          createdAt: new Date(1_800_300_000_000).toISOString(), editRevision: 0 },
          protectedPayload: { status: "encrypted", cryptoObjectId: `message:live-shadow:v1:${"e".repeat(64)}`,
            payloadVersion: 2, keyClass: "ai", encryptedPayloadBytesBase64url: "BA",
            accessManifestBytesBase64url: "BQ", namespaceEnvelopeBytesBase64url: "Bg" } } }),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      recordFallback: () => Promise.resolve(true), bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(), recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: async (input) => ({ status: "executed", value: await input.work(null as never, sentinel) }),
      shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({ method: "POST", url: `/api/rooms/${R1_ID}/messages`, payload: {
        clientActionSessionId: "browser:full-first", liveShadow: { requestVersion: 2,
          representationMode: "full_encryption", status: "prepared", operationId,
          planBytesBase64url: Buffer.from(planBytes).toString("base64url"), signedRequestBytesBase64url: "Ag",
          encryptedPayloadBytesBase64url: "BA", accessManifestBytesBase64url: "BQ",
          namespaceEnvelopeBytesBase64url: "Bg", grantBytesBase64url: "Bw" },
      } });
      expect(response.statusCode).toBe(202);
      expect(runtimeInput).toBe(sentinel);
      expect(durableReference).toEqual({ kind: "full_encryption_foreground_operation_v1",
        operationId, policyRevision: 4, roomId: R1_ID });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(maybeResumeAwaitingTask).not.toHaveBeenCalled();
      expect(hasAwaitingTaskReply).not.toHaveBeenCalled();
      expect(JSON.stringify({ events, logs: logSpy.mock.calls, errors: errorSpy.mock.calls })).not.toContain(sentinel);
    } finally {
      eventBus.off(listener as never); logSpy.mockRestore(); errorSpy.mockRestore(); planBytes.fill(0);
      uninstallProductionLiveShadowMessageComposition(app); await app.close();
    }
  });

  test("accepts a canonical Full Human-AI-readable group message without ordinary publication", async () => {
    peerBroadcastHumanMessage.mockClear();
    finalizeProtectedHumanPeerMessage.mockClear();
    const group = { ...r1Detail(), members: [...r1Detail().members, {
      actorId: "b7777777-1111-4111-8111-111111111111", kind: "agent" as const,
      displayName: "Second Agent", handle: "secondqaagent", agentId: "b8888888-1111-4111-8111-111111111111",
      agentOwnerUserId: AGENT_OWNER_USER_ID, roomRole: "member" as const,
    }] };
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) => roomId === R1_ID ? group : null);
    const app = await makeMessagingApp(mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` });
    const operationId = "full-human-ai-group";
    const sessionId = "22222222-3333-4444-8555-666666666666";
    const planBytes = fullHumanAiReadablePlan(operationId, sessionId);
    const requestBytes = humanAiReadableRequestBytes(planBytes);
    const published = mock(async () => "published" as const);
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(), plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(new Error("not used")),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      admitSharedAgent: async (input) => {
        expect(input).toMatchObject({ operationId, representationMode: "full_encryption" });
        expect(input).not.toHaveProperty("expectedContent");
        expect(input).not.toHaveProperty("ordinaryPayloadBytes");
        return { status: "human_verified", representationMode: "full_encryption", operationId,
          messageId: 73, protectedMessage: { dtoVersion: 2, projection: { messageId: "73", sessionId,
            roomId: R1_ID, namespaceId: "11111111-2222-4333-8444-555555555555", role: "user",
            createdAt: new Date(1_800_300_000_000).toISOString(), editRevision: 0 },
            protectedPayload: { status: "encrypted", cryptoObjectId: `message:live-shadow:v1:${"d".repeat(64)}`,
              payloadVersion: 2, keyClass: "ai", encryptedPayloadBytesBase64url: "BA",
              accessManifestBytesBase64url: "BQ", namespaceEnvelopeBytesBase64url: "Bg" } },
          protectedMessageDigest: new Uint8Array(32).fill(5),
          senderDeviceSigningPublicKey: new Uint8Array(32).fill(6) };
      },
      recordSharedAgentPublished: published, recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true), runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("must not run")), shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({ method: "POST", url: `/api/rooms/${R1_ID}/messages`, payload: {
        clientActionSessionId: "browser:full-group", liveShadow: { requestVersion: 2,
          representationMode: "full_encryption", status: "prepared", operationId,
          authorizationScheme: "human_ai_readable_v1",
          planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          signedRequestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
          encryptedPayloadBytesBase64url: "BA", accessManifestBytesBase64url: "BQ",
          namespaceEnvelopeBytesBase64url: "Bg" },
      } });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true,
        liveShadow: { status: "human_verified", operationId } });
      expect(finalizeProtectedHumanPeerMessage).toHaveBeenCalledTimes(1);
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(published).toHaveBeenCalledTimes(1);
    } finally {
      planBytes.fill(0); requestBytes.fill(0);
      uninstallProductionLiveShadowMessageComposition(app); await app.close();
    }
  });

  test("uses signed everyone intent to keep a Full strict-DM send out of the direct wake path", async () => {
    peerBroadcastHumanMessage.mockClear();
    finalizeProtectedHumanPeerMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const operationId = "full-human-ai-everyone-dm";
    const sessionId = "22222222-3333-4444-8555-666666666666";
    const namespace = "11111111-2222-4333-8444-555555555555";
    const planBytes = fullHumanAiReadablePlan(operationId, sessionId, true);
    const requestBytes = humanAiReadableRequestBytes(planBytes);
    const protectedMessage = {
      dtoVersion: 2 as const,
      projection: {
        messageId: "73", sessionId, roomId: R1_ID, namespaceId: namespace,
        role: "user" as const,
        createdAt: new Date(1_800_300_000_000).toISOString(), editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted" as const,
        cryptoObjectId: `message:live-shadow:v1:${"c".repeat(64)}`,
        payloadVersion: 2 as const, keyClass: "ai" as const,
        encryptedPayloadBytesBase64url: "BA",
        accessManifestBytesBase64url: "BQ",
        namespaceEnvelopeBytesBase64url: "Bg",
      },
    };
    installProductionLiveShadowMessageComposition(app, {
      recipients: new LiveShadowRecipientRegistry(),
      plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(new Error("not used")),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      admitSharedAgent: async () => ({
        status: "human_verified" as const,
        representationMode: "full_encryption" as const,
        operationId,
        messageId: 73,
        mentionEveryone: true as const,
        protectedMessage,
        protectedMessageDigest: new Uint8Array(32).fill(5),
        senderDeviceSigningPublicKey: new Uint8Array(32).fill(6),
      }),
      recordSharedAgentPublished: async () => "published" as const,
      recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("must not run")),
      shutdown: () => Promise.resolve(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          clientActionSessionId: "browser:full-everyone-dm",
          liveShadow: {
            requestVersion: 2,
            representationMode: "full_encryption",
            status: "prepared",
            operationId,
            authorizationScheme: "human_ai_readable_v1",
            planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
            signedRequestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
            encryptedPayloadBytesBase64url: "BA",
            accessManifestBytesBase64url: "BQ",
            namespaceEnvelopeBytesBase64url: "Bg",
          },
        },
      });
      expect(response.statusCode).toBe(202);
      expect(finalizeProtectedHumanPeerMessage).toHaveBeenCalledTimes(1);
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
    } finally {
      planBytes.fill(0);
      requestBytes.fill(0);
      uninstallProductionLiveShadowMessageComposition(app);
      await app.close();
    }
  });

  test.each([
    { full: false, outerMentionEveryone: undefined, version: 1 as const },
    { full: false, outerMentionEveryone: false, version: 1 as const },
    { full: true, outerMentionEveryone: undefined, version: 1 as const },
    { full: true, outerMentionEveryone: false, version: 2 as const },
  ])(
    "rechecks manage_rooms for signed AI-readable everyone intent: %j",
    async ({ full, outerMentionEveryone, version }) => {
      manageRoomsCapabilityEnabled = false;
      peerBroadcastHumanMessage.mockClear();
      finalizeProtectedHumanPeerMessage.mockClear();
      const mocks = makeTestMocks();
      mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
        roomId === R1_ID ? r1Detail() : null,
      );
      const app = await makeMessagingApp(
        mocks,
        { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
        { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      );
      const operationId = `ai-everyone-denied-${String(full)}-${version}-${String(outerMentionEveryone)}`;
      const pair = version === 2
        ? fullHumanAiReadableV2Pair(operationId)
        : (() => {
            const planBytes = fullHumanAiReadablePlan(operationId,
              "22222222-3333-4444-8555-666666666666", true);
            return { planBytes, requestBytes: humanAiReadableRequestBytes(planBytes) };
          })();
      const { planBytes, requestBytes } = pair;
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/rooms/${R1_ID}/messages`,
          payload: {
            ...(full ? {} : { content: "Protected everyone" }),
            ...(outerMentionEveryone === undefined
              ? {} : { mentionEveryone: outerMentionEveryone }),
            clientActionSessionId: "browser:full-everyone-denied",
            liveShadow: {
              requestVersion: full ? 2 : 1,
              ...(full
                ? { representationMode: "full_encryption" }
                : { ordinaryPayloadBytesBase64url: "Aw" }),
              status: "prepared",
              operationId,
              authorizationScheme: version === 2
                ? "human_ai_readable_v2" : "human_ai_readable_v1",
              planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
              signedRequestBytesBase64url: Buffer.from(requestBytes).toString("base64url"),
              encryptedPayloadBytesBase64url: "BA",
              accessManifestBytesBase64url: "BQ",
              namespaceEnvelopeBytesBase64url: "Bg",
            },
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: "manage_rooms_required",
          capability: "manage_rooms",
        });
        expect(finalizeProtectedHumanPeerMessage).not.toHaveBeenCalled();
        expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
        expect(mocks.createForegroundJob).not.toHaveBeenCalled();
      } finally {
        planBytes.fill(0);
        requestBytes.fill(0);
        manageRoomsCapabilityEnabled = true;
        await app.close();
      }
    },
  );

  test.each([
    { full: false, outerMentionEveryone: undefined },
    { full: false, outerMentionEveryone: false },
    { full: false, outerMentionEveryone: undefined, mismatchedRoom: true },
    { full: true, outerMentionEveryone: undefined },
    { full: true, outerMentionEveryone: false },
  ])(
    "rejects signed Human-peer everyone intent without manage_rooms before protected admission: %j",
    async ({ full, outerMentionEveryone, mismatchedRoom }) => {
      manageRoomsCapabilityEnabled = false;
      peerBroadcastHumanMessage.mockClear();
      finalizeProtectedHumanPeerMessage.mockClear();
      const mocks = makeTestMocks();
      mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
        roomId === R1_ID ? humanOnlyRoomDetail() : null,
      );
      const app = await makeMessagingApp(
        mocks,
        { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
        { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
      );
      const operationId = `peer-everyone-denied-${String(full)}`;
      const planBytes = humanPeerPlan(
        operationId,
        true,
        mismatchedRoom ? DEFAULT_ROOM_ID : R1_ID,
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/rooms/${R1_ID}/messages`,
          payload: {
            ...(full ? {} : { content: "Protected everyone" }),
            ...(outerMentionEveryone === undefined
              ? {} : { mentionEveryone: outerMentionEveryone }),
            clientActionSessionId: "browser:peer-everyone-denied",
            liveShadow: {
              requestVersion: full ? 2 : 1,
              ...(full
                ? { representationMode: "full_encryption" }
                : { ordinaryPayloadBytesBase64url: "Aw" }),
              status: "prepared",
              operationId,
              authorizationScheme: "human_peer_v1",
              planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
              signedRequestBytesBase64url: "Ag",
              encryptedPayloadBytesBase64url: "BA",
              accessManifestBytesBase64url: "BQ",
              namespaceEnvelopeBytesBase64url: "Bg",
            },
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: "manage_rooms_required",
          capability: "manage_rooms",
        });
        expect(finalizeProtectedHumanPeerMessage).not.toHaveBeenCalled();
        expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
        expect(mocks.createForegroundJob).not.toHaveBeenCalled();
      } finally {
        planBytes.fill(0);
        manageRoomsCapabilityEnabled = true;
        await app.close();
      }
    },
  );

  test("keeps one ordinary Agent run when unexpected live Shadow admission fails", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async () => r1Roster());
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    const recipients = new LiveShadowRecipientRegistry();
    installProductionLiveShadowMessageComposition(app, {
      recipients,
      plan: () => Promise.reject(new Error("not used")),
      admitPrepared: () => Promise.reject(
        new Error("restricted crypto database unavailable"),
      ),
      admitHumanPeer: () => Promise.reject(new Error("not used")),
      recordHumanPeerPublished: () => Promise.reject(new Error("not used")),
      recordHumanPeerFallback: () => Promise.reject(new Error("not used")),
      acknowledgeHumanPeer: () => Promise.reject(new Error("not used")),
      planHumanPeerAcknowledgement: () => Promise.reject(new Error("not used")),
      recordFallback: () => Promise.resolve(true),
      bindJob: () => Promise.resolve(true),
      runDispatchOnce: (input) => input.work(),
      recover: () => Promise.resolve({ status: "absent" }),
      verifyClient: () => Promise.reject(new Error("not used")),
      runAgentTurn: () => Promise.reject(new Error("not used")),
      shutdown: () => Promise.resolve(),
    } satisfies ProductionLiveShadowMessageComposition);
    try {
      const encoded = "AQ";
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: {
          content: "ordinary survives",
          clientActionSessionId: "browser:m282",
          liveShadow: {
            requestVersion: 1,
            status: "prepared",
            operationId: "live-shadow:m282:admission-failure",
            planBytesBase64url: encoded,
            signedRequestBytesBase64url: encoded,
            ordinaryPayloadBytesBase64url: encoded,
            encryptedPayloadBytesBase64url: encoded,
            accessManifestBytesBase64url: encoded,
            namespaceEnvelopeBytesBase64url: encoded,
            grantBytesBase64url: encoded,
          },
        },
      });
      expect(res.statusCode).toBe(202);
      expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      expect(jobInputFromLastCall(mocks)["message"]).toBe("ordinary survives");
      expect(JSON.parse(res.body) as unknown).toMatchObject({
        liveShadow: {
          status: "ordinary_fallback",
          reason: "protected_open_failed",
        },
      });
    } finally {
      uninstallProductionLiveShadowMessageComposition(app);
      recipients.shutdown();
      await app.close();
    }
  });

  test("keeps a validated Advanced video workcard continuation durable but machine-presented", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const content = "Continue the Advanced Seedance reference-to-video brief from the workcard and request its exact quote now.";
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        headers: { "content-type": "application/json" },
        payload: {
          content,
          cardContinuation: "advanced_video",
          focusedResources: [
            { kind: "workspace-artifact", artifactId: "reference-1" },
            { kind: "workspace-artifact", artifactId: "reference-2" },
          ],
        },
      });
      expect(res.statusCode).toBe(202);
      const input = jobInputFromLastCall(mocks);
      expect(input["message"]).toBe(content);
      expect(input["metadata"]).toEqual({
        originatedBy: "advanced_video_workcard",
        kind: "advanced_video",
        referenceCount: 2,
      });
    } finally {
      await app.close();
    }
  });

  test("rejects a forged Advanced video presentation marker without exact focused references", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        headers: { "content-type": "application/json" },
        payload: {
          content: "anything I want to hide",
          cardContinuation: "advanced_video",
          focusedResources: [],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test("M254 denies an incapable Human's strict Agent DM before persistence", async () => {
    invocationCapabilityEnabled = false;
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "wake the agent" },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: "invoke_agents_required",
        code: "invoke_agents_required",
        capability: "invoke_agents",
      });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      invocationCapabilityEnabled = true;
      await app.close();
    }
  });

  test("M254 persists a strict-DM awaiting Task reply before its gated resume hook", async () => {
    invocationCapabilityEnabled = false;
    hasAwaitingTaskReply.mockImplementation(async () => true);
    maybeResumeAwaitingTask.mockClear();
    peerBroadcastHumanMessage.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "Here is the requested answer" },
      });
      expect(res.statusCode).toBe(201);
      expect(peerBroadcastHumanMessage).toHaveBeenCalledTimes(1);
      expect(maybeResumeAwaitingTask).toHaveBeenCalledWith(
        R1_ID,
        SENDER_USER_ID,
        "Here is the requested answer",
      );
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      invocationCapabilityEnabled = true;
      hasAwaitingTaskReply.mockImplementation(async () => false);
      await app.close();
    }
  });

  test("M254 persists incapable ordinary mixed-Room text without maintenance or Agent work", async () => {
    invocationCapabilityEnabled = false;
    peerBroadcastHumanMessage.mockClear();
    const maintenanceCalls: string[] = [];
    setMaintenanceGate({
      async assertAcceptingNewWork() {
        maintenanceCalls.push("checked");
        throw new MaintenanceDrainError("draining");
      },
      async isAcceptingWork() {
        return false;
      },
    });
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? mixedRoomDetail() : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "hello, humans" },
      });
      expect(res.statusCode).toBe(201);
      expect(peerBroadcastHumanMessage).toHaveBeenCalledTimes(1);
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
      expect(maintenanceCalls).toEqual([]);
    } finally {
      invocationCapabilityEnabled = true;
      setMaintenanceGate(permissiveMaintenanceGate);
      await app.close();
    }
  });

  test("M254 denies an incapable explicit Agent mention in a mixed Room", async () => {
    invocationCapabilityEnabled = false;
    peerBroadcastHumanMessage.mockClear();
    const detail = mixedRoomDetail();
    const members = detail.members.map((member) =>
      member.kind === "agent" ? { ...member, handle: "helper" } : member,
    );
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? { ...detail, members } : null,
    );
    const app = await makeMessagingApp(
      mocks,
      { ownerId: SENDER_USER_ID, agentId: CUSTOM_AGENT_ID, roomId: R1_ID },
      { actorRole: "guest", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        payload: { content: "@helper please answer" },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "invoke_agents_required",
        capability: "invoke_agents",
      });
      expect(peerBroadcastHumanMessage).not.toHaveBeenCalled();
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      invocationCapabilityEnabled = true;
      await app.close();
    }
  });

  test("D420 rejects group executable work before persisting its human message", async () => {
    const drainingGate: MaintenanceGate = {
      async assertAcceptingNewWork() {
        throw new MaintenanceDrainError("draining");
      },
      async isAcceptingWork() {
        return false;
      },
    };
    setMaintenanceGate(drainingGate);
    const mocks = makeTestMocks();
    const groupDetail = {
      ...r1Detail(),
      members: [
        ...r1Detail().members,
        {
          actorId: "b7777777-1111-4111-8111-111111111111",
          kind: "agent" as const,
          displayName: "Second Agent",
          agentId: "b8888888-1111-4111-8111-111111111111",
          agentOwnerUserId: AGENT_OWNER_USER_ID,
          roomRole: "member" as const,
        },
      ],
    };
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? groupDetail : null,
    );
    const app = await makeMessagingApp(
      mocks,
      {
        ownerId: SENDER_USER_ID,
        agentId: BOOTSTRAP_AGENT_ID,
        roomId: R1_ID,
      },
      { actorRole: "owner", laneKey: `room:${R1_ID}`, graphThreadId: `room:${R1_ID}` },
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        headers: { "content-type": "application/json" },
        payload: { content: "do not persist" },
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({
        code: "maintenance_draining",
        retryable: true,
        maintenanceState: "draining",
      });
      expect(mocks.createForegroundJob).not.toHaveBeenCalled();
    } finally {
      setMaintenanceGate(permissiveMaintenanceGate);
      await app.close();
    }
  });

  test("B1 fix — canonical room agent strips unverified client Relay characterization", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Detail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async (roomId) =>
      roomId === R1_ID ? r1Roster() : [],
    );

    const app = await makeMessagingApp(
      mocks,
      {
        ownerId: SENDER_USER_ID,
        agentId: BOOTSTRAP_AGENT_ID,
        roomId: DEFAULT_ROOM_ID,
      },
      { actorRole: "owner", laneKey: "app:default", graphThreadId: "app:default" },
    );

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        headers: { "content-type": "application/json" },
        payload: { content: "hi", currentFolderRelayId: "relay-canonical" },
      });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toMatchObject({ jobId: "job-b1-test" });
      expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      expect(mocks.loadRoomRoster).toHaveBeenCalledWith(R1_ID);
      // M155 — the turn's authorization envelope is built from the HUMAN
      // sender's actor (not the agent actor, which has no capability subject
      // and would collapse the tool policy to guest). The responding agent's
      // identity still flows through the `agentId` param (CUSTOM_AGENT_ID).
      expect(mocks.buildEnvelopeForRoom).toHaveBeenCalledWith(
        SENDER_ACTOR_ID,
        `room:${R1_ID}`,
        CUSTOM_AGENT_ID,
        R1_ID,
      );
      expect(jobLaneKeyFromLastCall(mocks)).toBe(`room:${R1_ID}`);

      const input = jobInputFromLastCall(mocks);
      const createJobCall = mocks.createForegroundJob.mock.calls.at(-1) as unknown[] | undefined;
      // M155 — ownerId is the human sender again (envelope built from the
      // human actor), so transcriptOwnerId is a harmless no-op equal to it.
      expect(createJobCall?.[0]).toBe(SENDER_USER_ID);
      expect(createJobCall?.[1]).toBe(SENDER_USER_ID);
      expect(input["ownerId"]).toBe(SENDER_USER_ID);
      expect(input["requestorId"]).toBe(SENDER_USER_ID);
      expect(input["transcriptOwnerId"]).toBe(SENDER_USER_ID);
      expect(input["roomId"]).toBe(R1_ID);
      expect(input["roomId"]).not.toBe(DEFAULT_ROOM_ID);
      expect(input["agentId"]).toBe(CUSTOM_AGENT_ID);
      expect(input["agentId"]).not.toBe(BOOTSTRAP_AGENT_ID);
      expect(input["graphThreadId"]).toBe(`room:${R1_ID}`);
      // No verified Electron-main origin: the explicit renderer field is
      // removed rather than retained as authority or a routing hint.
      expect(input["currentFolderRelayId"]).toBe("");
      expect(input["memoryAccessEnvelope"]).toMatchObject({
        agentId: CUSTOM_AGENT_ID,
        roomId: R1_ID,
        writableNamespaces: [`writable:${R1_ID}`],
      });
      expect(input["memoryAccessEnvelope"]).not.toMatchObject({
        roomId: DEFAULT_ROOM_ID,
      });

      const roster = input["roomRoster"] as RoomParticipant[];
      expect(roster).toHaveLength(2);
      expect(roster.some((m) => m.kind === "agent" && m.agentId === CUSTOM_AGENT_ID)).toBe(true);
      expect(roster.some((m) => m.kind === "user" && m.userId === SENDER_USER_ID)).toBe(true);

      setRelayRegistry({
        getUserId: (relayId: string) =>
          relayId === "relay-canonical" ? SENDER_USER_ID : null,
      } as never);
      const forgedRelayRes = await app.inject({
        method: "POST",
        url: `/api/rooms/${R1_ID}/messages`,
        headers: {
          "content-type": "application/json",
          "user-agent": "Electron/41.2.1",
          "x-nautilo-client-surface": "electron",
        },
        payload: {
          content: "client body selects a same-owner host",
          currentFolderRelayId: "relay-canonical",
        },
      });
      expect(forgedRelayRes.statusCode).toBe(202);
      // User-agent text and a same-owner Relay field are not Electron-main
      // origin. The ordinary turn remains valid conversation, but local path
      // context is stripped before the Job can discover or dispatch a host.
      expect(jobInputFromLastCall(mocks)["currentFolderRelayId"]).toBe("");
      expect(jobInputFromLastCall(mocks)["securityAuditUserAgent"]).toBe(
        "Electron/41.2.1",
      );
    } finally {
      setRelayRegistry(null);
      await app.close();
    }
  });

  test("D426 direct one-to-one subthread forwards its existing child-room persistence id", async () => {
    shouldFireLLMTurn.mockClear();
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === DIRECT_SUBTHREAD_ROOM_ID ? directSubthreadDetail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async (roomId) =>
      roomId === DIRECT_SUBTHREAD_ROOM_ID ? r1Roster() : [],
    );
    const app = await makeMessagingApp(
      mocks,
      {
        ownerId: SENDER_USER_ID,
        agentId: BOOTSTRAP_AGENT_ID,
        roomId: DEFAULT_ROOM_ID,
      },
      { actorRole: "owner", laneKey: "app:default", graphThreadId: "app:default" },
    );

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${DIRECT_SUBTHREAD_ROOM_ID}/messages`,
        headers: { "content-type": "application/json" },
        payload: { content: "continue the thread" },
      });

      expect(res.statusCode).toBe(202);
      expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      expect(shouldFireLLMTurn).not.toHaveBeenCalled();
      const input = jobInputFromLastCall(mocks);
      expect(input).toMatchObject({
        roomId: DIRECT_SUBTHREAD_ROOM_ID,
        graphThreadId: `room:${DIRECT_SUBTHREAD_ROOM_ID}`,
        agentId: CUSTOM_AGENT_ID,
        subthreadRoomId: DIRECT_SUBTHREAD_ROOM_ID,
        subthreadParentRoomId: SUBTHREAD_PARENT_ROOM_ID,
        subthreadAnchorMessageId: SUBTHREAD_ANCHOR_MESSAGE_ID,
      });
    } finally {
      await app.close();
    }
  });

  test("default Genie room with agreeing envelope keeps bootstrap agent id", async () => {
    const mocks = makeTestMocks();
    mocks.getRoomDetailForMember.mockImplementation(async (roomId) =>
      roomId === DEFAULT_ROOM_ID ? defaultGenieDetail() : null,
    );
    mocks.loadRoomRoster.mockImplementation(async (roomId) =>
      roomId === DEFAULT_ROOM_ID
        ? [
            {
              actorId: SENDER_ACTOR_ID,
              kind: "user",
              displayName: "Sender",
              userId: SENDER_USER_ID,
              roomRole: "admin",
            },
            {
              actorId: "99999999-9999-4999-8999-999999999999",
              kind: "agent",
              displayName: "Genie",
              agentId: BOOTSTRAP_AGENT_ID,
              roomRole: "member",
            },
          ]
        : [],
    );

    const app = await makeMessagingApp(
      mocks,
      {
        ownerId: SENDER_USER_ID,
        agentId: BOOTSTRAP_AGENT_ID,
        roomId: DEFAULT_ROOM_ID,
      },
      { actorRole: "owner", laneKey: "app:default", graphThreadId: "app:default" },
    );

    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/rooms/${DEFAULT_ROOM_ID}/messages`,
        headers: { "content-type": "application/json" },
        payload: { content: "hi genie" },
      });

      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toMatchObject({ jobId: "job-b1-test" });
      expect(mocks.createForegroundJob).toHaveBeenCalledTimes(1);
      expect(jobLaneKeyFromLastCall(mocks)).toBe(`room:${DEFAULT_ROOM_ID}`);

      const input = jobInputFromLastCall(mocks);
      expect(input["roomId"]).toBe(DEFAULT_ROOM_ID);
      expect(input["agentId"]).toBe(BOOTSTRAP_AGENT_ID);
      expect(input["graphThreadId"]).toBe("app:default");
      expect(input["memoryAccessEnvelope"]).toMatchObject({
        agentId: BOOTSTRAP_AGENT_ID,
        roomId: DEFAULT_ROOM_ID,
      });
    } finally {
      await app.close();
    }
  });
});
