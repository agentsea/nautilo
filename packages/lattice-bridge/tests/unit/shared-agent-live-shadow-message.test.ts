import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareDeviceWrappedAgentLiveShadowStreamStart,
  sealDeviceWrappedAgentLiveShadowStreamFrame,
  sharedAgentLiveShadowExecutionInputSetDigest,
  unixTimestamp,
  verifySharedAgentLiveShadowAcknowledgement,
  wrapObjectDekForNamespace,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  encodeLiveShadowMessagePlanV4,
  encodeNamespaceObjectEnvelopeV2,
  encodeSharedAgentLiveShadowMessagePlanV1,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { parseProtectedMessageDtoV2 } from "@nautilo/types";

import {
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
} from "../../src/client-vault/profile-v3.ts";
import {
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
} from "../../src/client-vault/profile-v4.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
  InterruptedClientProfileResolution,
  StageClientProfileInput,
} from "../../src/client-vault/types.ts";
import type {
  NamespaceAuthorityClient,
  NamespaceGenerationAuthority,
  OpenedNamespaceGeneration,
} from "../../src/client/message/namespace-authority-client.ts";
import {
  createVaultSharedAgentLiveShadowMessageReceiver,
} from "../../src/client/message/vault-shared-agent-live-shadow-message-receiver.ts";
import {
  createVaultSharedAgentOutputLiveShadowReceiver,
} from "../../src/client/message/vault-shared-agent-output-live-shadow-receiver.ts";
import {
  prepareVaultSharedAgentLiveShadowMessage,
} from "../../src/client/message/vault-shared-agent-live-shadow-message.ts";
import {
  fullEncryptionDurableEventDigestV2,
  liveShadowDurableEventDigestV1,
} from "../../src/message/live-shadow-realtime-evidence.ts";
import {
  prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek,
} from "../../src/message/agent-conversation-crypto.ts";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from
  "../../src/message/conversation-repository.ts";
import { encodeMessagePayloadV2 } from
  "../../src/message/message-payload-v2.ts";
import { readPreparedConversationCryptoRevisionSnapshot } from
  "../../src/message/conversation-prepared-revision.ts";
import { PROTECTED_TOP_LEVEL_ROOM_KINDS } from
  "../../src/message/protected-room-topology.ts";
import {
  createDormantConversationShadowRepository,
} from "../../src/message/conversation-shadow-saga.ts";
import {
  admitAndPersistSharedAgentLiveShadowMessage,
} from "../../src/server/message/shared-agent-live-shadow-admission.ts";
import {
  openPostgresRuntimeInvocationProtectedHistoryHits,
  openPostgresSharedAgentProtectedInputSet,
} from
  "../../src/server/message/postgres-shared-agent-live-shadow-input-opener.ts";
import { PostgresSharedAgentLiveShadowPlanner } from
  "../../src/server/message/postgres-shared-agent-live-shadow-plan.ts";
import {
  createFakeConversationShadowHarness,
} from "../../src/testing/fake-conversation-shadow-repository.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";

const NOW = 1_800_200_000_000;
const SESSION = "10000000-0000-4000-8000-000000000296";
const ROOM = "20000000-0000-4000-8000-000000000296";
const NAMESPACE = "30000000-0000-4000-8000-000000000296";
const AGENT = "35000000-0000-4000-8000-000000000296";
const SENDER_HUMAN = "40000000-0000-4000-8000-000000000296";
const RECIPIENT_HUMAN = "50000000-0000-4000-8000-000000000296";
const SENDER_DEVICE = "device_m296_sender";
const RECIPIENT_DEVICE = "device_m296_recipient";
const OPERATION = "shared_agent_operation_m296_live";
const MESSAGE_ID = 296;
const PROTECTED_TOP_LEVEL_ROOM_KIND_SQL =
  PROTECTED_TOP_LEVEL_ROOM_KINDS.map((kind) => `'${kind}'`).join(", ");

function expectProtectedTopLevelOrInheritedRoomSql(statement: string): void {
  expect(statement).toContain(
    `authority.kind IN (${PROTECTED_TOP_LEVEL_ROOM_KIND_SQL})`,
  );
  expect(statement).toContain(
    `source.kind IN (${PROTECTED_TOP_LEVEL_ROOM_KIND_SQL})`,
  );
  expect(statement).toContain("source.parent_room_id = authority.id");
  expect(statement).toContain("source.kind = 'subthread'");
  expect(PROTECTED_TOP_LEVEL_ROOM_KINDS).not.toContain("access");
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function createProfile(input: Readonly<{
  crypto: LatticeCrypto;
  deviceId: string;
  humanId: string;
  userId: string;
  hostAuthorizationRevision: number;
}>): Promise<Readonly<{
  vault: MemoryClientProfileVault;
  coordinates: ClientProfileCoordinates;
  signingPublicKey: Uint8Array;
}>> {
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  const v2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: input.deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: input.hostAuthorizationRevision,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(v2);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto: input.crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: input.deviceId,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto: input.crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: input.deviceId,
  });
  const coordinates: ClientProfileCoordinates = Object.freeze({
    serverScope: "https://m296.test",
    userId: input.userId,
    humanActorId: input.humanId,
    profileId: `profile_${input.deviceId}`,
    deviceId: input.deviceId,
    installationLineageDigest: "95".repeat(32),
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({
    crypto: input.crypto,
    vault,
    coordinates,
    stageId: `stage_${input.deviceId}`,
    generation: 1,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "59".repeat(32),
    },
    candidate: v4,
  });
  const signingPublicKey = signing.publicKey.slice();
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0);
  v3Bytes.fill(0);
  signing.publicKey.fill(0);
  signing.privateKey.fill(0);
  encryption.publicKey.fill(0);
  encryption.privateKey.fill(0);
  return Object.freeze({ vault, coordinates, signingPublicKey });
}

function namespaceAuthority(
  generationKey: Uint8Array,
  headDigest: Uint8Array,
  audienceFingerprint: Uint8Array,
): NamespaceAuthorityClient {
  async function withOpenedGenerations<Value>(
    _request: Readonly<{
      sourceRoomId: string;
      subjectHumanId: string;
      deviceSigningKeyGeneration: number;
      keyClass: "ai" | "human";
      authority: readonly NamespaceGenerationAuthority[];
    }>,
    use: (
      entries: readonly OpenedNamespaceGeneration[],
    ) => Promise<Value> | Value,
  ): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  > {
    const entry: OpenedNamespaceGeneration = Object.freeze({
      namespaceId: namespaceId(NAMESPACE),
      keyClass: "ai",
      accessRevision: accessRevision(2),
      generation: namespaceGeneration(3),
      generationKey: generationKey.slice(),
      audienceFingerprint: audienceFingerprint.slice(),
      headDigest: headDigest.slice(),
    });
    try {
      return Object.freeze({
        status: "opened" as const,
        value: await use([entry]),
      });
    } finally {
      entry.generationKey.fill(0);
      entry.audienceFingerprint.fill(0);
      entry.headDigest.fill(0);
    }
  }
  return Object.freeze({
    ensure: async () => Object.freeze({ status: "ready" as const }),
    synchronizeRecipients: async () =>
      Object.freeze({ status: "ready" as const }),
    withOpenedAiGenerations: async () =>
      Object.freeze({
        status: "unavailable" as const,
        reason: "wrong_key_class",
      }),
    withOpenedGenerations,
  });
}

