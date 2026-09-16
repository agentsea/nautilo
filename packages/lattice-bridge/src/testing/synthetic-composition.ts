import {
  accessRevision,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  decryptObjectThroughNamespace,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  findOrCreateCryptoDomain,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  objectId,
  persistNamespaceBinding,
  persistPreparedObjectAccessManifestGenesis,
  prepareObjectAccessManifestGenesis,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type LatticeStorage,
  LatticeCrypto,
  domainEpoch,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  manualClock,
  seededRng,
} from "@nautilo/lattice-crypto/testing";
import {
  nautiloActorId,
  nautiloNamespaceId,
  translateNamespaceDomainCoordinates,
  type HumanActorFact,
  type TranslationResult,
} from "../index.ts";

const ALICE_ID = "00000000-0000-4000-8000-00000000000a";
const BOB_ID = "00000000-0000-4000-8000-00000000000b";
const NAMESPACE_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
] as const;
const SHARED_DOMAIN_ID = "domain-shared-alice-bob";

function valueOf<Value>(result: TranslationResult<Value>): Value {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function humanFact(id: string): HumanActorFact {
  return {
    id: valueOf(nautiloActorId(id)),
    actorKind: "user",
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodedText(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

async function persistSyntheticBinding(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly storage: LatticeStorage;
  readonly signingPrivateKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly namespace: string;
  readonly domain: string;
  readonly marker: number;
}>): Promise<Readonly<{
  readonly status: "applied" | "duplicate" | "stale";
  readonly persistAgain: () => Promise<"applied" | "duplicate" | "stale">;
}>> {
  const targetNamespace = namespaceId(input.namespace);
  const keyrings = createInitialNamespaceKeyrings(
    input.crypto,
    targetNamespace,
  );
  const metadata = {
    domainId: cryptoDomainId(input.domain),
    domainEpoch: domainEpoch(0),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("device-synthetic-alice"),
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: new Uint8Array(32).fill(input.marker),
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: () => input.signingPublicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: new Uint8Array(32).fill(input.marker + 1),
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: () => input.signingPublicKey,
  });
  const binding = createNamespaceBinding({
    crypto: input.crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: () => input.signingPublicKey,
  });
  const bindingHash = namespaceBindingHash(binding);
  const prepared = {
      expectedHead: null,
      nextHead: {
        namespaceId: binding.namespaceId,
        accessRevision: binding.accessRevision,
        bindingHash,
        domainId: binding.domainId,
        domainEpoch: binding.domainEpoch,
      },
      signedBindingBytes: serializeNamespaceBindingV2(binding),
      humanKeyringEnvelopeBytes:
        serializeNamespaceKeyringEnvelopeV2(humanEnvelope),
      aiKeyringEnvelopeBytes:
        serializeNamespaceKeyringEnvelopeV2(aiEnvelope),
  } as const;
  const persistAgain = () =>
    persistNamespaceBinding({
      crypto: input.crypto,
      storage: input.storage,
      prepared,
      resolveCurrentCommitter: () => input.signingPublicKey,
    });
  return Object.freeze({
    status: await persistAgain(),
    persistAgain,
  });
}

async function persistSyntheticObject(input: Readonly<{
  readonly crypto: LatticeCrypto;
  readonly storage: LatticeStorage;
  readonly signingPrivateKey: Uint8Array;
  readonly signingPublicKey: Uint8Array;
  readonly namespace: string;
  readonly object: string;
  readonly plaintext: string;
  readonly marker: number;
}>): Promise<Readonly<{
  readonly correctPlaintext: string | null;
  readonly wrongKeyPlaintext: string | null;
  readonly payload: ReturnType<typeof encryptObjectPayload>["payload"];
  readonly envelope: ReturnType<typeof wrapObjectDekForNamespace>;
  readonly namespaceKey: Uint8Array;
  readonly accessDuplicate: "applied" | "duplicate" | "stale";
  readonly accessStale: "applied" | "duplicate" | "stale";
}>> {
  const namespaceKey = new Uint8Array(32).fill(input.marker);
  const encrypted = encryptObjectPayload(
    input.crypto,
    {
      objectId: objectId(input.object),
      keyClass: "human",
      objectType: "synthetic-test-record",
      createdAt: unixTimestamp(1_700_000_000_000 + input.marker),
    },
    text(input.plaintext),
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  await input.storage.putObject(encryptedObjectWriteRecord(payloadBytes));

  const envelope = wrapObjectDekForNamespace(
    input.crypto,
    namespaceKey,
    {
      objectId: objectId(input.object),
      namespaceId: namespaceId(input.namespace),
      keyClass: "human",
      keyGeneration: namespaceGeneration(0),
      bindingRevisionAtWrap: accessRevision(0),
    },
    encrypted.dek,
  );
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const prepared = prepareObjectAccessManifestGenesis(input.crypto, {
    objectId: objectId(input.object),
    payloadHash: input.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-synthetic-alice"),
    hostAuthorizationRevision: authorizationRevision(0),
    signingPrivateKey: input.signingPrivateKey,
  });
  const status = await persistPreparedObjectAccessManifestGenesis({
    crypto: input.crypto,
    storage: input.storage,
    prepared,
    resolveCurrentAuthorization: (context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision:
        context.hostAuthorizationRevision,
      committerSigningPublicKey: input.signingPublicKey,
    }),
  });
  if (status !== "applied") {
    throw new Error(
      `Synthetic object access genesis expected applied, received ${status}`,
    );
  }
  const accessDuplicate =
    await persistPreparedObjectAccessManifestGenesis({
      crypto: input.crypto,
      storage: input.storage,
      prepared,
      resolveCurrentAuthorization: (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision:
          context.hostAuthorizationRevision,
        committerSigningPublicKey: input.signingPublicKey,
      }),
    });
  const concurrentAccessReplays = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        persistPreparedObjectAccessManifestGenesis({
          crypto: input.crypto,
          storage: input.storage,
          prepared,
          resolveCurrentAuthorization: (context) => ({
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision:
              context.hostAuthorizationRevision,
            committerSigningPublicKey: input.signingPublicKey,
          }),
        }),
    ),
  );
  if (concurrentAccessReplays.some((status) => status !== "duplicate")) {
    throw new Error("Concurrent object-access replay did not converge");
  }
  const staleEnvelope = wrapObjectDekForNamespace(
    input.crypto,
    new Uint8Array(32).fill(input.marker + 1),
    {
      objectId: objectId(input.object),
      namespaceId: namespaceId(input.namespace),
      keyClass: "human",
      keyGeneration: namespaceGeneration(0),
      bindingRevisionAtWrap: accessRevision(0),
    },
    encrypted.dek,
  );
  const stalePrepared = prepareObjectAccessManifestGenesis(input.crypto, {
    objectId: objectId(input.object),
    payloadHash: input.crypto.hash(payloadBytes),
    envelopeBytes: [encodeNamespaceObjectEnvelopeV2(staleEnvelope)],
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-synthetic-alice"),
    hostAuthorizationRevision: authorizationRevision(0),
    signingPrivateKey: input.signingPrivateKey,
  });
  const accessStale =
    await persistPreparedObjectAccessManifestGenesis({
      crypto: input.crypto,
      storage: input.storage,
      prepared: stalePrepared,
      resolveCurrentAuthorization: (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision:
          context.hostAuthorizationRevision,
        committerSigningPublicKey: input.signingPublicKey,
      }),
    });

  return {
    correctPlaintext: decodedText(
      decryptObjectThroughNamespace(
        input.crypto,
        namespaceKey,
        envelope,
        encrypted.payload,
      ),
    ),
    wrongKeyPlaintext: decodedText(
      decryptObjectThroughNamespace(
        input.crypto,
        new Uint8Array(32).fill(input.marker + 0x20),
        envelope,
        encrypted.payload,
      ),
    ),
    payload: encrypted.payload,
    envelope,
    namespaceKey,
    accessDuplicate,
    accessStale,
  };
}

