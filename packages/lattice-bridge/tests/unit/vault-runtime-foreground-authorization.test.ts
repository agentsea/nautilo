import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  unixTimestamp,
  type DomainForegroundAuthorityEntry,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationV2,
  serializeDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  prepareVaultRuntimeForegroundAuthorization,
  prepareVaultTaskRuntimeAuthorization,
} from "../../src/client/message/vault-runtime-foreground-authorization.ts";
import type { DomainForegroundAuthorityClientV2 } from
  "../../src/client/message/domain-foreground-authority-client.ts";
import { MemoryClientProfileVault } from
  "../../src/testing/client-profile-vault.ts";
import {
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
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
import type { ClientProfileCoordinates } from
  "../../src/client-vault/types.ts";

const NOW = 1_800_000_000_000;
const EPISODE_ID = "task-runtime-episode-1";
const SOURCE_ROOM_ID = "task-runtime-source-room-1";
const DEVICE_ID = "task-runtime-device-1";
const HUMAN_ID = "20000000-0000-4000-8000-000000000907";
const COORDINATES: ClientProfileCoordinates = Object.freeze({
  serverScope: "https://task-runtime.test",
  userId: "10000000-0000-4000-8000-000000000907",
  humanActorId: HUMAN_ID,
  profileId: "task-runtime-profile-1",
  deviceId: DEVICE_ID,
  installationLineageDigest: "71".repeat(32),
});

const DOMAIN: DomainForegroundAuthorityEntry = Object.freeze({
  domainId: "task-runtime-domain-1",
  sourceNamespaceId: "task-runtime-namespace-1",
  participantDigest: new Uint8Array(32).fill(0x31),
  participantCount: 1,
  keyClass: "ai",
  domainKeyGeneration: 1,
  authorizationRevision: authorizationRevision(1),
  headDigest: new Uint8Array(32).fill(0x32),
  activeNamespaceBindingSetDigest: new Uint8Array(32).fill(0x33),
  activeNamespaceBindingCount: 1,
});

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(907_401), { now: () => NOW });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const v2: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: DEVICE_ID,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 1,
    trustedHostAuthorizationRevision: 1,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const v2Bytes = encodeClientDeviceProfileV2(v2);
  const v3 = await createClientDeviceProfileV3Candidate({
    crypto,
    currentProfileBytes: v2Bytes,
    expectedDeviceId: DEVICE_ID,
  });
  const v3Bytes = encodeClientDeviceProfileV3(v3);
  const v4 = await createClientDeviceProfileV4Candidate({
    crypto,
    currentProfileBytes: v3Bytes,
    expectedDeviceId: DEVICE_ID,
  });
  const vault = new MemoryClientProfileVault();
  await vault.unlock();
  await stageAndActivateClientDeviceProfileV4({
    crypto,
    vault,
    coordinates: COORDINATES,
    stageId: "task-runtime-stage-1",
    generation: 1,
    publicState: {
      clientKind: "browser",
      publicFingerprint: "72".repeat(32),
    },
    candidate: v4,
  });
  destroyOpenedClientDeviceProfileV4(v4);
  destroyOpenedClientDeviceProfileV3(v3);
  v2Bytes.fill(0);
  v3Bytes.fill(0);
  const recipient = await crypto.generateEncryptionKeyPair();
  return { crypto, vault, recipient };
}

function planBytes(
  crypto: LatticeCrypto,
  overrides: Readonly<{
    sessionId?: string;
    roomId?: string;
    recipientPrincipalId?: string;
    subjectHumanId?: string;
    committerDeviceId?: string;
  }> = {},
): Uint8Array {
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: "task-runtime-authorization-1",
    policyRevision: 1,
    sessionId: overrides.sessionId ?? EPISODE_ID,
    roomId: overrides.roomId ?? SOURCE_ROOM_ID,
    subjectHumanId: humanId(overrides.subjectHumanId ?? HUMAN_ID),
    committerDeviceId: cryptoDeviceId(
      overrides.committerDeviceId ?? DEVICE_ID,
    ),
    committerDeviceSigningGeneration: 1,
    hostAuthorizationRevision: authorizationRevision(1),
    recipientKind: "runtime",
    recipientPrincipalId:
      overrides.recipientPrincipalId ?? "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(0),
    recipientRuntimeGeneration: 0,
    recipientKeyId: "task-runtime-recipient-key-1",
    operations: ["decrypt", "encrypt"],
    issuedAt: unixTimestamp(NOW),
    deadlineAt: unixTimestamp(NOW + 5 * 60_000),
    maximumSecretBytes: 1024,
    domains: Object.freeze([DOMAIN]),
  });
  try {
    return serializeDomainForegroundAuthorizationPlanV2(plan);
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

function domainAuthority(
  available = true,
  observe?: (sourceRoomId: string) => void,
): DomainForegroundAuthorityClientV2 {
  return Object.freeze({
    async withOpenedAuthorizationDomains<Value>(request: Readonly<{
      sourceRoomId: string;
      domains: readonly DomainForegroundAuthorityEntry[];
    }>, use: (domains: readonly DomainForegroundSecretEntry[]) =>
      Value | Promise<Value>) {
      observe?.(request.sourceRoomId);
      if (!available) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "authority_stale",
        });
      }
      return Object.freeze({
        status: "opened" as const,
        value: await use(Object.freeze([Object.freeze({
          ...DOMAIN,
          participantDigest: DOMAIN.participantDigest.slice(),
          headDigest: DOMAIN.headDigest.slice(),
          domainKey: new Uint8Array(32).fill(0x34),
        })])),
      });
    },
    withOpenedTurnAuthority: () => Promise.reject(new Error("unused")),
    withOpenedReusableTurnRoomKey: () => Promise.reject(new Error("unused")),
  });
}

