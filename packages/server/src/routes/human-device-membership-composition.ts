import {
  createPostgresJsBridgeConnection,
  getSharedDirectCryptoDb,
} from "@nautilo/db";
import {
  LatticeCrypto,
  cryptoDeviceId,
  decodeHumanDeviceGroupHead,
} from "@nautilo/lattice-crypto";
import { nautiloActorId, nautiloUserId } from "@nautilo/lattice-bridge";
import type { PinChallengeProvider } from "@nautilo/trust";
import {
  AdditionalDeviceEnrollmentService,
  destroyEnrollmentAuthorization,
  destroyPendingAdditionalDeviceEnrollment,
  enrollmentDto,
  PostgresAdditionalDeviceEnrollmentRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresRecoveryChallengeRepository,
  prepareEnrollmentAuthorization,
  resolveAdditionalDevicePersonalAuthorityAnchor,
  verifyCryptoPostgresHandle,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

import type { HumanDeviceMembershipComposition } from
  "./human-device-membership";
import { getServerDirectDb } from "../lib/server-direct-db";

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createProductionHumanDeviceMembershipComposition(
  pinProvider: Pick<PinChallengeProvider, "verifyProof">,
): HumanDeviceMembershipComposition {
  let connection: ReturnType<typeof createPostgresJsBridgeConnection> | null =
    null;
  let handlePromise: Promise<CryptoPostgresHandle> | null = null;
  const getHandle = () => {
    connection ??= createPostgresJsBridgeConnection(getSharedDirectCryptoDb());
    handlePromise ??= verifyCryptoPostgresHandle(connection);
    return handlePromise;
  };
  let productConnection:
    ReturnType<typeof createPostgresJsBridgeConnection> | null = null;
  const getProduct = () => {
    productConnection ??= createPostgresJsBridgeConnection(getServerDirectDb());
    return productConnection;
  };
  const crypto = new LatticeCrypto();
  const repository = async () =>
    new PostgresHumanDeviceGroupRepository(await getHandle(), crypto);

  const composition: HumanDeviceMembershipComposition = {
    async status(input) {
      const result = await (await repository()).status({
        ...input.authority,
        humanId: input.authority.humanActorId,
        deviceId: input.request.deviceId,
        ...(input.request.afterSequence === undefined ? {} : {
          afterSequence: input.request.afterSequence,
        }),
      });
      const targetJoin = ["pending", "welcome_pending"].includes(
        result.membershipState,
      )
        ? await (await repository()).targetJoin({
          ...input.authority,
          humanId: input.authority.humanActorId,
          deviceId: input.request.deviceId,
        })
        : null;
      const personalAuthority = await resolveAdditionalDevicePersonalAuthorityAnchor(
        getProduct(),
        input.authority.humanActorId,
      );
      return Object.freeze({
        formatVersion: 1 as const,
        ...result,
        personalAuthority,
        head: result.head === null ? null : Object.freeze({
          headBytesBase64url: encode(result.head.headBytes),
          sequence: result.head.sequence,
        }),
        welcome: result.welcome === null ? null : Object.freeze({
          operationId: result.welcome.operationId,
          sequence: result.welcome.sequence,
          transitionBytesBase64url: encode(result.welcome.transitionBytes),
          welcomeBytesBase64url: encode(result.welcome.welcomeBytes),
        }),
        targetJoin: targetJoin === null
          ? null
          : Object.freeze({
              operationId: targetJoin.operationId,
              requestBytesBase64url: encode(targetJoin.requestBytes),
            }),
        commits: result.commits.map((entry) => ({
          sequence: entry.sequence,
          transitionBytesBase64url: encode(entry.transitionBytes),
        })),
      });
    },
    async establishInitial(input) {
      const result = await (await repository()).establishInitial({
        ...input.authority,
        humanId: input.authority.humanActorId,
        deviceId: input.request.deviceId,
        headBytes: decode(input.request.headBytesBase64url),
        rosterBytes: decode(input.request.rosterBytesBase64url),
        now: Date.now(),
      });
      return Object.freeze({ formatVersion: 1 as const, status: result });
    },
    async begin(input) {
      const detached = [
        decode(input.request.installationLineageDigestBase64url),
        decode(input.request.signingPublicKeyBase64url),
        decode(input.request.encryptionPublicKeyBase64url),
      ];
      const authorization = await prepareEnrollmentAuthorization({
        handle: await getHandle(),
        crypto,
        ...input.authority,
        transferScope: "identity_only",
      });
      try {
        const user = nautiloUserId(input.authority.userId);
        const actor = nautiloActorId(input.authority.humanActorId);
        if (!user.ok || !actor.ok) {
          throw new Error("human_device_membership_unauthorized");
        }
        const service = new AdditionalDeviceEnrollmentService({
          crypto,
          repository: new PostgresAdditionalDeviceEnrollmentRepository(
            await getHandle(),
            false,
          ),
          enforceLegacyFleetBounds: false,
          authorize: (candidate) =>
              candidate.userId === input.authority.userId
              && candidate.humanActorId === input.authority.humanActorId
            ? Object.freeze({
                authorized: true as const,
                authorizationEvidenceDigest:
                  authorization.authorizationEvidenceDigest.slice(),
                installationLineageDigest:
                  candidate.installationLineageDigest.slice(),
                expectedCustodyRevision:
                  authorization.expectedCustodyRevision,
                expectedRecoveryGeneration:
                  authorization.expectedRecoveryGeneration,
                inventoryRevision: authorization.inventoryRevision,
                inventoryCount: authorization.inventoryCount,
                inventoryDigest: authorization.inventoryDigest.slice(),
                activeDeviceCount: authorization.activeDeviceCount,
                pendingDeviceCount: authorization.pendingDeviceCount,
              })
            : Object.freeze({ authorized: false as const }),
        });
        const enrollment = await service.begin(Object.freeze({
          userId: user.value,
          humanActorId: actor.value,
          deviceId: cryptoDeviceId(input.request.deviceId),
          clientKind: input.request.clientKind,
          installationLineageDigest: detached[0]!,
          deviceGeneration: 1,
          signingPublicKey: detached[1]!,
          encryptionPublicKey: detached[2]!,
          method: "device_approval" as const,
          idempotencyKey: input.request.idempotencyKey,
        }));
        try {
          const status = await (await repository()).status({
            ...input.authority,
            humanId: input.authority.humanActorId,
            deviceId: input.request.deviceId,
          });
          if (status.head === null) {
            throw new Error("human_device_group_unavailable");
          }
          const personalAuthority =
            await resolveAdditionalDevicePersonalAuthorityAnchor(
              getProduct(),
              input.authority.humanActorId,
            );
          return Object.freeze({
            formatVersion: 1 as const,
            enrollment: enrollmentDto(enrollment),
            serverInstanceId: status.serverInstanceId,
            head: Object.freeze({
              headBytesBase64url: encode(status.head.headBytes),
              sequence: status.head.sequence,
            }),
            personalAuthority,
          });
        } finally {
          destroyPendingAdditionalDeviceEnrollment(enrollment);
        }
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyEnrollmentAuthorization(authorization);
      }
    },
    async publishJoin(input) {
      const result = await (await repository()).bindPendingAndPublishJoin({
        ...input.authority,
        humanId: input.authority.humanActorId,
        operationId: input.operationId,
        targetDeviceId: input.request.deviceId,
        requestBytes: decode(input.request.requestBytesBase64url),
        now: Date.now(),
      });
      return Object.freeze({ formatVersion: 1 as const, status: result });
    },
    async pending(input) {
      const rows = await (await repository()).listPending({
        ...input.authority,
        humanId: input.authority.humanActorId,
        approverDeviceId: input.request.approverDeviceId,
        ...(input.request.afterOperationId === undefined ? {} : {
          afterOperationId: input.request.afterOperationId,
        }),
      });
      return Object.freeze({
        formatVersion: 1 as const,
        pending: rows.map((row) => ({
          operationId: row.operationId,
          targetDeviceId: row.targetDeviceId,
          targetClientKind: row.targetClientKind,
          targetDeviceGeneration: row.targetDeviceGeneration,
          targetSigningPublicKeyBase64url: encode(row.targetSigningPublicKey),
          requestBytesBase64url: encode(row.requestBytes),
          createdAt: row.createdAt,
        })),
        nextOperationId: rows.length === 64
          ? rows.at(-1)!.operationId
          : null,
      });
    },
    async roster(input) {
      const result = await (await repository()).roster({
        ...input.authority,
        humanId: input.authority.humanActorId,
        currentDeviceId: input.request.currentDeviceId,
      });
      return {
        formatVersion: 1 as const,
        currentDeviceId: result.currentDeviceId,
        currentMemberCount: result.currentMemberCount,
        devices: result.devices.map((entry) => ({ ...entry })),
      };
    },
    async publishAdd(input) {
      const result = await (await repository()).publishAdd({
        ...input.authority,
        humanId: input.authority.humanActorId,
        operationId: input.operationId,
        committerDeviceId: input.request.committerDeviceId,
        transitionBytes: decode(input.request.transitionBytesBase64url),
        welcomeBytes: decode(input.request.welcomeBytesBase64url),
        now: Date.now(),
      });
      return Object.freeze({ formatVersion: 1 as const, status: result });
    },
    async publishRemove(input) {
      if (!await pinProvider.verifyProof(
        input.authority.userId,
        input.request.pin,
      )) throw new Error("human_device_remove_unauthorized");
      const result = await (await repository()).publishRemove({
        ...input.authority,
        humanId: input.authority.humanActorId,
        operationId: input.operationId,
        committerDeviceId: input.request.committerDeviceId,
        transitionBytes: decode(input.request.transitionBytesBase64url),
        now: Date.now(),
      });
      return Object.freeze({ formatVersion: 1 as const, status: result });
    },
    async beginRecovery(input) {
      const detached = [
        decode(input.request.installationLineageDigestBase64url),
        decode(input.request.signingPublicKeyBase64url),
        decode(input.request.encryptionPublicKeyBase64url),
      ];
      const authorization = await prepareEnrollmentAuthorization({
        handle: await getHandle(),
        crypto,
        ...input.authority,
        transferScope: "identity_only",
      });
      try {
        const user = nautiloUserId(input.authority.userId);
        const actor = nautiloActorId(input.authority.humanActorId);
        if (!user.ok || !actor.ok) {
          throw new Error("human_device_recovery_unauthorized");
        }
        const service = new AdditionalDeviceEnrollmentService({
          crypto,
          repository: new PostgresAdditionalDeviceEnrollmentRepository(
            await getHandle(),
            false,
          ),
          enforceLegacyFleetBounds: false,
          authorize: (candidate) =>
              candidate.userId === input.authority.userId
              && candidate.humanActorId === input.authority.humanActorId
            ? Object.freeze({
                authorized: true as const,
                authorizationEvidenceDigest:
                  authorization.authorizationEvidenceDigest.slice(),
                installationLineageDigest:
                  candidate.installationLineageDigest.slice(),
                expectedCustodyRevision:
                  authorization.expectedCustodyRevision,
                expectedRecoveryGeneration:
                  authorization.expectedRecoveryGeneration,
                inventoryRevision: authorization.inventoryRevision,
                inventoryCount: authorization.inventoryCount,
                inventoryDigest: authorization.inventoryDigest.slice(),
                activeDeviceCount: authorization.activeDeviceCount,
                pendingDeviceCount: authorization.pendingDeviceCount,
              })
            : Object.freeze({ authorized: false as const }),
        });
        const enrollment = await service.begin(Object.freeze({
          userId: user.value,
          humanActorId: actor.value,
          deviceId: cryptoDeviceId(input.request.deviceId),
          clientKind: input.request.clientKind,
          installationLineageDigest: detached[0]!,
          deviceGeneration: 1,
          signingPublicKey: detached[1]!,
          encryptionPublicKey: detached[2]!,
          method: "recovery" as const,
          idempotencyKey: input.request.idempotencyKey,
        }));
        try {
          const challenge = await new PostgresRecoveryChallengeRepository({
            handle: await getHandle(),
            crypto,
            purpose: "mls_rebootstrap_possession",
          }).publish({
            operationId: enrollment.operationId,
            publishedAt: Date.now(),
          });
          const current = await (await repository()).status({
            ...input.authority,
            humanId: input.authority.humanActorId,
            deviceId: input.request.deviceId,
          });
          if (current.head === null) {
            throw new Error("human_device_recovery_head_unavailable");
          }
          const decodedHead = decodeHumanDeviceGroupHead(
            current.head.headBytes,
          );
          const personalAuthority =
            await resolveAdditionalDevicePersonalAuthorityAnchor(
              getProduct(),
              input.authority.humanActorId,
            );
          return Object.freeze({
            formatVersion: 1 as const,
            operationId: enrollment.operationId,
            challengeBytesBase64url: encode(challenge.challengeBytes),
            serverInstanceId: current.serverInstanceId,
            currentLineageGeneration: decodedHead.lineageGeneration,
            nextLineageGeneration: decodedHead.lineageGeneration + 1,
            personalAuthority,
          });
        } finally {
          destroyPendingAdditionalDeviceEnrollment(enrollment);
        }
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyEnrollmentAuthorization(authorization);
      }
    },
    async completeRecovery(input) {
      const challengeHash = decode(input.request.challengeHashBase64url);
      const response = decode(input.request.responseBase64url);
      const headBytes = decode(input.request.headBytesBase64url);
      const rosterBytes = decode(input.request.rosterBytesBase64url);
      try {
        const result = await (await repository()).rebootstrapWithRecovery({
          ...input.authority,
          humanId: input.authority.humanActorId,
          operationId: input.operationId,
          deviceId: input.request.deviceId,
          challengeHash,
          response,
          headBytes,
          rosterBytes,
          now: Date.now(),
        });
        return Object.freeze({ formatVersion: 1 as const, status: result });
      } finally {
        challengeHash.fill(0);
        response.fill(0);
        headBytes.fill(0);
        rosterBytes.fill(0);
      }
    },
    async acknowledge(input) {
      const result = await (await repository()).acknowledge({
        ...input.authority,
        humanId: input.authority.humanActorId,
        deviceId: input.request.deviceId,
        sequence: input.request.sequence,
        headDigest: decode(input.request.headDigestBase64url),
        leafIndex: input.request.leafIndex,
        now: Date.now(),
      });
      return Object.freeze({ formatVersion: 1 as const, status: result });
    },
  };
  return Object.freeze(composition);
}