export interface SyntheticSharedDomainScenarioReport {
  readonly domain: Readonly<{
    readonly firstStatus: "created" | "existing";
    readonly secondStatus: "created" | "existing";
    readonly firstId: string;
    readonly secondId: string;
    readonly participants: readonly string[];
  }>;
  readonly namespaces: readonly [string, string];
  readonly bindingStatuses:
    readonly ["applied" | "duplicate" | "stale", "applied" | "duplicate" | "stale"];
  readonly correctDecryptions: readonly [string | null, string | null];
  readonly crossNamespaceRejected: boolean;
  readonly persistedAccessNamespaces:
    readonly [readonly string[], readonly string[]];
  readonly casReplays: Readonly<{
    readonly namespaceDuplicate: "applied" | "duplicate" | "stale";
    readonly namespaceStale: "applied" | "duplicate" | "stale";
    readonly objectDuplicate: "applied" | "duplicate" | "stale";
    readonly objectStale: "applied" | "duplicate" | "stale";
  }>;
}

export async function runSyntheticSharedDomainScenario(
  storage: LatticeStorage,
): Promise<SyntheticSharedDomainScenarioReport> {
  const crypto = new LatticeCrypto(seededRng(0x231_06), manualClock(1));
  const signing = crypto.generateSigningKeyPair();
  const alice = humanFact(ALICE_ID);
  const bob = humanFact(BOB_ID);
  const firstCoordinates = valueOf(
    translateNamespaceDomainCoordinates({
      namespaceId: valueOf(nautiloNamespaceId(NAMESPACE_IDS[0])),
      participants: [alice, bob],
    }),
  );
  const secondCoordinates = valueOf(
    translateNamespaceDomainCoordinates({
      namespaceId: valueOf(nautiloNamespaceId(NAMESPACE_IDS[1])),
      participants: [bob, alice],
    }),
  );
  if (
    !equalBytes(
      firstCoordinates.exactHumanSet.participantDigest,
      secondCoordinates.exactHumanSet.participantDigest,
    )
  ) {
    throw new Error("Reordered exact Human set produced a different digest");
  }

  const firstDomain = await findOrCreateCryptoDomain(storage, {
    participants: firstCoordinates.exactHumanSet.participants,
    createDomainId: () => cryptoDomainId(SHARED_DOMAIN_ID),
    rosterBytes: new Uint8Array([0x41, 0x42]),
  });
  const secondDomain = await findOrCreateCryptoDomain(storage, {
    participants: secondCoordinates.exactHumanSet.participants,
    createDomainId: () => cryptoDomainId("domain-must-not-be-created"),
    rosterBytes: new Uint8Array([0x41, 0x42]),
  });

  const bindings = await Promise.all([
    persistSyntheticBinding({
      crypto,
      storage,
      signingPrivateKey: signing.privateKey,
      signingPublicKey: signing.publicKey,
      namespace: NAMESPACE_IDS[0],
      domain: firstDomain.domain.id,
      marker: 0x30,
    }),
    persistSyntheticBinding({
      crypto,
      storage,
      signingPrivateKey: signing.privateKey,
      signingPublicKey: signing.publicKey,
      namespace: NAMESPACE_IDS[1],
      domain: firstDomain.domain.id,
      marker: 0x32,
    }),
  ]);
  const namespaceDuplicate = await bindings[0].persistAgain();
  const concurrentNamespaceReplays = await Promise.all(
    Array.from({ length: 4 }, bindings[0].persistAgain),
  );
  if (concurrentNamespaceReplays.some((status) => status !== "duplicate")) {
    throw new Error("Concurrent Namespace replay did not converge");
  }
  const staleBinding = await persistSyntheticBinding({
    crypto,
    storage,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    namespace: NAMESPACE_IDS[0],
    domain: firstDomain.domain.id,
    marker: 0x3f,
  });
  const objects = await Promise.all([
    persistSyntheticObject({
      crypto,
      storage,
      signingPrivateKey: signing.privateKey,
      signingPublicKey: signing.publicKey,
      namespace: NAMESPACE_IDS[0],
      object: "synthetic-object-one",
      plaintext: "synthetic namespace one",
      marker: 0x51,
    }),
    persistSyntheticObject({
      crypto,
      storage,
      signingPrivateKey: signing.privateKey,
      signingPublicKey: signing.publicKey,
      namespace: NAMESPACE_IDS[1],
      object: "synthetic-object-two",
      plaintext: "synthetic namespace two",
      marker: 0x61,
    }),
  ]);
  const crossEnvelopePlaintext = decryptObjectThroughNamespace(
    crypto,
    objects[1].namespaceKey,
    objects[1].envelope,
    objects[0].payload,
  );
  const accessStates = await Promise.all([
    storage.getObjectAccessState("synthetic-object-one"),
    storage.getObjectAccessState("synthetic-object-two"),
  ]);
  if (accessStates.some((state) => state === null)) {
    throw new Error("Synthetic object access state was not persisted");
  }

  const firstBinding = await storage.getBinding(NAMESPACE_IDS[0], 0);
  const secondBinding = await storage.getBinding(NAMESPACE_IDS[1], 0);
  const firstHead = await storage.getNamespaceHead(NAMESPACE_IDS[0]);
  const secondHead = await storage.getNamespaceHead(NAMESPACE_IDS[1]);
  if (
    firstBinding === null
    || secondBinding === null
    || firstHead?.domainId !== firstDomain.domain.id
    || secondHead?.domainId !== firstDomain.domain.id
  ) {
    throw new Error("Synthetic Namespace bindings did not share one Domain");
  }

  return Object.freeze({
    domain: Object.freeze({
      firstStatus: firstDomain.status,
      secondStatus: secondDomain.status,
      firstId: firstDomain.domain.id,
      secondId: secondDomain.domain.id,
      participants: Object.freeze([...firstDomain.domain.participants]),
    }),
    namespaces: Object.freeze([
      NAMESPACE_IDS[0],
      NAMESPACE_IDS[1],
    ] as const),
    bindingStatuses: Object.freeze([
      bindings[0].status,
      bindings[1].status,
    ] as const),
    correctDecryptions: Object.freeze([
      objects[0].correctPlaintext,
      objects[1].correctPlaintext,
    ] as const),
    crossNamespaceRejected:
      objects.every((object) => object.wrongKeyPlaintext === null)
      && crossEnvelopePlaintext === null,
    persistedAccessNamespaces: Object.freeze([
      Object.freeze(
        accessStates[0]!.namespaceEnvelopes.map(
          (envelope) => envelope.namespaceId,
        ),
      ),
      Object.freeze(
        accessStates[1]!.namespaceEnvelopes.map(
          (envelope) => envelope.namespaceId,
        ),
      ),
    ] as const),
    casReplays: Object.freeze({
      namespaceDuplicate,
      namespaceStale: staleBinding.status,
      objectDuplicate: objects[0].accessDuplicate,
      objectStale: objects[0].accessStale,
    }),
  });
}
