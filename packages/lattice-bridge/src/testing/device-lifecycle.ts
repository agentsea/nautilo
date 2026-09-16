import type {
  BeginInitialDeviceBootstrap,
  InitialDeviceBootstrapContext,
  InitialDeviceBootstrapReceipt,
} from "../device/initial-bootstrap.ts";
import type {
  AuthorizeInitialDeviceBootstrap,
  InitialDeviceBootstrapRepository,
} from "../server/device/initial-bootstrap-service.ts";
import type {
  NautiloActorId,
  NautiloUserId,
} from "../identity/product-ids.ts";

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function contextsEqual(
  left: InitialDeviceBootstrapContext,
  right: InitialDeviceBootstrapContext,
): boolean {
  return left.kind === right.kind && left.authorityId === right.authorityId;
}

function requestsEqual(
  left: BeginInitialDeviceBootstrap,
  right: BeginInitialDeviceBootstrap,
): boolean {
  return left.userId === right.userId
    && left.humanActorId === right.humanActorId
    && left.deviceId === right.deviceId
    && left.clientKind === right.clientKind
    && equalBytes(
      left.installationLineageDigest,
      right.installationLineageDigest,
    )
    && equalBytes(left.signingPublicKey, right.signingPublicKey)
    && equalBytes(left.encryptionPublicKey, right.encryptionPublicKey)
    && left.recoveryKeyId === right.recoveryKeyId
    && equalBytes(left.recoveryPublicKey, right.recoveryPublicKey)
    && contextsEqual(left.context, right.context)
    && left.idempotencyKey === right.idempotencyKey;
}

function copyRequest(
  request: BeginInitialDeviceBootstrap,
): BeginInitialDeviceBootstrap {
  return Object.freeze({
    ...request,
    context: Object.freeze({ ...request.context }),
    installationLineageDigest: Uint8Array.from(
      request.installationLineageDigest,
    ),
    signingPublicKey: Uint8Array.from(request.signingPublicKey),
    encryptionPublicKey: Uint8Array.from(request.encryptionPublicKey),
    recoveryPublicKey: Uint8Array.from(request.recoveryPublicKey),
  });
}

interface StoredBootstrap {
  readonly request: BeginInitialDeviceBootstrap;
  readonly authorizationDigest: Uint8Array;
  readonly challengeId: string;
  readonly challengeHash: Uint8Array;
  readonly publicFingerprint: Uint8Array;
  readonly issuedAt: number;
  readonly expiresAt: number;
  receipt?: InitialDeviceBootstrapReceipt;
  recoveryArchiveHash?: Uint8Array;
}

