import { describe, expect, test } from "bun:test";


describe("modern Human request negotiation", () => {
  test.each(["unsupported", "ineligible", "missing_marker", "wrong_version", "malformed", "legacy_agent", "legacy_agent_unmarked"] as const)(
    "V2 rejects %s without an ordinary mutation",
    async (failure) => {
      let sends = 0;
      let plans = 0;
      const client = pendingAttentionClient({
        planLiveShadowRoomMessage: (_roomId, request) => {
          plans += 1;
          expect(request.requestVersion).toBe(2);
          if (failure === "unsupported") {
            return Promise.reject(Object.assign(new Error("invalid_request"), { status: 400 }));
          }
          if (failure === "ineligible") {
            return Promise.resolve({ responseVersion: 1, status: "ineligible",
              reason: "room_topology_unsupported" });
          }
          return Promise.resolve({
            responseVersion: 1, status: "planned",
            ...(failure === "missing_marker" || failure === "legacy_agent_unmarked" ? {}
              : { authorizationScheme: "human_ai_readable_v2" as const }),
            planBytesBase64url: failure === "malformed" ? "AQID"
              : base64url(failure.startsWith("legacy_agent") ? sharedAgentPlanBytes() : humanAiReadablePlanBytes()),
          });
        },
        sendRoomMessage: () => {
          sends += 1;
          return Promise.reject(new Error("ordinary mutation forbidden"));
        },
      }, { planRequestVersion: 2 });
      expect(client.send(ROOM, {
        content: "protected draft stays local", clientActionSessionId: "modern-client",
      })).rejects.toThrow();
      expect(plans).toBe(1);
      expect(sends).toBe(0);
    },
  );
});
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  encodeHumanAiReadableLiveShadowMessagePlanV1,
  encodeSharedAgentLiveShadowMessagePlanV1,
  destroyDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { liveShadowMessageSendAttemptV1Schema } from "@nautilo/api-client/browser";
import type { ServerEvent } from "@nautilo/types";

import {
  createAuthorizedHumanLiveShadowMessageClient,
  type HumanLiveShadowMessageApiPort,
} from "../../src/client/message/authorized-human-live-shadow-message-client.ts";
import { createPreparedMutationJournal, PREPARED_MUTATION_JOURNAL_LIMITS } from
  "../../src/client/memory/prepared-mutation-journal.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../src/client-vault/types.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";
import { encodeClientDeviceProfileV2, type OpenedClientDeviceProfileV2 } from
  "../../src/client-vault/profile-v2.ts";
import { createClientDeviceProfileV3Candidate, destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3 } from "../../src/client-vault/profile-v3.ts";
import { createClientDeviceProfileV4Candidate, destroyOpenedClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4 } from "../../src/client-vault/profile-v4.ts";
import type { PreparedMutationJournalVaultPort } from
  "../../src/client/memory/prepared-mutation-journal.ts";

const NOW = 1_800_000_000_000;
const ROOM = "40000000-0000-4000-8000-000000000282";
const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://m282.test",
  userId: "10000000-0000-4000-8000-000000000282",
  humanActorId: "20000000-0000-4000-8000-000000000282",
  profileId: "profile_m282_browser",
  deviceId: "device_m282_browser",
  installationLineageDigest: "82".repeat(32),
});

function invalidForegroundPlanBytes(): Uint8Array {
  return new Uint8Array([0xff]);
}

function sharedAgentPlanBytes(): Uint8Array {
  return encodeSharedAgentLiveShadowMessagePlanV1({
    formatVersion: 1,
    purpose: "message.shared_agent_live_shadow_plan",
    operationId: "shared-agent:m296:client",
    clientIdempotencyKey: "shared-agent-client:m296",
    policyRevision: 1,
    sessionId: "30000000-0000-4000-8000-000000000296",
    roomId: ROOM,
    recipientAgentId: agentId("agent_m296"),
    humanMessageId: 296,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(COORDINATES.humanActorId),
    committerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(1),
    namespaceId: namespaceId("namespace_m296_shared"),
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(1),
    namespaceKeyGeneration: namespaceGeneration(1),
    namespaceHeadDigest: new Uint8Array(32).fill(0x31),
    namespacePublicationDigest: new Uint8Array(32).fill(0x32),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x33),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x34),
    attemptCoordinate: "shared-agent-attempt:m296",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  });
}

