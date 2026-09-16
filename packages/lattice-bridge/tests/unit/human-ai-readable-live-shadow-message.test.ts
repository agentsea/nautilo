import { prepareVaultHumanMessageEdit } from "../../src/client/message/vault-human-message-edit.ts";
import { createAuthorizedHumanLiveShadowMessageClient } from "../../src/client/message/authorized-human-live-shadow-message-client.ts";
import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  deriveAgentRuntimeObjectSignerPublic,
  humanAiReadableLiveShadowExecutionInputSetDigest,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
  type LatticeStorage,
  encodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  decodeLiveShadowMessagePlanV4,
  decodeHumanMessageEditRequestV1,
  deriveHumanMessageEditCryptoObjectIdV1,
  encodeHumanMessageEditPlanV1,
  verifyHumanMessageEditRequestV1,
  encodeLiveShadowMessagePlanV4,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

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
} from "../../src/client-vault/types.ts";
import {
  prepareVaultHumanAiReadableLiveShadowMessage,
} from "../../src/client/message/vault-human-ai-readable-live-shadow-message.ts";
import type {
  NamespaceAuthorityClient,
  NamespaceGenerationAuthority,
  OpenedNamespaceGeneration,
} from "../../src/client/message/namespace-authority-client.ts";
import {
  admitHumanAiReadableLiveShadowMessage,
} from "../../src/message/human-ai-readable-live-shadow-message-admission.ts";
import {
  createDormantConversationShadowRepository,
} from "../../src/message/conversation-shadow-saga.ts";
import {
  admitAndPersistHumanAiReadableLiveShadowMessage,
} from "../../src/server/message/human-ai-readable-live-shadow-admission.ts";
import {
  openPostgresSharedAgentProtectedInputSet,
} from "../../src/server/message/postgres-shared-agent-live-shadow-input-opener.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import {
  createFakeConversationShadowHarness,
} from "../../src/testing/fake-conversation-shadow-repository.ts";

const NOW = 1_800_300_000_000;
const SESSION = "10000000-0000-4000-8000-000000000298";
const ROOM = "20000000-0000-4000-8000-000000000298";
const NAMESPACE = "30000000-0000-4000-8000-000000000298";
const HUMAN = "40000000-0000-4000-8000-000000000298";
const DEVICE = "device_m298_sender";

