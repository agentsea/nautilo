import {
  ApiError,
  type NautiloApiClient,
  type ProtectedInitialDeviceChallengeV1,
  type ProtectedInitialHumanDomainPlanResponseV1,
  type ProtectedInitialHumanDomainReceiptV1,
} from "@nautilo/api-client/browser";

/*
 * Initial bootstrap is intentionally not a second-device protocol. Preserve a
 * typed boundary so ordinary clients can route an existing Human to enrollment
 * without treating a rejected locally-generated recovery kit as active.
 */
export class InitialDeviceEnrollmentRequiredError extends Error {
  override readonly name = "InitialDeviceEnrollmentRequiredError";
}

import type {
  HumanMembershipTargetDomainSubmission,
} from "../delivery/human-membership-target-domain.ts";
import type { InitialDeviceBootstrapClientPort } from
  "./initial-bootstrap-client-ceremony.ts";
import type {
  InitialDeviceBootstrapChallenge,
  InitialDeviceBootstrapReceipt,
} from "./initial-bootstrap.ts";
import type {
  InitialHumanDomainServerReceipt,
} from "./initial-human-domain-client-ceremony.ts";
import {
  nautiloActorId,
  nautiloUserId,
} from "../identity/product-ids.ts";
import type {
  BeginInitialDeviceBootstrap,
  InitialDeviceBootstrapCompletion,
  InitialDeviceBootstrapReceiptQuery,
} from "./initial-bootstrap.ts";

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function supportedClientKind(
  value: "browser" | "electron" | "tui",
): "browser" | "electron" {
  if (value === "tui") {
    throw new TypeError("TUI crypto device bootstrap is unsupported");
  }
  return value;
}

function requiredProductId<Id>(
  result: Readonly<{ ok: true; value: Id }> | Readonly<{ ok: false }>,
): Id {
  if (!result.ok) throw new TypeError("Server returned an invalid product identity");
  return result.value;
}

