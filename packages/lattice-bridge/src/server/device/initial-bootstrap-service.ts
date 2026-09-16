import {
  type LatticeCrypto,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  decodeHumanRecoveryArchiveV2,
  humanRecoveryArchiveSigningBytesV2,
  recoveryPublicKeyDigestV2,
} from "@nautilo/lattice-crypto/wire";
import {
  INITIAL_DEVICE_BOOTSTRAP_CHALLENGE_BYTES,
  INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION,
  INITIAL_DEVICE_BOOTSTRAP_TTL_MS,
  assertInitialDeviceBootstrapChallenge,
  initialDeviceBootstrapAuditRef,
  initialDeviceBootstrapAuthorizationDigest,
  initialDeviceBootstrapSigningBytes,
  type BeginInitialDeviceBootstrap,
  type InitialDeviceBootstrapChallenge,
  type InitialDeviceBootstrapCompletion,
  type InitialDeviceBootstrapReceipt,
  type InitialDeviceBootstrapReceiptQuery,
} from "../../device/initial-bootstrap.ts";
import { productIdIsValid } from "../../identity/product-ids.ts";

export type InitialDeviceBootstrapErrorCode =
  | "authorization_rejected"
  | "already_initialized"
  | "conflicting_idempotency"
  | "challenge_expired"
  | "challenge_invalid"
  | "invalid_device_proof"
  | "invalid_recovery_archive"
  | "stale_state";

export class InitialDeviceBootstrapError extends Error {
  override readonly name = "InitialDeviceBootstrapError";

  constructor(readonly code: InitialDeviceBootstrapErrorCode) {
    super(`Initial device bootstrap rejected: ${code}`);
  }
}

export type InitialDeviceBootstrapAuthorization =
  | {
    readonly authorized: true;
    readonly authorizationDigest: Uint8Array;
    readonly installationLineageDigest: Uint8Array;
  }
  | {
    readonly authorized: false;
  };

export type AuthorizeInitialDeviceBootstrap = (
  input: BeginInitialDeviceBootstrap,
) =>
  | InitialDeviceBootstrapAuthorization
  | Promise<InitialDeviceBootstrapAuthorization>;

export type AuthorizeInitialDeviceBootstrapReceiptLookup = (
  input: InitialDeviceBootstrapReceiptQuery,
) => boolean | Promise<boolean>;

