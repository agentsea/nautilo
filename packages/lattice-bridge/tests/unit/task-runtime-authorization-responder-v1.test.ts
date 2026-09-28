import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  withOpenedDomainForegroundAuthorization,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import { tryRespondToCurrentTaskRuntimeAuthorizationV1 } from
  "../../src/client/background/task-runtime-authorization-responder-v1.ts";
import type { DomainForegroundAuthorityClientV2 } from
  "../../src/client/message/domain-foreground-authority-client.ts";

const NOW = 1_900_000_000_000;
const HUMAN_ID = "20000000-0000-4000-8000-000000000907";
const DEVICE_ID = "task-runtime-device-907";
const ROOM_ID = "task-runtime-room-907";
const EPISODE_ID = "task-runtime-episode-907";
const RECIPIENT_GENERATION = 4;
const DEVICE_GENERATION = 7;
const POLICY_REVISION = 11;
const HOST_AUTHORIZATION_REVISION = 13;

const DOMAIN: DomainForegroundAuthorityEntry = Object.freeze({
  domainId: "task-runtime-domain-907",
  sourceNamespaceId: "task-runtime-namespace-907",
  participantDigest: new Uint8Array(32).fill(0x31),
  participantCount: 2,
  keyClass: "ai",
  domainKeyGeneration: 3,
  authorizationRevision: authorizationRevision(5),
  headDigest: new Uint8Array(32).fill(0x32),
  activeNamespaceBindingSetDigest: new Uint8Array(32).fill(0x33),
  activeNamespaceBindingCount: 1,
});

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(907_407), { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "task-runtime-authorization-907",
    policyRevision: POLICY_REVISION,
    sessionId: EPISODE_ID,
    roomId: ROOM_ID,
    subjectHumanId: humanId(HUMAN_ID),
    committerDeviceId: cryptoDeviceId(DEVICE_ID),
    committerDeviceSigningGeneration: DEVICE_GENERATION,
    hostAuthorizationRevision: authorizationRevision(
      HOST_AUTHORIZATION_REVISION,
    ),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: RECIPIENT_GENERATION,
    recipientKeyId: "task-runtime-recipient-key-907",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 300_000,
    maximumSecretBytes: 1024,
    domains: [DOMAIN],
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: plan.authorizationId,
    workId: "task-run-907",
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: RECIPIENT_GENERATION,
    episodeId: EPISODE_ID,
    sourceRoomId: ROOM_ID,
    recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: plan.issuedAt,
    deadlineAt: plan.deadlineAt,
  });
  const requestBytes = encodeTaskRuntimeBackgroundAuthorizationRequestV1(
    request,
  );
  destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
  return { crypto, signer, recipient, plan, requestBytes };
}

function domainAuthority(observedRooms: string[]):
  DomainForegroundAuthorityClientV2 {
  return Object.freeze({
    async withOpenedAuthorizationDomains<Value>(
      request: Parameters<
        DomainForegroundAuthorityClientV2[
          "withOpenedAuthorizationDomains"
        ]
      >[0],
      use: (domains: readonly DomainForegroundSecretEntry[]) =>
        Value | Promise<Value>,
    ) {
      observedRooms.push(request.sourceRoomId);
      const secret: DomainForegroundSecretEntry = Object.freeze({
        ...DOMAIN,
        participantDigest: DOMAIN.participantDigest.slice(),
        headDigest: DOMAIN.headDigest.slice(),
        domainKey: new Uint8Array(32).fill(0x34),
      });
      try {
        return Object.freeze({
          status: "opened" as const,
          value: await use(Object.freeze([secret])),
        });
      } finally {
        secret.participantDigest.fill(0);
        secret.headDigest.fill(0);
        secret.domainKey.fill(0);
      }
    },
    withOpenedTurnAuthority: () => Promise.reject(new Error("unused")),
    withOpenedReusableTurnRoomKey: () => Promise.reject(
      new Error("unused"),
    ),
  });
}