function decodeChallenge(
  value: ProtectedInitialDeviceChallengeV1,
): InitialDeviceBootstrapChallenge {
  return Object.freeze({
    formatVersion: 1,
    userId: requiredProductId(nautiloUserId(value.userId)),
    humanActorId: requiredProductId(nautiloActorId(value.humanActorId)),
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigest: decode(value.installationLineageDigestBase64url),
    signingPublicKey: decode(value.signingPublicKeyBase64url),
    encryptionPublicKey: decode(value.encryptionPublicKeyBase64url),
    recoveryKeyId: value.recoveryKeyId,
    recoveryPublicKey: decode(value.recoveryPublicKeyBase64url),
    context: value.context,
    idempotencyKey: value.idempotencyKey,
    challengeId: value.challengeId,
    authorizationEvidenceDigest:
      decode(value.authorizationEvidenceDigestBase64url),
    authorizationDigest: decode(value.authorizationDigestBase64url),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function encodeChallenge(value: InitialDeviceBootstrapChallenge) {
  return {
    formatVersion: 1 as const,
    userId: value.userId,
    humanActorId: value.humanActorId,
    deviceId: value.deviceId,
    clientKind: supportedClientKind(value.clientKind),
    installationLineageDigestBase64url: encode(value.installationLineageDigest),
    signingPublicKeyBase64url: encode(value.signingPublicKey),
    encryptionPublicKeyBase64url: encode(value.encryptionPublicKey),
    recoveryKeyId: value.recoveryKeyId,
    recoveryPublicKeyBase64url: encode(value.recoveryPublicKey),
    context: value.context.kind === "preparation"
      ? value.context
      : { kind: "preparation" as const, authorityId: value.context.authorityId },
    idempotencyKey: value.idempotencyKey,
    challengeId: value.challengeId,
    authorizationEvidenceDigestBase64url:
      encode(value.authorizationEvidenceDigest),
    authorizationDigestBase64url: encode(value.authorizationDigest),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

function decodeReceipt(
  value: Awaited<ReturnType<NautiloApiClient["completeProtectedInitialDeviceBootstrap"]>>,
): InitialDeviceBootstrapReceipt {
  return Object.freeze({
    formatVersion: 1,
    status: "active",
    humanActorId: requiredProductId(nautiloActorId(value.humanActorId)),
    deviceId: value.deviceId,
    recoveryKeyId: value.recoveryKeyId,
    recoveryGeneration: 1,
    deviceRevision: 1,
    custodyRevision: 1,
    auditRef: value.auditRef,
    committedAt: value.committedAt,
  });
}

export function createInitialDeviceBootstrapApiClientPort(
  api: NautiloApiClient,
): InitialDeviceBootstrapClientPort {
  return Object.freeze({
    async begin(request: BeginInitialDeviceBootstrap) {
      try {
        const response = await api.beginProtectedInitialDeviceBootstrap({
          requestVersion: 1,
          deviceId: request.deviceId,
          clientKind: supportedClientKind(request.clientKind),
          installationLineageDigestBase64url:
            encode(request.installationLineageDigest),
          signingPublicKeyBase64url: encode(request.signingPublicKey),
          encryptionPublicKeyBase64url: encode(request.encryptionPublicKey),
          recoveryKeyId: request.recoveryKeyId,
          recoveryPublicKeyBase64url: encode(request.recoveryPublicKey),
          idempotencyKey: request.idempotencyKey,
        });
        return decodeChallenge(response);
      } catch (error) {
        if (error instanceof ApiError
          && error.status === 409
          && error.message === "already_initialized") {
          throw new InitialDeviceEnrollmentRequiredError();
        }
        throw error;
      }
    },
    async complete(completion: InitialDeviceBootstrapCompletion) {
      return decodeReceipt(await api.completeProtectedInitialDeviceBootstrap({
        requestVersion: 1,
        challenge: encodeChallenge(completion.challenge),
        recoveryArchiveBytesBase64url: encode(completion.recoveryArchiveBytes),
        deviceProofBase64url: encode(completion.deviceProof),
      }));
    },
    async resolveReceipt(query: InitialDeviceBootstrapReceiptQuery) {
      const response = await api.resolveProtectedInitialDeviceBootstrapReceipt({
        requestVersion: 1,
        deviceId: query.deviceId,
        challengeId: query.challengeId,
        publicFingerprintBase64url: encode(query.publicFingerprint),
      });
      return response === null ? null : decodeReceipt(response);
    },
  });
}

function encodeSubmission(value: HumanMembershipTargetDomainSubmission) {
  if (value.additions.length !== 0) {
    throw new TypeError("Initial Human Domain submission must have no additions");
  }
  return {
    formatVersion: 1 as const,
    operationId: value.operationId,
    targetDomainId: value.targetDomainId,
    participants: [...value.participants],
    participantDigestBase64url: encode(value.participantDigest),
    committerDeviceId: value.committerDeviceId,
    committerHumanId: value.committerHumanId,
    initialProviderHead: {
      providerId: value.initialProviderHead.providerId,
      domainId: value.initialProviderHead.domainId,
      epoch: 0 as const,
      stateHashBase64url: encode(value.initialProviderHead.stateHash),
    },
    initialRosterBytesBase64url: encode(value.initialRosterBytes),
    additions: [] as [],
    chainDigestBase64url: encode(value.chainDigest),
    signatureBase64url: encode(value.signature),
  };
}

function decodeDomainReceipt(
  value: ProtectedInitialHumanDomainReceiptV1,
): InitialHumanDomainServerReceipt {
  return Object.freeze({
    formatVersion: 1,
    status: "active",
    operationId: value.operationId,
    humanId: value.humanId,
    deviceId: value.deviceId,
    domainId: value.domainId,
    providerId: value.providerId,
    epoch: 0,
    stateHash: decode(value.stateHashBase64url),
    rosterHash: decode(value.rosterHashBase64url),
    submissionDigest: decode(value.submissionDigestBase64url),
    committedAt: value.committedAt,
  });
}

export function createInitialHumanDomainApiClientPort(api: NautiloApiClient) {
  return Object.freeze({
    async plan(deviceId: string): Promise<InitialHumanDomainPlan> {
      return decodeDomainPlan(await api.planProtectedInitialHumanDomain({
        requestVersion: 1,
        deviceId,
      }));
    },
    async activate(
      submission: HumanMembershipTargetDomainSubmission,
    ): Promise<InitialHumanDomainServerReceipt> {
      return decodeDomainReceipt(await api.activateProtectedInitialHumanDomain({
        requestVersion: 1,
        submission: encodeSubmission(submission),
      }));
    },
  });
}

export type InitialHumanDomainPlan =
  | Readonly<{
    status: "planned";
    operationId: string;
    humanId: string;
    deviceId: string;
    domainId: string;
    currentDomainHead: null;
    activeDeviceIds: readonly string[];
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>
  | Readonly<{
    status: "active";
    humanId: string;
    deviceId: string;
    domainId: string;
    providerId: string;
    epoch: number;
    stateHash: Uint8Array;
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>
  | Readonly<{
    status: "unavailable";
    reason:
      | "device_unavailable"
      | "existing_domain_requires_delivery"
      | "multiple_active_devices_require_fanout"
      | "stale_identity";
    migration?: Readonly<{
      trustedDeviceRevision: number;
      trustedHostAuthorizationRevision: number;
      deliveryHighWatermark: number;
    }>;
  }>;

export interface InitialHumanDomainApiClientPort {
  plan(deviceId: string): Promise<InitialHumanDomainPlan>;
  activate(
    submission: HumanMembershipTargetDomainSubmission,
  ): Promise<InitialHumanDomainServerReceipt>;
}

function decodeDomainPlan(
  value: ProtectedInitialHumanDomainPlanResponseV1,
): InitialHumanDomainPlan {
  if (value.status === "unavailable") {
    return Object.freeze({
      status: value.status,
      reason: value.reason,
      ...(value.migration === undefined ? {} : {
        migration: Object.freeze({ ...value.migration }),
      }),
    });
  }
  if (value.status === "active") {
    return Object.freeze({
      status: value.status,
      humanId: value.humanId,
      deviceId: value.deviceId,
      domainId: value.domainId,
      providerId: value.providerId,
      epoch: value.epoch,
      stateHash: decode(value.stateHashBase64url),
      trustedDeviceRevision: value.trustedDeviceRevision,
      trustedHostAuthorizationRevision:
        value.trustedHostAuthorizationRevision,
      deliveryHighWatermark: value.deliveryHighWatermark,
    });
  }
  return Object.freeze({
    status: value.status,
    operationId: value.operationId,
    humanId: value.humanId,
    deviceId: value.deviceId,
    domainId: value.domainId,
    currentDomainHead: null,
    activeDeviceIds: Object.freeze([...value.activeDeviceIds]),
    trustedDeviceRevision: value.trustedDeviceRevision,
    trustedHostAuthorizationRevision:
      value.trustedHostAuthorizationRevision,
    deliveryHighWatermark: value.deliveryHighWatermark,
  });
}
