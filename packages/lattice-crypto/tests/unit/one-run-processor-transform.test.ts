import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
  type KeyPair,
} from "../../src/crypto/index.ts";
import {
  appendNamespaceGeneration,
  createInitialNamespaceKeyrings,
  sealNamespaceKeyring,
} from "../../src/namespace/keyrings.ts";
import {
  wrapObjectDekForNamespaceV2,
  decryptObjectThroughNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import {
  encryptObjectPayloadV2,
} from "../../src/object/payload.ts";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  backgroundWorkDescriptorDigestV1,
  type BackgroundWorkDescriptorV1,
} from "../../src/background/work-descriptor-v1.ts";
import {
  createProcessorCredentialV1,
  type ResolveCurrentProcessorCredentialIssuerPublicKeyV1,
} from "../../src/background/processor-credential-v1.ts";
import {
  createProcessorObjectSignerPublicV1,
} from "../../src/background/processor-object-signer-v1.ts";
import {
  createProcessorSignerAuthorizationV1,
} from "../../src/background/processor-signer-authorization-v1.ts";
import {
  verifyObjectAccessManifestV4,
} from "../../src/format/object-access-manifest-v4.ts";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "../../src/format/object-v2.ts";
import {
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

import {
  PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1,
  PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1,
  PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1,
  ProcessorTransformRecipientRegistryV1,
  type ProcessorCredentialClaimPortV1,
  type ProcessorTransformCapabilityV1,
  type ProcessorTransformDeadlineHandleV1,
  type ProcessorTransformDeadlineSchedulerV1,
  type ProcessorTransformObjectPortV1,
  type ProcessorTransformRunInputV1,
} from "../../src/background/one-run-processor-transform-v1.ts";

const NOW = 8_000_000;

class FakeClockScheduler implements ProcessorTransformDeadlineSchedulerV1 {
  now = NOW + 1;
  readonly #deadlines = new Set<{
    readonly deadline: number;
    readonly expire: () => void;
    active: boolean;
  }>();

  readonly read = (): number => this.now;

  get nextDeadline(): number | undefined {
    return [...this.#deadlines]
      .filter((task) => task.active)
      .map((task) => task.deadline)
      .sort((left, right) => left - right)[0];
  }

  scheduleAt(
    deadline: number,
    expire: () => void,
  ): ProcessorTransformDeadlineHandleV1 {
    const task = { deadline, expire, active: true };
    this.#deadlines.add(task);
    return Object.freeze({
      cancel: () => {
        task.active = false;
        this.#deadlines.delete(task);
      },
    });
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
    for (const task of [...this.#deadlines]) {
      if (task.active && task.deadline <= this.now) {
        task.active = false;
        this.#deadlines.delete(task);
        task.expire();
      }
    }
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RecordingKeygenCrypto extends LatticeCrypto {
  readonly privateKeys: Uint8Array[] = [];

  override async generateEncryptionKeyPair(): Promise<KeyPair> {
    const pair = await super.generateEncryptionKeyPair();
    this.privateKeys.push(pair.privateKey);
    return pair;
  }
}

class GatedKeygenCrypto extends RecordingKeygenCrypto {
  readonly #release = deferred<void>();
  readonly #entered = deferred<void>();
  readonly #expected: number;
  #count = 0;

  constructor(seed: number, expected: number) {
    super(seededRng(seed));
    this.#expected = expected;
  }

  get entered(): Promise<void> {
    return this.#entered.promise;
  }

  release(): void {
    this.#release.resolve();
  }

  override async generateEncryptionKeyPair(): Promise<KeyPair> {
    const pair = await super.generateEncryptionKeyPair();
    this.#count += 1;
    if (this.#count === this.#expected) this.#entered.resolve();
    await this.#release.promise;
    return pair;
  }
}

class GatedNthKeygenCrypto extends RecordingKeygenCrypto {
  readonly #release = deferred<void>();
  readonly #entered = deferred<void>();
  readonly #gateAt: number;
  #count = 0;

  constructor(seed: number, gateAt: number) {
    super(seededRng(seed));
    this.#gateAt = gateAt;
  }

  get entered(): Promise<void> {
    return this.#entered.promise;
  }

  release(): void {
    this.#release.resolve();
  }

  override async generateEncryptionKeyPair(): Promise<KeyPair> {
    const pair = await super.generateEncryptionKeyPair();
    this.#count += 1;
    if (this.#count === this.#gateAt) {
      this.#entered.resolve();
      await this.#release.promise;
    }
    return pair;
  }
}

class StalledOpenCrypto extends LatticeCrypto {
  readonly #release = deferred<void>();
  readonly #entered = deferred<void>();
  openedPrivateKey: Uint8Array | undefined;

  get entered(): Promise<void> {
    return this.#entered.promise;
  }

  release(): void {
    this.#release.resolve();
  }

  override async openSealed(
    recipientPrivateKey: Uint8Array,
    sealed: Uint8Array,
  ): Promise<Uint8Array | null> {
    this.openedPrivateKey = recipientPrivateKey;
    this.#entered.resolve();
    await this.#release.promise;
    return super.openSealed(recipientPrivateKey, sealed);
  }
}

class CountingAeadCrypto extends LatticeCrypto {
  aeadOpenCalls = 0;

  override aeadOpen(
    key: Uint8Array,
    blob: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array | null {
    this.aeadOpenCalls += 1;
    return super.aeadOpen(key, blob, aad);
  }
}

class CapturingAeadCrypto extends LatticeCrypto {
  captureKeys = false;
  readonly observedKeys: Uint8Array[] = [];

  override aeadSeal(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array {
    if (this.captureKeys) this.observedKeys.push(key);
    return super.aeadSeal(key, plaintext, aad);
  }

  override aeadOpen(
    key: Uint8Array,
    blob: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array | null {
    if (this.captureKeys) this.observedKeys.push(key);
    return super.aeadOpen(key, blob, aad);
  }
}

class NullOpenCrypto extends LatticeCrypto {
  override async openSealed(): Promise<null> {
    return null;
  }
}

class MalformedKeygenCrypto extends LatticeCrypto {
  returnedPrivateKey: Uint8Array | undefined;

  constructor(seed: number, readonly malformedPart: "private" | "public") {
    super(seededRng(seed));
  }

  override async generateEncryptionKeyPair(): Promise<KeyPair> {
    const pair = await super.generateEncryptionKeyPair();
    const malformed = {
      privateKey: this.malformedPart === "private"
        ? pair.privateKey.slice(1)
        : pair.privateKey,
      publicKey: this.malformedPart === "public"
        ? pair.publicKey.slice(1)
        : pair.publicKey,
    };
    this.returnedPrivateKey = malformed.privateKey;
    return malformed;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(
  seed = 54_100,
  overrides: Partial<BackgroundWorkDescriptorV1> = {},
  suppliedCrypto?: LatticeCrypto,
  suppliedScheduler?: ProcessorTransformDeadlineSchedulerV1,
  useDefaultScheduler = false,
  rotateKeyring = false,
) {
  const crypto = suppliedCrypto ?? new LatticeCrypto(seededRng(seed));
  const issuer = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const clock = new FakeClockScheduler();
  const requestId = `request-${seed}`;
  const workId = `work-${seed}`;
  const exactNamespaceId = namespaceId(`namespace-${seed}`);
  const registry = new ProcessorTransformRecipientRegistryV1({
    crypto,
    now: clock.read,
    ...(useDefaultScheduler
      ? {}
      : { scheduler: suppliedScheduler ?? clock }),
  });
  const recipientResult = await registry.createAttempt({
    requestId,
    workId,
    namespaceId: exactNamespaceId,
    recipientGeneration: 1,
    recipientKeyId: `recipient-${seed}`,
    expiresAt: NOW + 60_000,
  });
  if (recipientResult.status !== "created") {
    throw new Error("Test recipient was not created");
  }
  const recipient = recipientResult.attempt;
  const outputObjectIds = overrides.outputObjectIds
    ?? [objectId(`output-${seed}-a`)];
  const outputObjectMetadata = overrides.outputObjectMetadata
    ?? outputObjectIds.map((exactObjectId, index) => ({
      objectId: exactObjectId,
      objectType: "test.output",
      createdAt: unixTimestamp(NOW + index),
    }));
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId,
    recipientGeneration: 1,
    workKind: "stenographer.extraction",
    workId,
    namespaceId: exactNamespaceId,
    domainId: cryptoDomainId(`domain-${seed}`),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(8),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: 10,
      endSequence: 11,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [
      objectId(`input-${seed}-a`),
      objectId(`input-${seed}-b`),
    ],
    outputObjectIds,
    outputObjectMetadata,
    maximumInputObjectCount: 2,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 128,
    maximumCiphertextBytes: 64 * 1024,
    expectedDomainEpoch: domainEpoch(4),
    expectedNamespaceAccessRevision: accessRevision(0),
    expectedPolicyRevision: authorizationRevision(6),
    recipientKeyId: `recipient-${seed}`,
    recipientPublicKey: recipient.recipientPublicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 60_000,
    idempotencyId: `idempotency-${seed}`,
    ...overrides,
  };
  const signerIdentity = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: `signer-auth-${seed}`,
    workDescriptorHash:
      backgroundWorkDescriptorDigestV1(crypto, descriptor),
    signerPrivateKey: signer.privateKey,
  });
  const created = await createProcessorCredentialV1(crypto, {
    id: `credential-${seed}`,
    workDescriptor: descriptor,
    issuingHumanId: humanId(`human-${seed}`),
    issuingDeviceId: cryptoDeviceId(`device-${seed}`),
    issuingDeviceAuthorizationRevision: authorizationRevision(7),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    signer: signerIdentity.principal,
    signerPublicKey: signerIdentity.publicKey,
    signerPrivateKey: signer.privateKey,
    aiRoot: new Uint8Array(32).fill(0x72),
  });
  const signerAuthorization = createProcessorSignerAuthorizationV1(
    crypto,
    {
      formatVersion: 1,
      id: `signer-auth-${seed}`,
      processorKind: "stenographer",
      processorVersion: 1,
      workId: descriptor.workId,
      namespaceId: descriptor.namespaceId,
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      namespaceAccessRevision:
        descriptor.expectedNamespaceAccessRevision,
      policyRevision: descriptor.expectedPolicyRevision,
      processorAuthorizationRevision: authorizationRevision(8),
      issuingHumanId: humanId(`human-${seed}`),
      issuingDeviceId: cryptoDeviceId(`device-${seed}`),
      issuingDeviceAuthorizationRevision: authorizationRevision(7),
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
      signer: signerIdentity.principal,
      signerPublicKey: signerIdentity.publicKey,
      workDescriptorHash:
        backgroundWorkDescriptorDigestV1(crypto, descriptor),
      credentialHash: created.hash,
      outputObjectIds: descriptor.outputObjectIds,
      maxOutputObjects: descriptor.maximumOutputObjectCount,
      maxOutputPlaintextBytes: descriptor.maximumPlaintextBytes,
      maxOutputCiphertextBytes: descriptor.maximumCiphertextBytes,
      issuedAt: descriptor.issuedAt,
      expiresAt: descriptor.expiresAt,
    },
    issuer.privateKey,
  );
  const aiRoot = new Uint8Array(32).fill(0x72);
  const initialKeyrings = createInitialNamespaceKeyrings(
    crypto,
    descriptor.namespaceId,
  );
  const keyrings = rotateKeyring
    ? Object.freeze({
      ...initialKeyrings,
      ai: appendNamespaceGeneration(crypto, initialKeyrings.ai),
    })
    : initialKeyrings;
  const keyringEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiRoot,
    keyring: keyrings.ai,
    metadata: {
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      previousBindingHash: null,
      committerDeviceId: cryptoDeviceId(`device-${seed}`),
    },
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  return {
    crypto,
    issuer,
    recipient,
    registry,
    clock,
    signer,
    descriptor,
    created,
    signerAuthorization,
    aiRoot,
    keyrings,
    keyringEnvelope,
  };
}

function authority(
  value: Fixture,
  calls?: string[],
): ResolveCurrentProcessorCredentialIssuerPublicKeyV1 {
  return (context) => {
    calls?.push(`authority:${context.credentialId}`);
    return value.issuer.publicKey;
  };
}

function claimPort(events: string[] = []): ProcessorCredentialClaimPortV1 {
  const claimed = new Set<string>();
  return {
    async claimExactCredential(input) {
      expect(input.signal.aborted).toBeFalse();
      expect(input.claimId).toBe(`claim-${input.requestId}`);
      const key = Buffer.from(input.credentialHash).toString("hex");
      events.push(`claim:${input.credentialId}`);
      if (claimed.has(key)) return "already_claimed";
      claimed.add(key);
      return "claimed";
    },
  };
}

function objectPort(
  value: Fixture,
  events: string[] = [],
  plaintextById = new Map<string, Uint8Array>(),
): ProcessorTransformObjectPortV1 {
  return {
    async loadNamespaceKeyring() {
      events.push("keyring");
      return {
        envelope: value.keyringEnvelope,
      };
    },
    async openInput(input) {
      events.push(`open:${input.objectId}`);
      expect(input.signal.aborted).toBeFalse();
      expect(Object.keys(input).sort()).toEqual(["objectId", "signal"]);
      const plaintext =
        plaintextById.get(input.objectId)?.slice()
        ?? new TextEncoder().encode(input.objectId);
      const encrypted = encryptObjectPayloadV2(
        value.crypto,
        {
          objectId: objectId(input.objectId),
          keyClass: "ai",
          objectType: "test.input",
          createdAt: unixTimestamp(NOW),
        },
        plaintext,
      );
      plaintext.fill(0);
      const current = value.keyrings.ai.generations.find(
        (entry) =>
          entry.generation === value.keyrings.ai.currentGeneration,
      )!;
      const envelope = wrapObjectDekForNamespaceV2(
        value.crypto,
        current.key,
        {
          objectId: objectId(input.objectId),
          namespaceId: value.descriptor.namespaceId,
          keyClass: "ai",
          keyGeneration: current.generation,
          bindingRevisionAtWrap:
            value.descriptor.expectedNamespaceAccessRevision,
        },
        encrypted.dek,
      );
      encrypted.dek.fill(0);
      return {
        payload: encrypted.payload,
        envelope,
      };
    },
    async publishOutputs(input) {
      expect(input.signal.aborted).toBeFalse();
      expect(Object.keys(input).sort()).toEqual([
        "authorityCheckedAt",
        "authorizeCommit",
        "claimId",
        "idempotencyId",
        "outputs",
        "signal",
      ]);
      expect(input.idempotencyId).toBe(value.descriptor.idempotencyId);
      expect(input.claimId).toBe(`claim-${value.descriptor.requestId}`);
      expect(input.authorityCheckedAt).toBe(value.clock.now);
      expect(await input.authorizeCommit()).toBe(value.clock.now);
      for (const output of input.outputs) {
        events.push(`publish:${output.objectId}`);
        expect(Object.keys(output).sort()).toEqual([
          "envelopeBytes",
          "manifestBytes",
          "objectId",
          "payloadBytes",
          "signerAuthorizationBytes",
          "tombstoneManifestBytes",
        ]);
      }
    },
  };
}

function executeInput(
  value: Fixture,
  overrides: Partial<ProcessorTransformRunInputV1> = {},
): ProcessorTransformRunInputV1 & Readonly<{
  readonly registry: ProcessorTransformRecipientRegistryV1;
}> {
  return {
    registry: value.registry,
    requestId: value.descriptor.requestId,
    recipientGeneration: value.descriptor.recipientGeneration,
    recipientKeyId: value.descriptor.recipientKeyId,
    claimId: `claim-${value.descriptor.requestId}`,
    credentialBytes: value.created.bytes,
    resolveCurrentIssuerPublicKey: authority(value),
    signerAuthorizationBytes: value.signerAuthorization.bytes,
    resolveHistoricalNamespaceCommitter: () => value.issuer.publicKey,
    resolveCurrentSignerIssuingDevicePublicKey: () =>
      value.issuer.publicKey,
    claims: claimPort(),
    objects: objectPort(value),
    execute: async (capability: ProcessorTransformCapabilityV1) => {
      const inputs = await capability.openInputs();
      await capability.publishOutputs([{
        objectId: value.descriptor.outputObjectIds[0]!,
        plaintext: inputs[0]!.plaintext,
      }]);
    },
    ...overrides,
  };
}

function runRegisteredTransform(
  input: ProcessorTransformRunInputV1 & Readonly<{
    readonly registry: ProcessorTransformRecipientRegistryV1;
  }>,
) {
  return input.registry.run(input);
}

async function expectRejection(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}

function registryAttemptInput(index: number) {
  return {
    requestId: `registry-request-${index}`,
    workId: `registry-work-${index}`,
    namespaceId: namespaceId("registry-namespace"),
    recipientGeneration: 1,
    recipientKeyId: `registry-key-${index}`,
    expiresAt: NOW + 60_000,
  } as const;
}

describe("processor transform recipient registry", () => {
  test("locks and enforces every registry bound", () => {
    const crypto = new LatticeCrypto(seededRng(54_188));
    expect(PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1).toBe(256);
    expect(PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1).toBe(32);
    expect(PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1).toBe(600_000);

    for (const bounds of [
      { maxLive: Number.NaN, maxPerNamespace: 1 },
      { maxLive: 0, maxPerNamespace: 1 },
      { maxLive: 257, maxPerNamespace: 1 },
      { maxLive: 2, maxPerNamespace: Number.NaN },
      { maxLive: 2, maxPerNamespace: 0 },
      { maxLive: 33, maxPerNamespace: 33 },
      { maxLive: 1, maxPerNamespace: 2 },
    ]) {
      expect(() => new ProcessorTransformRecipientRegistryV1({
        crypto,
        ...bounds,
      })).toThrow("recipient bounds are invalid");
    }
    expect(() => new ProcessorTransformRecipientRegistryV1({
      crypto,
      maxLive: 1,
      maxPerNamespace: 1,
    })).not.toThrow();
    expect(() => new ProcessorTransformRecipientRegistryV1({
      crypto,
      maxLive: PROCESSOR_TRANSFORM_MAX_LIVE_RECIPIENTS_V1,
      maxPerNamespace:
        PROCESSOR_TRANSFORM_MAX_RECIPIENTS_PER_NAMESPACE_V1,
    })).not.toThrow();
  });

  test("enforces expiry, duplicate-work, and Namespace capacity boundaries", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_187));
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
      maxLive: 3,
      maxPerNamespace: 2,
    });
    const input = registryAttemptInput(20);
    await expectRejection(registry.createAttempt({
      ...input,
      expiresAt: clock.now,
    }), "expiry is invalid");
    await expectRejection(registry.createAttempt({
      ...input,
      expiresAt: clock.now
        + PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1 + 1,
    }), "expiry is invalid");
    expect(crypto.privateKeys).toHaveLength(0);
    expect((await registry.createAttempt({
      ...input,
      expiresAt: clock.now + PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1,
    })).status).toBe("created");
    expect(await registry.createAttempt({
      ...registryAttemptInput(21),
      workId: input.workId,
      namespaceId: input.namespaceId,
    })).toEqual({
      status: "unavailable",
      reason: "duplicate_work",
    });
    expect((await registry.createAttempt(registryAttemptInput(22))).status)
      .toBe("created");
    expect(await registry.createAttempt(registryAttemptInput(23))).toEqual({
      status: "unavailable",
      reason: "namespace_capacity",
    });
    registry.close();
  });

  test("fails closed before and after key generation", async () => {
    const clock = new FakeClockScheduler();
    const closedCrypto = new RecordingKeygenCrypto(seededRng(54_193));
    const closed = new ProcessorTransformRecipientRegistryV1({
      crypto: closedCrypto,
      now: clock.read,
      scheduler: clock,
    });
    closed.close();
    expect(await closed.createAttempt(registryAttemptInput(50))).toEqual({
      status: "unavailable",
      reason: "registry_closed",
    });
    expect(closedCrypto.privateKeys).toHaveLength(0);

    for (const [index, malformedPart] of
      (["private", "public"] as const).entries()) {
      const crypto = new MalformedKeygenCrypto(
        54_194 + index,
        malformedPart,
      );
      const registry = new ProcessorTransformRecipientRegistryV1({
        crypto,
        now: clock.read,
        scheduler: clock,
      });
      await expectRejection(
        registry.createAttempt(registryAttemptInput(51 + index)),
        "HPKE keypair is malformed",
      );
      expect(crypto.returnedPrivateKey).toEqual(
        new Uint8Array(crypto.returnedPrivateKey!.length),
      );
      expect(registry.size).toBe(0);
    }

    const gated = new GatedKeygenCrypto(54_196, 1);
    const guarded = new ProcessorTransformRecipientRegistryV1({
      crypto: gated,
      now: clock.read,
      scheduler: clock,
    });
    const creating = guarded.createAttempt({
      ...registryAttemptInput(53),
      expiresAt: clock.now + PROCESSOR_TRANSFORM_MAX_RECIPIENT_TTL_MS_V1,
    });
    await gated.entered;
    clock.now -= 1;
    gated.release();
    await expectRejection(creating, "expiry is invalid");
    expect(gated.privateKeys[0]).toEqual(
      new Uint8Array(gated.privateKeys[0]!.length),
    );
  });

  test("Namespace capacity counts only that exact Namespace", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_197));
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
      maxLive: 3,
      maxPerNamespace: 1,
    });
    const first = registryAttemptInput(54);
    const otherNamespace = {
      ...registryAttemptInput(55),
      namespaceId: namespaceId("registry-other-namespace"),
    };
    expect((await registry.createAttempt(first)).status).toBe("created");
    expect((await registry.createAttempt(otherNamespace)).status)
      .toBe("created");
    expect(await registry.createAttempt(registryAttemptInput(56))).toEqual({
      status: "unavailable",
      reason: "namespace_capacity",
    });
    registry.close();
  });

  test("sweep, delete, and repeated close remove only exact live attempts", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_186));
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
    });
    const first = registryAttemptInput(30);
    const expiring = await registry.createAttempt({
      ...first,
      expiresAt: clock.now + 1,
    });
    expect(expiring.status).toBe("created");
    if (expiring.status !== "created") throw new Error("creation failed");
    const publicKeySnapshot = expiring.attempt.recipientPublicKey.slice();
    expect(registry.sweep()).toBe(0);
    clock.advance(1);
    expect(registry.sweep()).toBe(1);
    expect(expiring.attempt.recipientPublicKey).toEqual(publicKeySnapshot);
    expect(registry.sweep()).toBe(0);
    expect(registry.delete(first.requestId, first.recipientGeneration))
      .toBe(false);

    const second = registryAttemptInput(31);
    expect((await registry.createAttempt(second)).status).toBe("created");
    expect(registry.delete(second.requestId, second.recipientGeneration + 1))
      .toBe(false);
    expect(registry.delete(second.requestId, second.recipientGeneration))
      .toBe(true);
    expect(registry.size).toBe(0);
    registry.close();
    registry.close();
    expect(registry.size).toBe(0);
    expect(crypto.privateKeys.every((key) =>
      key.every((byte) => byte === 0)
    )).toBe(true);
  });

  test("hasAttempt expires exactly at its deadline and commit rechecks time", async () => {
    const clock = new FakeClockScheduler();
    const crypto = new RecordingKeygenCrypto(seededRng(54_185));
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
    });
    const exact = {
      ...registryAttemptInput(40),
      expiresAt: clock.now + 1,
    };
    expect((await registry.createAttempt(exact)).status).toBe("created");
    clock.now += 1;
    expect(registry.hasAttempt({
      requestId: exact.requestId,
      recipientGeneration: exact.recipientGeneration,
      recipientKeyId: exact.recipientKeyId,
    })).toBe(false);
    expect(registry.size).toBe(0);
    expect(crypto.privateKeys[0]!.every((byte) => byte === 0)).toBe(true);

    const gated = new GatedKeygenCrypto(54_184, 1);
    const gatedRegistry = new ProcessorTransformRecipientRegistryV1({
      crypto: gated,
      now: clock.read,
      scheduler: clock,
    });
    const creating = gatedRegistry.createAttempt({
      ...registryAttemptInput(41),
      expiresAt: clock.now + 1,
    });
    await gated.entered;
    clock.now += 1;
    gated.release();
    await expectRejection(creating, "expiry is invalid");
    expect(gatedRegistry.size).toBe(0);
    expect(gated.privateKeys[0]!.every((byte) => byte === 0)).toBe(true);
  });

  test("reports only the exact live process-local recipient attempt", async () => {
    const crypto = new LatticeCrypto(seededRng(54_189));
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
    });
    const input = registryAttemptInput(0);
    expect((await registry.createAttempt(input)).status).toBe("created");

    expect(registry.hasAttempt({
      requestId: input.requestId,
      recipientGeneration: input.recipientGeneration,
      recipientKeyId: input.recipientKeyId,
    })).toBe(true);
    expect(registry.hasAttempt({
      requestId: input.requestId,
      recipientGeneration: input.recipientGeneration,
      recipientKeyId: "substituted-recipient-key",
    })).toBe(false);
    expect(registry.hasAttempt({
      requestId: input.requestId,
      recipientGeneration: input.recipientGeneration + 1,
      recipientKeyId: input.recipientKeyId,
    })).toBe(false);

    registry.close();
    expect(registry.hasAttempt({
      requestId: input.requestId,
      recipientGeneration: input.recipientGeneration,
      recipientKeyId: input.recipientKeyId,
    })).toBe(false);
  });

  test("concurrent duplicate creation stores one key and wipes the loser", async () => {
    const crypto = new GatedKeygenCrypto(54_190, 2);
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
      maxLive: 2,
      maxPerNamespace: 2,
    });
    const input = registryAttemptInput(1);
    const creations = [
      registry.createAttempt(input),
      registry.createAttempt(input),
    ];
    await crypto.entered;
    crypto.release();
    const results = await Promise.all(creations);

    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results).toContainEqual({
      status: "unavailable",
      reason: "duplicate_attempt",
    });
    expect(registry.size).toBe(1);
    expect(
      crypto.privateKeys.filter((key) => key.every((byte) => byte === 0)),
    ).toHaveLength(1);
    registry.close();
    expect(
      crypto.privateKeys.every((key) => key.every((byte) => byte === 0)),
    ).toBeTrue();
  });

  test("concurrent creation cannot exceed process capacity", async () => {
    const crypto = new GatedKeygenCrypto(54_191, 2);
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
      maxLive: 1,
      maxPerNamespace: 1,
    });
    const creations = [
      registry.createAttempt(registryAttemptInput(2)),
      registry.createAttempt(registryAttemptInput(3)),
    ];
    await crypto.entered;
    crypto.release();
    const results = await Promise.all(creations);

    expect(results.filter((result) => result.status === "created")).toHaveLength(1);
    expect(results).toContainEqual({
      status: "unavailable",
      reason: "process_capacity",
    });
    expect(registry.size).toBe(1);
    expect(
      crypto.privateKeys.filter((key) => key.every((byte) => byte === 0)),
    ).toHaveLength(1);
    registry.close();
  });

  test("closing during key generation wipes the uncommitted key", async () => {
    const crypto = new GatedKeygenCrypto(54_192, 1);
    const clock = new FakeClockScheduler();
    const registry = new ProcessorTransformRecipientRegistryV1({
      crypto,
      now: clock.read,
      scheduler: clock,
    });
    const creating = registry.createAttempt(registryAttemptInput(4));
    await crypto.entered;
    registry.close();
    crypto.release();

    expect(await creating).toEqual({
      status: "unavailable",
      reason: "registry_closed",
    });
    expect(registry.size).toBe(0);
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );
  });
});

