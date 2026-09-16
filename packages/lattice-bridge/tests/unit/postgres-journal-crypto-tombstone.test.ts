import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  backgroundWorkDescriptorDigestV1,
  createProcessorObjectAccessManifestV4,
  createProcessorObjectSignerPublicV1,
  createProcessorSignerAuthorizationV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  JOURNAL_CRYPTO_TOMBSTONE_MAX_OBJECTS,
  PostgresJournalCryptoTombstoneRepository,
} from "../../src/server/journal/postgres-journal-crypto-tombstone.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state & 0xff;
      }
      return bytes;
    },
  };
}

type ObjectState = {
  readonly objectId: string;
  readonly payloadHash: Uint8Array;
  readonly genesisHash: Uint8Array;
  readonly genesisBytes: Uint8Array;
  readonly genesisEnvelopeHash: Uint8Array;
  storedGenesisEnvelopeHash: Uint8Array;
  storedGenesisNamespaceId: string;
  tombstoneHash: Uint8Array;
  tombstoneBytes: Uint8Array;
  headRevision: 0 | 1 | 2;
  headHash: Uint8Array;
  tombstoneHasEnvelope: boolean;
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim()
    .toLowerCase();
}

class TombstoneConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly fixture: Fixture;
  objects: Map<string, ObjectState>;
  transactionCount = 0;
  failCas = false;
  failCommitWithSerialization = false;

  constructor(fixtureValue: Fixture) {
    this.fixture = fixtureValue;
    this.objects = new Map(
      fixtureValue.objects.map((object) => [
        object.objectId,
        {
          ...object,
          payloadHash: object.payloadHash.slice(),
          genesisHash: object.genesisHash.slice(),
          genesisBytes: object.genesisBytes.slice(),
          genesisEnvelopeHash: object.genesisEnvelopeHash.slice(),
          storedGenesisEnvelopeHash:
            object.storedGenesisEnvelopeHash.slice(),
          tombstoneHash: object.tombstoneHash.slice(),
          tombstoneBytes: object.tombstoneBytes.slice(),
          headHash: object.headHash.slice(),
        },
      ]),
    );
  }

  query<Row>(
    statement: string,
    _parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as Row[]);
    }
    throw new Error("Journal tombstone SQL must use a transaction");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    const working = new Map(
      [...this.objects].map(([key, value]) => [key, {
        ...value,
        payloadHash: value.payloadHash.slice(),
        genesisHash: value.genesisHash.slice(),
        genesisBytes: value.genesisBytes.slice(),
        genesisEnvelopeHash: value.genesisEnvelopeHash.slice(),
        storedGenesisEnvelopeHash:
          value.storedGenesisEnvelopeHash.slice(),
        tombstoneHash: value.tombstoneHash.slice(),
        tombstoneBytes: value.tombstoneBytes.slice(),
        headHash: value.headHash.slice(),
      }]),
    );
    const transaction: CryptoPostgresExecutor = {
      query: async <Row>(
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = normalizedSql(statement);
        if (
          statement.includes("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        ) return [];
        if (
          statement.includes("FROM crypto_objects AS object")
          && statement.includes("FOR UPDATE OF head")
        ) {
          const state = working.get(parameters[0] as string);
          return state === undefined ? [] : [{
            object_id: state.objectId,
            object_payload_hash: state.payloadHash.slice(),
            head_access_revision: state.headRevision,
            head_manifest_hash: state.headHash.slice(),
            genesis_manifest_hash: state.genesisHash.slice(),
            genesis_payload_hash: state.payloadHash.slice(),
            genesis_manifest_bytes: state.genesisBytes.slice(),
            tombstone_manifest_hash: state.tombstoneHash.slice(),
            tombstone_previous_hash: state.genesisHash.slice(),
            tombstone_payload_hash: state.payloadHash.slice(),
            tombstone_manifest_bytes: state.tombstoneBytes.slice(),
          }] as Row[];
        }
        if (
          normalized.includes("select authorization_bytes from")
          && normalized.includes("processor_crypto_signer_authorizations")
        ) {
          return [{
            authorization_bytes: this.fixture.authorization.bytes.slice(),
          }] as Row[];
        }
        if (
          normalized.includes("from processor_crypto_signer_authorizations")
        ) {
          return [{ ...this.fixture.evidenceRow }] as Row[];
        }
        if (normalized.includes("from human_crypto_devices")) {
          return [{ ...this.fixture.deviceRow }] as Row[];
        }
        if (
          normalized.includes("from object_crypto_namespace_envelopes")
          && normalized.includes("access_revision =")
          && parameters.includes(0)
        ) {
          const state = working.get(parameters[0] as string);
          return state === undefined ? [] : [{
            namespace_id: state.storedGenesisNamespaceId,
            ordinal: 0,
            envelope_hash: state.storedGenesisEnvelopeHash.slice(),
          }] as Row[];
        }
        if (
          normalized.includes("from object_crypto_namespace_envelopes")
          && normalized.includes("access_revision =")
          && parameters.includes(1)
        ) {
          const state = working.get(parameters[0] as string);
          return state?.tombstoneHasEnvelope === true
            ? [{ ordinal: 0 }] as Row[]
            : [];
        }
        if (normalized.includes("update object_crypto_access_heads")) {
          const state = working.get(parameters[2] as string);
          if (
            this.failCas
            || state === undefined
            || state.headRevision !== 0
            || !Buffer.from(state.headHash).equals(
              Buffer.from(parameters[4] as Uint8Array),
            )
          ) return [];
          state.headRevision = 1;
          state.headHash = (parameters[1] as Uint8Array).slice();
          return [{ object_id: state.objectId }] as Row[];
        }
        throw new Error(`Unexpected journal tombstone SQL: ${
          statement.trim()
        }`);
      },
    };
    const result = await callback(transaction);
    if (this.failCommitWithSerialization) {
      this.failCommitWithSerialization = false;
      throw Object.assign(new Error("injected serialization abort"), {
        code: "40001",
      });
    }
    this.objects = working;
    return result;
  }
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(241_100));
  const issuer = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const exactHumanId = humanId("human-journal-tombstone");
  const exactDeviceId = cryptoDeviceId("device-journal-tombstone");
  const outputObjectIds = [
    objectId("journal-tombstone-object-a"),
    objectId("journal-tombstone-object-b"),
  ];
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: "request-journal-tombstone",
    recipientGeneration: 1,
    workKind: "stenographer.rebuild",
    workId: "work-journal-tombstone",
    namespaceId: namespaceId("namespace-journal-tombstone"),
    domainId: cryptoDomainId("domain-journal-tombstone"),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(8),
    },
    purpose: "journal.rebuild",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: 1,
      endSequence: 2,
      rebuildGeneration: 4,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [objectId("journal-tombstone-input")],
    outputObjectIds,
    outputObjectMetadata: outputObjectIds.map((id, index) => ({
      objectId: id,
      objectType: "nautilo-journal-event-v1",
      createdAt: unixTimestamp(20_000 + index),
    })),
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 4_096,
    maximumCiphertextBytes: 32_768,
    expectedDomainEpoch: domainEpoch(3),
    expectedNamespaceAccessRevision: accessRevision(2),
    expectedPolicyRevision: authorizationRevision(7),
    recipientKeyId: "recipient-journal-tombstone",
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    issuedAt: 20_000,
    notBefore: 20_000,
    expiresAt: 80_000,
    idempotencyId: "idempotency-journal-tombstone",
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash = backgroundWorkDescriptorDigestV1(
    crypto,
    descriptor,
  );
  const principal = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: "authorization-journal-tombstone",
    workDescriptorHash: descriptorHash,
    signerPrivateKey: signer.privateKey,
  }).principal;
  const authorization = createProcessorSignerAuthorizationV1(
    crypto,
    {
      formatVersion: 1,
      id: "authorization-journal-tombstone",
      processorKind: "stenographer",
      processorVersion: 1,
      workId: descriptor.workId,
      namespaceId: descriptor.namespaceId,
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      namespaceAccessRevision:
        descriptor.expectedNamespaceAccessRevision,
      policyRevision: descriptor.expectedPolicyRevision,
      processorAuthorizationRevision:
        descriptor.subject.authorizationRevision,
      issuingHumanId: exactHumanId,
      issuingDeviceId: exactDeviceId,
      issuingDeviceAuthorizationRevision: authorizationRevision(5),
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
      signer: principal,
      signerPublicKey: signer.publicKey,
      workDescriptorHash: descriptorHash,
      credentialHash: new Uint8Array(32).fill(0x43),
      outputObjectIds,
      maxOutputObjects: 2,
      maxOutputPlaintextBytes: descriptor.maximumPlaintextBytes,
      maxOutputCiphertextBytes: descriptor.maximumCiphertextBytes,
      issuedAt: descriptor.issuedAt,
      expiresAt: descriptor.expiresAt,
    },
    issuer.privateKey,
  );
  const objects = outputObjectIds.map((exactObjectId, index): ObjectState => {
    const payloadHash = crypto.hash(
      new TextEncoder().encode(`payload-${index}`),
    );
    const genesisEnvelopeHash = new Uint8Array(32).fill(0x51 + index);
    const genesis = createProcessorObjectAccessManifestV4(
      crypto,
      {
        objectId: exactObjectId,
        payloadHash,
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [genesisEnvelopeHash],
        signer: principal,
        signerAuthorizationHash: authorization.hash,
        hostAuthorizationRevision:
          descriptor.subject.authorizationRevision,
      },
      {
        signerPrivateKey: signer.privateKey,
        signerAuthorizationBytes: authorization.bytes,
        now: descriptor.issuedAt,
        resolveCurrentIssuingDevicePublicKey: () => issuer.publicKey,
      },
    );
    const tombstone = createProcessorObjectAccessManifestV4(
      crypto,
      {
        objectId: exactObjectId,
        payloadHash,
        accessRevision: accessRevision(1),
        previousManifestHash: genesis.hash,
        envelopeHashes: [],
        signer: principal,
        signerAuthorizationHash: authorization.hash,
        hostAuthorizationRevision:
          descriptor.subject.authorizationRevision,
      },
      {
        signerPrivateKey: signer.privateKey,
        signerAuthorizationBytes: authorization.bytes,
        now: descriptor.issuedAt,
        resolveCurrentIssuingDevicePublicKey: () => issuer.publicKey,
      },
    );
    return {
      objectId: exactObjectId,
      payloadHash,
      genesisHash: genesis.hash,
      genesisBytes: genesis.bytes,
      genesisEnvelopeHash,
      storedGenesisEnvelopeHash: genesisEnvelopeHash.slice(),
      storedGenesisNamespaceId: descriptor.namespaceId,
      tombstoneHash: tombstone.hash,
      tombstoneBytes: tombstone.bytes,
      headRevision: 0,
      headHash: genesis.hash.slice(),
      tombstoneHasEnvelope: false,
    };
  });
  return {
    crypto,
    authorization,
    objects,
    evidenceRow: {
      authorization_id: authorization.authorization.id,
      request_id: descriptor.requestId,
      recipient_generation: descriptor.recipientGeneration,
      processor_kind: authorization.authorization.processorKind,
      processor_version: authorization.authorization.processorVersion,
      authorization_hash: authorization.hash,
      authorization_bytes: authorization.bytes,
      issuing_human_id: exactHumanId,
      issuing_device_id: exactDeviceId,
      issuing_device_authorization_revision: 5,
      issuer_signing_public_key_hash:
        authorization.authorization.issuerSigningPublicKeyHash,
      signer_key_id: authorization.authorization.signer.signerKeyId,
      signer_public_key: authorization.authorization.signerPublicKey,
      work_descriptor_hash: descriptorHash,
      work_descriptor_bytes: descriptorBytes,
      work_id: descriptor.workId,
      namespace_id: descriptor.namespaceId,
      domain_id: descriptor.domainId,
      domain_epoch: descriptor.expectedDomainEpoch,
      namespace_access_revision:
        descriptor.expectedNamespaceAccessRevision,
      policy_revision: descriptor.expectedPolicyRevision,
      processor_authorization_revision:
        descriptor.subject.authorizationRevision,
      credential_hash: authorization.authorization.credentialHash,
    },
    deviceRow: {
      device_id: exactDeviceId,
      human_id: exactHumanId,
      signing_public_key: issuer.publicKey,
      state: "revoked",
      revision: 7,
    },
  };
}

