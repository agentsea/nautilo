import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  ADDITIONAL_DEVICE_CHALLENGE_TTL_MS,
  ADDITIONAL_DEVICE_ENROLLMENT_FORMAT_VERSION,
  MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN,
  MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS,
  MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN,
  additionalDeviceAuthorizationDigest,
  assertBeginAdditionalDeviceEnrollment,
  assertPendingAdditionalDeviceEnrollment,
  type BeginAdditionalDeviceEnrollment,
  type PendingAdditionalDeviceEnrollment,
} from "../../device/additional-device-enrollment.ts";

export type AdditionalDeviceEnrollmentErrorCode =
  | "authorization_rejected"
  | "conflicting_idempotency"
  | "already_registered"
  | "device_limit_reached"
  | "operation_limit_reached"
  | "pending_limit_reached"
  | "stale_state";

export class AdditionalDeviceEnrollmentError extends Error {
  override readonly name = "AdditionalDeviceEnrollmentError";

  constructor(readonly code: AdditionalDeviceEnrollmentErrorCode) {
    super(`Additional-device enrollment rejected: ${code}`);
  }
}

export type AdditionalDeviceEnrollmentAuthorization =
  | {
    readonly authorized: true;
    readonly authorizationEvidenceDigest: Uint8Array;
    readonly installationLineageDigest: Uint8Array;
    readonly expectedCustodyRevision: number;
    readonly expectedRecoveryGeneration: number;
    readonly inventoryRevision: number;
    readonly inventoryCount: number;
    readonly inventoryDigest: Uint8Array;
    readonly activeDeviceCount: number;
    readonly pendingDeviceCount: number;
  }
  | {
    readonly authorized: false;
  };

export type AuthorizeAdditionalDeviceEnrollment = (
  input: BeginAdditionalDeviceEnrollment,
) =>
  | AdditionalDeviceEnrollmentAuthorization
  | Promise<AdditionalDeviceEnrollmentAuthorization>;