function humanAiReadablePlanBytes(): Uint8Array {
  return encodeHumanAiReadableLiveShadowMessagePlanV1({
    formatVersion: 1,
    purpose: "message.human_ai_readable_live_shadow_plan",
    operationId: "human-ai-readable:m298:client",
    clientIdempotencyKey: "human-ai-readable-client:m298",
    policyRevision: 1,
    sessionId: "30000000-0000-4000-8000-000000000298",
    roomId: ROOM,
    humanMessageId: 298,
    revision: 0,
    transcriptOrdinal: 1,
    role: "user",
    createdAt: unixTimestamp(NOW),
    subjectHumanId: humanId(COORDINATES.humanActorId),
    committerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(1),
    namespaceId: namespaceId("namespace_m298_ai_readable"),
    keyClass: "ai",
    namespaceAccessRevision: accessRevision(1),
    namespaceKeyGeneration: namespaceGeneration(1),
    namespaceHeadDigest: new Uint8Array(32).fill(0x41),
    namespacePublicationDigest: new Uint8Array(32).fill(0x42),
    namespacePublicationSetDigest: new Uint8Array(32).fill(0x43),
    namespaceAudienceFingerprint: new Uint8Array(32).fill(0x44),
    attemptCoordinate: "human-ai-readable-attempt:m298",
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
  });
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function pendingAttentionPlanBytes(
  crypto: LatticeCrypto,
  operations: readonly ("decrypt" | "encrypt")[],
): Uint8Array {
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "pending-challenge-1",
    policyRevision: 1,
    sessionId: "pending-session-1",
    roomId: ROOM,
    subjectHumanId: humanId(COORDINATES.humanActorId),
    committerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(1),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_foreground_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: "pending-recipient-key-1",
    operations,
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 30_000),
    maximumSecretBytes: 1024,
    domains: Object.freeze([{
      domainId: "pending-domain-1",
      sourceNamespaceId: "pending-namespace-1",
      participantDigest: new Uint8Array(32).fill(0x51),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(1),
      headDigest: new Uint8Array(32).fill(0x52),
      activeNamespaceBindingSetDigest: new Uint8Array(32).fill(0x53),
      activeNamespaceBindingCount: 1,
    }]),
  });
  try {
    return serializeDomainForegroundAuthorizationPlanV2(plan);
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

function pendingAttentionClient(
  api: HumanLiveShadowMessageApiPort,
  input: Readonly<{
    planRequestVersion?: 1 | 2;
    crypto?: LatticeCrypto;
    domainForegroundAuthority?: Parameters<
      typeof createAuthorizedHumanLiveShadowMessageClient
    >[0]["domainForegroundAuthority"];
  }> = {},
) {
  return createAuthorizedHumanLiveShadowMessageClient({
    ...(input.planRequestVersion === undefined ? {}
      : { planRequestVersion: input.planRequestVersion }),
    api,
    crypto: input.crypto ?? new LatticeCrypto(seededRng(322_001)),
    vault: {} as ClientProfileVault,
    coordinates: COORDINATES,
    journal: createPreparedMutationJournal({
      vault: {} as PreparedMutationJournalVaultPort,
      now: () => NOW,
    }),
    ensureJournalAvailable: () => Promise.resolve(false),
    now: () => NOW + 1,
    createIdempotencyKey: () => "unused",
    normalizeContent: (content) => content,
    ...(input.domainForegroundAuthority === undefined
      ? {}
      : { domainForegroundAuthority: input.domainForegroundAuthority }),
  });
}

function pendingApprovalEvent(
  id: string,
  laneKey = `room:${ROOM}`,
): Extract<ServerEvent, { type: "approval.ask" }> {
  return {
    type: "approval.ask",
    approvalId: id,
    threadId: `thread:${id}`,
    laneKey,
    userId: COORDINATES.userId,
    tools: [{ name: "read_file", args: { path: `/tmp/${id}` }, id: `tool:${id}` }],
    reason: "Human review is required",
    reasonCode: "destructive-tool",
    allowedVerbs: ["once", "deny"],
  };
}

function pendingAttentionApi(
  overrides: Partial<HumanLiveShadowMessageApiPort>,
): HumanLiveShadowMessageApiPort {
  return {
    planLiveShadowRoomMessage: () => Promise.reject(new Error("unused")),
    sendRoomMessage: () => Promise.reject(new Error("unused")),
    ...overrides,
  };
}

function expectFreshPlanAttempts(
  idempotencyKeys: readonly string[],
  count: number,
): void {
  expect(idempotencyKeys).toHaveLength(count);
  expect(new Set(idempotencyKeys).size).toBe(count);
}

function fixture(
  planStatus:
    | "disabled"
    | "ineligible"
    | "planned"
    | "plan_error"
    | "invalid_plan_response"
    | "device_namespaces_then_planned"
    | "device_namespaces_then_invalid_response"
    | "recipient_sync_then_planned"
    | "cascading_device_namespaces_then_planned",
  options: Readonly<{
    unavailableNamespaceId?: string;
    recipientSyncUnavailable?: boolean;
    humanPeerNamespace?: boolean;
    sharedAgentPlan?: boolean;
    humanAiReadablePlan?: boolean;
    v2ForegroundAuthority?: boolean;
    repairDeviceMembership?: boolean;
    journalState?: "full" | "unavailable";
    diagnosticObserverThrows?: boolean;
  }> = {},
) {
  const crypto = new LatticeCrypto(seededRng(282_003));
  let vaultOpens = 0;
  let journalChecks = 0;
  const deviceNamespaceEnsures: string[] = [];
  const recipientSynchronizations: string[] = [];
  const requestedKeyClasses: Array<string | undefined> = [];
  const planIdempotencyKeys: string[] = [];
  let deviceMembershipRepairs = 0;
  const sends: unknown[] = [];
  const unavailableDiagnostics: unknown[] = [];
  const vault: ClientProfileVault = {
    availability: () => Promise.resolve({ status: "unsupported" }),
    unlock: () => Promise.resolve({ status: "unsupported" }),
    lock: () => Promise.resolve(),
    stageProfile: () => Promise.reject(new Error("not used")),
    activateProfile: () => Promise.reject(new Error("not used")),
    abortStagedProfile: () => Promise.reject(new Error("not used")),
    recoverInterruptedActivation: () => Promise.reject(new Error("not used")),
    withOpenProfile: () => {
      vaultOpens += 1;
      return Promise.reject(new Error("profile unavailable"));
    },
    listPublicProfiles: () => Promise.resolve([]),
    rotateWrappingMaterial: () => Promise.reject(new Error("not used")),
    forgetProfile: () => Promise.reject(new Error("not used")),
  };
  const journalVault: PreparedMutationJournalVaultPort = {
    putSealed: () => Promise.reject(new Error("not used")),
    listIndexes: () => options.journalState === "unavailable"
      ? Promise.reject(new Error("journal unavailable"))
      : Promise.resolve(options.journalState === "full"
        ? Array.from({ length: PREPARED_MUTATION_JOURNAL_LIMITS.maxRecords }, (_, index) => ({
          formatVersion: 1 as const, kind: "live_shadow_message" as const,
          operationId: `pending:${index}`, roomId: ROOM,
          authenticatedRequestDigestBase64url: "a".repeat(43), canonicalBytes: 1, sealedBytes: 17,
          createdAt: NOW, updatedAt: NOW, attempts: 0, attemptWindowStartedAt: null,
          attemptsInWindow: 0, nextAttemptAt: NOW, lastAttemptAt: null, state: "pending" as const,
        })) : []),
    withOpenedBody: () => Promise.reject(new Error("not used")),
    updateIndex: () => Promise.resolve(false),
    removeExact: () => Promise.resolve(false),
  };
  const api: HumanLiveShadowMessageApiPort = {
    planLiveShadowRoomMessage: (_roomId, request) => {
      planIdempotencyKeys.push(request.idempotencyKey);
      if (planStatus === "plan_error") {
        return Promise.reject(new Error("Shadow planner unavailable"));
      }
      if (planStatus === "invalid_plan_response") {
        const error = new Error("Unknown Shadow policy response");
        error.name = "ZodError";
        return Promise.reject(error);
      }
      if (
        planStatus === "device_namespaces_then_invalid_response"
        && planIdempotencyKeys.length > 1
      ) {
        const error = new Error("Unknown Shadow replan response");
        error.name = "ZodError";
        return Promise.reject(error);
      }
      if (planStatus === "disabled") {
        return Promise.resolve({
          responseVersion: 1,
          status: "disabled",
          mode: "plaintext_only",
        });
      }
      if (planStatus === "ineligible") {
        return Promise.resolve({
          responseVersion: 1,
          status: "ineligible",
          reason: "room_topology_unsupported",
        });
      }
      if (
        (planStatus === "device_namespaces_then_planned"
          || planStatus === "device_namespaces_then_invalid_response"
          || planStatus === "recipient_sync_then_planned"
          || planStatus === "cascading_device_namespaces_then_planned")
        && planIdempotencyKeys.length === 1
      ) {
        return Promise.resolve({
          responseVersion: 1,
          status: "unavailable",
          ...(options.sharedAgentPlan
            ? { authorizationScheme: "shared_agent_v1" as const }
            : options.humanPeerNamespace
            ? { authorizationScheme: "human_peer_v1" as const }
            : {}),
          reason: planStatus === "recipient_sync_then_planned"
            ? "recipient_sync_required"
            : "namespace_unavailable",
          requiredNamespaceIds: planStatus === "device_namespaces_then_planned"
            ? [
              "40000000-0000-4000-8000-000000000290",
              "40000000-0000-4000-8000-000000000291",
            ]
            : planStatus === "cascading_device_namespaces_then_planned"
            ? ["40000000-0000-4000-8000-000000000290"]
            : ["namespace_m282"],
        });
      }
      if (
        planStatus === "cascading_device_namespaces_then_planned"
        && planIdempotencyKeys.length === 2
      ) {
        return Promise.resolve({
          responseVersion: 1,
          status: "unavailable",
          reason: "namespace_unavailable",
          requiredNamespaceIds: [
            "40000000-0000-4000-8000-000000000290",
            "40000000-0000-4000-8000-000000000291",
          ],
        });
      }
      return Promise.resolve({
        responseVersion: 1,
        status: "planned",
        planBytesBase64url: base64url(
          options.humanAiReadablePlan === true
            ? humanAiReadablePlanBytes()
            : options.sharedAgentPlan === true
            ? sharedAgentPlanBytes()
            : invalidForegroundPlanBytes(),
        ),
      });
    },
    sendRoomMessage: (_roomId, body) => {
      sends.push(body);
      return Promise.resolve({
        messageId: 1,
        jobId: "job:1",
        accepted: true,
        attachments: [],
        coalesced: false,
        ...(body.liveShadow?.status === "client_unavailable"
          ? {
              liveShadow: {
                responseVersion: 1 as const,
                status: "ordinary_fallback" as const,
                operationId: body.liveShadow.operationId,
                reason: "request_invalid" as const,
              },
            }
          : {}),
      });
    },
  };
  let nextId = 0;
  const client = createAuthorizedHumanLiveShadowMessageClient({
    api,
    crypto,
    vault,
    coordinates: COORDINATES,
    journal: createPreparedMutationJournal({
      vault: journalVault,
      now: () => NOW,
    }),
    ensureJournalAvailable: () => {
      journalChecks += 1;
      return Promise.resolve(true);
    },
    now: () => NOW + 1,
    createIdempotencyKey: () => `send:m282:client:${++nextId}`,
    normalizeContent: (content) => content.trim(),
    onUnavailable: (diagnostic) => {
      unavailableDiagnostics.push(diagnostic);
      if (options.diagnosticObserverThrows === true) {
        throw new Error("diagnostic observer failed");
      }
    },
    ...(options.repairDeviceMembership !== true ? {} : {
      ensureDeviceMembershipReady: () => {
        deviceMembershipRepairs += 1;
        return Promise.resolve(true);
      },
    }),
    ...(planStatus === "device_namespaces_then_planned"
        || planStatus === "device_namespaces_then_invalid_response"
        || planStatus === "recipient_sync_then_planned"
        || planStatus === "cascading_device_namespaces_then_planned"
        || options.sharedAgentPlan === true
        || options.humanAiReadablePlan === true
      ? {
        namespaceAuthority: {
          ensure: (request: { namespaceId: string; keyClass?: "human" | "ai" }) => {
            requestedKeyClasses.push(request.keyClass);
            deviceNamespaceEnsures.push(request.namespaceId);
            return Promise.resolve(
              request.namespaceId === options.unavailableNamespaceId
                ? { status: "unavailable" as const, reason: "recipient_pending" }
                : { status: "ready" as const },
            );
          },
          synchronizeRecipients: (request: { namespaceId: string; keyClass?: "human" | "ai" }) => {
            requestedKeyClasses.push(request.keyClass);
            recipientSynchronizations.push(request.namespaceId);
            return Promise.resolve(options.recipientSyncUnavailable
              ? {
                status: "unavailable" as const,
                reason: "waiting_for_recipient_enrollment",
              }
              : { status: "ready" as const });
          },
          withOpenedAiGenerations: () => Promise.reject(
            new Error("preparation is outside this replan test"),
          ),
        },
        ...(options.v2ForegroundAuthority !== true
          ? {}
          : {
              domainForegroundAuthority: {
                withOpenedAuthorizationDomains: () => Promise.resolve({
                  status: "unavailable" as const,
                  reason: "preparation_is_outside_this_replan_test",
                }),
                withOpenedTurnAuthority: () => Promise.resolve({
                  status: "unavailable" as const,
                  reason: "preparation_is_outside_this_replan_test",
                }),
                withOpenedReusableTurnRoomKey: () => Promise.resolve({
                  status: "unavailable" as const,
                  reason: "preparation_is_outside_this_replan_test",
                }),
              },
            }),
      }
      : {}),
  });
  return {
    client,
    sends,
    counts: () => ({ journalChecks, vaultOpens }),
    deviceNamespaceEnsures,
    recipientSynchronizations,
    requestedKeyClasses,
    planIdempotencyKeys,
    deviceMembershipRepairs: () => deviceMembershipRepairs,
    unavailableDiagnostics,
  };
}

describe("authorized Human live Shadow Message client", () => {
  test("recovers every ordinary pending page without an execution request", async () => {
    const cursors: Array<string | undefined> = [];
    let executionRequests = 0;
    const groupLane = `room:${ROOM}:user:${COORDINATES.humanActorId}:bot:30000000-0000-4000-8000-000000000322`;
    const client = pendingAttentionClient(pendingAttentionApi({
      getRoomPendingAttention: (_roomId, request) => {
        cursors.push(request.cursor);
        return Promise.resolve(request.cursor === undefined ? {
          status: "ready" as const,
          events: [pendingApprovalEvent("approval-1")],
          nextCursor: "eyJ2IjoxLCJpZCI6IjEifQ",
        } : {
          status: "ready" as const,
          events: [pendingApprovalEvent("approval-2", groupLane)],
          nextCursor: null,
        });
      },
      authorizeSharedAgentExecution: () => {
        executionRequests += 1;
        return Promise.reject(new Error("must not execute"));
      },
      authorizeRuntimeInvocation: () => {
        executionRequests += 1;
        return Promise.reject(new Error("must not execute"));
      },
    }));

    const result = await client.recoverRoomPendingAttention({
      roomId: ROOM,
      clientActionSessionId: "pending-session-1",
    });

    expect(result).toEqual({
      status: "ready",
      events: [
        pendingApprovalEvent("approval-1"),
        pendingApprovalEvent("approval-2", groupLane),
      ],
    });
    expect(cursors).toEqual([undefined, "eyJ2IjoxLCJpZCI6IjEifQ"]);
    expect(executionRequests).toBe(0);
  });

  test("rejects a pending read plan that is not decrypt-only", async () => {
    const crypto = new LatticeCrypto(seededRng(322_002));
    const recipient = await crypto.generateEncryptionKeyPair();
    const planBytes = pendingAttentionPlanBytes(crypto, ["decrypt", "encrypt"]);
    let reads = 0;
    let domainOpens = 0;
    const client = pendingAttentionClient(pendingAttentionApi({
      getRoomPendingAttention: () => Promise.resolve({
        status: "ready" as const,
        events: [],
        challenge: {
          challengeId: "pending-challenge-1",
          authorizationPlanBytesBase64url: base64url(planBytes),
          recipientPublicKeyBase64url: base64url(recipient.publicKey),
          deadlineAt: NOW + 30_000,
          roomId: ROOM,
        },
        nextCursor: null,
      }),
      readRoomPendingAttention: () => {
        reads += 1;
        return Promise.reject(new Error("must not read"));
      },
    }), {
      crypto,
      domainForegroundAuthority: {
        withOpenedAuthorizationDomains: () => {
          domainOpens += 1;
          return Promise.reject(new Error("must not open domains"));
        },
        withOpenedTurnAuthority: () => Promise.reject(new Error("unused")),
        withOpenedReusableTurnRoomKey: () => Promise.reject(new Error("unused")),
      },
    });

    expect(await client.recoverRoomPendingAttention({
      roomId: ROOM,
      clientActionSessionId: "pending-session-1",
    })).toEqual({ status: "unavailable", events: [] });
    expect(reads).toBe(0);
    expect(domainOpens).toBe(0);
    planBytes.fill(0);
    recipient.privateKey.fill(0);
  });

  test("suppresses a pending page response after its viewer fence turns stale", async () => {
    let resolvePage!: (value: {
      status: "ready";
      events: ServerEvent[];
      nextCursor: null;
    }) => void;
    const page = new Promise<{
      status: "ready";
      events: ServerEvent[];
      nextCursor: null;
    }>((resolve) => {
      resolvePage = resolve;
    });
    let current = true;
    const client = pendingAttentionClient(pendingAttentionApi({
      getRoomPendingAttention: () => page,
    }));
    const recovery = client.recoverRoomPendingAttention({
      roomId: ROOM,
      clientActionSessionId: "pending-session-1",
      isCurrent: () => current,
    });
    current = false;
    resolvePage({
      status: "ready",
      events: [pendingApprovalEvent("stale-approval")],
      nextCursor: null,
    });

    expect(await recovery).toEqual({ status: "unavailable", events: [] });
  });

  test("authorizes one real current Runtime plan and permits an explicit later retry after cold authority", async () => {
    const crypto = new LatticeCrypto(seededRng(282_900), { now: () => NOW });
    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    const v2: OpenedClientDeviceProfileV2 = Object.freeze({
      formatVersion: 2, deviceId: COORDINATES.deviceId,
      signingPublicKey: signing.publicKey, signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey,
      trustedDeviceRevision: 1, trustedHostAuthorizationRevision: 1,
      deliveryHighWatermark: 0, keyringDeliveries: Object.freeze([]),
    });
    const v2Bytes = encodeClientDeviceProfileV2(v2);
    const v3 = await createClientDeviceProfileV3Candidate({
      crypto, currentProfileBytes: v2Bytes, expectedDeviceId: COORDINATES.deviceId,
    });
    const v3Bytes = encodeClientDeviceProfileV3(v3);
    const v4 = await createClientDeviceProfileV4Candidate({
      crypto, currentProfileBytes: v3Bytes, expectedDeviceId: COORDINATES.deviceId,
    });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await stageAndActivateClientDeviceProfileV4({ crypto, vault, coordinates: COORDINATES,
      stageId: "stage:runtime-auth", generation: 1,
      publicState: { clientKind: "browser", publicFingerprint: "90".repeat(32) },
      candidate: v4 });
    destroyOpenedClientDeviceProfileV4(v4);
    destroyOpenedClientDeviceProfileV3(v3);
    v2Bytes.fill(0);
    v3Bytes.fill(0);

    const recipient = await crypto.generateEncryptionKeyPair();
    const domain = Object.freeze({
      domainId: "domain:runtime:m321", sourceNamespaceId: "namespace:runtime:m321",
      participantDigest: new Uint8Array(32).fill(0x91), participantCount: 1,
      keyClass: "ai" as const, domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(1),
      headDigest: new Uint8Array(32).fill(0x92),
      activeNamespaceBindingSetDigest: new Uint8Array(32).fill(0x93),
      activeNamespaceBindingCount: 1,
    });
    const plan = createDomainForegroundAuthorizationPlan(crypto, {
      authorizationId: "runtime-auth:m321", policyRevision: 1,
      sessionId: "30000000-0000-4000-8000-000000000298", roomId: ROOM,
      subjectHumanId: humanId(COORDINATES.humanActorId),
      committerDeviceId: cryptoDeviceId(COORDINATES.deviceId),
      committerDeviceSigningGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(1), recipientKind: "runtime",
      recipientPrincipalId: "runtime:m321", recipientAuthorizationRevision: authorizationRevision(0),
      recipientRuntimeGeneration: 0, recipientKeyId: "runtime-key:m321",
      operations: ["decrypt", "encrypt"], issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000), maximumSecretBytes: 1024,
      domains: Object.freeze([domain]),
    });
    const planBytes = serializeDomainForegroundAuthorizationPlanV2(plan);
    destroyDomainForegroundAuthorizationPlanV2(plan);
    const event = {
      wireVersion: 1 as const,
      type: "message.runtime_invocation_authorization_required" as const,
      laneKey: `room:${ROOM}`, userId: COORDINATES.userId, roomId: ROOM,
      invocationId: "runtime-invocation:m321",
      clientActionSessionId: "30000000-0000-4000-8000-000000000298",
      deadlineAt: NOW + 30_000, authorizationScheme: "runtime_foreground_v1" as const,
      authorizationPlanBytesBase64url: base64url(planBytes),
      sourceHumanPlanBytesBase64url: base64url(humanAiReadablePlanBytes()),
      recipientPublicKeyBase64url: base64url(recipient.publicKey),
    };
    let ready = false;
    let publications = 0;
    const diagnostics: unknown[] = [];
    let diagnosticObserverThrows = false;
    let currentNow = NOW + 1;
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: { planLiveShadowRoomMessage: () => Promise.reject(new Error("unused")),
        sendRoomMessage: () => Promise.reject(new Error("unused")),
        authorizeRuntimeInvocation: () => {
          publications += 1;
          return Promise.resolve({ responseVersion: 1 as const, status: "authorized" as const,
            invocationId: "runtime-invocation:m321" });
        } },
      crypto, vault, coordinates: COORDINATES,
      journal: createPreparedMutationJournal({ vault: {} as PreparedMutationJournalVaultPort,
        now: () => NOW }), ensureJournalAvailable: () => Promise.resolve(false),
      now: () => currentNow, createIdempotencyKey: () => "unused",
      normalizeContent: (content) => content,
      onUnavailable: (diagnostic) => {
        diagnostics.push(diagnostic);
        if (diagnosticObserverThrows) throw new Error("observer failed");
      },
      domainForegroundAuthority: {
        withOpenedAuthorizationDomains: async (_request, use) => ready
          ? { status: "opened" as const, value: await use([Object.freeze({
            ...domain, domainKey: new Uint8Array(32).fill(0x94),
          })]) }
          : { status: "unavailable" as const, reason: "source_required" },
        withOpenedTurnAuthority: () => Promise.reject(new Error("unused")),
        withOpenedReusableTurnRoomKey: () => Promise.reject(new Error("unused")),
      },
    });
    expect(await client.authorizeSharedAgentExecution(event)).toBe(false);
    expect(publications).toBe(0);
    ready = true;
    diagnosticObserverThrows = true;
    const authorized = await client.authorizeSharedAgentExecution(event);
    expect(authorized).toBe(true);
    expect(publications).toBe(1);
    diagnosticObserverThrows = false;
    currentNow = NOW + 30_000;
    expect(await client.authorizeSharedAgentExecution(event)).toBe(false);
    expect(publications).toBe(1);
    expect(diagnostics).toEqual([
      { stage: "runtime_authorization", reason: "prepare_started" },
      { stage: "runtime_authorization", reason: "prepare_complete_unavailable" },
      { stage: "runtime_authorization", reason: "domain_unavailable" },
      { stage: "runtime_authorization", reason: "prepare_started" },
      { stage: "runtime_authorization", reason: "prepare_complete_prepared" },
      { stage: "runtime_authorization", reason: "request_started" },
      { stage: "runtime_authorization", reason: "request_authorized" },
      { stage: "runtime_authorization", reason: "event_stale" },
    ]);
    planBytes.fill(0);
    recipient.publicKey.fill(0);
    recipient.privateKey.fill(0);
  });

  test("reports only fixed diagnostics when Runtime authorization cannot start", async () => {
    const unavailable = fixture("disabled");
    expect(await unavailable.client.authorizeSharedAgentExecution({})).toBe(false);
    expect(unavailable.unavailableDiagnostics).toEqual([{
      stage: "runtime_authorization",
      reason: "domain_authority_unavailable",
    }]);

    const invalid = fixture("disabled", {
      sharedAgentPlan: true,
      v2ForegroundAuthority: true,
    });
    expect(await invalid.client.authorizeSharedAgentExecution({ secret: "not logged" }))
      .toBe(false);
    expect(invalid.unavailableDiagnostics).toEqual([{
      stage: "runtime_authorization",
      reason: "event_invalid",
    }]);
    expect(JSON.stringify(invalid.unavailableDiagnostics)).not.toContain("secret");

    const throwing = fixture("disabled", { diagnosticObserverThrows: true });
    expect(await throwing.client.authorizeSharedAgentExecution({})).toBe(false);
    expect(throwing.unavailableDiagnostics).toEqual([{
      stage: "runtime_authorization",
      reason: "domain_authority_unavailable",
    }]);
  });

  test.each(["device_namespaces_then_planned", "recipient_sync_then_planned"] as const)(
    "Human-only %s requests Human keys only", async (status) => {
      const state = fixture(status, { humanPeerNamespace: true });
      await state.client.send(ROOM, { content: "hello", clientActionSessionId: "action-m311" });
      expect(state.requestedKeyClasses.length).toBeGreaterThan(0);
      expect(state.requestedKeyClasses.every((keyClass) => keyClass === "human")).toBe(true);
    },
  );
  test("runs a server-authored Human recipient wake-up as subordinate work", async () => {
    const seen: string[] = [];
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: {
        planLiveShadowRoomMessage: () => Promise.reject(new Error("not used")),
        sendRoomMessage: () => Promise.reject(new Error("not used")),
      },
      crypto: new LatticeCrypto(seededRng(295_001)),
      vault: {} as ClientProfileVault,
      coordinates: COORDINATES,
      journal: createPreparedMutationJournal({
        vault: {
          putSealed: () => Promise.reject(new Error("not used")),
          listIndexes: () => Promise.resolve([]),
          withOpenedBody: () => Promise.reject(new Error("not used")),
          updateIndex: () => Promise.resolve(false),
          removeExact: () => Promise.resolve(false),
        },
        now: () => NOW,
      }),
      ensureJournalAvailable: () => Promise.resolve(false),
      now: () => NOW,
      createIdempotencyKey: () => "not-used",
      normalizeContent: (content) => content,
      synchronizeHumanPeerRecipients: (roomId, namespaceId) => {
        seen.push(roomId, namespaceId);
        return Promise.resolve(true);
      },
    });

    expect(await client.synchronizeHumanPeerRecipients(
      ROOM,
      "40000000-0000-4000-8000-000000000295",
    )).toBe(true);
    expect(seen).toEqual([
      ROOM,
      "40000000-0000-4000-8000-000000000295",
    ]);

    const absent = fixture("disabled").client;
    expect(await absent.synchronizeHumanPeerRecipients(ROOM, "namespace"))
      .toBe(false);
  });

  test("services only the Domain key class named by a catch-up event", async () => {
    const seen: unknown[][] = [];
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: {} as HumanLiveShadowMessageApiPort,
      crypto: new LatticeCrypto(seededRng(296_001)),
      vault: {} as ClientProfileVault,
      coordinates: COORDINATES,
      journal: createPreparedMutationJournal({
        vault: {
          putSealed: () => Promise.reject(new Error("not used")),
          listIndexes: () => Promise.resolve([]),
          withOpenedBody: () => Promise.reject(new Error("not used")),
          updateIndex: () => Promise.resolve(false),
          removeExact: () => Promise.resolve(false),
        },
        now: () => NOW,
      }),
      ensureJournalAvailable: () => Promise.resolve(false),
      now: () => NOW,
      createIdempotencyKey: () => "not-used",
      normalizeContent: (content) => content,
      serviceDomainKeyRequests: (roomId, namespaceId, keyClass) => {
        seen.push([roomId, namespaceId, keyClass]);
        return Promise.resolve(true);
      },
    });

    expect(await client.serviceDomainKeyRequests(
      ROOM,
      "40000000-0000-4000-8000-000000000296",
      "ai",
    )).toBe(true);
    expect(seen).toEqual([[
      ROOM,
      "40000000-0000-4000-8000-000000000296",
      "ai",
    ]]);
  });

  test("does not inspect a recovery journal until custody is available", async () => {
    let listCalls = 0;
    const journal = createPreparedMutationJournal({
      vault: {
        putSealed: () => Promise.reject(new Error("not used")),
        listIndexes: () => {
          listCalls++;
          return Promise.resolve([]);
        },
        withOpenedBody: () => Promise.reject(new Error("not used")),
        updateIndex: () => Promise.resolve(false),
        removeExact: () => Promise.resolve(false),
      },
      now: () => NOW,
    });
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: {
        planLiveShadowRoomMessage: () => Promise.reject(new Error("not used")),
        sendRoomMessage: () => Promise.reject(new Error("not used")),
        recoverLiveShadowRoomMessage: () => Promise.reject(new Error("not used")),
      },
      crypto: new LatticeCrypto(seededRng(282_005)),
      vault: {} as ClientProfileVault,
      coordinates: COORDINATES,
      journal,
      ensureJournalAvailable: () => Promise.resolve(false),
      now: () => NOW,
      createIdempotencyKey: () => "not-used",
      normalizeContent: (content) => content,
    });

    expect(await client.recoverPending()).toBe(0);
    expect(listCalls).toBe(0);
  });

  test("recovers a journaled terminal turn without resending the Agent job", async () => {
    let stored: Readonly<{
      index: Parameters<PreparedMutationJournalVaultPort["putSealed"]>[0]["index"];
      body: Uint8Array;
    }> | null = null;
    let bodyLeaseOpen = false;
    const assertBodyLeaseReleased = (): void => {
      if (bodyLeaseOpen) {
        throw new Error("journal outcome attempted under opened-body lease");
      }
    };
    const vaultPort: PreparedMutationJournalVaultPort = {
      putSealed: (input) => {
        stored = Object.freeze({ index: input.index, body: input.canonicalBody.slice() });
        return Promise.resolve("inserted");
      },
      listIndexes: () => {
        assertBodyLeaseReleased();
        return Promise.resolve(stored === null ? [] : [stored.index]);
      },
      withOpenedBody: async (_operationId, _digest, use) => {
        if (stored === null) throw new Error("missing");
        bodyLeaseOpen = true;
        try {
          return await use(stored.body.slice());
        } finally {
          bodyLeaseOpen = false;
        }
      },
      updateIndex: () => {
        assertBodyLeaseReleased();
        return Promise.resolve(false);
      },
      removeExact: () => {
        assertBodyLeaseReleased();
        stored = null;
        return Promise.resolve(true);
      },
    };
    const journal = createPreparedMutationJournal({
      vault: vaultPort,
      now: () => NOW,
    });
    const operationId = "live-shadow:m282:recovery";
    const request = {
      requestVersion: 1 as const,
      status: "prepared" as const,
      operationId,
      planBytesBase64url: "AQ",
      signedRequestBytesBase64url: "Ag",
      ordinaryPayloadBytesBase64url: "Aw",
      encryptedPayloadBytesBase64url: "BA",
      accessManifestBytesBase64url: "BQ",
      namespaceEnvelopeBytesBase64url: "Bg",
      grantBytesBase64url: "Bw",
    };
    await journal.putBeforeSend({
      kind: "live_shadow_message",
      roomId: ROOM,
      request,
    });
    const human = {
      dtoVersion: 2 as const,
      projection: {
        messageId: "282",
        sessionId: "30000000-0000-4000-8000-000000000282",
        roomId: ROOM,
        namespaceId: "40000000-0000-4000-8000-000000000283",
        role: "user" as const,
        createdAt: "2027-01-15T08:00:00.000Z",
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted" as const,
        cryptoObjectId: "message:live-shadow:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        payloadVersion: 2 as const,
        keyClass: "ai" as const,
        encryptedPayloadBytesBase64url: "AQ",
        accessManifestBytesBase64url: "Ag",
        namespaceEnvelopeBytesBase64url: "Aw",
      },
    };
    let sends = 0;
    const recovered: unknown[] = [];
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: {
        planLiveShadowRoomMessage: () => Promise.reject(new Error("not used")),
        sendRoomMessage: () => {
          sends++;
          return Promise.reject(new Error("must not resend"));
        },
        recoverLiveShadowRoomMessage: () => Promise.resolve({
          responseVersion: 1,
          status: "completed",
          state: "completed",
          jobId: "50000000-0000-4000-8000-000000000282",
          human: { protectedMessage: human },
          durableEvents: [{
            wireVersion: 1,
            type: "message.shadow_durable",
            laneKey: `room:${ROOM}`,
            operationId,
            policyRevision: 1,
            transcriptOrdinal: 2,
            ordinaryPayloadBytesBase64url: "AQ",
            protectedMessage: {
              ...human,
              projection: { ...human.projection, messageId: "283", role: "assistant" },
            },
            durableEventDigestBase64url: base64url(new Uint8Array(32)),
          }],
        }),
      },
      crypto: new LatticeCrypto(seededRng(282_004)),
      vault: {} as ClientProfileVault,
      coordinates: COORDINATES,
      journal,
      ensureJournalAvailable: () => Promise.resolve(true),
      now: () => NOW,
      createIdempotencyKey: () => "not-used",
      normalizeContent: (content) => content,
      onHumanVerified: async (value) => {
        recovered.push(value);
        value.planBytes.fill(0);
        value.ordinaryPayloadBytes.fill(0);
      },
      onDurableRecovery: async (event) => {
        recovered.push(event);
        return true;
      },
    });

    expect(await client.recoverPending()).toBe(1);
    expect(sends).toBe(0);
    expect(recovered).toHaveLength(2);
    expect(await journal.listStatus()).toEqual([]);
  });

  test("keeps disabled and ineligible sends on literal zero custody", async () => {
    for (const status of ["disabled", "ineligible", "plan_error"] as const) {
      const state = fixture(status);
      await state.client.send(ROOM, {
        content: " ordinary ",
        clientActionSessionId: "client-action:m282",
      });
      expect(state.sends).toEqual([{
        content: " ordinary ",
        clientActionSessionId: "client-action:m282",
        ...(status === "disabled" ? {} : { liveShadow: {
          requestVersion: 1, status: "plan_unavailable",
          reason: status === "ineligible" ? "room_topology_unsupported" : "request_failed",
        } }),
      }]);
      expect(state.counts()).toEqual({
        journalChecks: 0,
        vaultOpens: 0,
      });
    }
  });

  test.each(["full", "unavailable"] as const)("distinguishes %s journal before Human preparation", async (journalState) => {
    const state = fixture("planned", { sharedAgentPlan: true, journalState });
    await state.client.send(ROOM, { content: "private message", clientActionSessionId: "client-action:journal" });
    expect(state.sends).toHaveLength(1);
    const body = state.sends[0] as { liveShadow: unknown };
    expect(liveShadowMessageSendAttemptV1Schema.parse(body.liveShadow)).toMatchObject({
      status: "client_unavailable",
      reason: journalState === "full" ? "journal_full" : "journal_unavailable",
    });
    expect(state.counts()).toEqual({ journalChecks: 1, vaultOpens: 0 });
  });

  test("fails closed when the planner answers with an unknown policy shape", async () => {
    const state = fixture("invalid_plan_response");

    expect(state.client.send(ROOM, {
      content: "must not downgrade",
      clientActionSessionId: "client-action:m305:unknown-policy",
    })).rejects.toMatchObject({ name: "ZodError" });
    expect(state.sends).toHaveLength(0);
    expect(state.counts()).toEqual({ journalChecks: 0, vaultOpens: 0 });
  });

  test("fails closed when a post-readiness replan has an unknown policy shape", async () => {
    const state = fixture("device_namespaces_then_invalid_response");

    expect(state.client.send(ROOM, {
      content: "must not downgrade after readiness",
      clientActionSessionId: "client-action:m305:unknown-replan",
    })).rejects.toMatchObject({ name: "ZodError" });
    expect(state.deviceNamespaceEnsures).toEqual(["namespace_m282"]);
    expect(state.sends).toHaveLength(0);
  });

  test("preserves an invalid plan diagnostic without opening custody", async () => {
    const state = fixture("planned");
    const result = await state.client.send(ROOM, {
      content: " canonical fallback ",
      clientActionSessionId: "client-action:m282",
    });
    expect(result.liveShadow).toBeUndefined();
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toEqual({
      content: " canonical fallback ",
      clientActionSessionId: "client-action:m282",
      liveShadow: { requestVersion: 1, status: "plan_unavailable", reason: "invalid_plan" },
    });
    expect(state.counts()).toEqual({
      journalChecks: 0,
      vaultOpens: 0,
    });
  });

  test("fails a shared-Agent plan closed when local V2 custody is unavailable", async () => {
    const state = fixture("planned", { sharedAgentPlan: true });
    const result = await state.client.send(ROOM, {
      content: " mixed participant fallback ",
      clientActionSessionId: "client-action:m296",
    });
    expect(result.liveShadow).toMatchObject({ status: "ordinary_fallback" });
    expect(state.sends).toHaveLength(1);
  });

  test("recognizes an Agent-free Human AI-readable plan", async () => {
    const state = fixture("planned", { humanAiReadablePlan: true });
    const result = await state.client.send(ROOM, {
      content: " topology-neutral fallback ",
      clientActionSessionId: "client-action:m298",
    });
    expect(result.liveShadow).toMatchObject({ status: "ordinary_fallback" });
    expect(state.sends[0]).toMatchObject({
      content: "topology-neutral fallback",
      liveShadow: {
        operationId: "human-ai-readable:m298:client",
        reason: "plan_stale",
      },
    });
  });

  test("repairs stale Human-device membership once before fallback", async () => {
    const state = fixture("planned", {
      humanAiReadablePlan: true,
      repairDeviceMembership: true,
    });
    await state.client.send(ROOM, {
      content: " repair stale local membership ",
      clientActionSessionId: "client-action:m304-membership-repair",
    });

    expect(state.deviceMembershipRepairs()).toBe(1);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({
      liveShadow: {
        status: "client_unavailable",
        reason: "plan_stale",
      },
    });
  });

  test("prepares every missing readable V2 Namespace before shared dispatch", async () => {
    const state = fixture("device_namespaces_then_planned", {
      sharedAgentPlan: true,
    });
    await state.client.send(ROOM, {
      content: " shared readable readiness ",
      clientActionSessionId: "client-action:m296-readiness",
    });

    expect(state.deviceNamespaceEnsures).toEqual([
      "40000000-0000-4000-8000-000000000290",
      "40000000-0000-4000-8000-000000000291",
    ]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 2);
    expect(state.sends).toHaveLength(1);
  });

  test("does not plan unsupported attachments or replies", async () => {
    const state = fixture("planned");
    await state.client.send(ROOM, {
      content: "attachment",
      clientActionSessionId: "client-action:m282",
      attachments: [{ attachmentId: "attachment:1" }],
    });
    expect(state.counts()).toEqual({
      journalChecks: 0,
      vaultOpens: 0,
    });
    expect(state.sends).toHaveLength(1);
  });


  test("prepares every exact readable Namespace before one V2 replan", async () => {
    const state = fixture("device_namespaces_then_planned");
    await state.client.send(ROOM, {
      content: " ordinary ",
      clientActionSessionId: "client-action:m290",
    });
    expect(state.deviceNamespaceEnsures).toEqual([
      "40000000-0000-4000-8000-000000000290",
      "40000000-0000-4000-8000-000000000291",
    ]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 2);
  });

  test("replans V2 Namespace readiness through native authority", async () => {
    const state = fixture("device_namespaces_then_planned", {
      v2ForegroundAuthority: true,
    });
    await state.client.send(ROOM, {
      content: " v2 authority only ",
      clientActionSessionId: "client-action:m301:v2-replan",
    });
    expect(state.deviceNamespaceEnsures).toEqual([
      "40000000-0000-4000-8000-000000000290",
      "40000000-0000-4000-8000-000000000291",
    ]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 2);
  });

  test("prepares a Human-only Namespace through native authority", async () => {
    const state = fixture("device_namespaces_then_planned", {
      humanPeerNamespace: true,
    });
    await state.client.send(ROOM, {
      content: " human peer ordinary ",
      clientActionSessionId: "client-action:m295:human-peer",
    });
    expect(state.deviceNamespaceEnsures).toEqual([
      "40000000-0000-4000-8000-000000000290",
      "40000000-0000-4000-8000-000000000291",
    ]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 2);
  });

  test("synchronizes retained keys, rotates a stale recipient set, and replans without Agent Domain work", async () => {
    const state = fixture("recipient_sync_then_planned");
    await state.client.send(ROOM, {
      content: " ordinary ",
      clientActionSessionId: "client-action:m295:recipient-sync",
    });
    expect(state.recipientSynchronizations).toEqual(["namespace_m282"]);
    expect(state.deviceNamespaceEnsures).toEqual(["namespace_m282"]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 2);
    expect(state.sends).toHaveLength(1);
  });

  test("keeps an unenrolled Human ordinary-usable without a synchronization loop", async () => {
    const state = fixture("recipient_sync_then_planned", {
      recipientSyncUnavailable: true,
    });
    await state.client.send(ROOM, {
      content: " ordinary while peer enrollment is pending ",
      clientActionSessionId: "client-action:m295:unenrolled",
    });
    expect(state.recipientSynchronizations).toEqual(["namespace_m282"]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 1);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({ liveShadow: {
      requestVersion: 1, status: "plan_unavailable", reason: "recipient_sync_required",
    } });
  });

  test("continues bounded replans when fresh authority widens with overlap", async () => {
    const state = fixture("cascading_device_namespaces_then_planned");
    await state.client.send(ROOM, {
      content: " ordinary ",
      clientActionSessionId: "client-action:m290:cascade",
    });
    expect(state.deviceNamespaceEnsures).toEqual([
      "40000000-0000-4000-8000-000000000290",
      "40000000-0000-4000-8000-000000000291",
    ]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 3);
    expect(state.sends).toHaveLength(1);
  });

  test("continues preparing later readable Namespaces after one is pending", async () => {
    const state = fixture("device_namespaces_then_planned", {
      unavailableNamespaceId: "40000000-0000-4000-8000-000000000290",
    });
    await state.client.send(ROOM, {
      content: " ordinary fallback ",
      clientActionSessionId: "client-action:m290:partial",
    });
    expect(state.deviceNamespaceEnsures).toEqual([
      "40000000-0000-4000-8000-000000000290",
      "40000000-0000-4000-8000-000000000291",
    ]);
    expectFreshPlanAttempts(state.planIdempotencyKeys, 1);
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]).toMatchObject({ liveShadow: {
      requestVersion: 1, status: "plan_unavailable", reason: "namespace_unavailable",
    } });
  });
});