async function setup() {
  const value = await fixture();
  const connection = new TombstoneConnection(value);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    value,
    connection,
    repository: new PostgresJournalCryptoTombstoneRepository({
      handle,
      crypto: value.crypto,
    }),
  };
}

describe("Postgres journal crypto tombstone repository", () => {
  test("verifies the pre-signed chain and atomically advances exact heads without deleting history", async () => {
    const { value, connection, repository } = await setup();
    const objectIds = value.objects.map((object) => object.objectId);

    expect(repository.tombstoneObjects({
      objectIds,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "tombstoned",
      advancedCount: 2,
      alreadyTombstonedCount: 0,
    });

    expect(
      [...connection.objects.values()].every((object) =>
        object.headRevision === 1
        && Buffer.from(object.headHash).equals(
          Buffer.from(object.tombstoneHash),
        )
      ),
    ).toBeTrue();
    expect(connection.statements.some((statement) =>
      /\bDELETE\b/u.test(statement)
    )).toBeFalse();
    expect(connection.statements.filter((statement) =>
      normalizedSql(statement).includes("update object_crypto_access_heads")
    )).toHaveLength(2);
    expect(connection.statements.filter((statement) =>
      normalizedSql(statement).includes(
        "from processor_crypto_signer_authorizations",
      )
    ).every((statement) => !normalizedSql(statement).includes("for share")))
      .toBeTrue();
  });

  test("exact replay is bounded idempotent verification with no second head update", async () => {
    const { value, connection, repository } = await setup();
    const objectIds = value.objects.map((object) => object.objectId);
    await repository.tombstoneObjects({
      objectIds,
      signal: new AbortController().signal,
    });
    const updateCount = connection.statements.filter((statement) =>
      normalizedSql(statement).includes("update object_crypto_access_heads")
    ).length;

    expect(repository.tombstoneObjects({
      objectIds,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "tombstoned",
      advancedCount: 0,
      alreadyTombstonedCount: 2,
    });
    expect(connection.statements.filter((statement) =>
      normalizedSql(statement).includes("update object_crypto_access_heads")
    )).toHaveLength(updateCount);
  });

  test("retries a serialization abort because the transaction has no external one-shot authority", async () => {
    const { value, connection, repository } = await setup();
    connection.failCommitWithSerialization = true;

    expect(repository.tombstoneObjects({
      objectIds: [value.objects[0]!.objectId],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: "tombstoned",
      advancedCount: 1,
      alreadyTombstonedCount: 0,
    });
    expect(connection.transactionCount).toBe(2);
    expect(connection.objects.get(
      value.objects[0]!.objectId,
    )?.headRevision).toBe(1);
  });

  test("verifies the whole batch before mutation and rolls back CAS failure", async () => {
    const corrupt = await setup();
    const second = corrupt.connection.objects.get(
      corrupt.value.objects[1]!.objectId,
    )!;
    const finalByte = second.tombstoneBytes.length - 1;
    second.tombstoneBytes[finalByte] =
      second.tombstoneBytes[finalByte]! ^ 0xff;
    second.tombstoneHash = corrupt.value.crypto.hash(second.tombstoneBytes);

    expect(corrupt.repository.tombstoneObjects({
      objectIds: corrupt.value.objects.map((object) => object.objectId),
      signal: new AbortController().signal,
    })).rejects.toThrow(/signature|tombstone/i);
    expect(
      [...corrupt.connection.objects.values()].every(
        (object) => object.headRevision === 0,
      ),
    ).toBeTrue();

    const cas = await setup();
    cas.connection.failCas = true;
    expect(cas.repository.tombstoneObjects({
      objectIds: [cas.value.objects[0]!.objectId],
      signal: new AbortController().signal,
    })).rejects.toThrow(/CAS/i);
    expect(cas.connection.objects.get(
      cas.value.objects[0]!.objectId,
    )?.headRevision).toBe(0);
  });

  test("rejects a retained tombstone envelope and an unrelated access head", async () => {
    const envelope = await setup();
    envelope.connection.objects.get(
      envelope.value.objects[0]!.objectId,
    )!.tombstoneHasEnvelope = true;
    expect(envelope.repository.tombstoneObjects({
      objectIds: [envelope.value.objects[0]!.objectId],
      signal: new AbortController().signal,
    })).rejects.toThrow(/envelope/i);

    const head = await setup();
    const state = head.connection.objects.get(
      head.value.objects[0]!.objectId,
    )!;
    state.headRevision = 2;
    state.headHash = new Uint8Array(32).fill(0x77);
    expect(head.repository.tombstoneObjects({
      objectIds: [state.objectId],
      signal: new AbortController().signal,
    })).rejects.toThrow(/head/i);
  });

  test("rejects genesis envelope hash or Namespace substitution before the head update", async () => {
    const hash = await setup();
    const hashState = hash.connection.objects.get(
      hash.value.objects[0]!.objectId,
    )!;
    hashState.storedGenesisEnvelopeHash =
      new Uint8Array(32).fill(0x66);
    expect(hash.repository.tombstoneObjects({
      objectIds: [hashState.objectId],
      signal: new AbortController().signal,
    })).rejects.toThrow(/genesis envelope inventory/i);
    expect(hashState.headRevision).toBe(0);

    const namespace = await setup();
    const namespaceState = namespace.connection.objects.get(
      namespace.value.objects[0]!.objectId,
    )!;
    namespaceState.storedGenesisNamespaceId = "foreign-namespace";
    expect(namespace.repository.tombstoneObjects({
      objectIds: [namespaceState.objectId],
      signal: new AbortController().signal,
    })).rejects.toThrow(/genesis envelope inventory/i);
    expect(namespaceState.headRevision).toBe(0);
  });

  test("rejects duplicate, oversized, and aborted batches before SQL mutation", async () => {
    const { value, connection, repository } = await setup();
    const exactObjectId = value.objects[0]!.objectId;
    expect(repository.tombstoneObjects({
      objectIds: [exactObjectId, exactObjectId],
      signal: new AbortController().signal,
    })).rejects.toThrow(/duplicated/i);
    expect(repository.tombstoneObjects({
      objectIds: Array.from(
        { length: JOURNAL_CRYPTO_TOMBSTONE_MAX_OBJECTS + 1 },
        (_, index) => objectId(`oversized-journal-tombstone-${index}`),
      ),
      signal: new AbortController().signal,
    })).rejects.toThrow(/batch/i);
    const controller = new AbortController();
    controller.abort();
    expect(repository.tombstoneObjects({
      objectIds: [exactObjectId],
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i);
    expect(connection.transactionCount).toBe(0);
  });
});