describe("vault Task Runtime authorization", () => {
  test("preserves foreground acceptance while authorizing the exact Task episode", async () => {
    const { crypto, vault, recipient } = await fixture();
    const foregroundBytes = planBytes(crypto, {
      recipientPrincipalId: "existing-foreground-principal",
    });
    const foreground = await prepareVaultRuntimeForegroundAuthorization({
      crypto,
      vault,
      coordinates: COORDINATES,
      domainForegroundAuthority: domainAuthority(),
      authorizationPlanBytes: foregroundBytes,
      recipientPublicKey: recipient.publicKey,
      browserSessionId: EPISODE_ID,
      now: NOW + 1,
    });
    expect(foreground.status).toBe("prepared");

    const taskBytes = planBytes(crypto);
    const task = await prepareVaultTaskRuntimeAuthorization({
      crypto,
      vault,
      coordinates: COORDINATES,
      domainForegroundAuthority: domainAuthority(),
      authorizationPlanBytes: taskBytes,
      recipientPublicKey: recipient.publicKey,
      authorizationEpisodeId: EPISODE_ID,
      sourceRoomId: SOURCE_ROOM_ID,
      now: NOW + 1,
    });
    expect(task.status).toBe("prepared");
    if (task.status === "prepared") {
      const parsed = parseDomainForegroundAuthorizationV2(
        task.authorizationBytes,
      );
      expect(parsed).not.toBeNull();
      if (parsed !== null) destroyDomainForegroundAuthorizationV2(parsed);
      task.authorizationBytes.fill(0);
      task.authorizationDigest.fill(0);
    }
    if (foreground.status === "prepared") {
      foreground.authorizationBytes.fill(0);
      foreground.authorizationDigest.fill(0);
    }
    foregroundBytes.fill(0);
    taskBytes.fill(0);
    recipient.publicKey.fill(0);
    recipient.privateKey.fill(0);
  });

  test.each([
    ["session", { sessionId: "other-task-runtime-episode" }],
    ["source Room", { roomId: "other-task-runtime-room" }],
    ["principal", { recipientPrincipalId: "nautilo_foreground_runtime" }],
    ["device", { committerDeviceId: "other-task-runtime-device" }],
    ["Human", { subjectHumanId: "20000000-0000-4000-8000-000000000335" }],
  ] as const)("rejects a plan for the wrong %s before opening authority", async (
    _label,
    overrides,
  ) => {
    const { crypto, vault, recipient } = await fixture();
    const bytes = planBytes(crypto, overrides);
    let opens = 0;
    const result = await prepareVaultTaskRuntimeAuthorization({
      crypto,
      vault,
      coordinates: COORDINATES,
      domainForegroundAuthority: domainAuthority(true, () => { opens += 1; }),
      authorizationPlanBytes: bytes,
      recipientPublicKey: recipient.publicKey,
      authorizationEpisodeId: EPISODE_ID,
      sourceRoomId: SOURCE_ROOM_ID,
      now: NOW + 1,
    });
    expect(result).toEqual({ status: "unavailable", reason: "plan_stale" });
    expect(opens).toBe(0);
    bytes.fill(0);
    recipient.publicKey.fill(0);
    recipient.privateKey.fill(0);
  });

  test("rejects stale Domain authority for the exact Task binding", async () => {
    const { crypto, vault, recipient } = await fixture();
    const bytes = planBytes(crypto);
    const openedRooms: string[] = [];
    const result = await prepareVaultTaskRuntimeAuthorization({
      crypto,
      vault,
      coordinates: COORDINATES,
      domainForegroundAuthority: domainAuthority(
        false,
        (sourceRoomId) => { openedRooms.push(sourceRoomId); },
      ),
      authorizationPlanBytes: bytes,
      recipientPublicKey: recipient.publicKey,
      authorizationEpisodeId: EPISODE_ID,
      sourceRoomId: SOURCE_ROOM_ID,
      now: NOW + 1,
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "domain_unavailable",
    });
    expect(openedRooms).toEqual([SOURCE_ROOM_ID]);
    bytes.fill(0);
    recipient.publicKey.fill(0);
    recipient.privateKey.fill(0);
  });
});