async function createProfile(crypto: LatticeCrypto): Promise<Readonly<{
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  signingPublicKey: Uint8Array;
}>> {
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const v2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: DEVICE,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: 7,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(v2);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: DEVICE,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: DEVICE,
  });
  const coordinates: ClientProfileCoordinates = Object.freeze({
    serverScope: "https://m298.test",
    userId: "50000000-0000-4000-8000-000000000298",
    humanActorId: HUMAN,
    profileId: "profile_m298_sender",
    deviceId: DEVICE,
    installationLineageDigest: "98".repeat(32),
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({
    crypto,
    vault,
    coordinates,
    stageId: "stage_m298_sender",
    generation: 1,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "89".repeat(32),
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

function namespaceAuthority(input: Readonly<{
  generationKey: Uint8Array;
  headDigest: Uint8Array;
  audienceFingerprint: Uint8Array;
  keyClass?: "ai" | "human";
  omit?: boolean;
  onRequest?: (authority: readonly NamespaceGenerationAuthority[]) => void;
}>): NamespaceAuthorityClient {
  async function withOpenedGenerations<Value>(
    request: Readonly<{
      sourceRoomId: string;
      subjectHumanId: string;
      deviceSigningKeyGeneration: number;
      keyClass: "ai" | "human";
      authority: readonly NamespaceGenerationAuthority[];
    }>,
    use: (
      entries: readonly OpenedNamespaceGeneration[],
    ) => Promise<Value> | Value,
  ) {
    input.onRequest?.(request.authority);
    const entry: OpenedNamespaceGeneration = Object.freeze({
      namespaceId: namespaceId(NAMESPACE),
      keyClass: input.keyClass ?? "ai",
      accessRevision: accessRevision(2),
      generation: namespaceGeneration(3),
      generationKey: input.generationKey.slice(),
      audienceFingerprint: input.audienceFingerprint.slice(),
      headDigest: input.headDigest.slice(),
    });
    try {
      return Object.freeze({
        status: "opened" as const,
        value: await use(input.omit === true ? [] : [entry]),
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
      Object.freeze({ status: "unavailable" as const, reason: "wrong_path" }),
    withOpenedGenerations,
  });
}

function humanEditPlan(
  input: Readonly<{
    scheme?: "human_ai_readable_v1" | "human_peer_v1";
    roomId?: string;
    deviceId?: string;
    expectedRevision?: number;
    issuedAt?: number;
    deadlineAt?: number;
    targets?: number;
  }> = {},
): Uint8Array {
  const expectedRevision = input.expectedRevision ?? 0;
  const keyClass = input.scheme === "human_peer_v1" ? "human" : "ai";
  const operationId = "human-edit:v1:30000000-0000-4000-8000-000000000318";
  return encodeHumanMessageEditPlanV1({
    formatVersion: 1,
    purpose: "message.human_edit_plan",
    operationId,
    clientIdempotencyKey: "human_edit_client_m318",
    authorizationScheme: input.scheme ?? "human_ai_readable_v1",
    policyRevision: 40,
    roomId: input.roomId ?? ROOM,
    subjectHumanId: HUMAN,
    committerDeviceId: input.deviceId ?? DEVICE,
    committerDeviceSigningKeyGeneration: 1,
    hostAuthorizationRevision: 7,
    targets: Array.from({ length: input.targets ?? 1 }, (_, index) => ({
      sessionId: index === 0 ? SESSION : "10000000-0000-4000-8000-000000000299",
      messageId: 298 + index,
      expectedRevision,
      nextRevision: expectedRevision + 1,
      createdAt: NOW - index,
      namespaceId: NAMESPACE,
      keyClass,
      namespaceAccessRevision: 2,
      namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(0x31),
      namespacePublicationDigest: new Uint8Array(32).fill(0x32),
      namespacePublicationSetDigest: new Uint8Array(32).fill(0x33),
      namespaceAudienceFingerprint: new Uint8Array(32).fill(0x34),
      cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
        operationId,
        sessionId: index === 0 ? SESSION : "10000000-0000-4000-8000-000000000299",
        messageId: 298 + index,
        revision: expectedRevision + 1,
      }),
    })),
    issuedAt: input.issuedAt ?? NOW,
    deadlineAt: input.deadlineAt ?? NOW + 30_000,
  });
}

describe("M298 topology-neutral Human AI-readable write", () => {
  test("prepares a signed Full edit fanout without ordinary transport bytes", async () => {
    const crypto = new LatticeCrypto(seededRng(318_200));
    const profile = await createProfile(crypto);
    const generationKey = new Uint8Array(32).fill(0x98);
    const headDigest = new Uint8Array(32).fill(0x31);
    const publicationDigest = new Uint8Array(32).fill(0x32);
    const publicationSetDigest = new Uint8Array(32).fill(0x33);
    const audienceFingerprint = new Uint8Array(32).fill(0x34);
    const operationId = "human-edit:v1:30000000-0000-4000-8000-000000000318";
    const planBytes = encodeHumanMessageEditPlanV1({
      formatVersion: 1,
      purpose: "message.human_edit_plan",
      operationId,
      clientIdempotencyKey: "human_edit_client_m318",
      authorizationScheme: "human_ai_readable_v1",
      policyRevision: 40,
      roomId: ROOM,
      subjectHumanId: HUMAN,
      committerDeviceId: DEVICE,
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: 7,
      targets: [
        {
          sessionId: SESSION,
          messageId: 298,
          expectedRevision: 0,
          nextRevision: 1,
          createdAt: NOW,
          namespaceId: NAMESPACE,
          keyClass: "ai",
          namespaceAccessRevision: 2,
          namespaceKeyGeneration: 3,
          namespaceHeadDigest: headDigest,
          namespacePublicationDigest: publicationDigest,
          namespacePublicationSetDigest: publicationSetDigest,
          namespaceAudienceFingerprint: audienceFingerprint,
          cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
            operationId,
            sessionId: SESSION,
            messageId: 298,
            revision: 1,
          }),
        },
      ],
      issuedAt: NOW,
      deadlineAt: NOW + 30_000,
    });
    const prepared = await prepareVaultHumanMessageEdit({
      crypto,
      vault: profile.vault,
      coordinates: profile.coordinates,
      namespaceAuthority: namespaceAuthority({
        generationKey,
        headDigest,
        audienceFingerprint,
      }),
      planBytes,
      roomId: ROOM,
      messageId: 298,
      expectedRevision: 0,
      normalizedContent: "edited secret m318",
      now: NOW + 1,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") return;
    const signed = decodeHumanMessageEditRequestV1(prepared.value.requestBytes);
    expect(signed.targets).toHaveLength(1);
    expect(signed.targets[0]?.messageId).toBe(298);
    expect(prepared.value.targets).toHaveLength(1);
    expect(
      Buffer.from(prepared.value.targets[0]!.encryptedPayloadBytes).includes(
        Buffer.from("edited secret m318"),
      ),
    ).toBe(false);
    expect(
      verifyHumanMessageEditRequestV1(crypto, {
        requestBytes: prepared.value.requestBytes,
        planBytes,
        now: NOW + 1,
        resolveCurrentAuthority: () => profile.signingPublicKey,
      }).operationId,
    ).toBe(operationId);
    let publishedBody: unknown;
    const editClient = createAuthorizedHumanLiveShadowMessageClient({
      api: {
        planLiveShadowRoomMessage: () => Promise.reject(new Error("not used")),
        sendRoomMessage: () => Promise.reject(new Error("not used")),
        planProtectedHumanMessageEdit: () =>
          Promise.resolve({
            responseVersion: 1,
            status: "planned",
            representationMode: "full_encryption",
            planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          }),
        publishProtectedHumanMessageEdit: (_roomId, _messageId, body) => {
          publishedBody = body;
          return Promise.resolve({
            responseVersion: 1,
            status: "published",
            representationMode: "full_encryption",
            editRevision: 1,
            targets: [
              {
                sessionId: SESSION,
                messageId: 298,
                cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
                  operationId,
                  sessionId: SESSION,
                  messageId: 298,
                  revision: 1,
                }),
              },
            ],
          });
        },
      },
      crypto,
      vault: profile.vault,
      coordinates: profile.coordinates,
      journal: {} as never,
      ensureJournalAvailable: () => Promise.resolve(false),
      now: () => NOW + 1,
      createIdempotencyKey: () => "unused-edit-idempotency",
      normalizeContent: (content) => content.trim(),
      namespaceAuthority: namespaceAuthority({
        generationKey,
        headDigest,
        audienceFingerprint,
      }),
    });
    expect(
      await editClient.edit(ROOM, "298", {
        content: "  edited secret m318  ",
        expectedRevision: 0,
        clientIdempotencyKey: "human_edit_client_m318",
      }),
    ).toEqual({ content: "edited secret m318", editRevision: 1 });
    expect(JSON.stringify(publishedBody)).not.toContain("edited secret m318");
    planBytes.fill(0);
    prepared.value.requestBytes.fill(0);
    generationKey.fill(0);
  });

  test("prepares complete AI and Human-key edit fanouts", async () => {
    for (const scheme of ["human_ai_readable_v1", "human_peer_v1"] as const) {
      const crypto = new LatticeCrypto(
        seededRng(scheme === "human_peer_v1" ? 318_202 : 318_201),
      );
      const profile = await createProfile(crypto);
      const planBytes = humanEditPlan({ scheme, targets: 2 });
      let requestedAuthority: readonly NamespaceGenerationAuthority[] = [];
      const prepared = await prepareVaultHumanMessageEdit({
        crypto,
        vault: profile.vault,
        coordinates: profile.coordinates,
        namespaceAuthority: namespaceAuthority({
          generationKey: new Uint8Array(32).fill(0x98),
          headDigest: new Uint8Array(32).fill(0x31),
          audienceFingerprint: new Uint8Array(32).fill(0x34),
          keyClass: scheme === "human_peer_v1" ? "human" : "ai",
          onRequest: (authority) => {
            requestedAuthority = authority;
          },
        }),
        planBytes,
        roomId: ROOM,
        messageId: 298,
        expectedRevision: 0,
        normalizedContent: "two target secret",
        now: NOW + 1,
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") continue;
      const signed = decodeHumanMessageEditRequestV1(
        prepared.value.requestBytes,
      );
      expect(signed.authorizationScheme).toBe(scheme);
      expect(signed.targets.map((target) => target.messageId)).toEqual([
        298, 299,
      ]);
      expect(prepared.value.targets.map((target) => target.messageId)).toEqual([
        298, 299,
      ]);
      expect(requestedAuthority).toHaveLength(1);
      expect(requestedAuthority[0]?.retainedGenerations).toHaveLength(1);
      for (const [index, target] of prepared.value.targets.entries()) {
        expect(signed.targets[index]?.encryptedPayloadDigest).toEqual(
          crypto.hash(target.encryptedPayloadBytes),
        );
        expect(signed.targets[index]?.manifestDigest).toEqual(
          crypto.hash(target.accessManifestBytes),
        );
        expect(signed.targets[index]?.envelopeDigest).toEqual(
          crypto.hash(target.namespaceEnvelopeBytes),
        );
      }
    }
  });

  test("rejects stale edit plans and missing target custody before publish", async () => {
    const cases = [
      humanEditPlan({ roomId: "20000000-0000-4000-8000-000000000299" }),
      humanEditPlan({ deviceId: "wrong_device" }),
      humanEditPlan({ expectedRevision: 1 }),
      humanEditPlan({ issuedAt: NOW - 30_000, deadlineAt: NOW }),
    ];
    for (const [index, planBytes] of cases.entries()) {
      const crypto = new LatticeCrypto(seededRng(318_210 + index));
      const profile = await createProfile(crypto);
      const prepared = await prepareVaultHumanMessageEdit({
        crypto,
        vault: profile.vault,
        coordinates: profile.coordinates,
        namespaceAuthority: namespaceAuthority({
          generationKey: new Uint8Array(32).fill(0x98),
          headDigest: new Uint8Array(32).fill(0x31),
          audienceFingerprint: new Uint8Array(32).fill(0x34),
        }),
        planBytes,
        roomId: ROOM,
        messageId: 298,
        expectedRevision: 0,
        normalizedContent: "draft remains local",
        now: NOW + 1,
      });
      expect(prepared).toMatchObject({ status: "unavailable" });
    }

    let publishCalls = 0;
    let ordinaryCalls = 0;
    const crypto = new LatticeCrypto(seededRng(318_220));
    const profile = await createProfile(crypto);
    const planBytes = humanEditPlan();
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: {
        planLiveShadowRoomMessage: () => Promise.reject(new Error("unused")),
        sendRoomMessage: () => {
          ordinaryCalls += 1;
          return Promise.reject(new Error("forbidden"));
        },
        planProtectedHumanMessageEdit: () =>
          Promise.resolve({
            responseVersion: 1,
            status: "planned",
            representationMode: "full_encryption",
            planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          }),
        publishProtectedHumanMessageEdit: () => {
          publishCalls += 1;
          return Promise.reject(new Error("forbidden"));
        },
      },
      crypto,
      vault: profile.vault,
      coordinates: profile.coordinates,
      journal: {} as never,
      ensureJournalAvailable: () => Promise.resolve(false),
      now: () => NOW + 1,
      createIdempotencyKey: () => "human_edit_client_m318",
      normalizeContent: (content) => content.trim(),
      namespaceAuthority: namespaceAuthority({
        generationKey: new Uint8Array(32).fill(0x98),
        headDigest: new Uint8Array(32).fill(0x31),
        audienceFingerprint: new Uint8Array(32).fill(0x34),
        omit: true,
      }),
    });
    expect(
      client.edit(ROOM, "298", {
        content: "  draft remains local  ",
        expectedRevision: 0,
      }),
    ).rejects.toThrow("protected_edit_namespace_unavailable");
    expect({ publishCalls, ordinaryCalls }).toEqual({
      publishCalls: 0,
      ordinaryCalls: 0,
    });
  });

  test("replays exact prepared edit bytes after response loss and validates success", async () => {
    const crypto = new LatticeCrypto(seededRng(318_230));
    const profile = await createProfile(crypto);
    const planBytes = humanEditPlan();
    const operationId = "human-edit:v1:30000000-0000-4000-8000-000000000318";
    const publishedBodies: unknown[] = [];
    let planCalls = 0;
    let ordinaryCalls = 0;
    const successfulTarget = {
      sessionId: SESSION,
      messageId: 298,
      cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
        operationId,
        sessionId: SESSION,
        messageId: 298,
        revision: 1,
      }),
    };
    let malformed: "none" | "revision" | "target" | "object" = "none";
    const client = createAuthorizedHumanLiveShadowMessageClient({
      api: {
        planLiveShadowRoomMessage: () => Promise.reject(new Error("unused")),
        sendRoomMessage: () => {
          ordinaryCalls += 1;
          return Promise.reject(new Error("forbidden"));
        },
        planProtectedHumanMessageEdit: () => {
          planCalls += 1;
          return Promise.resolve({
            responseVersion: 1,
            status: "planned",
            representationMode: "full_encryption",
            planBytesBase64url: Buffer.from(planBytes).toString("base64url"),
          });
        },
        publishProtectedHumanMessageEdit: (_roomId, _messageId, body) => {
          publishedBodies.push(structuredClone(body));
          if (publishedBodies.length === 1) {
            return Promise.reject(new Error("response lost after commit"));
          }
          return Promise.resolve({
            responseVersion: 1,
            status: "published",
            representationMode: "full_encryption",
            editRevision: malformed === "revision" ? 7 : 1,
              targets: [malformed === "target"
                ? { ...successfulTarget, messageId: 999 }
                : malformed === "object"
                  ? { ...successfulTarget, cryptoObjectId: "message:v2:wrong" }
                  : successfulTarget],
          });
        },
      },
      crypto,
      vault: profile.vault,
      coordinates: profile.coordinates,
      journal: {} as never,
      ensureJournalAvailable: () => Promise.resolve(false),
      now: () => NOW + 1,
      createIdempotencyKey: () => "human_edit_client_m318",
      normalizeContent: (content) => content.trim().replaceAll(/\s+/gu, " "),
      namespaceAuthority: namespaceAuthority({
        generationKey: new Uint8Array(32).fill(0x98),
        headDigest: new Uint8Array(32).fill(0x31),
        audienceFingerprint: new Uint8Array(32).fill(0x34),
      }),
    });
    const draft = { content: "  exact   signed bytes  ", expectedRevision: 0 };
    expect(await client.edit(ROOM, "298", draft)).toEqual({
      content: "exact signed bytes",
      editRevision: 1,
    });
    expect(planCalls).toBe(1);
    expect(publishedBodies).toHaveLength(2);
    expect(publishedBodies[1]).toEqual(publishedBodies[0]);
    expect(JSON.stringify(publishedBodies)).not.toContain("exact signed bytes");
    expect(ordinaryCalls).toBe(0);
    expect(draft.content).toBe("  exact   signed bytes  ");

    for (const invalid of ["revision", "target", "object"] as const) {
      malformed = invalid;
      publishedBodies.length = 1;
      expect(client.edit(ROOM, "298", draft)).rejects.toThrow(
        "protected_edit_response_invalid",
      );
    }
    expect(ordinaryCalls).toBe(0);
  });
  test.each([1, 2] as const)("Browser prepares and server admits V%s bytes without an Agent identity", async (formatVersion) => {
    const crypto = new LatticeCrypto(seededRng(298_100));
    const profile = await createProfile(crypto);
    const generationKey = new Uint8Array(32).fill(0x98);
    const headDigest = new Uint8Array(32).fill(0x31);
    const publicationDigest = new Uint8Array(32).fill(0x32);
    const publicationSetDigest = new Uint8Array(32).fill(0x33);
    const audienceFingerprint = new Uint8Array(32).fill(0x34);
    const planBytes = encodeHumanAiReadableLiveShadowMessagePlan({
      formatVersion,
      purpose: "message.human_ai_readable_live_shadow_plan",
      operationId: "human_ai_readable_operation_m298",
      clientIdempotencyKey: "human_ai_readable_client_m298",
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      humanMessageId: 298,
      revision: 0,
      transcriptOrdinal: 1,
      role: "user",
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(HUMAN),
      committerDeviceId: cryptoDeviceId(DEVICE),
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
      attemptCoordinate: "human_ai_readable_attempt_m298",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + (formatVersion === 2 ? 300_000 : 30_000)),
    });
    const prepared = await prepareVaultHumanAiReadableLiveShadowMessage({
      crypto,
      vault: profile.vault,
      coordinates: profile.coordinates,
      namespaceAuthority: namespaceAuthority({
        generationKey,
        headDigest,
        audienceFingerprint,
      }),
      planBytes,
      normalizedContent: "Runtime principal protected hello",
      now: NOW + 1,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error(prepared.reason);

    if (formatVersion === 2) {
      const lateInput = {
        crypto, expectedPlanBytes: planBytes,
        requestBytes: prepared.value.requestBytes,
        ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
        encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
        manifestBytes: prepared.value.accessManifestBytes,
        envelopeBytes: prepared.value.namespaceEnvelopeBytes,
        resolveCurrentHumanAuthority: () => profile.signingPublicKey.slice(),
      };
      const late = await admitHumanAiReadableLiveShadowMessage({
        ...lateInput, now: NOW + 299_999,
      });
      expect(late.plan.formatVersion).toBe(2);
      expect(late.plan.deadlineAt).toBe(unixTimestamp(NOW + 300_000));
      expect(admitHumanAiReadableLiveShadowMessage({
        ...lateInput, now: NOW + 300_000,
      })).rejects.toThrow("not currently valid");
      expect(admitHumanAiReadableLiveShadowMessage({
        ...lateInput, now: NOW + 299_999, resolveCurrentHumanAuthority: () => null,
      })).rejects.toThrow("authority is unavailable");
    }

    const admitted = await admitHumanAiReadableLiveShadowMessage({
      crypto,
      expectedPlanBytes: planBytes,
      requestBytes: prepared.value.requestBytes,
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
      resolveCurrentHumanAuthority: () => profile.signingPublicKey.slice(),
    });

    const protectedOnly = await admitHumanAiReadableLiveShadowMessage({
      crypto,
      contentRepresentation: "full",
      expectedPlanBytes: planBytes,
      requestBytes: prepared.value.requestBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
      resolveCurrentHumanAuthority: () => profile.signingPublicKey.slice(),
    });
    expect(protectedOnly).toMatchObject({
      contentRepresentation: "full",
      contentVerification: "signed_representation_authenticated",
      ordinaryContent: null,
    });
    const fullHarness = createFakeConversationShadowHarness({
      crypto, now: () => new Date(NOW + 1),
    });
    fullHarness.product.addSession({
      sessionId: SESSION, roomId: ROOM, namespaceId: NAMESPACE,
    });
    const full = await admitAndPersistHumanAiReadableLiveShadowMessage({
      crypto,
      product: fullHarness.product,
      sourceUserId: profile.coordinates.userId,
      conversation: createDormantConversationShadowRepository({
        product: fullHarness.product,
        crypto: fullHarness.crypto,
      }),
      resolveCurrentHumanAuthority: () => profile.signingPublicKey.slice(),
      senderDeviceSigningPublicKey: profile.signingPublicKey,
    }, {
      representationMode: "full_encryption",
      operationId: "human_ai_readable_operation_m298",
      planBytes,
      requestBytes: prepared.value.requestBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
    });
    expect(full).toMatchObject({
      status: "human_verified",
      representationMode: "full_encryption",
      protectedMessage: { projection: {
        sourceUserId: "50000000-0000-4000-8000-000000000298",
      } },
    });
    expect(admitHumanAiReadableLiveShadowMessage({
      crypto,
      contentRepresentation: "full",
      ordinaryPayloadBytes: prepared.value.ordinaryPayloadBytes,
      expectedPlanBytes: planBytes,
      requestBytes: prepared.value.requestBytes,
      encryptedPayloadBytes: prepared.value.encryptedPayloadBytes,
      manifestBytes: prepared.value.accessManifestBytes,
      envelopeBytes: prepared.value.namespaceEnvelopeBytes,
      now: NOW + 1,
      resolveCurrentHumanAuthority: () => profile.signingPublicKey.slice(),
    } as never)).rejects.toThrow("forbids an ordinary payload sibling");

    expect(admitted.ordinaryContent).toBe(
      "Runtime principal protected hello",
    );
    expect(admitted.plan.roomId).toBe(ROOM);
    expect(admitted.plan).not.toHaveProperty("recipientAgentId");
    expect(admitted.prepared.keyClass).toBe("ai");

    const recipientAgentId = "35000000-0000-4000-8000-000000000298";
    const runtime = Object.freeze({
      agentId: agentId(recipientAgentId),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(0),
      key: new Uint8Array(32).fill(0x99),
    });
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const executionId = "runtime_execution_m298";
    const inputSetDigest = humanAiReadableLiveShadowExecutionInputSetDigest(
      crypto,
      [{ operationId: admitted.plan.operationId, messageId: 298 }],
    );
    const executionPlanBytes = encodeLiveShadowMessagePlanV4({
      formatVersion: 4,
      purpose: "message.live_shadow_plan",
      operationId: executionId,
      policyRevision: 4,
      sessionId: SESSION,
      roomId: ROOM,
      humanMessageId: 298,
      revision: 0,
      createdAt: unixTimestamp(NOW),
      subjectHumanId: humanId(HUMAN),
      committerDeviceId: cryptoDeviceId(DEVICE),
      committerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: authorizationRevision(7),
      recipientAgentId: runtime.agentId,
      agentAuthorizationRevision: authorizationRevision(0),
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
      grantDomainId: "grant_domain_m298_runtime",
      grantDomainParticipantDigest: new Uint8Array(32).fill(0x41),
      grantDomainKeyGeneration: 1,
      grantDomainHeadDigest: new Uint8Array(32).fill(0x42),
      grantDomainPublicationDigest: new Uint8Array(32).fill(0x43),
      grantDomainAuthorizationRevision: authorizationRevision(1),
      namespaceBundleGrantDomainAuthorizationRevision:
        authorizationRevision(1),
      namespaceBundleRevision: 1,
      namespaceBundleDigest: new Uint8Array(32).fill(0x44),
      authorization: {
        disposition: "authorization_reusable",
        sessionReference: "runtime_session_m298",
        authorizationDigest: new Uint8Array(32).fill(0x45),
      },
      attemptCoordinate: "runtime_execution_attempt_m298",
      issuedAt: unixTimestamp(NOW + 1),
      deadlineAt: unixTimestamp(NOW + 30_000),
    });
    const executionPlan = decodeLiveShadowMessagePlanV4(executionPlanBytes);
    const product = {
      query: (statement: string) => {
        if (statement.includes("m296_shared_agent_input_execution")) {
          return Promise.resolve([{
            execution_id: executionId,
            invocation_id: "runtime_invocation_m298",
            state: "authorized",
            policy_revision: 4,
            session_id: SESSION,
            room_id: ROOM,
            agent_id: recipientAgentId,
            invoking_human_id: HUMAN,
            invoking_device_id: DEVICE,
            input_count: 1,
            input_set_digest: inputSetDigest,
          }]);
        }
        if (statement.includes("m296_shared_agent_protected_inputs")) {
          return Promise.resolve([{
            input_ordinal: 1,
            human_operation_id: admitted.plan.operationId,
            message_id: 298,
            operation_state: "published",
            conductor_state: "selected",
            policy_revision: 4,
            room_id: ROOM,
            agent_id: null,
            subject_human_id: HUMAN,
            committer_device_id: DEVICE,
            committer_device_signing_key_generation: 1,
            host_authorization_revision: 7,
            namespace_id: NAMESPACE,
            namespace_access_revision: 2,
            namespace_key_generation: 3,
            namespace_head_digest: headDigest,
            namespace_publication_digest: publicationDigest,
            namespace_publication_set_digest: publicationSetDigest,
            namespace_audience_fingerprint: audienceFingerprint,
            crypto_object_id: admitted.prepared.objectId,
            plan_bytes: planBytes,
            human_request_bytes: prepared.value.requestBytes,
            human_request_digest: prepared.value.requestDigest,
            protected_message_digest: crypto.hash(
              prepared.value.encryptedPayloadBytes,
            ),
            content: "Runtime principal protected hello",
            mapped_object_id: admitted.prepared.objectId,
            mapped_operation_id: admitted.plan.operationId,
            crypto_completion: "complete",
            crypto_disposition: "mapped",
            parity_status: "client_verified",
            key_class: "ai",
            author_role: "user",
            object_id_scheme: "live_shadow_v1",
            representation_mode: "shadow_encryption",
            publication_policy_revision: null,
          }]);
        }
        if (statement.includes("m318_shared_agent_input_representation_origins")) {
          return Promise.resolve([{
            representation_mode: "shadow_encryption",
            publication_policy_revision: null,
            mode: "shadow_encryption",
            current_policy_revision: executionPlan.policyRevision,
          }]);
        }
        return Promise.reject(new Error("unexpected product query"));
      },
    } as unknown as PostgresJsBridgeConnection;
    const restricted = {
      query: (statement: string) => statement.includes(
          "m296_shared_agent_input_signers"
        )
        ? Promise.resolve([{
            device_id: DEVICE,
            device_generation: 1,
            signing_public_key: profile.signingPublicKey,
          }])
        : Promise.reject(new Error("unexpected restricted query")),
    } as unknown as PostgresJsBridgeConnection;
    const storage = {
      getObject: () => Promise.resolve({
        payloadBytes: prepared.value.encryptedPayloadBytes.slice(),
      }),
      getObjectAccessState: () => Promise.resolve({
        head: { manifestBytes: prepared.value.accessManifestBytes.slice() },
        namespaceEnvelopes: [{
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
      expectedMergedContent: "Runtime principal protected hello",
    })).toEqual({
      status: "verified",
      inputCount: 1,
      mergedContent: "Runtime principal protected hello",
      causalHumanTurnId: admitted.plan.operationId,
    });
  });
});
