import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  humanId,
  publishHumanRecoveryArchive,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  recoveryKeyGenerationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createInitialDeviceBootstrapProof,
  nautiloActorId,
  nautiloUserId,
  prepareInitialDeviceBootstrapRequest,
  type TranslationResult,
} from "../../src/index.ts";
import {
  InitialDeviceBootstrapService,
} from "../../src/server/index.ts";
import {
  MemoryDeviceLifecycleRepository,
  createSyntheticInitialDeviceAuthorizer,
} from "../../src/testing/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const USER_ID = valueOf(
  nautiloUserId("00000000-0000-4000-8000-00000000000a"),
);
const ACTOR_ID = valueOf(
  nautiloActorId("00000000-0000-4000-8000-00000000000b"),
);
const HUMAN_ID = humanId(ACTOR_ID);
const LINEAGE = new Uint8Array(32).fill(0x31);
const AUTHORIZATION = new Uint8Array(32).fill(0x41);

function deterministicCrypto(now = 10_000): LatticeCrypto {
  let counter = 1;
  return new LatticeCrypto(
    {
      bytes(length) {
        return new Uint8Array(length).fill(counter++);
      },
    },
    { now: () => now },
  );
}

async function bootstrapFixture(context: {
  readonly kind:
    | "preparation"
    | "greenfield_initial_owner"
    | "pending_encrypted_invite";
  readonly authorityId: string;
}, suppliedCrypto?: LatticeCrypto) {
  const crypto = suppliedCrypto ?? deterministicCrypto();
  const repository = new MemoryDeviceLifecycleRepository();
  const service = new InitialDeviceBootstrapService({
    crypto,
    repository,
    authorize: createSyntheticInitialDeviceAuthorizer({
      expectedUserId: USER_ID,
      expectedHumanActorId: ACTOR_ID,
      expectedInstallationLineageDigest: LINEAGE,
      authorizationDigest: AUTHORIZATION,
      allowedContext: context,
    }),
    authorizeReceiptLookup: () => true,
  });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const preparedRequest = await prepareInitialDeviceBootstrapRequest({
    crypto,
    request: {
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      signingPublicKey: signing.publicKey,
      encryptionPublicKey: encryption.publicKey,
      context,
      idempotencyKey: `bootstrap_${context.kind}`,
    },
    presentRecoveryKit() {
      return {
        status: "confirmed",
      };
    },
  });
  const recovery = {
    keyId: preparedRequest.recoveryKeyId,
    publicKey: preparedRequest.recoveryPublicKey,
  };
  const recoveryDigest = crypto.hash(recovery.publicKey);
  const archive = await publishHumanRecoveryArchive({
    crypto,
    humanId: HUMAN_ID,
    recoveryKeyId: recovery.keyId,
    recoveryGeneration: recoveryKeyGenerationV2(1),
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey: () => ({
      humanId: HUMAN_ID,
      recoveryKeyId: recovery.keyId,
      recoveryGeneration: recoveryKeyGenerationV2(1),
      publicKeyDigest: recoveryDigest,
    }),
    issuerDeviceId: cryptoDeviceId("device_alice_browser"),
    createdAt: unixTimestamp(crypto.clock.now()),
    sources: [],
    issuerSigningPrivateKey: signing.privateKey,
    resolveIssuerDevice: () => signing.publicKey,
  });

  return {
    crypto,
    repository,
    service,
    signing,
    encryption,
    recovery,
    archive,
    context,
  };
}