describe("one-run processor transform", () => {
  test("claims before crypto use and lends only bounded object methods", async () => {
    const value = await fixture();
    const events: string[] = [];
    const keys: string[][] = [];
    let published:
      | Readonly<{
        payloadBytes: Uint8Array;
        envelopeBytes: Uint8Array;
        manifestBytes: Uint8Array;
        tombstoneManifestBytes: Uint8Array;
      }>
      | undefined;
    const baseObjects = objectPort(value, events);

    const result = await runRegisteredTransform(executeInput(value, {
      resolveCurrentIssuerPublicKey: authority(value, events),
      claims: claimPort(events),
      objects: {
        ...baseObjects,
        publishOutputs: async (input) => {
          const output = input.outputs[0]!;
          published = {
            payloadBytes: output.payloadBytes.slice(),
            envelopeBytes: output.envelopeBytes.slice(),
            manifestBytes: output.manifestBytes.slice(),
            tombstoneManifestBytes:
              output.tombstoneManifestBytes.slice(),
          };
          await baseObjects.publishOutputs(input);
        },
      },
      execute: async (capability) => {
        keys.push(Object.keys(capability).sort());
        const inputs = await capability.openInputs();
        expect(inputs.map((input) => input.objectId)).toEqual(
          [...value.descriptor.inputObjectIds],
        );
        await capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: new Uint8Array([1, 2, 3]),
        }]);
      },
    }));

    expect(result).toEqual({ status: "executed" });
    expect(keys).toEqual([["openInputs", "publishOutputs"]]);
    const payload = decodeEncryptedPayloadV2(published!.payloadBytes);
    const envelope =
      decodeNamespaceObjectEnvelopeV2(published!.envelopeBytes);
    const currentKey = value.keyrings.ai.generations.find(
      (entry) =>
        entry.generation === value.keyrings.ai.currentGeneration,
    )!.key;
    expect(
      decryptObjectThroughNamespaceV2(
        value.crypto,
        currentKey,
        envelope,
        payload,
      ),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(payload.context.objectType).toBe(
      value.descriptor.outputObjectMetadata[0]!.objectType,
    );
    expect(payload.context.createdAt).toBe(
      value.descriptor.outputObjectMetadata[0]!.createdAt,
    );
    const genesis = verifyObjectAccessManifestV4(value.crypto, {
      manifestBytes: published!.manifestBytes,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () =>
        value.signerAuthorization.bytes,
      resolveHistoricalIssuingDevicePublicKey: () =>
        value.issuer.publicKey,
    });
    const tombstone = verifyObjectAccessManifestV4(value.crypto, {
      manifestBytes: published!.tombstoneManifestBytes,
      resolveAgentRuntimeSignerPublicKey: () => null,
      resolveProcessorSignerAuthorizationBytes: () =>
        value.signerAuthorization.bytes,
      resolveHistoricalIssuingDevicePublicKey: () =>
        value.issuer.publicKey,
    });
    expect(genesis.manifest.signer.kind).toBe("processor_invocation");
    expect(genesis.manifest.envelopeHashes).toEqual([
      value.crypto.hash(published!.envelopeBytes),
    ]);
    expect(tombstone.manifest).toMatchObject({
      objectId: genesis.manifest.objectId,
      accessRevision: 1,
      envelopeHashes: [],
      hostAuthorizationRevision:
        genesis.manifest.hostAuthorizationRevision,
    });
    expect(tombstone.manifest.payloadHash).toEqual(
      genesis.manifest.payloadHash,
    );
    expect(tombstone.manifest.signerAuthorizationHash).toEqual(
      genesis.manifest.signerAuthorizationHash,
    );
    expect(tombstone.manifest.previousManifestHash).toEqual(
      genesis.manifestHash,
    );
    expect(events).toEqual([
      `authority:${value.created.credential.id}`,
      `claim:${value.created.credential.id}`,
      `authority:${value.created.credential.id}`,
      "keyring",
      `open:${value.descriptor.inputObjectIds[0]}`,
      `open:${value.descriptor.inputObjectIds[1]}`,
      `authority:${value.created.credential.id}`,
      `authority:${value.created.credential.id}`,
      `authority:${value.created.credential.id}`,
      `publish:${value.descriptor.outputObjectIds[0]}`,
    ]);
  });

  test("wipes claim comparison hashes after the exact CAS", async () => {
    const value = await fixture(54_183);
    let credentialHash: Uint8Array | undefined;
    let workDescriptorHash: Uint8Array | undefined;
    await runRegisteredTransform(executeInput(value, {
      claims: {
        async claimExactCredential(input) {
          credentialHash = input.credentialHash;
          workDescriptorHash = input.workDescriptorHash;
          expect(credentialHash.some((byte) => byte !== 0)).toBeTrue();
          expect(workDescriptorHash.some((byte) => byte !== 0)).toBeTrue();
          return "claimed";
        },
      },
    }));
    expect(credentialHash).toEqual(new Uint8Array(credentialHash!.length));
    expect(workDescriptorHash).toEqual(
      new Uint8Array(workDescriptorHash!.length),
    );
  });

  test("the process-local recipient is single-use across sequential runs", async () => {
    const value = await fixture(54_101);
    const events: string[] = [];
    let executions = 0;
    const input = executeInput(value, {
      claims: claimPort(events),
      objects: objectPort(value, events),
      execute: async (capability) => {
        executions += 1;
        const opened = await capability.openInputs();
        await capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: opened[0]!.plaintext,
        }]);
      },
    });

    expect((await runRegisteredTransform(input)).status)
      .toBe("executed");
    expect(await runRegisteredTransform(input)).toEqual({
      status: "unavailable",
      reason: "recipient_unavailable",
    });
    expect(executions).toBe(1);
    expect(events.filter((event) => event.startsWith("open:"))).toHaveLength(2);
  });

  test("an atomic claim admits only one concurrent transform", async () => {
    const value = await fixture(54_102);
    let held = false;
    let executions = 0;
    const claims: ProcessorCredentialClaimPortV1 = {
      async claimExactCredential() {
        await Promise.resolve();
        if (held) return "already_claimed";
        held = true;
        return "claimed";
      },
    };
    const input = executeInput(value, {
      claims,
      execute: async (capability) => {
        executions += 1;
        const opened = await capability.openInputs();
        await capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: opened[0]!.plaintext,
        }]);
      },
    });

    const results = await Promise.all([
      runRegisteredTransform(input),
      runRegisteredTransform(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "executed",
      "unavailable",
    ]);
    expect(results).toContainEqual({
      status: "unavailable",
      reason: "recipient_in_use",
    });
    expect(executions).toBe(1);
  });

  test("reports exact lookup, key, expiry, and timeout failures", async () => {
    const lookup = await fixture(54_131);
    expect(await runRegisteredTransform(executeInput(lookup, {
      recipientGeneration: lookup.descriptor.recipientGeneration + 1,
    }))).toEqual({
      status: "unavailable",
      reason: "recipient_unavailable",
    });
    expect(await runRegisteredTransform(executeInput(lookup, {
      recipientKeyId: "substituted-recipient-key",
    }))).toEqual({
      status: "unavailable",
      reason: "recipient_key_mismatch",
    });
    lookup.registry.close();
    expect(await runRegisteredTransform(executeInput(lookup))).toEqual({
      status: "unavailable",
      reason: "registry_closed",
    });

    const expired = await fixture(54_132);
    expired.clock.advance(
      expired.descriptor.expiresAt - expired.clock.now,
    );
    expect(await runRegisteredTransform(executeInput(expired))).toEqual({
      status: "unavailable",
      reason: "recipient_expired",
    });
    expect(expired.registry.size).toBe(0);

    const timeout = await fixture(54_133);
    const remaining = timeout.descriptor.expiresAt - timeout.clock.now;
    for (const timeoutMs of [Number.NaN, 0, remaining + 1]) {
      await expectRejection(runRegisteredTransform(executeInput(timeout, {
        timeoutMs,
      })), "timeout must fit recipient validity");
    }
    expect(timeout.registry.size).toBe(1);
    timeout.registry.close();
  });

  test("publishes every prepared output in one atomic port call", async () => {
    const value = await fixture(54_113, {
      outputObjectIds: [
        objectId("output-54113-a"),
        objectId("output-54113-b"),
      ],
      maximumOutputObjectCount: 2,
    });
    const base = objectPort(value);
    let publicationCalls = 0;
    let publicationSize = 0;
    const payloads: Uint8Array[] = [];
    const envelopes: Uint8Array[] = [];
    const sharedOutput = new Uint8Array([7, 8, 9]);

    await runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        publishOutputs: async (input) => {
          publicationCalls += 1;
          publicationSize = input.outputs.length;
          payloads.push(
            ...input.outputs.map((output) => output.payloadBytes.slice()),
          );
          envelopes.push(
            ...input.outputs.map((output) => output.envelopeBytes.slice()),
          );
          await base.publishOutputs(input);
        },
      },
      execute: async (capability) => {
        await capability.openInputs();
        await capability.publishOutputs(
          value.descriptor.outputObjectIds.map((exactId) => ({
            objectId: exactId,
            plaintext: sharedOutput,
          })),
        );
      },
    }));

    expect(publicationCalls).toBe(1);
    expect(publicationSize).toBe(2);
    expect(sharedOutput).toEqual(new Uint8Array(3));
    for (let index = 0; index < payloads.length; index += 1) {
      const currentKey = value.keyrings.ai.generations.find(
        (generation) =>
          generation.generation === value.keyrings.ai.currentGeneration,
      )!.key;
      expect(decryptObjectThroughNamespaceV2(
        value.crypto,
        currentKey,
        decodeNamespaceObjectEnvelopeV2(envelopes[index]!),
        decodeEncryptedPayloadV2(payloads[index]!),
      )).toEqual(new Uint8Array([7, 8, 9]));
    }
  });

  test("wipes every prepared publication buffer after port ownership ends", async () => {
    const value = await fixture(54_177);
    const base = objectPort(value);
    let retained: Readonly<{
      payloadBytes: Uint8Array;
      envelopeBytes: Uint8Array;
      manifestBytes: Uint8Array;
      tombstoneManifestBytes: Uint8Array;
      signerAuthorizationBytes: Uint8Array;
    }> | undefined;
    await runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        async publishOutputs(input) {
          retained = input.outputs[0]!;
          expect([
            retained.payloadBytes,
            retained.envelopeBytes,
            retained.manifestBytes,
            retained.tombstoneManifestBytes,
            retained.signerAuthorizationBytes,
          ].every((bytes) => bytes.some((byte) => byte !== 0))).toBeTrue();
          await base.publishOutputs(input);
        },
      },
    }));
    for (const bytes of [
      retained!.payloadBytes,
      retained!.envelopeBytes,
      retained!.manifestBytes,
      retained!.tombstoneManifestBytes,
      retained!.signerAuthorizationBytes,
    ]) {
      expect(bytes).toEqual(new Uint8Array(bytes.length));
    }
  });

  test("encrypts output only with the declared current Namespace generation", async () => {
    const value = await fixture(
      54_186,
      {},
      undefined,
      undefined,
      false,
      true,
    );
    const base = objectPort(value);
    let payloadBytes: Uint8Array | undefined;
    let envelopeBytes: Uint8Array | undefined;
    await runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        async publishOutputs(input) {
          payloadBytes = input.outputs[0]!.payloadBytes.slice();
          envelopeBytes = input.outputs[0]!.envelopeBytes.slice();
          await base.publishOutputs(input);
        },
      },
    }));
    const current = value.keyrings.ai.generations.find(
      (entry) => entry.generation === value.keyrings.ai.currentGeneration,
    )!;
    const previous = value.keyrings.ai.generations[0]!;
    const payload = decodeEncryptedPayloadV2(payloadBytes!);
    const envelope = decodeNamespaceObjectEnvelopeV2(envelopeBytes!);
    expect(envelope.context.keyGeneration).toBe(current.generation);
    expect(decryptObjectThroughNamespaceV2(
      value.crypto,
      current.key,
      envelope,
      payload,
    )).not.toBeNull();
    expect(decryptObjectThroughNamespaceV2(
      value.crypto,
      previous.key,
      envelope,
      payload,
    )).toBeNull();
  });

  test("publishes an ordered prefix of authorized output slots, including empty", async () => {
    for (const publishedCount of [0, 1, 2, 3]) {
      const offset = publishedCount;
      const seed = 54_131 + offset;
      const value = await fixture(seed, {
        outputObjectIds: [
          objectId(`output-${seed}-a`),
          objectId(`output-${seed}-b`),
          objectId(`output-${seed}-c`),
        ],
        maximumOutputObjectCount: 3,
      });
      const base = objectPort(value);
      const publishedIds: string[][] = [];

      expect(await runRegisteredTransform(executeInput(value, {
        objects: {
          ...base,
          publishOutputs: async (input) => {
            publishedIds.push(
              input.outputs.map((output) => output.objectId),
            );
            await base.publishOutputs(input);
          },
        },
        execute: async (capability) => {
          await capability.openInputs();
          await capability.publishOutputs(
            value.descriptor.outputObjectIds
              .slice(0, publishedCount)
              .map((exactId) => ({
                objectId: exactId,
                plaintext: new Uint8Array([publishedCount]),
              })),
          );
        },
      }))).toEqual({ status: "executed" });
      expect(publishedIds).toEqual([
        value.descriptor.outputObjectIds.slice(0, publishedCount),
      ]);
    }
  });

  test("rejects gaps, reordering, foreign ids, duplicates, and over-limit output selections", async () => {
    const cases = [
      {
        label: "gap",
        select: (ids: readonly string[]) => [ids[0]!, ids[2]!],
      },
      {
        label: "reordering",
        select: (ids: readonly string[]) => [ids[1]!, ids[0]!],
      },
      {
        label: "foreign id",
        select: (ids: readonly string[]) => [
          ids[0]!,
          objectId("foreign-output-slot"),
        ],
      },
      {
        label: "duplicate",
        select: (ids: readonly string[]) => [ids[0]!, ids[0]!],
      },
      {
        label: "over-limit",
        select: (ids: readonly string[]) => [
          ids[0]!,
          ids[1]!,
          ids[2]!,
          objectId("over-limit-output-slot"),
        ],
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const seed = 54_140 + index;
      const value = await fixture(seed, {
        outputObjectIds: [
          objectId(`output-${seed}-a`),
          objectId(`output-${seed}-b`),
          objectId(`output-${seed}-c`),
        ],
        maximumOutputObjectCount: 3,
      });
      const base = objectPort(value);
      let publicationCalls = 0;
      const plaintexts: Uint8Array[] = [];

      await expectRejection(
        runRegisteredTransform(executeInput(value, {
          objects: {
            ...base,
            publishOutputs: async (input) => {
              publicationCalls += 1;
              await base.publishOutputs(input);
            },
          },
          execute: async (capability) => {
            await capability.openInputs();
            const selected = testCase.select(
              value.descriptor.outputObjectIds,
            );
            for (let outputIndex = 0; outputIndex < selected.length; outputIndex += 1) {
              plaintexts.push(new Uint8Array([outputIndex + 1]));
            }
            await capability.publishOutputs(
              selected.map((exactId, outputIndex) => ({
                objectId: exactId,
                plaintext: plaintexts[outputIndex]!,
              })),
            );
          },
        })),
        "ordered prefix of authorized output slots",
      );
      expect(publicationCalls, testCase.label).toBe(0);
      expect(
        plaintexts.every((plaintext) =>
          plaintext.every((byte) => byte === 0)
        ),
        testCase.label,
      ).toBeTrue();
    }
  });

  test("retained methods fail and opened plaintext is wiped after success", async () => {
    const value = await fixture(54_103);
    let retained: ProcessorTransformCapabilityV1 | undefined;
    let retainedPlaintext: Uint8Array | undefined;
    const outputPlaintext = new Uint8Array([9]);

    await runRegisteredTransform(executeInput(value, {
      execute: async (capability) => {
        retained = capability;
        const opened = await capability.openInputs();
        retainedPlaintext = opened[0]!.plaintext;
        await capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: outputPlaintext,
        }]);
      },
    }));

    expect(retainedPlaintext).toEqual(
      new Uint8Array(retainedPlaintext!.length),
    );
    expect(outputPlaintext).toEqual(new Uint8Array(1));
    await expectRejection(retained!.openInputs(), "unavailable");
    await expectRejection(retained!.publishOutputs([]), "unavailable");
  });

  test("wipes every symmetric key lent to transform crypto", async () => {
    const crypto = new CapturingAeadCrypto(seededRng(54_181));
    const value = await fixture(54_181, {}, crypto);
    const base = objectPort(value);
    const encryptedInputs = new Map(await Promise.all(
      value.descriptor.inputObjectIds.map(async (exactObjectId) => [
        exactObjectId,
        await base.openInput({
          objectId: exactObjectId,
          signal: new AbortController().signal,
        }),
      ] as const),
    ));
    crypto.captureKeys = true;
    await runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        async openInput(input) {
          return encryptedInputs.get(objectId(input.objectId))!;
        },
        async publishOutputs(input) {
          await input.authorizeCommit();
        },
      },
    }));
    expect(crypto.observedKeys.length).toBeGreaterThanOrEqual(4);
    expect(crypto.observedKeys.every((key) =>
      key.every((byte) => byte === 0)
    )).toBeTrue();
  });

  test("removes every transform abort listener after success", async () => {
    const value = await fixture(54_184);
    let added = 0;
    let removed = 0;
    const tracked = new Set<unknown>();
    await runRegisteredTransform(executeInput(value, {
      execute: async (capability, signal) => {
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        Object.defineProperties(signal, {
          addEventListener: {
            configurable: true,
            value: (...arguments_: Parameters<AbortSignal["addEventListener"]>) => {
              if (arguments_[0] === "abort") {
                added += 1;
                tracked.add(arguments_[1]);
              }
              return Reflect.apply(add, signal, arguments_);
            },
          },
          removeEventListener: {
            configurable: true,
            value: (...arguments_: Parameters<AbortSignal["removeEventListener"]>) => {
              if (
                arguments_[0] === "abort"
                && tracked.delete(arguments_[1])
              ) removed += 1;
              return Reflect.apply(remove, signal, arguments_);
            },
          },
        });
        const opened = await capability.openInputs();
        await capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: opened[0]!.plaintext,
        }]);
      },
    }));
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });

  test("throwing worker code invalidates retained authority", async () => {
    const value = await fixture(54_104);
    let retained: ProcessorTransformCapabilityV1 | undefined;
    await expectRejection(runRegisteredTransform(executeInput(value, {
      execute: async (capability) => {
        retained = capability;
        await capability.openInputs();
        throw new Error("worker failed");
      },
    })), "worker failed");

    await expectRejection(retained!.openInputs(), "unavailable");
  });

  test("a worker cannot swallow a failed publication and report success", async () => {
    const value = await fixture(54_111);
    const outputPlaintext = new Uint8Array([1]);
    const result = runRegisteredTransform(executeInput(value, {
      objects: {
        ...objectPort(value),
        publishOutputs: async () => {
          throw new Error("publication failed");
        },
      },
      execute: async (capability) => {
        await capability.openInputs();
        try {
          await capability.publishOutputs([{
            objectId: value.descriptor.outputObjectIds[0]!,
            plaintext: outputPlaintext,
          }]);
        } catch {
          // A malicious or buggy worker must not turn a failed crypto tail into
          // a successful transform merely by swallowing the port error.
        }
      },
    }));

    await expectRejection(result, "publication failed");
    expect(outputPlaintext).toEqual(new Uint8Array(1));
  });

  test("abort invalidates authority immediately, even for a retained worker", async () => {
    const value = await fixture(54_105);
    const controller = new AbortController();
    let retained: ProcessorTransformCapabilityV1 | undefined;
    let release!: () => void;
    let markEntered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const running = runRegisteredTransform(executeInput(value, {
      signal: controller.signal,
      execute: async (capability) => {
        retained = capability;
        markEntered();
        await held;
      },
    }));
    await entered;
    controller.abort(new Error("cancelled"));

    await expectRejection(running, "cancelled");
    await expectRejection(retained!.openInputs(), "unavailable");
    release();
  });

  test("an already-aborted caller cannot reach claims or transform crypto", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_182));
    const value = await fixture(54_182, {}, crypto);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before run"));
    let claims = 0;
    let objectCalls = 0;
    const base = objectPort(value);
    await expectRejection(runRegisteredTransform(executeInput(value, {
      signal: controller.signal,
      claims: {
        async claimExactCredential() {
          claims += 1;
          return "claimed";
        },
      },
      objects: {
        ...base,
        async loadNamespaceKeyring(input) {
          objectCalls += 1;
          return base.loadNamespaceKeyring(input);
        },
      },
    })), "cancelled before run");
    expect(claims).toBe(0);
    expect(objectCalls).toBe(0);
    expect(value.registry.size).toBe(0);
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );
  });

  test("deleting or closing a recipient revokes a running worker", async () => {
    for (const [offset, remove] of (["delete", "close"] as const).entries()) {
      const value = await fixture(54_178 + offset);
      const entered = deferred<void>();
      let workerSignal: AbortSignal | undefined;
      const running = runRegisteredTransform(executeInput(value, {
        execute: async (_capability, signal) => {
          workerSignal = signal;
          entered.resolve();
          await new Promise(() => {});
        },
      }));
      await entered.promise;
      if (remove === "delete") {
        expect(value.registry.delete(
          value.recipient.requestId,
          value.recipient.recipientGeneration,
        )).toBe(true);
      } else {
        value.registry.close();
      }
      await expectRejection(running, "recipient was removed");
      expect(workerSignal?.aborted).toBeTrue();
      expect(value.registry.size).toBe(0);
    }
  });

  test("abort wipes already-open plaintext before worker unwinding", async () => {
    const value = await fixture(54_176);
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    let plaintext: Uint8Array | undefined;
    const running = runRegisteredTransform(executeInput(value, {
      signal: controller.signal,
      execute: async (capability) => {
        plaintext = (await capability.openInputs())[0]!.plaintext;
        entered.resolve();
        await release.promise;
      },
    }));
    await entered.promise;
    expect(plaintext!.some((byte) => byte !== 0)).toBe(true);
    controller.abort(new Error("cancelled after opening"));
    expect(plaintext).toEqual(new Uint8Array(plaintext!.length));
    release.resolve();
    await expectRejection(running, "cancelled after opening");
  });

  test("a fake deadline invalidates authority without wall-clock sleeps", async () => {
    const value = await fixture(54_106);
    let retained: ProcessorTransformCapabilityV1 | undefined;
    let workerSignal: AbortSignal | undefined;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const running = runRegisteredTransform(executeInput(value, {
      timeoutMs: 5,
      execute: async (capability, signal) => {
        retained = capability;
        workerSignal = signal;
        markEntered();
        await new Promise(() => {});
      },
    }));

    await entered;
    expect(value.clock.nextDeadline).toBe(value.clock.now + 5);
    value.clock.advance(5);
    await expectRejection(running, "timed out");
    expect(workerSignal?.aborted).toBe(true);
    expect((workerSignal?.reason as Error).message).toContain("timed out");
    await expectRejection(retained!.openInputs(), "unavailable");
  });

  test("absolute lease deadlines do not slide with delayed execution", async () => {
    const value = await fixture(54_106);
    const deadlineAt = value.clock.now + 10;
    value.clock.advance(4);
    const entered = deferred<void>();
    const running = runRegisteredTransform(executeInput(value, {
      deadlineAt,
      execute: async () => { entered.resolve(); await new Promise(() => {}); },
    }));
    await entered.promise;
    expect(value.clock.nextDeadline).toBe(deadlineAt);
    value.clock.advance(6);
    await expectRejection(running, "timed out");
    expect(value.registry.size).toBe(0);
  });

  test("expired or invalid absolute deadlines never enter a transform", async () => {
    const value = await fixture(54_106);
    for (const deadlineAt of [NaN, 0, -1, Infinity, 1.5]) {
      await expectRejection(runRegisteredTransform(executeInput(value, {deadlineAt})), "positive timestamp");
    }
    expect(value.registry.size).toBe(1);
    await expectRejection(runRegisteredTransform(executeInput(value, {deadlineAt: value.clock.now})), "timed out");
    expect(value.registry.size).toBe(0);
  });

  test("the default scheduler enforces a real deadline", async () => {
    const value = await fixture(
      54_172,
      {},
      undefined,
      undefined,
      true,
    );
    await expectRejection(runRegisteredTransform(executeInput(value, {
      timeoutMs: 5,
      execute: async () => new Promise(() => {}),
    })), "timed out");
    expect(value.registry.size).toBe(0);
  });

  test("the default scheduler uses the exact delay and cancels its timer", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let expire: (() => void) | undefined;
    let delay: number | undefined;
    let cleared = false;
    const timer = 54_185 as unknown as ReturnType<typeof setTimeout>;
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
    ) => {
      expire = handler as () => void;
      delay = timeout;
      return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      expect(handle).toBe(timer);
      cleared = true;
    }) as typeof clearTimeout;
    try {
      const value = await fixture(
        54_185,
        {},
        undefined,
        undefined,
        true,
      );
      const entered = deferred<void>();
      const running = runRegisteredTransform(executeInput(value, {
        timeoutMs: 7,
        execute: async () => {
          entered.resolve();
          await new Promise(() => {});
        },
      }));
      await entered.promise;
      expect(delay).toBe(7);
      expire!();
      await expectRejection(running, "timed out");
      expect(cleared).toBeTrue();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("drains a fire-and-forget publication before reporting success", async () => {
    const value = await fixture(54_116);
    const base = objectPort(value);
    const entered = deferred<void>();
    const release = deferred<void>();
    const outputPlaintext = new Uint8Array([4, 5, 6]);
    let committed = 0;
    let settled = false;
    const running = runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        publishOutputs: async (input) => {
          entered.resolve();
          await release.promise;
          await input.authorizeCommit();
          if (input.signal.aborted) throw new Error("commit aborted");
          committed += 1;
        },
      },
      execute: async (capability) => {
        await capability.openInputs();
        void capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: outputPlaintext,
        }]);
      },
    }));
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await entered.promise;
    await Promise.resolve();
    expect(settled).toBeFalse();
    expect(committed).toBe(0);
    release.resolve();
    expect(await running).toEqual({ status: "executed" });
    expect(committed).toBe(1);
    expect(outputPlaintext).toEqual(new Uint8Array(3));
  });

  test("an aborted publication wipes secrets without waiting and cannot commit later", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_117));
    const value = await fixture(54_117, {}, crypto);
    const base = objectPort(value);
    const entered = deferred<void>();
    const release = deferred<void>();
    const outputPlaintext = new Uint8Array([7]);
    let committed = 0;
    let settled = false;
    const running = runRegisteredTransform(executeInput(value, {
      timeoutMs: 5,
      objects: {
        ...base,
        publishOutputs: async (input) => {
          entered.resolve();
          await release.promise;
          await input.authorizeCommit();
          if (input.signal.aborted) throw new Error("commit aborted");
          committed += 1;
        },
      },
      execute: async (capability) => {
        await capability.openInputs();
        void capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: outputPlaintext,
        }]);
      },
    }));
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await entered.promise;
    value.clock.advance(5);
    for (let turn = 0; turn < 20 && !settled; turn += 1) {
      await Promise.resolve();
    }
    expect(settled).toBeTrue();
    await expectRejection(running, "timed out");
    expect(committed).toBe(0);
    expect(outputPlaintext).toEqual(new Uint8Array(1));
    expect(value.registry.size).toBe(0);
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );

    release.resolve();
    await Promise.resolve();
    expect(committed).toBe(0);
  });

  test("an old run cannot remove a replacement recipient while unwinding", async () => {
    const crypto = new GatedNthKeygenCrypto(54_128, 2);
    const value = await fixture(54_128, {}, crypto);
    const base = objectPort(value);
    const publicationEntered = deferred<void>();
    const publicationRelease = deferred<void>();
    const oldRun = runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        async publishOutputs(input) {
          publicationEntered.resolve();
          await publicationRelease.promise;
          await input.authorizeCommit();
        },
      },
      execute: async (capability) => {
        const inputs = await capability.openInputs();
        void capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: inputs[0]!.plaintext,
        }]);
      },
    }));
    await publicationEntered.promise;

    const replacementCreation = value.registry.createAttempt({
      requestId: value.descriptor.requestId,
      workId: value.descriptor.workId,
      namespaceId: value.descriptor.namespaceId,
      recipientGeneration: value.descriptor.recipientGeneration,
      recipientKeyId: value.descriptor.recipientKeyId,
      expiresAt: value.descriptor.expiresAt,
    });
    await crypto.entered;
    crypto.release();
    expect(value.registry.delete(
      value.descriptor.requestId,
      value.descriptor.recipientGeneration,
    )).toBeTrue();
    expect((await replacementCreation).status).toBe("created");
    await expectRejection(oldRun, "recipient was removed");

    expect(value.registry.size).toBe(1);
    expect(crypto.privateKeys[1]!.some((byte) => byte !== 0)).toBeTrue();
    value.registry.close();
    expect(crypto.privateKeys[1]).toEqual(
      new Uint8Array(crypto.privateKeys[1]!.length),
    );
    publicationRelease.resolve();
  });

  test("a publication adapter cannot skip commit-boundary authorization", async () => {
    const value = await fixture(54_118);
    const base = objectPort(value);
    await expectRejection(runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        publishOutputs: async () => {},
      },
    })), "skipped commit authorization");
  });

  test("commit authorization is single-use", async () => {
    const value = await fixture(54_151);
    const base = objectPort(value);
    await expectRejection(runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        async publishOutputs(input) {
          await input.authorizeCommit();
          await input.authorizeCommit();
        },
      },
    })), "commit authority was already checked");
  });

  test("rejects every Namespace keyring coordinate substitution", async () => {
    const substitutions = [
      (envelope: Fixture["keyringEnvelope"]) => ({
        ...envelope,
        namespaceId: namespaceId("foreign-namespace"),
      }),
      (envelope: Fixture["keyringEnvelope"]) => ({
        ...envelope,
        domainId: cryptoDomainId("foreign-domain"),
      }),
      (envelope: Fixture["keyringEnvelope"]) => ({
        ...envelope,
        domainEpoch: domainEpoch(envelope.domainEpoch + 1),
      }),
      (envelope: Fixture["keyringEnvelope"]) => ({
        ...envelope,
        accessRevision: accessRevision(envelope.accessRevision + 1),
      }),
      (envelope: Fixture["keyringEnvelope"]) => ({
        ...envelope,
        keyClass: "human" as const,
      }),
    ];
    for (const [index, substitute] of substitutions.entries()) {
      const value = await fixture(54_152 + index);
      const base = objectPort(value);
      await expectRejection(runRegisteredTransform(executeInput(value, {
        objects: {
          ...base,
          async loadNamespaceKeyring() {
            return { envelope: substitute(value.keyringEnvelope) };
          },
        },
      })), "keyring does not match its descriptor");
    }
  });

  test("normalizes non-Error operation failures and abort reasons", async () => {
    const operation = await fixture(54_157);
    const base = objectPort(operation);
    await expectRejection(runRegisteredTransform(executeInput(operation, {
      objects: {
        ...base,
        openInput: () => Reflect.apply(
          Promise.reject,
          Promise,
          ["adapter rejection"],
        ),
      },
      execute: async (capability) => {
        await capability.openInputs();
      },
    })), "operation failed");

    const aborted = await fixture(54_158);
    const controller = new AbortController();
    controller.abort("caller cancellation");
    await expectRejection(runRegisteredTransform(executeInput(aborted, {
      signal: controller.signal,
    })), "Processor transform aborted");
  });

  test("fake deadlines abort stalled verification and exact claim phases", async () => {
    const stalledVerification = await fixture(54_119);
    const verificationEntered = deferred<void>();
    const verificationRelease = deferred<Uint8Array | null>();
    let claimCalls = 0;
    const verifying = runRegisteredTransform(executeInput(
      stalledVerification,
      {
        timeoutMs: 5,
        resolveCurrentIssuerPublicKey: async () => {
          verificationEntered.resolve();
          return verificationRelease.promise;
        },
        claims: {
          async claimExactCredential() {
            claimCalls += 1;
            return "claimed";
          },
        },
      },
    ));
    await verificationEntered.promise;
    stalledVerification.clock.advance(5);
    await expectRejection(verifying, "timed out");
    expect(claimCalls).toBe(0);
    verificationRelease.resolve(stalledVerification.issuer.publicKey);

    const stalledClaim = await fixture(54_120);
    const claimEntered = deferred<void>();
    const claimRelease = deferred<void>();
    let durableClaims = 0;
    const claiming = runRegisteredTransform(executeInput(stalledClaim, {
      timeoutMs: 5,
      claims: {
        async claimExactCredential(input) {
          claimEntered.resolve();
          await claimRelease.promise;
          if (input.signal.aborted) {
            throw new Error("claim commit aborted");
          }
          durableClaims += 1;
          return "claimed";
        },
      },
    }));
    await claimEntered.promise;
    stalledClaim.clock.advance(5);
    await expectRejection(claiming, "timed out");
    claimRelease.resolve();
    await Promise.resolve();
    expect(durableClaims).toBe(0);
  });

  test("a fake deadline unwinds stalled HPKE open and wipes its exact key", async () => {
    const crypto = new StalledOpenCrypto(seededRng(54_121));
    const value = await fixture(54_121, {}, crypto);
    const running = runRegisteredTransform(executeInput(value, {
      timeoutMs: 5,
    }));

    await crypto.entered;
    value.clock.advance(5);
    await expectRejection(running, "timed out");
    expect(crypto.openedPrivateKey).toBeDefined();
    expect(crypto.openedPrivateKey).toEqual(
      new Uint8Array(crypto.openedPrivateKey!.length),
    );
    crypto.release();
  });

  test("a fake deadline does not wait for a stalled encrypted input load", async () => {
    const value = await fixture(54_127);
    const base = objectPort(value);
    const objectId = value.descriptor.inputObjectIds[0]!;
    const encryptedInput = await base.openInput({
      objectId,
      signal: new AbortController().signal,
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    let settled = false;
    const running = runRegisteredTransform(executeInput(value, {
      timeoutMs: 5,
      objects: {
        ...base,
        async openInput() {
          entered.resolve();
          await release.promise;
          return encryptedInput;
        },
      },
    }));
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await entered.promise;
    value.clock.advance(5);
    for (let turn = 0; turn < 10 && !settled; turn += 1) {
      await Promise.resolve();
    }
    try {
      expect(settled).toBeTrue();
    } finally {
      release.resolve();
    }
    await expectRejection(running, "timed out");
  });

  test("wipes the registry-owned recipient key on every terminal run", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_122));
    const value = await fixture(54_122, {}, crypto);
    expect(crypto.privateKeys).toHaveLength(1);
    expect(crypto.privateKeys[0]!.some((byte) => byte !== 0)).toBeTrue();

    expect(await runRegisteredTransform(executeInput(value))).toEqual({
      status: "executed",
    });
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );
    expect(value.registry.size).toBe(0);
  });

  test("scheduler failure cannot strand a live recipient key", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_127));
    const value = await fixture(54_127, {}, crypto, {
      scheduleAt() {
        throw new Error("scheduler failed");
      },
    });

    await expectRejection(
      runRegisteredTransform(executeInput(value)),
      "scheduler failed",
    );
    expect(value.registry.size).toBe(0);
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );
  });

  test("throwing deadline cleanup cannot strand a live recipient key", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_129));
    const value = await fixture(54_129, {}, crypto, {
      scheduleAt() {
        return {
          cancel() {
            throw new Error("deadline cleanup failed");
          },
        };
      },
    });

    await expectRejection(
      runRegisteredTransform(executeInput(value)),
      "deadline cleanup failed",
    );
    expect(value.registry.size).toBe(0);
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );
  });

  test("malformed caller cancellation cannot strand a running recipient", async () => {
    const crypto = new RecordingKeygenCrypto(seededRng(54_130));
    const value = await fixture(54_130, {}, crypto);
    const malformedSignal = {
      get aborted() {
        throw new Error("malformed cancellation signal");
      },
    } as unknown as AbortSignal;

    await expectRejection(runRegisteredTransform(executeInput(value, {
      signal: malformedSignal,
    })), "malformed cancellation signal");
    expect(value.registry.size).toBe(0);
    expect(crypto.privateKeys[0]).toEqual(
      new Uint8Array(crypto.privateKeys[0]!.length),
    );
  });

  test("checks authenticated plaintext length before object decryption", async () => {
    const crypto = new CountingAeadCrypto(seededRng(54_123));
    const value = await fixture(54_123, {
      maximumPlaintextBytes: 10,
    }, crypto);
    const base = objectPort(value, [], new Map([
      [value.descriptor.inputObjectIds[0]!, new Uint8Array(11)],
    ]));
    let callsBeforeInput = 0;

    await expectRejection(runRegisteredTransform(executeInput(value, {
      objects: base,
      execute: async (capability) => {
        callsBeforeInput = crypto.aeadOpenCalls;
        await capability.openInputs();
      },
    })), "remaining plaintext budget");
    expect(crypto.aeadOpenCalls).toBe(callsBeforeInput);
  });

  test("rejects recipient and encrypted-input substitutions before use", async () => {
    const recipientMismatch = await fixture(54_124, {
      recipientKeyId: "credential-foreign-recipient",
    });
    let claims = 0;
    await expectRejection(runRegisteredTransform(executeInput(
      recipientMismatch,
      {
        recipientKeyId: recipientMismatch.recipient.recipientKeyId,
        claims: {
          async claimExactCredential() {
            claims += 1;
            return "claimed";
          },
        },
      },
    )), "does not match its process-local recipient");
    expect(claims).toBe(0);

    const envelopeMismatch = await fixture(54_125);
    const base = objectPort(envelopeMismatch);
    let decryptReached = false;
    await expectRejection(runRegisteredTransform(executeInput(
      envelopeMismatch,
      {
        objects: {
          ...base,
          openInput: async (input) => {
            const opened = await base.openInput(input);
            return {
              ...opened,
              envelope: {
                ...opened.envelope,
                context: {
                  ...opened.envelope.context,
                  namespaceId: namespaceId("foreign-namespace"),
                },
              },
            };
          },
        },
        execute: async (capability) => {
          await capability.openInputs();
          decryptReached = true;
        },
      },
    )), "does not match its descriptor");
    expect(decryptReached).toBeFalse();

    type OpenedInput = Awaited<ReturnType<
      ProcessorTransformObjectPortV1["openInput"]
    >>;
    const substitutions: ReadonlyArray<
      readonly [(opened: OpenedInput) => OpenedInput, string]
    > = [
      [(opened) => ({
        ...opened,
        payload: {
          ...opened.payload,
          context: {
            ...opened.payload.context,
            objectId: objectId("foreign-input"),
          },
        },
      }), "does not match its descriptor"],
      [(opened) => ({
        ...opened,
        payload: {
          ...opened.payload,
          context: { ...opened.payload.context, keyClass: "human" },
        },
      }), "does not match its descriptor"],
      [(opened) => ({
        ...opened,
        envelope: {
          ...opened.envelope,
          context: {
            ...opened.envelope.context,
            objectId: objectId("foreign-input"),
          },
        },
      }), "does not match its descriptor"],
      [(opened) => ({
        ...opened,
        envelope: {
          ...opened.envelope,
          context: { ...opened.envelope.context, keyClass: "human" },
        },
      }), "does not match its descriptor"],
      [(opened) => ({
        ...opened,
        envelope: {
          ...opened.envelope,
          context: {
            ...opened.envelope.context,
            bindingRevisionAtWrap: accessRevision(
              opened.envelope.context.bindingRevisionAtWrap + 1,
            ),
          },
        },
      }), "does not match its descriptor"],
      [(opened) => ({
        ...opened,
        envelope: {
          ...opened.envelope,
          context: {
            ...opened.envelope.context,
            keyGeneration: namespaceGeneration(
              opened.envelope.context.keyGeneration + 100,
            ),
          },
        },
      }), "generation is unavailable"],
      [(opened) => ({
        ...opened,
        payload: {
          ...opened.payload,
          ciphertext: new Uint8Array(opened.payload.ciphertext.length),
        },
      }), "ciphertext failed to open"],
    ];
    for (const [index, [substitute, message]] of substitutions.entries()) {
      const candidate = await fixture(54_140 + index);
      const candidateBase = objectPort(candidate);
      await expectRejection(runRegisteredTransform(executeInput(candidate, {
        objects: {
          ...candidateBase,
          async openInput(input) {
            return substitute(await candidateBase.openInput(input));
          },
        },
        execute: async (capability) => {
          await capability.openInputs();
        },
      })), message);
    }
  });

  test("binds every process-local recipient coordinate before claim", async () => {
    const otherRecipient = await new LatticeCrypto(
      seededRng(54_199),
    ).generateEncryptionKeyPair();
    const substitutions: ReadonlyArray<
      readonly [Partial<BackgroundWorkDescriptorV1>, string]
    > = [
      [{ requestId: "credential-foreign-request" }, "request"],
      [{ workId: "credential-foreign-work" }, "work"],
      [{ namespaceId: namespaceId("credential-foreign-namespace") },
        "namespace"],
      [{ recipientGeneration: 2 }, "generation"],
      [{ recipientKeyId: "credential-foreign-key" }, "key"],
      [{ expiresAt: NOW + 59_999 }, "expiry"],
      [{
        recipientPublicKey: otherRecipient.publicKey,
      }, "public key"],
    ];
    for (const [index, [overrides, label]] of substitutions.entries()) {
      const value = await fixture(54_160 + index, overrides);
      let claims = 0;
      await expectRejection(runRegisteredTransform(executeInput(value, {
        requestId: value.recipient.requestId,
        recipientGeneration: value.recipient.recipientGeneration,
        recipientKeyId: value.recipient.recipientKeyId,
        claims: {
          async claimExactCredential() {
            claims += 1;
            return "claimed";
          },
        },
      })), "does not match its process-local recipient");
      expect(claims, label).toBe(0);
    }
  });

  test("handles replay, invalid claim results, and incomplete workers exactly", async () => {
    const replay = await fixture(54_166);
    expect(await runRegisteredTransform(executeInput(replay, {
      claims: {
        async claimExactCredential() {
          return "already_claimed";
        },
      },
    }))).toEqual({
      status: "unavailable",
      reason: "credential_replayed",
    });

    const invalidClaim = await fixture(54_167);
    await expectRejection(runRegisteredTransform(executeInput(invalidClaim, {
      claims: {
        async claimExactCredential() {
          return "invalid" as never;
        },
      },
    })), "claim port returned an invalid result");

    const incomplete = await fixture(54_168);
    await expectRejection(runRegisteredTransform(executeInput(incomplete, {
      execute: () => {},
    })), "must open its inputs and publish its outputs");

    const openOnly = await fixture(54_170);
    await expectRejection(runRegisteredTransform(executeInput(openOnly, {
      execute: async (capability) => {
        await capability.openInputs();
      },
    })), "must open its inputs and publish its outputs");

    const nonErrorWorker = await fixture(54_169);
    await expectRejection(runRegisteredTransform(executeInput(nonErrorWorker, {
      execute: () => Reflect.apply(
        Promise.reject,
        Promise,
        ["worker rejection"],
      ),
    })), "worker failed");

    const nullOpenCrypto = new NullOpenCrypto(seededRng(54_171));
    const nullOpen = await fixture(54_171, {}, nullOpenCrypto);
    await expectRejection(
      runRegisteredTransform(executeInput(nullOpen)),
      "credential could not be opened",
    );
  });

  test("enforces capability phase and operation boundaries", async () => {
    const phases = await fixture(54_147);
    await expectRejection(runRegisteredTransform(executeInput(phases, {
      execute: async (capability) => {
        await capability.openInputs();
        await expectRejection(
          capability.openInputs(),
          "inputs are already opened",
        );
        await capability.publishOutputs([]);
        await expectRejection(
          capability.publishOutputs([]),
          "outputs are already published",
        );
      },
    })), "inputs are already opened");

    const malformed = await fixture(54_150);
    await expectRejection(runRegisteredTransform(executeInput(malformed, {
      execute: async (capability) => {
        await capability.openInputs();
        await capability.publishOutputs([{
          objectId: malformed.descriptor.outputObjectIds[0]!,
          plaintext: "not-bytes" as never,
        }]);
      },
    })), "output plaintext must be Uint8Array");

    const nonArray = await fixture(54_180);
    await expectRejection(runRegisteredTransform(executeInput(nonArray, {
      execute: async (capability) => {
        await capability.openInputs();
        await capability.publishOutputs(null as never);
      },
    })), "outputs must be an array");
  });

  test("fresh authority time prevents publication after credential expiry", async () => {
    const value = await fixture(54_126);
    const base = objectPort(value);
    let publicationCalls = 0;
    const outputPlaintext = new Uint8Array([1]);
    await expectRejection(runRegisteredTransform(executeInput(value, {
      objects: {
        ...base,
        publishOutputs: async (input) => {
          publicationCalls += 1;
          await base.publishOutputs(input);
        },
      },
      execute: async (capability) => {
        await capability.openInputs();
        value.clock.now = value.descriptor.expiresAt;
        await capability.publishOutputs([{
          objectId: value.descriptor.outputObjectIds[0]!,
          plaintext: outputPlaintext,
        }]);
      },
    })), "not currently valid");
    expect(publicationCalls).toBe(0);
    expect(outputPlaintext).toEqual(new Uint8Array(1));
  });

  test("rejects output substitution before the object port", async () => {
    const value = await fixture(54_107);
    const events: string[] = [];
    const outputPlaintext = new Uint8Array([1]);
    await expectRejection(runRegisteredTransform(executeInput(value, {
      objects: objectPort(value, events),
      execute: async (capability) => {
        await capability.openInputs();
        await capability.publishOutputs([{
          objectId: objectId("foreign-output"),
          plaintext: outputPlaintext,
        }]);
      },
    })), "ordered prefix of authorized output slots");
    expect(outputPlaintext).toEqual(new Uint8Array(1));
    expect(events.some((event) => event.startsWith("publish:"))).toBeFalse();
  });

  test("fails closed on input and output byte-budget overruns", async () => {
    const inputOverrun = await fixture(54_108, {
      maximumPlaintextBytes: 3,
    });
    await expectRejection(runRegisteredTransform(executeInput(
      inputOverrun,
      {
        objects: objectPort(inputOverrun, [], new Map([
          [inputOverrun.descriptor.inputObjectIds[0]!, new Uint8Array(2)],
          [inputOverrun.descriptor.inputObjectIds[1]!, new Uint8Array(2)],
        ])),
      },
    )), "plaintext budget");

    const ciphertextOverrun = await fixture(54_109, {
      maximumCiphertextBytes: 30,
    });
    await expectRejection(runRegisteredTransform(executeInput(
      ciphertextOverrun,
    )), "ciphertext budget");
  });

  test("accepts empty input plaintext and the exact input budget", async () => {
    const value = await fixture(54_176, {
      maximumPlaintextBytes: 1,
    });
    const plaintexts = new Map([
      [value.descriptor.inputObjectIds[0]!, new Uint8Array([1])],
      [value.descriptor.inputObjectIds[1]!, new Uint8Array(0)],
    ]);
    expect(await runRegisteredTransform(executeInput(value, {
      objects: objectPort(value, [], plaintexts),
      execute: async (capability) => {
        const opened = await capability.openInputs();
        expect(opened.map((input) => input.plaintext.length)).toEqual([1, 0]);
        await capability.publishOutputs([]);
      },
    }))).toEqual({ status: "executed" });
  });

  test("accounts every encrypted byte and accepts only the exact boundary", async () => {
    const calibrating = await fixture(54_173);
    const calibratingBase = objectPort(calibrating);
    let inputCiphertextBytes = 0;
    let outputCiphertextBytes = 0;
    await runRegisteredTransform(executeInput(calibrating, {
      objects: {
        ...calibratingBase,
        async openInput(input) {
          const opened = await calibratingBase.openInput(input);
          inputCiphertextBytes +=
            encodeEncryptedPayloadV2(opened.payload).length
            + encodeNamespaceObjectEnvelopeV2(opened.envelope).length;
          return opened;
        },
        async publishOutputs(input) {
          const output = input.outputs[0]!;
          outputCiphertextBytes =
            output.payloadBytes.length
            + output.envelopeBytes.length
            + output.manifestBytes.length
            + output.tombstoneManifestBytes.length
            + output.signerAuthorizationBytes.length;
          await calibratingBase.publishOutputs(input);
        },
      },
      execute: async (capability) => {
        await capability.openInputs();
        await capability.publishOutputs([{
          objectId: calibrating.descriptor.outputObjectIds[0]!,
          plaintext: new Uint8Array([1, 2, 3]),
        }]);
      },
    }));
    const exactCiphertextBudget =
      serializeNamespaceKeyringEnvelope(calibrating.keyringEnvelope).length
      + inputCiphertextBytes
      + outputCiphertextBytes;
    const exactPlaintextBudget = calibrating.descriptor.inputObjectIds
      .reduce(
        (sum, id) => sum + new TextEncoder().encode(id).length,
        3,
      );

    const exact = await fixture(54_174, {
      maximumCiphertextBytes: exactCiphertextBudget,
      maximumPlaintextBytes: exactPlaintextBudget,
    });
    expect(await runRegisteredTransform(executeInput(exact, {
      execute: async (capability) => {
        await capability.openInputs();
        await capability.publishOutputs([{
          objectId: exact.descriptor.outputObjectIds[0]!,
          plaintext: new Uint8Array([1, 2, 3]),
        }]);
      },
    }))).toEqual({ status: "executed" });

    const oneByteShort = await fixture(54_175, {
      maximumCiphertextBytes: exactCiphertextBudget - 1,
      maximumPlaintextBytes: exactPlaintextBudget,
    });
    await expectRejection(runRegisteredTransform(executeInput(
      oneByteShort,
      {
        execute: async (capability) => {
          await capability.openInputs();
          await capability.publishOutputs([{
            objectId: oneByteShort.descriptor.outputObjectIds[0]!,
            plaintext: new Uint8Array([1, 2, 3]),
          }]);
        },
      },
    )), "ciphertext budget exceeded");
  });

  test("burns the claim when authority disappears before secret use", async () => {
    const value = await fixture(54_110);
    let authorityCalls = 0;
    let objectCalls = 0;
    const result = runRegisteredTransform(executeInput(value, {
      resolveCurrentIssuerPublicKey: () => {
        authorityCalls += 1;
        return authorityCalls === 1 ? value.issuer.publicKey : null;
      },
      objects: {
        ...objectPort(value),
        openInput: async () => {
          objectCalls += 1;
          throw new Error("must not run");
        },
        publishOutputs: async () => {
          objectCalls += 1;
          throw new Error("must not run");
        },
      },
    }));

    await expectRejection(result, "not currently authorized");
    expect(authorityCalls).toBe(2);
    expect(objectCalls).toBe(0);
  });

  test("rejects signer authorization from a different exact credential", async () => {
    const value = await fixture(54_114);
    const foreign = await fixture(54_115);
    let claims = 0;

    await expectRejection(
      runRegisteredTransform(executeInput(value, {
        signerAuthorizationBytes: foreign.signerAuthorization.bytes,
        resolveCurrentSignerIssuingDevicePublicKey: () =>
          foreign.issuer.publicKey,
        claims: {
          async claimExactCredential() {
            claims += 1;
            return "claimed";
          },
        },
      })),
      "does not match the exact credential",
    );
    expect(claims).toBe(0);
  });
});