export interface AdditionalDeviceEnrollmentRepository {
  begin(input: {
    readonly enrollment: PendingAdditionalDeviceEnrollment;
    readonly challengeHash: Uint8Array;
    readonly publicFingerprint: Uint8Array;
    readonly signingPublicKeyDigest: Uint8Array;
    readonly encryptionPublicKeyDigest: Uint8Array;
  }): Promise<
    | {
      readonly status: "created" | "duplicate";
      readonly operationId: string;
      readonly challengeId: string;
      readonly issuedAt: number;
      readonly expiresAt: number;
    }
    | {
      readonly status:
        | "conflicting_idempotency"
        | "already_registered"
        | "device_limit_reached"
        | "operation_limit_reached"
        | "pending_limit_reached"
        | "stale_state";
    }
  >;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function assertCounter(
  value: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (
    !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new AdditionalDeviceEnrollmentError("authorization_rejected");
  }
}

function randomId(prefix: string, bytes: Uint8Array): string {
  return `${prefix}_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export class AdditionalDeviceEnrollmentService {
  readonly #crypto: LatticeCrypto;
  readonly #repository: AdditionalDeviceEnrollmentRepository;
  readonly #authorize: AuthorizeAdditionalDeviceEnrollment;
  readonly #enforceLegacyFleetBounds: boolean;

  constructor(input: {
    readonly crypto: LatticeCrypto;
    readonly repository: AdditionalDeviceEnrollmentRepository;
    readonly authorize: AuthorizeAdditionalDeviceEnrollment;
    readonly enforceLegacyFleetBounds?: boolean;
  }) {
    this.#crypto = input.crypto;
    this.#repository = input.repository;
    this.#authorize = input.authorize;
    this.#enforceLegacyFleetBounds =
      input.enforceLegacyFleetBounds ?? true;
  }

  async begin(
    request: BeginAdditionalDeviceEnrollment,
  ): Promise<PendingAdditionalDeviceEnrollment> {
    assertBeginAdditionalDeviceEnrollment(request);
    const authorization = await this.#authorize(request);
    if (
      !authorization.authorized
      || !equalBytes(
        authorization.installationLineageDigest,
        request.installationLineageDigest,
      )
      || !(authorization.authorizationEvidenceDigest instanceof Uint8Array)
      || authorization.authorizationEvidenceDigest.length !== 32
      || !(authorization.inventoryDigest instanceof Uint8Array)
      || authorization.inventoryDigest.length !== 32
    ) {
      throw new AdditionalDeviceEnrollmentError("authorization_rejected");
    }
    assertCounter(
      authorization.expectedCustodyRevision,
    );
    assertCounter(
      authorization.expectedRecoveryGeneration,
    );
    assertCounter(authorization.inventoryRevision);
    assertCounter(
      authorization.inventoryCount,
      MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS,
    );
    assertCounter(authorization.activeDeviceCount);
    assertCounter(authorization.pendingDeviceCount);
    if (
      authorization.expectedCustodyRevision < 1
      || authorization.expectedRecoveryGeneration < 1
    ) {
      throw new AdditionalDeviceEnrollmentError("stale_state");
    }
    if (
      this.#enforceLegacyFleetBounds
      && authorization.activeDeviceCount
      >= MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN
    ) {
      throw new AdditionalDeviceEnrollmentError("device_limit_reached");
    }
    if (
      this.#enforceLegacyFleetBounds
      && authorization.pendingDeviceCount
      >= MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN
    ) {
      throw new AdditionalDeviceEnrollmentError("pending_limit_reached");
    }

    const random = this.#crypto.randomBytes(32);
    const operationId = randomId("device_operation", random);
    random.fill(0);
    const challengeRandom = this.#crypto.randomBytes(32);
    const challengeId = randomId("device_challenge", challengeRandom);
    challengeRandom.fill(0);
    const issuedAt = this.#crypto.clock.now();
    const expiresAt = issuedAt + ADDITIONAL_DEVICE_CHALLENGE_TTL_MS;
    const authorizationDigest = additionalDeviceAuthorizationDigest({
      request,
      authorizationEvidenceDigest:
        authorization.authorizationEvidenceDigest,
      expectedCustodyRevision: authorization.expectedCustodyRevision,
      expectedRecoveryGeneration:
        authorization.expectedRecoveryGeneration,
      inventoryRevision: authorization.inventoryRevision,
      inventoryCount: authorization.inventoryCount,
      inventoryDigest: authorization.inventoryDigest,
      crypto: this.#crypto,
    });
    const candidate: PendingAdditionalDeviceEnrollment = Object.freeze({
      formatVersion: ADDITIONAL_DEVICE_ENROLLMENT_FORMAT_VERSION,
      ...request,
      installationLineageDigest: Uint8Array.from(
        request.installationLineageDigest,
      ),
      signingPublicKey: Uint8Array.from(request.signingPublicKey),
      encryptionPublicKey: Uint8Array.from(request.encryptionPublicKey),
      operationId,
      challengeId,
      authorizationEvidenceDigest: Uint8Array.from(
        authorization.authorizationEvidenceDigest,
      ),
      authorizationDigest,
      expectedCustodyRevision: authorization.expectedCustodyRevision,
      expectedRecoveryGeneration:
        authorization.expectedRecoveryGeneration,
      inventoryRevision: authorization.inventoryRevision,
      inventoryCount: authorization.inventoryCount,
      inventoryDigest: Uint8Array.from(authorization.inventoryDigest),
      deviceRevision: 0,
      status: "pending",
      issuedAt,
      expiresAt,
    });
    assertPendingAdditionalDeviceEnrollment(candidate);
    const result = await this.#repository.begin({
      enrollment: candidate,
      challengeHash: this.#crypto.hash(
        new TextEncoder().encode(challengeId),
      ),
      publicFingerprint: this.#crypto.hash(
        new Uint8Array([
          ...request.signingPublicKey,
          ...request.encryptionPublicKey,
        ]),
      ),
      signingPublicKeyDigest: this.#crypto.hash(request.signingPublicKey),
      encryptionPublicKeyDigest: this.#crypto.hash(
        request.encryptionPublicKey,
      ),
    });
    if (result.status !== "created" && result.status !== "duplicate") {
      throw new AdditionalDeviceEnrollmentError(result.status);
    }
    const enrollment: PendingAdditionalDeviceEnrollment = Object.freeze({
      ...candidate,
      operationId: result.operationId,
      challengeId: result.challengeId,
      issuedAt: result.issuedAt,
      expiresAt: result.expiresAt,
    });
    assertPendingAdditionalDeviceEnrollment(enrollment);
    return enrollment;
  }
}