export interface InitialDeviceBootstrapRepository {
  begin(input: {
    readonly request: BeginInitialDeviceBootstrap;
    readonly authorizationDigest: Uint8Array;
    readonly challengeId: string;
    readonly challengeHash: Uint8Array;
    readonly publicFingerprint: Uint8Array;
    readonly signingPublicKeyDigest: Uint8Array;
    readonly encryptionPublicKeyDigest: Uint8Array;
    readonly recoveryPublicKeyDigest: Uint8Array;
    readonly issuedAt: number;
    readonly expiresAt: number;
  }): Promise<
    | {
      readonly status: "created" | "duplicate";
      readonly challengeId: string;
      readonly issuedAt: number;
      readonly expiresAt: number;
    }
    | {
      readonly status:
        | "already_initialized"
        | "conflicting_idempotency"
        | "stale_state";
    }
  >;
  complete(input: {
    readonly challenge: InitialDeviceBootstrapChallenge;
    readonly challengeHash: Uint8Array;
    readonly publicFingerprint: Uint8Array;
    readonly signingPublicKeyDigest: Uint8Array;
    readonly encryptionPublicKeyDigest: Uint8Array;
    readonly recoveryPublicKeyDigest: Uint8Array;
    readonly recoveryArchiveHash: Uint8Array;
    readonly recoveryArchiveBytes: Uint8Array;
    readonly auditRef: string;
    readonly committedAt: number;
  }): Promise<
    | {
      readonly status: "applied" | "duplicate";
      readonly receipt: InitialDeviceBootstrapReceipt;
    }
    | {
      readonly status:
        | "challenge_expired"
        | "challenge_invalid"
        | "stale_state";
    }
  >;
  resolveReceipt(
    query: InitialDeviceBootstrapReceiptQuery,
  ): Promise<InitialDeviceBootstrapReceipt | null>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function challengeId(bytes: Uint8Array): string {
  return `bootstrap_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

export class InitialDeviceBootstrapService {
  readonly #crypto: LatticeCrypto;
  readonly #repository: InitialDeviceBootstrapRepository;
  readonly #authorize: AuthorizeInitialDeviceBootstrap;
  readonly #authorizeReceiptLookup:
    AuthorizeInitialDeviceBootstrapReceiptLookup;

  constructor(input: {
    readonly crypto: LatticeCrypto;
    readonly repository: InitialDeviceBootstrapRepository;
    readonly authorize: AuthorizeInitialDeviceBootstrap;
    readonly authorizeReceiptLookup:
      AuthorizeInitialDeviceBootstrapReceiptLookup;
  }) {
    this.#crypto = input.crypto;
    this.#repository = input.repository;
    this.#authorize = input.authorize;
    this.#authorizeReceiptLookup = input.authorizeReceiptLookup;
  }

  async resolveReceipt(
    query: InitialDeviceBootstrapReceiptQuery,
  ): Promise<InitialDeviceBootstrapReceipt | null> {
    if (
      !productIdIsValid(query.userId)
      || !productIdIsValid(query.humanActorId)
      || !/^bootstrap_[0-9a-f]{64}$/u.test(query.challengeId)
      || !(query.publicFingerprint instanceof Uint8Array)
      || query.publicFingerprint.length !== 32
      || !(await this.#authorizeReceiptLookup(query))
    ) {
      throw new InitialDeviceBootstrapError("authorization_rejected");
    }
    return this.#repository.resolveReceipt(query);
  }

  async begin(
    request: BeginInitialDeviceBootstrap,
  ): Promise<InitialDeviceBootstrapChallenge> {
    const authorization = await this.#authorize(request);
    if (!authorization.authorized) {
      throw new InitialDeviceBootstrapError("authorization_rejected");
    }
    if (
      !equalBytes(
        authorization.installationLineageDigest,
        request.installationLineageDigest,
      )
    ) {
      throw new InitialDeviceBootstrapError("authorization_rejected");
    }
    const random = this.#crypto.randomBytes(
      INITIAL_DEVICE_BOOTSTRAP_CHALLENGE_BYTES,
    );
    const id = challengeId(random);
    random.fill(0);
    const issuedAt = this.#crypto.clock.now();
    const expiresAt = issuedAt + INITIAL_DEVICE_BOOTSTRAP_TTL_MS;
    const authorizationDigest = initialDeviceBootstrapAuthorizationDigest({
      request,
      authorizationEvidenceDigest: authorization.authorizationDigest,
      crypto: this.#crypto,
    });
    const candidate: InitialDeviceBootstrapChallenge = Object.freeze({
      formatVersion: INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION,
      ...request,
      authorizationEvidenceDigest: Uint8Array.from(
        authorization.authorizationDigest,
      ),
      authorizationDigest,
      challengeId: id,
      issuedAt,
      expiresAt,
    });
    assertInitialDeviceBootstrapChallenge(candidate);
    const result = await this.#repository.begin({
      request,
      authorizationDigest,
      challengeId: id,
      challengeHash: this.#crypto.hash(new TextEncoder().encode(id)),
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
      recoveryPublicKeyDigest: recoveryPublicKeyDigestV2(
        request.recoveryPublicKey,
      ),
      issuedAt,
      expiresAt,
    });
    if (result.status !== "created" && result.status !== "duplicate") {
      throw new InitialDeviceBootstrapError(result.status);
    }
    const challenge: InitialDeviceBootstrapChallenge = Object.freeze({
      ...candidate,
      challengeId: result.challengeId,
      issuedAt: result.issuedAt,
      expiresAt: result.expiresAt,
    });
    assertInitialDeviceBootstrapChallenge(challenge);
    return challenge;
  }

  async complete(
    completion: InitialDeviceBootstrapCompletion,
  ): Promise<InitialDeviceBootstrapReceipt> {
    if (
      completion.formatVersion !== INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION
      || !(completion.deviceProof instanceof Uint8Array)
      || completion.deviceProof.length !== 64
    ) {
      throw new InitialDeviceBootstrapError("challenge_invalid");
    }
    const challenge = completion.challenge;
    assertInitialDeviceBootstrapChallenge(challenge);
    if (
      !equalBytes(
        challenge.authorizationDigest,
        initialDeviceBootstrapAuthorizationDigest({
          request: challenge,
          authorizationEvidenceDigest:
            challenge.authorizationEvidenceDigest,
          crypto: this.#crypto,
        }),
      )
    ) {
      throw new InitialDeviceBootstrapError("challenge_invalid");
    }
    const signingBytes = initialDeviceBootstrapSigningBytes({
      challenge,
      recoveryArchiveBytes: completion.recoveryArchiveBytes,
      crypto: this.#crypto,
    });
    const validDeviceProof = this.#crypto.verify(
        challenge.signingPublicKey,
        signingBytes,
        completion.deviceProof,
      );
    signingBytes.fill(0);
    if (!validDeviceProof) {
      throw new InitialDeviceBootstrapError("invalid_device_proof");
    }

    let archive;
    try {
      archive = decodeHumanRecoveryArchiveV2(
        completion.recoveryArchiveBytes,
      );
      const expectedRecoveryDigest = recoveryPublicKeyDigestV2(
        challenge.recoveryPublicKey,
      );
      if (
        archive.humanId !== humanId(challenge.humanActorId)
        || archive.recoveryKeyId !== challenge.recoveryKeyId
        || archive.recoveryGeneration !== 1
        || archive.issuerDeviceId !== challenge.deviceId
        || !equalBytes(
          archive.recoveryPublicKeyDigest,
          expectedRecoveryDigest,
        )
        || !this.#crypto.verify(
          challenge.signingPublicKey,
          humanRecoveryArchiveSigningBytesV2(archive),
          archive.signature,
        )
      ) {
        throw new Error("archive binding mismatch");
      }
    } catch {
      throw new InitialDeviceBootstrapError("invalid_recovery_archive");
    }

    const committedAt = this.#crypto.clock.now();
    const archiveHash = this.#crypto.hash(completion.recoveryArchiveBytes);
    const auditRef = initialDeviceBootstrapAuditRef({
      challenge,
      recoveryArchiveBytes: completion.recoveryArchiveBytes,
      crypto: this.#crypto,
    });
    const result = await this.#repository.complete({
      challenge,
      challengeHash: this.#crypto.hash(
        new TextEncoder().encode(challenge.challengeId),
      ),
      publicFingerprint: this.#crypto.hash(
        new Uint8Array([
          ...challenge.signingPublicKey,
          ...challenge.encryptionPublicKey,
        ]),
      ),
      signingPublicKeyDigest: this.#crypto.hash(challenge.signingPublicKey),
      encryptionPublicKeyDigest: this.#crypto.hash(
        challenge.encryptionPublicKey,
      ),
      recoveryPublicKeyDigest: recoveryPublicKeyDigestV2(
        challenge.recoveryPublicKey,
      ),
      recoveryArchiveHash: archiveHash,
      recoveryArchiveBytes: completion.recoveryArchiveBytes,
      auditRef,
      committedAt,
    });
    if (result.status === "applied" || result.status === "duplicate") {
      return result.receipt;
    }
    throw new InitialDeviceBootstrapError(result.status);
  }
}