describe("M296 shared-Agent Human live Shadow message", () => {
  test("reserves one Runtime invocation and lets two Agent executions share each Human input", async () => {
    const operationIds = [
      "runtime-human-operation-1",
      "runtime-human-operation-2",
    ];
    const agentA = "35000000-0000-4000-8000-000000000297";
    const agentB = "35000000-0000-4000-8000-000000000298";
    const statements: string[] = [];
    const executionDigests: Uint8Array[] = [];
    let executionInputs = 0;
    let invocationId = "";
    let invocationDigest = new Uint8Array(0);
    let invocationDeadline = NOW + 30_000;
    let invocationState = "authorized";
    let invocationReason = "conductor_pending";
    const product = {
      async query(statement: string, parameters: readonly unknown[] = []) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("runtime_invocation_agent_membership")) {
          return [
            { agent_id: agentA, agent_response_mode: "active" },
            { agent_id: agentB, agent_response_mode: "active" },
          ];
        }
        if (statement.includes("runtime_invocation_input_lock")) {
          return operationIds.map((operationId, index) => ({
            operation_id: operationId,
            human_message_id: 297 + index,
            room_id: ROOM,
            session_id: SESSION,
            agent_id: null,
            subject_human_id: SENDER_HUMAN,
            committer_device_id: SENDER_DEVICE,
            conductor_state: "pending",
            state: "published",
            policy_revision: 4,
            human_content: `Human ${index + 1}`,
          }));
        }
        if (statement.includes('select "invocation_id", "deadline_at"')) {
          return invocationId.length === 0
            ? []
            : [{
                invocation_id: invocationId,
                deadline_at: new Date(invocationDeadline),
                terminal_reason: invocationReason,
                state: invocationState,
                sequence: 1,
              }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_invocations"',
        )) {
          invocationId = String(parameters[0]);
          const deadline = parameters.find((value) =>
            typeof value === "string" && value === new Date(NOW + 300_000).toISOString()
          );
          expect(deadline).toBeDefined();
          invocationDeadline = new Date(String(deadline)).getTime();
          invocationDigest = parameters.find(
            (value): value is Uint8Array => value instanceof Uint8Array,
          )?.slice() ?? new Uint8Array(0);
          return [{ invocation_id: parameters[0] }];
        }
        if (statement.includes(
          'update "conversation_shared_agent_shadow_invocations"',
        )) {
          const evidence = parameters.find((value) =>
            typeof value === "string" && value.startsWith("conductor_verified_")
          );
          if (evidence === undefined && invocationState !== "authorized") {
            return [];
          }
          invocationState = parameters.includes("completed")
            ? "completed"
            : parameters.includes("fallback")
              ? "fallback"
              : "running";
          if (typeof evidence === "string") invocationReason = evidence;
          return [{ invocation_id: invocationId }];
        }
        if (statement.includes('select "state" from')) {
          return [{ state: invocationState }];
        }
        if (statement.includes('select "invocation_id", "policy_revision"')) {
          return [{
            invocation_id: invocationId,
            policy_revision: 4,
            room_id: ROOM,
            invoking_human_id: SENDER_HUMAN,
            invoking_device_id: SENDER_DEVICE,
            client_action_session_id: "browser-session-m298",
            input_count: operationIds.length,
            input_set_digest: invocationDigest,
            state: invocationState,
            terminal_reason: invocationReason,
            deadline_at: new Date(invocationDeadline),
          }];
        }
        if (statement.includes("runtime_invocation_attachment_inputs")) {
          return operationIds.map((operationId, index) => ({
            operation_id: operationId,
            human_message_id: 297 + index,
            room_id: ROOM,
            session_id: SESSION,
            agent_id: null,
            subject_human_id: SENDER_HUMAN,
            committer_device_id: SENDER_DEVICE,
            conductor_state: "pending",
            state: "published",
            policy_revision: 4,
          }));
        }
        if (statement.includes(
          'from "conversation_shared_agent_shadow_executions" where',
        )) return [];
        if (statement.includes('insert into "sessions"')) return [];
        if (statement.includes('select "id", "room_id", "agent_id"')) {
          const threadId = String(parameters[1]);
          const agent = threadId.endsWith("a") ? agentA : agentB;
          return [{
            id: threadId.endsWith("a")
              ? "10000000-0000-4000-8000-000000000297"
              : "10000000-0000-4000-8000-000000000298",
            room_id: ROOM,
            agent_id: agent,
          }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_executions"',
        )) {
          expect(parameters).toContain(new Date(invocationDeadline).toISOString());
          const digest = parameters.find((value) => value instanceof Uint8Array);
          if (!(digest instanceof Uint8Array)) {
            throw new Error("execution digest missing");
          }
          executionDigests.push(digest.slice());
          return [{ execution_id: parameters[0] }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_execution_inputs"',
        )) {
          executionInputs++;
          return [];
        }
        if (statement.includes(
          'update "conversation_shared_agent_shadow_operations"',
        )) {
          return operationIds.map((operation_id) => ({ operation_id }));
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        return use(product as unknown as PostgresJsBridgeConnection);
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      product,
      product,
      undefined,
      null,
      { serverId: "test-server" },
    );
    const reserved = await planner.reserveRuntimeInvocation({
      operationIds,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      clientActionSessionId: "browser-session-m298",
      purpose: "conductor",
      now: NOW,
    });
    expect(reserved).not.toBeNull();
    expect(reserved?.deadlineAt).toBe(NOW + 300_000);
    const replayed = await planner.reserveRuntimeInvocation({
      operationIds,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      clientActionSessionId: "browser-session-m298",
      purpose: "conductor",
      now: NOW + 1,
    });
    expect(replayed?.invocationId).toBe(reserved?.invocationId);
    expect(replayed?.deadlineAt).toBe(reserved?.deadlineAt);
    // Existing persisted reservations keep their original, shorter budget.
    invocationDeadline = NOW + 30_000;
    expect((await planner.reserveRuntimeInvocation({
      operationIds,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      clientActionSessionId: "browser-session-m298",
      purpose: "conductor",
      now: NOW + 1,
    }))?.deadlineAt).toBe(NOW + 30_000);
    expect(await planner.claimRuntimeInvocationConductor({
      invocationId: reserved!.invocationId,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      now: NOW + 2,
    })).toBe("claimed");
    expect(await planner.recordRuntimeInvocationConductorOutcome({
      invocationId: reserved!.invocationId,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      routePath: "floor_manager",
      historyStatus: "verified",
      outcome: "wake",
      now: NOW + 3,
    })).toBe("recorded");
    const startedReplay = await planner.reserveRuntimeInvocation({
      operationIds,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      clientActionSessionId: "browser-session-m298",
      purpose: "conductor",
      now: NOW + 4,
    });
    expect(startedReplay?.conductorAlreadyStarted).toBe(true);
    const attached = await planner.attachRuntimeInvocationExecutions({
      invocationId: reserved!.invocationId,
      operationIds,
      roomId: ROOM,
      subjectUserId: "60000000-0000-4000-8000-000000000296",
      subjectHumanId: SENDER_HUMAN,
      agents: [
        {
          agentId: agentA,
          agentThreadId: "thread-a",
          expectedResponseMode: "active",
        },
        {
          agentId: agentB,
          agentThreadId: "thread-b",
          expectedResponseMode: "active",
        },
      ],
      now: NOW + 5,
    });
    expect(attached?.executions.map((entry) => entry.agentId))
      .toEqual([agentA, agentB]);
    expect(reserved?.inputs.map((entry) => entry.operationId))
      .toEqual(operationIds);
    expect(executionInputs).toBe(4);
    expect(executionDigests).toHaveLength(2);
    expect(executionDigests[0]).toEqual(executionDigests[1]);
    expectProtectedTopLevelOrInheritedRoomSql(statements.find((statement) =>
      statement.includes("runtime_invocation_agent_membership")
    )!);
    expect(statements.filter((statement) =>
      statement.includes(
        'insert into "conversation_shared_agent_shadow_invocations"',
      )
    )).toHaveLength(1);
    expect(statements.filter((statement) =>
      statement.includes(
        'insert into "conversation_shared_agent_shadow_executions"',
      )
    )).toHaveLength(2);
    expect(invocationState).toBe("running");
    expect(invocationReason)
      .toBe("conductor_verified_floor_manager_history_verified_wake");
    expect(await planner.claimRuntimeInvocationConductor({
      invocationId: reserved!.invocationId,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      now: NOW + 6,
    })).toBe("already_running");
  });

  test("retains ask-user Conductor evidence for an exact picker resume", async () => {
    const operationId = "runtime-human-operation-ask-user";
    let invocationId = "";
    let invocationState = "authorized";
    let invocationReason = "conductor_pending";
    const product = {
      async query(statement: string, parameters: readonly unknown[] = []) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("runtime_invocation_input_lock")) {
          return [{
            operation_id: operationId,
            human_message_id: 299,
            room_id: ROOM,
            session_id: SESSION,
            agent_id: null,
            subject_human_id: SENDER_HUMAN,
            committer_device_id: SENDER_DEVICE,
            conductor_state: "awaiting_user",
            state: "published",
            policy_revision: 4,
          }];
        }
        if (statement.includes('select "invocation_id", "deadline_at"')) {
          return invocationId.length === 0
            ? []
            : [{
                invocation_id: invocationId,
                deadline_at: new Date(NOW + 30_000),
                terminal_reason: invocationReason,
                state: invocationState,
                sequence: 1,
              }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_invocations"',
        )) {
          invocationId = String(parameters[0]);
          return [{ invocation_id: invocationId }];
        }
        if (statement.includes(
          'update "conversation_shared_agent_shadow_invocations"',
        )) {
          const evidence = parameters.find((value) =>
            typeof value === "string" && value.startsWith("conductor_verified_")
          );
          invocationState = "running";
          if (typeof evidence === "string") invocationReason = evidence;
          return [{ invocation_id: invocationId }];
        }
        if (statement.includes('select "state" from')) {
          return [{ state: invocationState }];
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        return use(product as unknown as PostgresJsBridgeConnection);
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      product,
      product,
      undefined,
      null,
      { serverId: "test-server" },
    );
    const reserved = await planner.reserveRuntimeInvocation({
      operationIds: [operationId],
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      clientActionSessionId: "browser-session-ask-user",
      purpose: "conductor",
      now: NOW,
    });
    expect(reserved).not.toBeNull();
    expect(await planner.claimRuntimeInvocationConductor({
      invocationId: reserved!.invocationId,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      now: NOW + 1,
    })).toBe("claimed");
    expect(await planner.recordRuntimeInvocationConductorOutcome({
      invocationId: reserved!.invocationId,
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      routePath: "floor_manager",
      historyStatus: "verified",
      outcome: "ask_user",
      now: NOW + 2,
    })).toBe("recorded");
    const replay = await planner.reserveRuntimeInvocation({
      operationIds: [operationId],
      roomId: ROOM,
      subjectHumanId: SENDER_HUMAN,
      clientActionSessionId: "browser-session-ask-user",
      purpose: "conductor",
      now: NOW + 3,
    });
    expect(replay?.conductorAlreadyStarted).toBe(true);
    expect(replay?.conductorAwaitingUser).toBe(true);
    expect(invocationState).toBe("running");
    expect(invocationReason)
      .toBe("conductor_verified_floor_manager_history_verified_ask_user");
  });

  test("refuses fan-out when any selected Agent is no longer a Room member", async () => {
    const agentA = "35000000-0000-4000-8000-000000000297";
    const agentB = "35000000-0000-4000-8000-000000000298";
    const statements: string[] = [];
    const product = {
      async query(statement: string) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("m299_runtime_invocation_agent_membership")) {
          return [{ agent_id: agentA, agent_response_mode: "active" }];
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        return use(product as unknown as PostgresJsBridgeConnection);
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      product,
      product,
      undefined,
      null,
      { serverId: "test-server" },
    );
    expect(await planner.attachRuntimeInvocationExecutions({
      invocationId: "runtime-invocation-membership-check",
      operationIds: ["runtime-human-operation-1"],
      roomId: ROOM,
      subjectUserId: "60000000-0000-4000-8000-000000000296",
      subjectHumanId: SENDER_HUMAN,
      agents: [
        { agentId: agentA, agentThreadId: "thread-a" },
        { agentId: agentB, agentThreadId: "thread-b" },
      ],
      now: NOW,
    })).toBeNull();
    expect(statements.some((statement) =>
      statement.includes(
        'insert into "conversation_shared_agent_shadow_invocations"',
      )
    )).toBe(false);
  });

  test("refuses fan-out when a selected Agent response mode changed", async () => {
    const agent = "35000000-0000-4000-8000-000000000297";
    const statements: string[] = [];
    const product = {
      async query(statement: string) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("m299_runtime_invocation_agent_membership")) {
          return [{ agent_id: agent, agent_response_mode: "observe" }];
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        return use(product as unknown as PostgresJsBridgeConnection);
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      product,
      product,
      undefined,
      null,
      { serverId: "test-server" },
    );
    expect(await planner.attachRuntimeInvocationExecutions({
      invocationId: "runtime-invocation-response-mode-check",
      operationIds: ["runtime-human-operation-1"],
      roomId: ROOM,
      subjectUserId: "60000000-0000-4000-8000-000000000296",
      subjectHumanId: SENDER_HUMAN,
      agents: [{
        agentId: agent,
        agentThreadId: "thread-a",
        expectedResponseMode: "active",
      }],
      now: NOW,
    })).toBeNull();
    expect(statements.some((statement) =>
      statement.includes(
        'insert into "conversation_shared_agent_shadow_executions"',
      )
    )).toBe(false);
  });

  test("reserves one idempotent resume with separate source and approving devices", async () => {
    const agent = "35000000-0000-4000-8000-000000000297";
    const user = "60000000-0000-4000-8000-000000000296";
    const approvingDevice = "crypto:browser:resume-device";
    let retainedInvocationId: string | null = null;
    let replayExecutionState: "authorized" | "fallback" = "authorized";
    const inserts: unknown[][] = [];
    const statements: string[] = [];
    const product = {
      async query(statement: string, parameters: readonly unknown[] = []) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes(
          'select "invocation_id" from "conversation_shared_agent_shadow_invocations"',
        )) {
          return retainedInvocationId === null
            ? []
            : [{ invocation_id: retainedInvocationId }];
        }
        if (statement.includes(
          'select "state" from "conversation_shared_agent_shadow_executions"',
        )) {
          return [{ state: replayExecutionState }];
        }
        if (statement.includes("runtime_resume_source")) {
          return [{
            session_id: SESSION,
            prior_execution_id: "prior-execution",
            policy_revision: 4,
            invoking_device_id: SENDER_DEVICE,
            input_count: 1,
            input_set_digest: new Uint8Array(32).fill(0x29),
          }];
        }
        if (statement.includes(
          'from "conversation_shared_agent_shadow_execution_inputs"',
        )) {
          return [{
            input_ordinal: 1,
            human_operation_id: "runtime-human-operation-1",
            message_id: 297,
          }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_invocations"',
        )) {
          inserts.push([...parameters]);
          retainedInvocationId = String(parameters[0]);
          return [{ invocation_id: parameters[0] }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_executions"',
        )) {
          inserts.push([...parameters]);
          return [{ execution_id: parameters[0] }];
        }
        if (statement.includes(
          'insert into "conversation_shared_agent_shadow_execution_inputs"',
        )) {
          return [];
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        return use(product as unknown as PostgresJsBridgeConnection);
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      product,
      product,
      undefined,
      null,
      { serverId: "test-server" },
    );
    const request = {
      roomId: ROOM,
      subjectUserId: user,
      subjectHumanId: SENDER_HUMAN,
      agentId: agent,
      agentThreadId: "thread-a",
      clientActionSessionId: "browser-session-resume",
      authorizationDeviceId: approvingDevice,
      resumeCoordinate: "approval:resume-coordinate",
      now: NOW,
    } as const;
    const reserved = await planner.reserveRuntimeResume(request);
    expect(reserved?.status).toBe("reserved");
    if (reserved?.status !== "reserved") throw new Error("resume not reserved");
    expect(reserved.sourceDeviceId).toBe(SENDER_DEVICE);
    expect(reserved.authorizationDeviceId).toBe(approvingDevice);
    expect(inserts[0]).toContain(new Date(NOW + 300_000).toISOString());
    expect(inserts[1]).toContain(new Date(NOW + 300_000).toISOString());
    expect(inserts[0]?.[5]).toBe(SENDER_DEVICE);
    expect(inserts[0]?.[6]).toBe(approvingDevice);
    expect(inserts[1]?.[7]).toBe(SENDER_DEVICE);
    expect(inserts[1]?.[8]).toBe(approvingDevice);
    expectProtectedTopLevelOrInheritedRoomSql(statements.find((statement) =>
      statement.includes("runtime_resume_source")
    )!);
    expect(await planner.reserveRuntimeResume({ ...request, now: NOW + 1 }))
      .toEqual({ status: "replayed", cancelRecovery: "unavailable" });
    replayExecutionState = "fallback";
    expect(await planner.reserveRuntimeResume({ ...request, now: NOW + 2 }))
      .toEqual({ status: "replayed", cancelRecovery: "available" });
  });

  test("terminalizes expired and process-lost shared work without replaying it", async () => {
    const statements: string[] = [];
    let transactionOpen = false;
    const quarantineParameters: unknown[][] = [];
    const product = {
      async query(statement: string, parameters: readonly unknown[]) {
        statements.push(statement);
        if (statement.startsWith('update "session_message_crypto_revisions"')) {
          expect(transactionOpen).toBe(false);
          quarantineParameters.push([...parameters]);
          return [];
        }
        if (statement.includes("reconcile_expired_operations")) {
          return [{ operation_id: "expired-human" }];
        }
        if (statement.includes("reconcile_expired_executions")) {
          return [{ execution_id: "expired-agent" }];
        }
        if (statement.includes("runtime_invocation_reconcile_expired")) {
          return [];
        }
        if (statement.includes("shared_agent_process_loss")) {
          return [{ execution_id: "process-agent" }];
        }
        if (statement.includes("runtime_invocation_process_loss")) {
          return [];
        }
        if (statement.includes("shared_agent_execution_unavailable")) {
          return [{ execution_id: "running-agent" }];
        }
        if (statement.includes(
          "runtime_invocation_terminal_after_child_failure",
        ) || statement.includes(
          'update "conversation_shared_agent_shadow_invocations"',
        )) {
          return [];
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      async transactionOnce<Value>(
        use: (connection: PostgresJsBridgeConnection) => Promise<Value>,
      ) {
        transactionOpen = true;
        try {
          return await use(product as unknown as PostgresJsBridgeConnection);
        } finally {
          transactionOpen = false;
        }
      },
    } as unknown as PostgresJsBridgeConnection;
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      product,
      product,
      undefined,
      null,
      { serverId: "test-server" },
    );

    expect(await planner.reconcileExpired(NOW, 3)).toBe(2);
    expect(await planner.recordProcessLoss(["process-agent"], NOW + 1))
      .toBe(1);
    expect(await planner.recordExecutionUnavailable({
      executionId: "running-agent",
      reason: "agent_execution_incomplete",
      now: NOW + 2,
    })).toBe("recorded");
    const operationExpiry = statements.find((statement) =>
      statement.includes("reconcile_expired_operations")
    );
    const executionExpiry = statements.find((statement) =>
      statement.includes("reconcile_expired_executions")
    );
    const processLoss = statements.find((statement) =>
      statement.includes("shared_agent_process_loss")
    );
    const unavailable = statements.find((statement) =>
      statement.includes("shared_agent_execution_unavailable")
    );
    expect(quarantineParameters).toHaveLength(3);
    for (const [index, executionId] of ["expired-agent", "process-agent", "running-agent"].entries()) {
      expect(quarantineParameters[index]).toContain(executionId);
      expect(quarantineParameters[index]).toContain("quarantined");
      expect(quarantineParameters[index]).toContain("authorization_unavailable");
      expect(quarantineParameters[index]).toContain("active");
    }
    const quarantine = statements.filter((statement) => statement.startsWith('update "session_message_crypto_revisions"'));
    expect(quarantine.every((statement) => statement.includes('"shared_agent_shadow_execution_id" in')
      && statement.includes('"disposition" =') && statement.includes('"shadow_durable_event_digest" is null'))).toBe(true);
    expect(operationExpiry).toContain(
      "state IN ('planned', 'human_verified')",
    );
    expect(operationExpiry).toContain(
      "conductor_state IN ('pending', 'awaiting_user')",
    );
    expect(executionExpiry).toContain(
      "state IN ('awaiting_authorization', 'authorized', 'running')",
    );
    expect(processLoss).toContain("terminal_reason = 'process_lost'");
    expect(unavailable).toContain(
      "state IN ('awaiting_authorization', 'authorized', 'running')",
    );
  });

  test("maps one canonical row and lets an independent recipient open, compare, and acknowledge it", async () => {
    const crypto = new LatticeCrypto(seededRng(296_900));
    const sender = await createProfile({
      crypto,
      deviceId: SENDER_DEVICE,
      humanId: SENDER_HUMAN,
      userId: "60000000-0000-4000-8000-000000000296",
      hostAuthorizationRevision: 7,
    });
    const recipient = await createProfile({
      crypto,
      deviceId: RECIPIENT_DEVICE,
      humanId: RECIPIENT_HUMAN,
      userId: "70000000-0000-4000-8000-000000000296",
      hostAuthorizationRevision: 11,
    });
    const generationKey = new Uint8Array(32).fill(0x95);
    const headDigest = new Uint8Array(32).fill(0x31);
    const publicationDigest = new Uint8Array(32).fill(0x32);
    const publicationSetDigest = new Uint8Array(32).fill(0x33);
    const audienceFingerprint = new Uint8Array(32).fill(0x34);
    const planBytes = encodeSharedAgentLiveShadowMessagePlanV1({
      formatVersion: 1,
      purpose: "message.shared_agent_live_shadow_plan",
      operationId: OPERATION,
      clientIdempotencyKey: "shared_agent_client_m296_live",
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      recipientAgentId: agentId(AGENT),
      humanMessageId: MESSAGE_ID,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(SENDER_HUMAN),
      committerDeviceId: cryptoDeviceId(SENDER_DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceId: namespaceId(NAMESPACE),
      keyClass: "ai",
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: headDigest,
      namespacePublicationDigest: publicationDigest,
      namespacePublicationSetDigest: publicationSetDigest,
      namespaceAudienceFingerprint: audienceFingerprint,
      attemptCoordinate: "shared_agent_attempt_m296_live",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const prepared = await prepareVaultSharedAgentLiveShadowMessage({
      crypto,
      vault: sender.vault,
      coordinates: sender.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      planBytes,
      normalizedContent: "Shared Agent protected hello",
      now: NOW + 1,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error(prepared.reason);

    const harness = createFakeConversationShadowHarness({
      crypto,
      now: () => new Date(NOW + 1),
    });
    harness.product.addSession({
      sessionId: SESSION,
      roomId: ROOM,
      namespaceId: NAMESPACE,
    });
    const admissionInput = {
      operationId: OPERATION,
      expectedContent: "Shared Agent protected hello",
      planBytes,
      requestBytes: prepared.value.requestBytes,
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
    } as const;
    const dependencies = {
      crypto,
      product: harness.product,
      sourceUserId: "60000000-0000-4000-8000-000000000296",
      conversation: createDormantConversationShadowRepository({
        product: harness.product,
        crypto: harness.crypto,
      }),
      resolveCurrentHumanAuthority: () => sender.signingPublicKey.slice(),
      senderDeviceSigningPublicKey: sender.signingPublicKey,
    } as const;
    const admitted = await admitAndPersistSharedAgentLiveShadowMessage(
      dependencies,
      admissionInput,
    );
    if (admitted.status !== "human_verified") {
      throw new Error(JSON.stringify({
        result: admitted,
        events: harness.events,
        cryptoFailure: harness.crypto.lastFailure?.message,
      }));
    }
    expect(admitted.status).toBe("human_verified");
    expect(harness.product.peekMessage(MESSAGE_ID)).toMatchObject({
      messageId: MESSAGE_ID,
      content: "Shared Agent protected hello",
      keyClass: "ai",
      cryptoObjectId: admitted.protectedMessage.protectedPayload.status
        === "encrypted"
        ? admitted.protectedMessage.protectedPayload.cryptoObjectId
        : null,
    });
    expect(harness.crypto.completionCount).toBe(1);
    const replayed = await admitAndPersistSharedAgentLiveShadowMessage(
      dependencies,
      admissionInput,
    );
    expect(replayed.status).toBe("human_replayed");
    expect(harness.crypto.completionCount).toBe(1);

    const fullHarness = createFakeConversationShadowHarness({
      crypto, now: () => new Date(NOW + 1),
    });
    fullHarness.product.addSession({ sessionId: SESSION, roomId: ROOM, namespaceId: NAMESPACE });
    const full = await admitAndPersistSharedAgentLiveShadowMessage({
      ...dependencies,
      product: fullHarness.product,
      conversation: createDormantConversationShadowRepository({
        product: fullHarness.product, crypto: fullHarness.crypto,
      }),
    }, {
      representationMode: "full_encryption",
      operationId: OPERATION, planBytes,
      requestBytes: prepared.value.requestBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
    });
    expect(full).toMatchObject({
      status: "human_verified", representationMode: "full_encryption",
      operationId: OPERATION, messageId: MESSAGE_ID,
      protectedMessage: { projection: {
        sourceUserId: "60000000-0000-4000-8000-000000000296",
      } },
    });
    expect(full).not.toHaveProperty("content");
    expect(fullHarness.product.peekMessage(MESSAGE_ID)).toMatchObject({ content: null });

    const runtime = Object.freeze({
      agentId: agentId(AGENT),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x96),
    });
    const runtimeSigner = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const executionPlanBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId: "shared_agent_execution_m296_input",
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      humanMessageId: MESSAGE_ID,
      revision: 0,
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(SENDER_HUMAN),
      committerDeviceId: cryptoDeviceId(SENDER_DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      recipientAgentId: runtime.agentId,
      agentAuthorizationRevision: authorizationRevision(5),
      agentRuntimeGeneration: runtime.generation,
      agentSignerKeyId: runtimeSigner.principal.signerKeyId,
      agentSignerPublicKey: runtimeSigner.publicKey,
      namespaceId: namespaceId(NAMESPACE),
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: headDigest,
      namespacePublicationDigest: publicationDigest,
      namespacePublicationSetDigest: publicationSetDigest,
      namespaceAudienceFingerprint: audienceFingerprint,
      grantDomainId: "grant_domain_m296_input",
      grantDomainParticipantDigest: new Uint8Array(32).fill(0x42),
      grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: new Uint8Array(32).fill(0x43),
      grantDomainPublicationDigest: new Uint8Array(32).fill(0x44),
      grantDomainAuthorizationRevision: authorizationRevision(3),
      namespaceBundleGrantDomainAuthorizationRevision:
        authorizationRevision(3),
      namespaceBundleRevision: 1,
      namespaceBundleDigest: new Uint8Array(32).fill(0x45),
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "shared_agent_session_m296_input",
        authorizationDigest: new Uint8Array(32).fill(0x46),
      },
      attemptCoordinate: "shared_agent_execution_attempt_m296_input",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const executionPlan = decodeLiveShadowMessagePlanV4(executionPlanBytes);
    const inputSetDigest = sharedAgentLiveShadowExecutionInputSetDigest(
      crypto,
      [{ operationId: OPERATION, messageId: MESSAGE_ID }],
    );
    const cryptoObjectId = admitted.protectedMessage.protectedPayload.status
        === "encrypted"
      ? admitted.protectedMessage.protectedPayload.cryptoObjectId
      : "unavailable";
    const requestDigest = crypto.hash(prepared.value.requestBytes);
    let representationMode: "shadow_encryption" | "full_encryption" = "shadow_encryption";
    let publicationPolicyRevision: number | null = null;
    let originPolicyRevision = 4;
    let currentMode: "shadow_encryption" | "encrypted_only" = "shadow_encryption";
    let currentPolicyRevision = 4;
    const executionPolicyRevision = 4;
    let parityStatus: "client_verified" | "client_authenticated" = "client_verified";
    let tamperPayload = false;
    const productQueries: string[] = [];
    const product = {
      query: (statement: string) => {
        productQueries.push(statement);
        if (statement.includes("m296_shared_agent_input_execution")) {
          return Promise.resolve([{
            execution_id: executionPlan.operationId,
            invocation_id: null,
            state: "authorized",
            policy_revision: executionPolicyRevision,
            session_id: SESSION,
            room_id: ROOM,
            agent_id: AGENT,
            invoking_human_id: SENDER_HUMAN,
            invoking_device_id: SENDER_DEVICE,
            input_count: 1,
            input_set_digest: inputSetDigest,
          }]);
        }
        if (statement.includes("m296_shared_agent_protected_inputs")) {
          return Promise.resolve([{
            input_ordinal: 1,
            human_operation_id: OPERATION,
            message_id: MESSAGE_ID,
            operation_state: "published",
            conductor_state: "selected",
            policy_revision: originPolicyRevision,
            room_id: ROOM,
            agent_id: AGENT,
            subject_human_id: SENDER_HUMAN,
            committer_device_id: SENDER_DEVICE,
            committer_device_signing_key_generation: 1,
            host_authorization_revision: 7,
            namespace_id: NAMESPACE,
            namespace_access_revision: 2,
            namespace_key_generation: 3,
            namespace_head_digest: headDigest,
            namespace_publication_digest: publicationDigest,
            namespace_publication_set_digest: publicationSetDigest,
            namespace_audience_fingerprint: audienceFingerprint,
            crypto_object_id: cryptoObjectId,
            plan_bytes: planBytes,
            human_request_bytes: prepared.value.requestBytes,
            human_request_digest: requestDigest,
            protected_message_digest: admitted.protectedMessageDigest,
            content: "Shared Agent protected hello",
            mapped_object_id: cryptoObjectId,
            mapped_operation_id: OPERATION,
            crypto_completion: "complete",
            crypto_disposition: "mapped",
            parity_status: parityStatus,
            key_class: "ai",
            author_role: "user",
            object_id_scheme: "live_shadow_v1",
            representation_mode: representationMode,
            publication_policy_revision: publicationPolicyRevision,
          }]);
        }
        if (statement.includes("m318_shared_agent_input_representation_origins")) {
          return Promise.resolve([{
            representation_mode: representationMode,
            publication_policy_revision: publicationPolicyRevision,
            origin_policy_revision: originPolicyRevision,
            mode: currentMode,
            current_policy_revision: currentPolicyRevision,
          }]);
        }
        if (statement.includes("m299_runtime_conductor_history_candidates")) {
          return Promise.resolve([{
            message_id: MESSAGE_ID,
            role: "user",
            content: "Shared Agent protected hello",
            room_id: ROOM,
            namespace_id: NAMESPACE,
            lifecycle_object_id: cryptoObjectId,
            mapped_object_id: cryptoObjectId,
            payload_version: 2,
            key_class: "ai",
            completion: "complete",
            disposition: "mapped",
            parity_status: "client_verified",
          }]);
        }
        return Promise.reject(new Error("unexpected product query"));
      },
    } as unknown as PostgresJsBridgeConnection;
    const restricted = {
      query: (statement: string) => statement.includes(
          "m296_shared_agent_input_signers",
        )
        ? Promise.resolve([{
            device_id: SENDER_DEVICE,
            device_generation: 1,
            signing_public_key: sender.signingPublicKey,
          }])
        : Promise.reject(new Error("unexpected restricted query")),
    } as unknown as PostgresJsBridgeConnection;
    const storage = {
      getObject: () => Promise.resolve({
        objectId: cryptoObjectId,
        payloadBytes: tamperPayload
          ? new Uint8Array(prepared.value.encryptedPayloadBytes.length).fill(0xff)
          : prepared.value.encryptedPayloadBytes.slice(),
      }),
      getObjectAccessState: () => Promise.resolve({
        head: {
          objectId: cryptoObjectId,
          manifestBytes: prepared.value.accessManifestBytes.slice(),
        },
        namespaceEnvelopes: [{
          namespaceId: NAMESPACE,
          envelopeBytes: prepared.value.namespaceEnvelopeBytes.slice(),
          envelopeHash: crypto.hash(prepared.value.namespaceEnvelopeBytes),
        }],
      }),
    } as unknown as LatticeStorage;
    expect(await openPostgresSharedAgentProtectedInputSet({
      product,
      restricted,
      storage,
      crypto,
      plan: executionPlan,
      namespaceKey: generationKey,
      expectedMergedContent: "Shared Agent protected hello",
    })).toEqual({
      status: "verified",
      inputCount: 1,
      mergedContent: "Shared Agent protected hello",
      causalHumanTurnId: OPERATION,
    });
    expect(await openPostgresSharedAgentProtectedInputSet({
      product,
      restricted,
      storage,
      crypto,
      plan: executionPlan,
      namespaceKey: generationKey,
      expectedMergedContent: "substituted ordinary prompt",
    })).toEqual({
      status: "unavailable",
      reason: "protected_input_parity_failed",
    });
    representationMode = "full_encryption";
    publicationPolicyRevision = 4;
    parityStatus = "client_authenticated";
    currentMode = "encrypted_only";
    productQueries.length = 0;
    expect(await openPostgresSharedAgentProtectedInputSet({
      product, restricted, storage, crypto, plan: executionPlan,
      namespaceKey: generationKey,
    })).toEqual({
      status: "verified", inputCount: 1,
      mergedContent: "Shared Agent protected hello",
      causalHumanTurnId: OPERATION,
    });
    expect(productQueries.find((query) => query.includes("m296_shared_agent_protected_inputs")))
      .not.toContain("message.content");
    currentMode = "shadow_encryption";
    currentPolicyRevision = 4;
    originPolicyRevision = 4;
    expect(await openPostgresSharedAgentProtectedInputSet({
      product, restricted, storage, crypto, plan: executionPlan,
      namespaceKey: generationKey, expectedMergedContent: "Shared Agent protected hello",
    })).toEqual({
      status: "verified", inputCount: 1,
      mergedContent: "Shared Agent protected hello",
      causalHumanTurnId: OPERATION,
    });
    currentMode = "encrypted_only";
    representationMode = "shadow_encryption";
    publicationPolicyRevision = null;
    parityStatus = "client_verified";
    originPolicyRevision = 3;
    productQueries.length = 0;
    expect(await openPostgresSharedAgentProtectedInputSet({
      product, restricted, storage, crypto, plan: executionPlan,
      namespaceKey: generationKey,
    })).toEqual({
      status: "verified", inputCount: 1,
      mergedContent: "Shared Agent protected hello",
      causalHumanTurnId: OPERATION,
    });
    expect(productQueries.find((query) => query.includes("m296_shared_agent_protected_inputs")))
      .not.toContain("message.content");
    currentPolicyRevision = 5;
    expect((await openPostgresSharedAgentProtectedInputSet({
      product, restricted, storage, crypto, plan: executionPlan,
      namespaceKey: generationKey,
    })).status).toBe("unavailable");
    currentPolicyRevision = 4;
    tamperPayload = true;
    expect((await openPostgresSharedAgentProtectedInputSet({
      product, restricted, storage, crypto, plan: executionPlan,
      namespaceKey: generationKey,
    })).status).toBe("unavailable");
    tamperPayload = false;
    currentMode = "shadow_encryption";
    currentPolicyRevision = 4;
    originPolicyRevision = 4;
    representationMode = "shadow_encryption";
    publicationPolicyRevision = null;
    parityStatus = "client_verified";
    expect(await openPostgresRuntimeInvocationProtectedHistoryHits({
      product,
      storage,
      crypto,
      roomId: ROOM,
      namespaceId: NAMESPACE,
      namespaceAccessRevision: 2,
      namespaceKeyGeneration: 3,
      namespaceKey: generationKey,
      candidates: [{
        messageId: MESSAGE_ID,
        ts: new Date(NOW),
        role: "user",
        authorDisplayName: "Sender",
        handle: "sender",
        authorActorId: SENDER_HUMAN,
        snippet: "poisoned ordinary candidate",
      }],
    })).toEqual([{
      messageId: MESSAGE_ID,
      ts: new Date(NOW),
      role: "user",
      authorDisplayName: "Sender",
      handle: "sender",
      authorActorId: SENDER_HUMAN,
      snippet: "Shared Agent protected hello",
    }]);
    runtime.key.fill(0);
    runtimeSigner.publicKey.fill(0);
    executionPlanBytes.fill(0);
    inputSetDigest.fill(0);
    requestDigest.fill(0);
    executionPlan.agentSignerPublicKey.fill(0);
    executionPlan.namespaceHeadDigest.fill(0);
    executionPlan.namespacePublicationDigest.fill(0);
    executionPlan.namespacePublicationSetDigest.fill(0);
    executionPlan.namespaceAudienceFingerprint.fill(0);
    executionPlan.grantDomainParticipantDigest.fill(0);
    executionPlan.grantDomainHeadDigest.fill(0);
    executionPlan.grantDomainPublicationDigest.fill(0);
    executionPlan.namespaceBundleDigest.fill(0);
    if (executionPlan.authorization.disposition === "authorization_reusable") {
      executionPlan.authorization.authorizationDigest.fill(0);
    }

    const eventDigest = liveShadowDurableEventDigestV1(crypto, {
      operationId: OPERATION,
      policyRevision: 4,
      transcriptOrdinal: 1,
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
      protectedMessage: admitted.protectedMessage,
    });
    let acknowledgements = 0;
    let profileUnlocked = false;
    let profileUnlocks = 0;
    const lockedRecipientVault: ClientProfileVault = Object.freeze({
      availability: async () => Object.freeze({
        status: profileUnlocked ? "available" as const : "locked" as const,
      }),
      unlock: async () => {
        profileUnlocked = true;
        profileUnlocks++;
        return Object.freeze({ status: "available" as const });
      },
      lock: () => recipient.vault.lock(),
      stageProfile: (input: StageClientProfileInput) =>
        recipient.vault.stageProfile(input),
      activateProfile: (coordinates: ClientProfileCoordinates, stageId: string) =>
        recipient.vault.activateProfile(coordinates, stageId),
      abortStagedProfile: (coordinates: ClientProfileCoordinates, stageId: string) =>
        recipient.vault.abortStagedProfile(coordinates, stageId),
      recoverInterruptedActivation: (coordinates: ClientProfileCoordinates,
        resolution: InterruptedClientProfileResolution) =>
        recipient.vault.recoverInterruptedActivation(coordinates, resolution),
      withOpenProfile: <Value>(coordinates: ClientProfileCoordinates,
        operation: (profileBytes: Uint8Array) => Promise<Value> | Value) => {
        if (!profileUnlocked) throw new Error("client profile vault is locked");
        return recipient.vault.withOpenProfile(coordinates, operation);
      },
      listPublicProfiles: () => recipient.vault.listPublicProfiles(),
      rotateWrappingMaterial: () => recipient.vault.rotateWrappingMaterial(),
      forgetProfile: (coordinates: ClientProfileCoordinates) =>
        recipient.vault.forgetProfile(coordinates),
    });
    const receiver = createVaultSharedAgentLiveShadowMessageReceiver({
      crypto,
      vault: lockedRecipientVault,
      coordinates: recipient.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      api: {
        planSharedAgentLiveShadowAcknowledgement: async () => Object.freeze({
          status: "ready" as const,
          subjectHumanId: RECIPIENT_HUMAN,
          clientDeviceId: RECIPIENT_DEVICE,
          clientDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 11,
        }),
        acknowledgeSharedAgentLiveShadowMessage: async (request) => {
          acknowledgements++;
          const bytes = Buffer.from(
            request.acknowledgementBytesBase64url,
            "base64url",
          );
          const acknowledgement = verifySharedAgentLiveShadowAcknowledgement(
            crypto,
            {
              bytes,
              now: unixTimestamp(NOW + 3),
              resolveCurrentAuthority: () =>
                recipient.signingPublicKey.slice(),
            },
          );
          expect(acknowledgement.status).toBe("verified");
          expect(String(acknowledgement.committerDeviceId))
            .toBe(RECIPIENT_DEVICE);
          return "verified" as const;
        },
      },
      now: () => NOW + 2,
    });
    const ordinarySibling = Object.freeze({
      role: "user" as const,
      content: "Shared Agent protected hello",
    });
    const liveEvent = Object.freeze({
      wireVersion: 1,
      type: "message.shared_agent_shadow",
      laneKey: `room:${ROOM}`,
      operationId: OPERATION,
      policyRevision: 4,
      transcriptOrdinal: 1,
      logicalMessageKey: `turn:${OPERATION}`,
      planBytesBase64url: base64url(planBytes),
      requestBytesBase64url: base64url(prepared.value.requestBytes),
      ordinaryPayloadBytesBase64url:
        base64url(prepared.value.ordinaryPayloadBytes),
      protectedMessage: admitted.protectedMessage,
      protectedMessageDigestBase64url:
        base64url(admitted.protectedMessageDigest),
      senderDeviceSigningPublicKeyBase64url:
        base64url(sender.signingPublicKey),
      durableEventDigestBase64url: base64url(eventDigest),
    });
    const received = await receiver.receive(liveEvent, ordinarySibling);
    expect(received).toMatchObject({
      status: "verified",
      reason: "matched",
      payload: ordinarySibling,
    });
    const fullDigest = fullEncryptionDurableEventDigestV2(crypto, {
      operationId: OPERATION, policyRevision: 4, transcriptOrdinal: 1,
      protectedMessage: admitted.protectedMessage,
    });
    const fullEvent = { ...liveEvent, wireVersion: 2 as const,
      durableEventDigestBase64url: base64url(fullDigest) };
    delete (fullEvent as { ordinaryPayloadBytesBase64url?: string })
      .ordinaryPayloadBytesBase64url;
    expect(await receiver.receive(fullEvent)).toMatchObject({
      status: "verified", payload: ordinarySibling,
    });
    const ensuredRequests:
      Parameters<NamespaceAuthorityClient["ensure"]>[0][] = [];
    let ensured = false;
    let retryPlanRequests = 0;
    let retryAcknowledgements = 0;
    const retryBaseAuthority = namespaceAuthority(
      generationKey,
      headDigest,
      audienceFingerprint,
    );
    const retryReceiver = createVaultSharedAgentLiveShadowMessageReceiver({
      crypto,
      vault: lockedRecipientVault,
      coordinates: recipient.coordinates,
      namespaceAuthority: Object.freeze({
        ...retryBaseAuthority,
        ensure: async (
          request: Parameters<NamespaceAuthorityClient["ensure"]>[0],
        ) => {
          ensuredRequests.push(request);
          ensured = true;
          return Object.freeze({ status: "ready" as const });
        },
      }),
      api: {
        planSharedAgentLiveShadowAcknowledgement: async () => {
          retryPlanRequests++;
          return ensured
            ? Object.freeze({
                status: "ready" as const,
                subjectHumanId: RECIPIENT_HUMAN,
                clientDeviceId: RECIPIENT_DEVICE,
                clientDeviceSigningKeyGeneration: 1,
                hostAuthorizationRevision: 11,
              })
            : Object.freeze({
                status: "unavailable" as const,
                reason: "current_read_authority_unavailable",
              });
        },
        acknowledgeSharedAgentLiveShadowMessage: async () => {
          retryAcknowledgements++;
          return "verified" as const;
        },
      },
      now: () => NOW + 2,
    });
    expect(await retryReceiver.receive(fullEvent)).toMatchObject({
      status: "verified", reason: "matched", payload: ordinarySibling,
    });
    expect(ensuredRequests).toEqual([{
      sourceRoomId: ROOM,
      namespaceId: NAMESPACE,
      operationId: OPERATION,
      idempotencyKey: OPERATION,
      keyClass: "ai",
    }]);
    expect(retryPlanRequests).toBe(2);
    expect(retryAcknowledgements).toBe(1);

    let deniedEnsureRequests = 0;
    let deniedAcknowledgements = 0;
    const deniedReceiver = createVaultSharedAgentLiveShadowMessageReceiver({
      crypto,
      vault: lockedRecipientVault,
      coordinates: recipient.coordinates,
      namespaceAuthority: Object.freeze({
        ...retryBaseAuthority,
        ensure: async () => {
          deniedEnsureRequests++;
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_denied",
          });
        },
      }),
      api: {
        planSharedAgentLiveShadowAcknowledgement: async () => Object.freeze({
          status: "unavailable" as const,
          reason: "current_read_authority_unavailable",
        }),
        acknowledgeSharedAgentLiveShadowMessage: async () => {
          deniedAcknowledgements++;
          return "verified" as const;
        },
      },
      now: () => NOW + 2,
    });
    expect(await deniedReceiver.receive(fullEvent)).toMatchObject({
      status: "fallback", reason: "authority_stale",
    });
    expect(deniedEnsureRequests).toBe(1);
    expect(deniedAcknowledgements).toBe(0);
    expect(await deniedReceiver.receive(liveEvent, ordinarySibling))
      .toMatchObject({ status: "fallback", reason: "authority_stale" });
    expect(deniedEnsureRequests).toBe(1);

    const bad = fullDigest.slice(); bad[0] = bad[0]! ^ 1;
    const failedFull = await receiver.receive({ ...fullEvent,
      durableEventDigestBase64url: base64url(bad) });
    expect(failedFull).toMatchObject({ status: "fallback" });
    expect(failedFull?.status === "fallback" && failedFull.payload)
      .toBeUndefined();
    const wrongRole = { ...admitted.protectedMessage,
      projection: { ...admitted.protectedMessage.projection,
        role: "assistant" as const } };
    const wrongRoleDigest = fullEncryptionDurableEventDigestV2(crypto, {
      operationId: OPERATION, policyRevision: 4, transcriptOrdinal: 1,
      protectedMessage: wrongRole,
    });
    expect(await receiver.receive({ ...fullEvent, protectedMessage: wrongRole,
      durableEventDigestBase64url: base64url(wrongRoleDigest) }))
      .toMatchObject({ status: "fallback" });
    expect(acknowledgements).toBe(2);
    expect(profileUnlocks).toBe(1);

    const acknowledgementFailureReceiver =
      createVaultSharedAgentLiveShadowMessageReceiver({
        crypto,
        vault: lockedRecipientVault,
        coordinates: recipient.coordinates,
        namespaceAuthority: namespaceAuthority(
          generationKey,
          headDigest,
          audienceFingerprint,
        ),
        api: {
          planSharedAgentLiveShadowAcknowledgement: async () => Object.freeze({
            status: "ready" as const,
            subjectHumanId: RECIPIENT_HUMAN,
            clientDeviceId: RECIPIENT_DEVICE,
            clientDeviceSigningKeyGeneration: 1,
            hostAuthorizationRevision: 11,
          }),
          acknowledgeSharedAgentLiveShadowMessage: async () => {
            throw new Error("simulated acknowledgement transport failure");
          },
        },
        now: () => NOW + 2,
      });
    expect(
      await acknowledgementFailureReceiver.receive(liveEvent, ordinarySibling),
    ).toMatchObject({
      status: "fallback",
      reason: "transport_unavailable",
      payload: ordinarySibling,
    });

    eventDigest.fill(0);
    generationKey.fill(0);
    headDigest.fill(0);
    publicationDigest.fill(0);
    publicationSetDigest.fill(0);
    audienceFingerprint.fill(0);
    sender.signingPublicKey.fill(0);
    recipient.signingPublicKey.fill(0);
  });

  test("lets an independent recipient verify one shared Agent stream and durable output", async () => {
    const crypto = new LatticeCrypto(seededRng(296_901));
    const recipient = await createProfile({
      crypto,
      deviceId: RECIPIENT_DEVICE,
      humanId: RECIPIENT_HUMAN,
      userId: "70000000-0000-4000-8000-000000000296",
      hostAuthorizationRevision: 11,
    });
    const generationKey = new Uint8Array(32).fill(0x95);
    const headDigest = new Uint8Array(32).fill(0x31);
    const publicationDigest = new Uint8Array(32).fill(0x32);
    const publicationSetDigest = new Uint8Array(32).fill(0x33);
    const audienceFingerprint = new Uint8Array(32).fill(0x34);
    const runtime = Object.freeze({
      agentId: agentId(AGENT),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(2),
      key: new Uint8Array(32).fill(0x96),
    });
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const authorizationDigest = new Uint8Array(32).fill(0x41);
    const planBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId: "shared_agent_execution_m296_live",
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      humanMessageId: MESSAGE_ID,
      revision: 0,
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(SENDER_HUMAN),
      committerDeviceId: cryptoDeviceId(SENDER_DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      recipientAgentId: runtime.agentId,
      agentAuthorizationRevision: authorizationRevision(5),
      agentRuntimeGeneration: runtime.generation,
      agentSignerKeyId: signer.principal.signerKeyId,
      agentSignerPublicKey: signer.publicKey,
      namespaceId: namespaceId(NAMESPACE),
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: headDigest,
      namespacePublicationDigest: publicationDigest,
      namespacePublicationSetDigest: publicationSetDigest,
      namespaceAudienceFingerprint: audienceFingerprint,
      grantDomainId: "grant_domain_m296_shared",
      grantDomainParticipantDigest: new Uint8Array(32).fill(0x42),
      grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: new Uint8Array(32).fill(0x43),
      grantDomainPublicationDigest: new Uint8Array(32).fill(0x44),
      grantDomainAuthorizationRevision: authorizationRevision(3),
      namespaceBundleGrantDomainAuthorizationRevision:
        authorizationRevision(3),
      namespaceBundleRevision: 1,
      namespaceBundleDigest: new Uint8Array(32).fill(0x45),
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "shared_agent_session_m296_live",
        authorizationDigest,
      },
      attemptCoordinate: "shared_agent_execution_attempt_m296_live",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const plan = decodeLiveShadowMessagePlanV4(planBytes);
    const assistantMessageId = 297;
    const assistantObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId: plan.operationId,
      sessionId: plan.sessionId,
      messageId: assistantMessageId,
      revision: 0,
      transcriptOrdinal: 2,
      authorRole: "assistant",
    });
    const objectDek = new Uint8Array(32).fill(0x97);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(crypto, generationKey, {
        objectId: objectId(assistantObjectId),
        namespaceId: namespaceId(NAMESPACE),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(3),
        bindingRevisionAtWrap: accessRevision(2),
      }, objectDek),
    );
    const start = prepareDeviceWrappedAgentLiveShadowStreamStart(crypto, {
      operationId: plan.operationId,
      policyRevision: plan.policyRevision,
      sessionId: plan.sessionId,
      roomId: plan.roomId,
      messageId: assistantMessageId,
      revision: 0,
      createdAt: unixTimestamp(NOW + 2),
      cryptoObjectId: objectId(assistantObjectId),
      authorAgentId: runtime.agentId,
      assistantMessageKey: "assistant_m296_297",
      transcriptOrdinal: 2,
      streamId: "stream_m296_297",
      namespaceId: namespaceId(NAMESPACE),
      namespaceAccessRevision: accessRevision(2),
      namespaceKeyGeneration: namespaceGeneration(3),
      namespaceHeadDigest: headDigest,
      namespacePublicationDigest: publicationDigest,
      namespacePublicationSetDigest: publicationSetDigest,
      namespaceAudienceFingerprint: audienceFingerprint,
      agentAuthorizationRevision: authorizationRevision(5),
      runtime,
      runtimeSigner: signer.principal,
      hostAuthorizationRevision: authorizationRevision(7),
      namespaceEnvelopeBytes: envelopeBytes,
      namespaceEnvelopeDigest: crypto.hash(envelopeBytes),
      firstChunkSequence: 1,
      issuedAt: unixTimestamp(NOW + 2),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const payload = Object.freeze({
      role: "assistant" as const,
      content: "Shared Agent protected reply",
    });
    const payloadBytes = encodeMessagePayloadV2(payload);
    const chunkBytes = new TextEncoder().encode(payload.content);
    const streamedTextDigest = crypto.hash(chunkBytes);
    const finalPayloadDigest = crypto.hash(payloadBytes);
    const frame = sealDeviceWrappedAgentLiveShadowStreamFrame(crypto, {
      startBytes: start.bytes,
      objectDek,
      chunkSequence: 1,
      previousFrameHash: new Uint8Array(32),
      ordinaryChunk: chunkBytes,
      done: true,
      totalChunkCount: 1,
      streamedTextDigest,
      finalPayloadDigest,
      reserveNonce: () => true,
    });
    const prepared =
      prepareDeviceWrappedLiveShadowAgentConversationCryptoRevisionWithDek({
        crypto,
        objectId: assistantObjectId,
        payload,
        createdAt: NOW + 2,
        objectDek,
        namespaceEnvelopeBytes: envelopeBytes,
        namespace: {
          namespaceId: NAMESPACE,
          accessRevision: 2,
          keyGeneration: 3,
          headDigest,
          publicationDigest,
          publicationSetDigest,
          audienceFingerprint,
          aiKey: generationKey,
        },
        operationId: plan.operationId,
        grant: {
          grantId: "shared_agent_authorization_m296_live",
          grantHash: authorizationDigest,
          recipientKeyId: "shared_agent_recipient_m296_live",
        },
        runtime,
        signerKeyId: plan.agentSignerKeyId,
        signerPublicKey: plan.agentSignerPublicKey,
        agentAuthorizationRevision: plan.agentAuthorizationRevision,
        resolveCurrentAuthorization: (context) => Object.freeze({
          context,
          grantAuthorized: true,
          namespaceAuthorized: true,
          agentAuthorized: true,
          hostAllowsOperation: true,
          currentRuntime: Object.freeze({
            agentId: runtime.agentId,
            authorizationRevision: plan.agentAuthorizationRevision,
            runtimeGeneration: runtime.generation,
          }),
          signerPublicKey: signer.publicKey.slice(),
        }),
      });
    const snapshot = readPreparedConversationCryptoRevisionSnapshot(prepared);
    if (snapshot.kind !== "agent-v3-device-wrapped-live-shadow") {
      throw new Error("expected device-wrapped Agent preparation");
    }
    const protectedMessage = parseProtectedMessageDtoV2({
      dtoVersion: 2,
      projection: {
        messageId: String(assistantMessageId),
        sessionId: SESSION,
        roomId: ROOM,
        namespaceId: NAMESPACE,
        role: "assistant",
        authorAgentId: AGENT,
        createdAt: new Date(NOW + 2).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: assistantObjectId,
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: base64url(
          snapshot.value.object.payloadBytes.ciphertext,
        ),
        accessManifestBytesBase64url: base64url(
          snapshot.value.access.manifestBytes,
        ),
        namespaceEnvelopeBytesBase64url: base64url(
          snapshot.value.access.envelopeBytes[0],
        ),
      },
    });
    const durableEventDigest = liveShadowDurableEventDigestV1(crypto, {
      operationId: plan.operationId,
      policyRevision: plan.policyRevision,
      transcriptOrdinal: 2,
      ordinaryPayloadBytes: payloadBytes,
      protectedMessage,
    });
    let expectedAcknowledgementDigest = durableEventDigest;
    let acknowledgements = 0;
    const receiver = createVaultSharedAgentOutputLiveShadowReceiver({
      crypto,
      vault: recipient.vault,
      coordinates: recipient.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      api: {
        planSharedAgentOutputRead: async () => Object.freeze({
          status: "ready" as const,
          subjectHumanId: RECIPIENT_HUMAN,
          clientDeviceId: RECIPIENT_DEVICE,
          clientDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 11,
        }),
        acknowledgeSharedAgentOutput: async (request) => {
          acknowledgements++;
          const bytes = Buffer.from(
            request.acknowledgementBytesBase64url,
            "base64url",
          );
          const acknowledgement = verifySharedAgentLiveShadowAcknowledgement(
            crypto,
            {
              bytes,
              now: unixTimestamp(NOW + 3),
              resolveCurrentAuthority: () => recipient.signingPublicKey.slice(),
            },
          );
          expect(acknowledgement.protectedMessageDigest)
            .toEqual(expectedAcknowledgementDigest);
          return "verified" as const;
        },
      },
      now: () => NOW + 3,
    });
    expect(await receiver.receive({
      wireVersion: 1,
      type: "message.shared_agent_stream_start",
      laneKey: `room:${ROOM}`,
      operationId: plan.operationId,
      transcriptOrdinal: 2,
      planBytesBase64url: base64url(planBytes),
      streamStartBytesBase64url: base64url(start.bytes),
    })).toEqual({ status: "start_verified" });
    expect(await receiver.receive({
      wireVersion: 1,
      type: "message.shared_agent_stream_frame",
      laneKey: `room:${ROOM}`,
      operationId: plan.operationId,
      transcriptOrdinal: 2,
      ordinaryChunk: payload.content,
      frameBytesBase64url: base64url(frame.bytes),
      done: true,
    })).toMatchObject({ status: "frame_verified", done: true });
    expect(await receiver.receive({
      wireVersion: 1,
      type: "message.shared_agent_output_shadow",
      laneKey: `room:${ROOM}`,
      operationId: plan.operationId,
      policyRevision: plan.policyRevision,
      transcriptOrdinal: 2,
      planBytesBase64url: base64url(planBytes),
      ordinaryPayloadBytesBase64url: base64url(payloadBytes),
      protectedMessage,
      durableEventDigestBase64url: base64url(durableEventDigest),
    })).toMatchObject({ status: "durable_verified", payload });
    expect(acknowledgements).toBe(1);

    const fullDigest = fullEncryptionDurableEventDigestV2(crypto, {
      operationId: plan.operationId, policyRevision: plan.policyRevision,
      transcriptOrdinal: 2, protectedMessage,
    });
    expectedAcknowledgementDigest = fullDigest;
    expect(await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_stream_start", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, transcriptOrdinal: 2,
      planBytesBase64url: base64url(planBytes),
      streamStartBytesBase64url: base64url(start.bytes) }))
      .toEqual({ status: "start_verified" });
    expect(await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_stream_frame", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, transcriptOrdinal: 2,
      frameBytesBase64url: base64url(frame.bytes), done: true }))
      .toMatchObject({ status: "frame_verified", ordinaryChunk: payload.content });
    expect(await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_output_shadow", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, policyRevision: plan.policyRevision,
      transcriptOrdinal: 2, planBytesBase64url: base64url(planBytes),
      protectedMessage, durableEventDigestBase64url: base64url(fullDigest) }))
      .toMatchObject({ status: "durable_verified", payload });
    await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_stream_start", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, transcriptOrdinal: 2,
      planBytesBase64url: base64url(planBytes),
      streamStartBytesBase64url: base64url(start.bytes) });
    const badFrame = frame.bytes.slice();
    badFrame[10] = badFrame[10]! ^ 1;
    const failedFrame = await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_stream_frame", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, transcriptOrdinal: 2,
      frameBytesBase64url: base64url(badFrame), done: true });
    expect(failedFrame).toMatchObject({ status: "failed" });
    expect(failedFrame?.status === "failed" && failedFrame.ordinaryFallback)
      .toBeUndefined();
    const badFullDigest = fullDigest.slice();
    badFullDigest[0] = badFullDigest[0]! ^ 1;
    const failedFull = await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_output_shadow", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, policyRevision: plan.policyRevision,
      transcriptOrdinal: 2, planBytesBase64url: base64url(planBytes),
      protectedMessage, durableEventDigestBase64url: base64url(badFullDigest) });
    expect(failedFull).toMatchObject({ status: "failed" });
    expect(failedFull?.status === "failed" && failedFull.ordinaryFallback)
      .toBeUndefined();
    const wrongOutputRole = { ...protectedMessage,
      projection: { ...protectedMessage.projection, role: "tool" as const } };
    const wrongOutputRoleDigest = fullEncryptionDurableEventDigestV2(crypto, {
      operationId: plan.operationId, policyRevision: plan.policyRevision,
      transcriptOrdinal: 2, protectedMessage: wrongOutputRole,
    });
    expect(await receiver.receive({ wireVersion: 2,
      type: "message.shared_agent_output_shadow", laneKey: `room:${ROOM}`,
      operationId: plan.operationId, policyRevision: plan.policyRevision,
      transcriptOrdinal: 2, planBytesBase64url: base64url(planBytes),
      protectedMessage: wrongOutputRole,
      durableEventDigestBase64url: base64url(wrongOutputRoleDigest) }))
      .toMatchObject({ status: "failed" });

    const durableWithoutStream = createVaultSharedAgentOutputLiveShadowReceiver({
      crypto,
      vault: recipient.vault,
      coordinates: recipient.coordinates,
      namespaceAuthority: namespaceAuthority(
        generationKey,
        headDigest,
        audienceFingerprint,
      ),
      api: {
        planSharedAgentOutputRead: async () => Object.freeze({
          status: "ready" as const,
          subjectHumanId: RECIPIENT_HUMAN,
          clientDeviceId: RECIPIENT_DEVICE,
          clientDeviceSigningKeyGeneration: 1,
          hostAuthorizationRevision: 11,
        }),
        acknowledgeSharedAgentOutput: async () => {
          acknowledgements++;
          return "verified" as const;
        },
      },
      now: () => NOW + 3,
    });
    expect(await durableWithoutStream.receive({
      wireVersion: 1,
      type: "message.shared_agent_output_shadow",
      laneKey: `room:${ROOM}`,
      operationId: plan.operationId,
      policyRevision: plan.policyRevision,
      transcriptOrdinal: 2,
      planBytesBase64url: base64url(planBytes),
      ordinaryPayloadBytesBase64url: base64url(payloadBytes),
      protectedMessage,
      durableEventDigestBase64url: base64url(durableEventDigest),
    })).toMatchObject({ status: "failed", reason: "integrity" });
    expect(acknowledgements).toBe(3);

    receiver.destroy();
    durableWithoutStream.destroy();
    recipient.signingPublicKey.fill(0);
    generationKey.fill(0);
    objectDek.fill(0);
    envelopeBytes.fill(0);
    payloadBytes.fill(0);
    chunkBytes.fill(0);
    streamedTextDigest.fill(0);
    finalPayloadDigest.fill(0);
    durableEventDigest.fill(0);
    frame.bytes.fill(0);
    frame.frameHash.fill(0);
    start.bytes.fill(0);
    start.startDigest.fill(0);
    runtime.key.fill(0);
    signer.publicKey.fill(0);
    authorizationDigest.fill(0);
    planBytes.fill(0);
    plan.agentSignerPublicKey.fill(0);
    plan.namespaceHeadDigest.fill(0);
    plan.namespacePublicationDigest.fill(0);
    plan.namespacePublicationSetDigest.fill(0);
    plan.namespaceAudienceFingerprint.fill(0);
    plan.grantDomainParticipantDigest.fill(0);
    plan.grantDomainHeadDigest.fill(0);
    plan.grantDomainPublicationDigest.fill(0);
    plan.namespaceBundleDigest.fill(0);
    if (plan.authorization.disposition === "authorization_reusable") {
      plan.authorization.authorizationDigest.fill(0);
    }
  });
});