describe("Task Runtime device authorization responder", () => {
  test("mints the existing Runtime authorization for the exact current device and Domain set", async () => {
    const value = await fixture();
    const observedRooms: string[] = [];
    let borrowedSigningKey: Uint8Array | undefined;
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority(observedRooms),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async (use) => {
          borrowedSigningKey = value.signer.privateKey.slice();
          try {
            return await use({
              issuer: {
                humanId: HUMAN_ID,
                deviceId: DEVICE_ID,
                deviceGeneration: DEVICE_GENERATION,
                serverInstanceId:
                  "10000000-0000-4000-8000-000000000907",
                lineageGeneration: 2,
                epoch: 3,
                securityRevision: 4,
                headDigest: new Uint8Array(32).fill(0x41),
                signingPublicKeyHash: value.crypto.hash(
                  value.signer.publicKey,
                ),
              },
              signingPrivateKey: borrowedSigningKey,
              policyRevision: POLICY_REVISION,
              hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
            });
          } finally {
            borrowedSigningKey.fill(0);
          }
        },
      });

      expect(result.status).toBe("ready");
      expect(observedRooms).toEqual([ROOM_ID]);
      expect(borrowedSigningKey?.every((byte) => byte === 0)).toBe(true);
      if (result.status !== "ready") return;
      expect(result).toMatchObject({
        requestId: value.plan.authorizationId,
        recipientGeneration: RECIPIENT_GENERATION,
        expiresAt: value.plan.deadlineAt,
      });
      expect(await withOpenedDomainForegroundAuthorization(value.crypto, {
        authorizationBytes: result.responseBytes,
        now: NOW + 2,
        current: {
          authorizationId: value.plan.authorizationId,
          policyRevision: POLICY_REVISION,
          sessionId: EPISODE_ID,
          roomId: ROOM_ID,
          subjectHumanId: humanId(HUMAN_ID),
          committerDeviceId: cryptoDeviceId(DEVICE_ID),
          committerDeviceSigningGeneration: DEVICE_GENERATION,
          committerDeviceSigningPublicKey: value.signer.publicKey,
          committerDeviceActive: true,
          hostAuthorizationRevision: authorizationRevision(
            HOST_AUTHORIZATION_REVISION,
          ),
          recipientKind: "runtime",
          recipientPrincipalId: "nautilo_task_runtime",
          recipientAuthorizationRevision: authorizationRevision(0),
          recipientRuntimeGeneration: RECIPIENT_GENERATION,
          recipientKeyId: value.plan.recipientKeyId,
          recipientEncryptionPrivateKey: value.recipient.privateKey,
          recipientAuthorized: true,
          domains: [DOMAIN],
        },
        operation: (entries) => entries.length,
      })).toEqual({ status: "opened", value: 1 });
      result.responseBytes.fill(0);
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
      value.requestBytes.fill(0);
      value.signer.privateKey.fill(0);
      value.recipient.privateKey.fill(0);
    }
  });

  test("refuses changed current-device authority after opening exact Domains", async () => {
    const value = await fixture();
    const observedRooms: string[] = [];
    try {
      const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
        requestBytes: value.requestBytes,
        domainForegroundAuthority: domainAuthority(observedRooms),
        crypto: value.crypto,
        now: () => NOW + 1,
        withCurrentSigningAuthority: async (use) => use({
          issuer: {
            humanId: HUMAN_ID,
            deviceId: DEVICE_ID,
            deviceGeneration: DEVICE_GENERATION + 1,
            serverInstanceId: "10000000-0000-4000-8000-000000000907",
            lineageGeneration: 2,
            epoch: 3,
            securityRevision: 4,
            headDigest: new Uint8Array(32).fill(0x41),
            signingPublicKeyHash: value.crypto.hash(value.signer.publicKey),
          },
          signingPrivateKey: value.signer.privateKey,
          policyRevision: POLICY_REVISION,
          hostAuthorizationRevision: HOST_AUTHORIZATION_REVISION,
        }),
      });
      expect(result).toEqual({
        status: "stale",
        reason: "device_authority_changed",
      });
      expect(observedRooms).toEqual([ROOM_ID]);
    } finally {
      destroyDomainForegroundAuthorizationPlanV2(value.plan);
      value.requestBytes.fill(0);
      value.signer.privateKey.fill(0);
      value.recipient.privateKey.fill(0);
    }
  });

  test("leaves non-Task carriers for the existing processor responder", async () => {
    let authorityOpened = false;
    const processorCarrier = Uint8Array.of(1, 2, 3);
    const originalCarrier = processorCarrier.slice();
    const result = await tryRespondToCurrentTaskRuntimeAuthorizationV1({
      requestBytes: processorCarrier,
      domainForegroundAuthority: {
        ...domainAuthority([]),
        withOpenedAuthorizationDomains: () => {
          authorityOpened = true;
          return Promise.reject(new Error("must not open"));
        },
      },
      crypto: new LatticeCrypto(seededRng(907_408)),
      now: () => NOW,
      withCurrentSigningAuthority: () => Promise.reject(
        new Error("must not open"),
      ),
    });
    expect(result).toEqual({ status: "not_task_runtime" });
    expect(processorCarrier).toEqual(originalCarrier);
    expect(authorityOpened).toBe(false);
  });
});
