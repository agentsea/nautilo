import {
  MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN,
  MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN,
  type BeginAdditionalDeviceEnrollment,
  type PendingAdditionalDeviceEnrollment,
} from "../device/additional-device-enrollment.ts";
import type {
  AdditionalDeviceEnrollmentRepository,
  AuthorizeAdditionalDeviceEnrollment,
} from "../server/device/additional-device-enrollment-service.ts";
import type {
  NautiloActorId,
  NautiloUserId,
} from "../identity/product-ids.ts";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function enrollmentsEqual(
  left: PendingAdditionalDeviceEnrollment,
  right: PendingAdditionalDeviceEnrollment,
): boolean {
  return left.userId === right.userId
    && left.humanActorId === right.humanActorId
    && left.deviceId === right.deviceId
    && left.clientKind === right.clientKind
    && left.deviceGeneration === right.deviceGeneration
    && left.method === right.method
    && left.idempotencyKey === right.idempotencyKey
    && left.expectedCustodyRevision === right.expectedCustodyRevision
    && left.expectedRecoveryGeneration === right.expectedRecoveryGeneration
    && left.inventoryRevision === right.inventoryRevision
    && left.inventoryCount === right.inventoryCount
    && equalBytes(
      left.installationLineageDigest,
      right.installationLineageDigest,
    )
    && equalBytes(left.signingPublicKey, right.signingPublicKey)
    && equalBytes(left.encryptionPublicKey, right.encryptionPublicKey)
    && equalBytes(
      left.authorizationEvidenceDigest,
      right.authorizationEvidenceDigest,
    )
    && equalBytes(left.authorizationDigest, right.authorizationDigest)
    && equalBytes(left.inventoryDigest, right.inventoryDigest);
}

function copyEnrollment(
  enrollment: PendingAdditionalDeviceEnrollment,
): PendingAdditionalDeviceEnrollment {
  return Object.freeze({
    ...enrollment,
    installationLineageDigest: Uint8Array.from(
      enrollment.installationLineageDigest,
    ),
    signingPublicKey: Uint8Array.from(enrollment.signingPublicKey),
    encryptionPublicKey: Uint8Array.from(enrollment.encryptionPublicKey),
    authorizationEvidenceDigest: Uint8Array.from(
      enrollment.authorizationEvidenceDigest,
    ),
    authorizationDigest: Uint8Array.from(enrollment.authorizationDigest),
    inventoryDigest: Uint8Array.from(enrollment.inventoryDigest),
  });
}