test("completed shared execution wins over cancellation and preserves its publication", async () => {
  const statements: string[] = [];
  const product = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes("shared_agent_execution_unavailable")) return [];
      if (statement.includes("SELECT state, terminal_reason")) return [{ state: "completed", terminal_reason: null }];
      throw new Error("Completed execution must not mutate reservations");
    },
  } as unknown as PostgresJsBridgeConnection;
  const planner = new PostgresSharedAgentLiveShadowPlanner(product, product, undefined, null, { serverId: "test-server" });
  expect(await planner.recordExecutionUnavailable({ executionId: "completed-execution", reason: "agent_input_cancelled", now: NOW })).toBe("conflict");
  expect(statements).toHaveLength(2);
});

test("cancellation replay repairs unpublished reservation cleanup without reopening work", async () => {
  let terminal = false;
  let quarantines = 0;
  const product = {
    query: async (statement: string, parameters: readonly unknown[]) => {
      if (statement.includes("shared_agent_execution_unavailable")) {
        if (terminal) return [];
        terminal = true;
        return [{ execution_id: "cancelled-execution" }];
      }
      if (statement.includes("SELECT state, terminal_reason")) {
        return [{ state: "fallback", terminal_reason: "agent_input_cancelled" }];
      }
      if (statement.startsWith('update "session_message_crypto_revisions"')) {
        quarantines += 1;
        expect(parameters).toContain("cancelled-execution");
        expect(parameters).toContain("fallback");
        expect(parameters).toContain("failed");
        expect(parameters).toContain("active");
        if (quarantines === 1) throw new Error("storage interruption");
        return [];
      }
      if (statement.startsWith('update "conversation_shared_agent_shadow_invocations"')) return [];
      throw new Error(`Unexpected query: ${statement}`);
    },
  } as unknown as PostgresJsBridgeConnection;
  const planner = new PostgresSharedAgentLiveShadowPlanner(product, product, undefined, null, { serverId: "test-server" });
  const input = { executionId: "cancelled-execution", reason: "agent_input_cancelled", now: NOW };
  const interrupted = await planner.recordExecutionUnavailable(input).catch((error: unknown) => error);
  expect(interrupted).toBeInstanceOf(Error);
  expect((interrupted as Error).message).toBe("storage interruption");
  expect(await planner.recordExecutionUnavailable(input)).toBe("replayed");
  expect(quarantines).toBe(2);
});