describe("first-device bootstrap", () => {
  for (const context of [
    { kind: "preparation", authorityId: "prep_1" },
    {
      kind: "greenfield_initial_owner",
      authorityId: "installation_1",
    },
    {
      kind: "pending_encrypted_invite",
      authorityId: "invite_1",
    },
  ] as const) {
    test(`activates atomically through ${context.kind}`, async () => {
      const fixture = await bootstrapFixture(context);
      const challenge = await fixture.service.begin({
        userId: USER_ID,
        humanActorId: ACTOR_ID,
        deviceId: "device_alice_browser",
        clientKind: "browser",
        installationLineageDigest: LINEAGE,
        signingPublicKey: fixture.signing.publicKey,
        encryptionPublicKey: fixture.encryption.publicKey,
        recoveryKeyId: fixture.recovery.keyId,
        recoveryPublicKey: fixture.recovery.publicKey,
        context,
        idempotencyKey: `bootstrap_${context.kind}`,
      });
      const completion = createInitialDeviceBootstrapProof({
        crypto: fixture.crypto,
        challenge,
        recoveryArchiveBytes: fixture.archive.archiveBytes,
        signingPrivateKey: fixture.signing.privateKey,
      });
      const receipt = await fixture.service.complete(completion);

      expect(receipt.status).toBe("active");
      expect(receipt.recoveryGeneration).toBe(1);
      expect(receipt.deviceId).toBe("device_alice_browser");
      expect(fixture.repository.publicSnapshot()).toMatchObject({
        custodyState: "active",
        everInitialized: true,
        activeDeviceCount: 1,
        recoveryGeneration: 1,
        challengeStatus: "consumed",
      });
    });
  }

  test("is idempotent after commit and never reopens first bootstrap", async () => {
    const fixture = await bootstrapFixture({
      kind: "preparation",
      authorityId: "prep_replay",
    });
    const beginInput = {
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      clientKind: "browser" as const,
      installationLineageDigest: LINEAGE,
      signingPublicKey: fixture.signing.publicKey,
      encryptionPublicKey: fixture.encryption.publicKey,
      recoveryKeyId: fixture.recovery.keyId,
      recoveryPublicKey: fixture.recovery.publicKey,
      context: fixture.context,
      idempotencyKey: "bootstrap_replay",
    };
    const challenge = await fixture.service.begin(beginInput);
    expect((await fixture.service.begin(beginInput)).challengeId).toBe(
      challenge.challengeId,
    );
    const completion = createInitialDeviceBootstrapProof({
      crypto: fixture.crypto,
      challenge,
      recoveryArchiveBytes: fixture.archive.archiveBytes,
      signingPrivateKey: fixture.signing.privateKey,
    });
    const first = await fixture.service.complete(completion);
    expect(await fixture.service.complete(completion)).toEqual(first);
    const receiptQuery = {
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      challengeId: challenge.challengeId,
      publicFingerprint: fixture.crypto.hash(new Uint8Array([
        ...fixture.signing.publicKey,
        ...fixture.encryption.publicKey,
      ])),
    };
    expect(await fixture.service.resolveReceipt(receiptQuery)).toEqual(first);
    const unauthorizedLookup = new InitialDeviceBootstrapService({
      crypto: fixture.crypto,
      repository: fixture.repository,
      authorize: () => ({ authorized: false }),
      authorizeReceiptLookup: () => false,
    });
    expect(unauthorizedLookup.resolveReceipt(receiptQuery)).rejects
      .toMatchObject({ code: "authorization_rejected" });

    expect(
      fixture.service.begin({
        ...beginInput,
        deviceId: "device_second",
        idempotencyKey: "bootstrap_illegal_second",
      }),
    ).rejects.toMatchObject({ code: "already_initialized" });
  });

  test("rejects a forged proof without partially authorizing the device", async () => {
    const fixture = await bootstrapFixture({
      kind: "pending_encrypted_invite",
      authorityId: "invite_forgery",
    });
    const challenge = await fixture.service.begin({
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      signingPublicKey: fixture.signing.publicKey,
      encryptionPublicKey: fixture.encryption.publicKey,
      recoveryKeyId: fixture.recovery.keyId,
      recoveryPublicKey: fixture.recovery.publicKey,
      context: fixture.context,
      idempotencyKey: "bootstrap_forgery",
    });
    const attacker = fixture.crypto.generateSigningKeyPair();
    const forged = createInitialDeviceBootstrapProof({
      crypto: fixture.crypto,
      challenge,
      recoveryArchiveBytes: fixture.archive.archiveBytes,
      signingPrivateKey: attacker.privateKey,
    });

    expect(fixture.service.complete(forged)).rejects.toMatchObject({
      code: "invalid_device_proof",
    });
    expect(fixture.repository.publicSnapshot()).toMatchObject({
      custodyState: "initializing",
      everInitialized: false,
      activeDeviceCount: 0,
      challengeStatus: "pending",
    });
  });

  test("rejects a device-signed challenge whose authorized request was changed", async () => {
    const fixture = await bootstrapFixture({
      kind: "pending_encrypted_invite",
      authorityId: "invite_original",
    });
    const challenge = await fixture.service.begin({
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      signingPublicKey: fixture.signing.publicKey,
      encryptionPublicKey: fixture.encryption.publicKey,
      recoveryKeyId: fixture.recovery.keyId,
      recoveryPublicKey: fixture.recovery.publicKey,
      context: fixture.context,
      idempotencyKey: "bootstrap_authorization_binding",
    });
    const changedChallenge = Object.freeze({
      ...challenge,
      context: Object.freeze({
        ...challenge.context,
        authorityId: "invite_substituted",
      }),
    });
    const signedByRealDevice = createInitialDeviceBootstrapProof({
      crypto: fixture.crypto,
      challenge: changedChallenge,
      recoveryArchiveBytes: fixture.archive.archiveBytes,
      signingPrivateKey: fixture.signing.privateKey,
    });

    expect(fixture.service.complete(signedByRealDevice)).rejects.toMatchObject({
      code: "challenge_invalid",
    });
    expect(fixture.repository.publicSnapshot()).toMatchObject({
      custodyState: "initializing",
      activeDeviceCount: 0,
      challengeStatus: "pending",
    });
  });

  test("validates the complete request before creating durable state", async () => {
    const fixture = await bootstrapFixture({
      kind: "preparation",
      authorityId: "prep_malformed",
    });
    expect(fixture.service.begin({
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      signingPublicKey: new Uint8Array(31),
      encryptionPublicKey: fixture.encryption.publicKey,
      recoveryKeyId: fixture.recovery.keyId,
      recoveryPublicKey: fixture.recovery.publicKey,
      context: fixture.context,
      idempotencyKey: "bootstrap_malformed",
    })).rejects.toThrow("exactly 32 bytes");
    expect(fixture.repository.publicSnapshot()).toMatchObject({
      custodyState: "absent",
      everInitialized: false,
      activeDeviceCount: 0,
      challengeStatus: "absent",
    });
  });

  test("fails closed at the exact challenge expiry boundary", async () => {
    let now = 10_000;
    let randomByte = 0x51;
    const crypto = new LatticeCrypto(
      {
        bytes(length) {
          return new Uint8Array(length).fill(randomByte++);
        },
      },
      { now: () => now },
    );
    const fixture = await bootstrapFixture({
      kind: "preparation",
      authorityId: "prep_expiry",
    }, crypto);
    const challenge = await fixture.service.begin({
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser",
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      signingPublicKey: fixture.signing.publicKey,
      encryptionPublicKey: fixture.encryption.publicKey,
      recoveryKeyId: fixture.recovery.keyId,
      recoveryPublicKey: fixture.recovery.publicKey,
      context: fixture.context,
      idempotencyKey: "bootstrap_expiry",
    });
    const completion = createInitialDeviceBootstrapProof({
      crypto,
      challenge,
      recoveryArchiveBytes: fixture.archive.archiveBytes,
      signingPrivateKey: fixture.signing.privateKey,
    });
    now = challenge.expiresAt;

    expect(fixture.service.complete(completion)).rejects.toMatchObject({
      code: "challenge_expired",
    });
    expect(fixture.repository.publicSnapshot()).toMatchObject({
      custodyState: "initializing",
      everInitialized: false,
      activeDeviceCount: 0,
      challengeStatus: "pending",
    });

    const retry = await fixture.service.begin({
      userId: USER_ID,
      humanActorId: ACTOR_ID,
      deviceId: "device_alice_browser_retry",
      clientKind: "browser",
      installationLineageDigest: LINEAGE,
      signingPublicKey: fixture.signing.publicKey,
      encryptionPublicKey: fixture.encryption.publicKey,
      recoveryKeyId: fixture.recovery.keyId,
      recoveryPublicKey: fixture.recovery.publicKey,
      context: fixture.context,
      idempotencyKey: "bootstrap_expiry_retry",
    });
    expect(retry.challengeId).not.toBe(challenge.challengeId);
  });
});