export class MemoryAdditionalDeviceEnrollmentRepository
  implements AdditionalDeviceEnrollmentRepository
{
  readonly #custodyRevision: number;
  readonly #recoveryGeneration: number;
  readonly #activeDeviceIds: Set<string>;
  readonly #preexistingPendingDeviceIds: Set<string>;
  readonly #enforceLegacyFleetBounds: boolean;
  readonly #pendingByDeviceId = new Map<
    string,
    PendingAdditionalDeviceEnrollment
  >();
  readonly #pendingByIdempotency = new Map<
    string,
    PendingAdditionalDeviceEnrollment
  >();

  constructor(input: {
    readonly custodyRevision: number;
    readonly recoveryGeneration: number;
    readonly activeDeviceIds?: readonly string[];
    readonly pendingDeviceIds?: readonly string[];
    readonly enforceLegacyFleetBounds?: boolean;
  }) {
    this.#custodyRevision = input.custodyRevision;
    this.#recoveryGeneration = input.recoveryGeneration;
    this.#activeDeviceIds = new Set(input.activeDeviceIds ?? []);
    this.#preexistingPendingDeviceIds = new Set(
      input.pendingDeviceIds ?? [],
    );
    this.#enforceLegacyFleetBounds = input.enforceLegacyFleetBounds ?? true;
  }

  begin(
    input: Parameters<AdditionalDeviceEnrollmentRepository["begin"]>[0],
  ): ReturnType<AdditionalDeviceEnrollmentRepository["begin"]> {
    const enrollment = input.enrollment;
    const idempotent = this.#pendingByIdempotency.get(
      enrollment.idempotencyKey,
    );
    if (idempotent !== undefined) {
      if (!enrollmentsEqual(idempotent, enrollment)) {
        return Promise.resolve({ status: "conflicting_idempotency" });
      }
      return Promise.resolve({
        status: "duplicate",
        operationId: idempotent.operationId,
        challengeId: idempotent.challengeId,
        issuedAt: idempotent.issuedAt,
        expiresAt: idempotent.expiresAt,
      });
    }
    if (
      this.#activeDeviceIds.has(enrollment.deviceId)
      || this.#preexistingPendingDeviceIds.has(enrollment.deviceId)
      || this.#pendingByDeviceId.has(enrollment.deviceId)
    ) {
      return Promise.resolve({ status: "already_registered" });
    }
    if (
      enrollment.expectedCustodyRevision !== this.#custodyRevision
      || enrollment.expectedRecoveryGeneration !== this.#recoveryGeneration
    ) {
      return Promise.resolve({ status: "stale_state" });
    }
    if (this.#enforceLegacyFleetBounds &&
      this.#activeDeviceIds.size >= MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN
    ) {
      return Promise.resolve({ status: "device_limit_reached" });
    }
    if (this.#enforceLegacyFleetBounds &&
      this.#preexistingPendingDeviceIds.size
        + this.#pendingByDeviceId.size
      >= MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN
    ) {
      return Promise.resolve({ status: "pending_limit_reached" });
    }
    const stored = copyEnrollment(enrollment);
    this.#pendingByDeviceId.set(enrollment.deviceId, stored);
    this.#pendingByIdempotency.set(enrollment.idempotencyKey, stored);
    return Promise.resolve({
      status: "created",
      operationId: enrollment.operationId,
      challengeId: enrollment.challengeId,
      issuedAt: enrollment.issuedAt,
      expiresAt: enrollment.expiresAt,
    });
  }

  publicSnapshot(): Readonly<{
    readonly activeDeviceCount: number;
    readonly pendingDeviceCount: number;
    readonly pendingDeviceIds: readonly string[];
  }> {
    return Object.freeze({
      activeDeviceCount: this.#activeDeviceIds.size,
      pendingDeviceCount:
        this.#preexistingPendingDeviceIds.size
        + this.#pendingByDeviceId.size,
      pendingDeviceIds: Object.freeze([
        ...this.#preexistingPendingDeviceIds,
        ...this.#pendingByDeviceId.keys(),
      ]),
    });
  }
}

export function createSyntheticAdditionalDeviceAuthorizer(input: {
  readonly expectedUserId: NautiloUserId;
  readonly expectedHumanActorId: NautiloActorId;
  readonly expectedInstallationLineageDigest: Uint8Array;
  readonly authorizationEvidenceDigest: Uint8Array;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly activeDeviceCount: number;
  readonly pendingDeviceCount: number;
}): AuthorizeAdditionalDeviceEnrollment {
  return (request: BeginAdditionalDeviceEnrollment) => {
    if (
      request.userId !== input.expectedUserId
      || request.humanActorId !== input.expectedHumanActorId
      || !equalBytes(
        request.installationLineageDigest,
        input.expectedInstallationLineageDigest,
      )
    ) {
      return { authorized: false };
    }
    return Object.freeze({
      authorized: true,
      authorizationEvidenceDigest: Uint8Array.from(
        input.authorizationEvidenceDigest,
      ),
      installationLineageDigest: Uint8Array.from(
        input.expectedInstallationLineageDigest,
      ),
      expectedCustodyRevision: input.expectedCustodyRevision,
      expectedRecoveryGeneration: input.expectedRecoveryGeneration,
      inventoryRevision: input.inventoryRevision,
      inventoryCount: input.inventoryCount,
      inventoryDigest: Uint8Array.from(input.inventoryDigest),
      activeDeviceCount: input.activeDeviceCount,
      pendingDeviceCount: input.pendingDeviceCount,
    });
  };
}