describe("room-wide mention negotiation", () => {
  test.each([1, 2] as const)("version %i rejects an unsupported audience without sending", async (requestVersion) => {
    let sends = 0;
    const client = pendingAttentionClient({
      planLiveShadowRoomMessage: (_roomId, request) => {
        expect(request.mentionEveryone).toBe(true);
        return Promise.reject(Object.assign(new Error("invalid_request"), { status: 400 }));
      },
      sendRoomMessage: () => { sends++; return Promise.reject(new Error("unexpected send")); },
    }, { planRequestVersion: requestVersion });
    expect(client.send(ROOM, {
      content: "@everyone hello", clientActionSessionId: "everyone-client", mentionEveryone: true,
      mentionedHumanUserIds: [COORDINATES.userId],
    })).rejects.toThrow("invalid_request");
    expect(sends).toBe(0);
  });

  test("rejects a plan that drops the requested audience before obtaining custody", async () => {
    let sends = 0;
    const client = pendingAttentionClient({
      planLiveShadowRoomMessage: () => Promise.resolve({
        responseVersion: 1, status: "planned", planBytesBase64url: base64url(humanAiReadablePlanBytes()),
      }),
      sendRoomMessage: () => { sends++; return Promise.reject(new Error("unexpected send")); },
    });
    expect(client.send(ROOM, {
      content: "@everyone hello", clientActionSessionId: "everyone-client", mentionEveryone: true,
    })).rejects.toThrow("Protected message plan is invalid");
    expect(sends).toBe(0);
  });
});