export class MemoryDeviceLifecycleRepository
  implements InitialDeviceBootstrapRepository
{
  #custodyState: "absent" | "initializing" | "active" = "absent";
  #challenge: StoredBootstrap | undefined;
  #activeDeviceCount = 0;
  #recoveryGeneration: number | undefined;

  begin(
    input: Parameters<InitialDeviceBootstrapRepository["begin"]>[0],
  ): ReturnType<InitialDeviceBootstrapRepository["begin"]> {
    const existing = this.#challenge;
    if (existing?.request.idempotencyKey === input.request.idempotencyKey) {
      if (
        requestsEqual(existing.request, input.request)
        && equalBytes(
          existing.authorizationDigest,
          input.authorizationDigest,
        )
      ) {
        return Promise.resolve({
          status: "duplicate",
          challengeId: existing.challengeId,
          issuedAt: existing.issuedAt,
          expiresAt: existing.expiresAt,
        });
      }
      return Promise.resolve({ status: "conflicting_idempotency" });
    }
    if (this.#custodyState === "active") {
      return Promise.resolve({ status: "already_initialized" });
    }
    if (this.#custodyState === "initializing") {
      if (
        existing === undefined
        || existing.receipt !== undefined
        || input.issuedAt < existing.expiresAt
        || !contextsEqual(existing.request.context, input.request.context)
      ) {
        return Promise.resolve({ status: "stale_state" });
      }
    }
    this.#custodyState = "initializing";
    this.#challenge = {
      request: copyRequest(input.request),
      authorizationDigest: Uint8Array.from(input.authorizationDigest),
      challengeId: input.challengeId,
      challengeHash: Uint8Array.from(input.challengeHash),
      publicFingerprint: Uint8Array.from(input.publicFingerprint),
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
    return Promise.resolve({
      status: "created",
      challengeId: input.challengeId,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
  }

  complete(
    input: Parameters<InitialDeviceBootstrapRepository["complete"]>[0],
  ): ReturnType<InitialDeviceBootstrapRepository["complete"]> {
    const stored = this.#challenge;
    if (
      stored === undefined
      || stored.challengeId !== input.challenge.challengeId
      || !equalBytes(stored.challengeHash, input.challengeHash)
      || !requestsEqual(stored.request, input.challenge)
      || !equalBytes(
        stored.authorizationDigest,
        input.challenge.authorizationDigest,
      )
    ) {
      return Promise.resolve({ status: "challenge_invalid" });
    }
    if (stored.receipt !== undefined) {
      if (
        stored.recoveryArchiveHash !== undefined
        && equalBytes(stored.recoveryArchiveHash, input.recoveryArchiveHash)
      ) {
        return Promise.resolve({
          status: "duplicate",
          receipt: stored.receipt,
        });
      }
      return Promise.resolve({ status: "challenge_invalid" });
    }
    if (input.committedAt >= stored.expiresAt) {
      return Promise.resolve({ status: "challenge_expired" });
    }
    if (this.#custodyState !== "initializing") {
      return Promise.resolve({ status: "stale_state" });
    }
    const receipt: InitialDeviceBootstrapReceipt = Object.freeze({
      formatVersion: 1,
      status: "active",
      humanActorId: input.challenge.humanActorId,
      deviceId: input.challenge.deviceId,
      recoveryKeyId: input.challenge.recoveryKeyId,
      recoveryGeneration: 1,
      deviceRevision: 1,
      custodyRevision: 1,
      auditRef: input.auditRef,
      committedAt: input.committedAt,
    });
    stored.receipt = receipt;
    stored.recoveryArchiveHash = Uint8Array.from(input.recoveryArchiveHash);
    this.#custodyState = "active";
    this.#activeDeviceCount = 1;
    this.#recoveryGeneration = 1;
    return Promise.resolve({ status: "applied", receipt });
  }

  resolveReceipt(
    query: Parameters<InitialDeviceBootstrapRepository["resolveReceipt"]>[0],
  ): ReturnType<InitialDeviceBootstrapRepository["resolveReceipt"]> {
    const stored = this.#challenge;
    if (
      stored?.receipt === undefined
      || stored.challengeId !== query.challengeId
      || stored.request.userId !== query.userId
      || stored.request.humanActorId !== query.humanActorId
      || stored.request.deviceId !== query.deviceId
      || !equalBytes(stored.publicFingerprint, query.publicFingerprint)
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(stored.receipt);
  }

  publicSnapshot(): Readonly<{
    readonly custodyState: "absent" | "initializing" | "active";
    readonly everInitialized: boolean;
    readonly activeDeviceCount: number;
    readonly recoveryGeneration: number | undefined;
    readonly challengeStatus: "absent" | "pending" | "consumed";
  }> {
    return Object.freeze({
      custodyState: this.#custodyState,
      everInitialized: this.#custodyState === "active",
      activeDeviceCount: this.#activeDeviceCount,
      recoveryGeneration: this.#recoveryGeneration,
      challengeStatus: this.#challenge === undefined
        ? "absent"
        : this.#challenge.receipt === undefined
        ? "pending"
        : "consumed",
    });
  }
}

export function createSyntheticInitialDeviceAuthorizer(input: {
  readonly expectedUserId: NautiloUserId;
  readonly expectedHumanActorId: NautiloActorId;
  readonly expectedInstallationLineageDigest: Uint8Array;
  readonly authorizationDigest: Uint8Array;
  readonly allowedContext: InitialDeviceBootstrapContext;
}): AuthorizeInitialDeviceBootstrap {
  return (request) => {
    if (
      request.userId !== input.expectedUserId
      || request.humanActorId !== input.expectedHumanActorId
      || !contextsEqual(request.context, input.allowedContext)
      || !equalBytes(
        request.installationLineageDigest,
        input.expectedInstallationLineageDigest,
      )
    ) {
      return { authorized: false };
    }
    return Object.freeze({
      authorized: true,
      authorizationDigest: Uint8Array.from(input.authorizationDigest),
      installationLineageDigest: Uint8Array.from(
        input.expectedInstallationLineageDigest,
      ),
    });
  };
}
