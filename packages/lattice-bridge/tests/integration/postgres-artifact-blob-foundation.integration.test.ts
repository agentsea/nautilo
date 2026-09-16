import { randomUUID } from "node:crypto";
import { mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  appendNamespaceGeneration,
  authorizationRevision,
  createCommonAgentObjectAccessManifest,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDomainId,
  cryptoDeviceId,
  domainEpoch,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  fingerprintHumanArtifactAccessInventory,
  humanId,
  namespaceBindingHash,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareAgentRuntimeInitialization,
  prepareHumanArtifactExactAccessRequest,
  prepareHumanObjectAccessManifestUpdateSet,
  prepareHumanObjectAccessManifestGenesisSet,
  sealNamespaceKeyring,
  type AgentRuntimeSignerPublication,
  type Rng,
  unixTimestamp,
  verifyCommonObjectAccessManifestChain,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  encodeArtifactControlV1,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresArtifactProductPublication,
  PostgresHumanArtifactExactAccessCryptoCompletion,
  PostgresHumanArtifactExactAccessProduct,
  createFilesystemEncryptedArtifactBlobStoreV1,
  createPostgresArtifactCryptoCompletion,
  verifyConversationProductPostgresHandle,
  verifyCryptoPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";
import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  ARTIFACT_CONTROL_VERSION_V1,
  createDormantArtifactShadowRepository,
  createPreparedArtifactCryptoRevision,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
} from "@nautilo/lattice-bridge";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const NOW = 1_830_000_000_000;
let admin: SqlClient;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function sqlClient(url: string): SqlClient {
  return postgres(url, { max: 2, prepare: false, onnotice: () => undefined });
}

function cryptoExecutor(client: SqlExecutor): CryptoPostgresExecutor {
  return {
    async query<Row>(statement: string, parameters = []): Promise<readonly Row[]> {
      return await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      ) as unknown as readonly Row[];
    },
  };
}

function cryptoConnection(client: SqlClient): CryptoPostgresConnection {
  return {
    ...cryptoExecutor(client),
    transaction: (callback) => client.begin((transaction) =>
      callback(cryptoExecutor(transaction))
    ) as unknown as ReturnType<typeof callback>,
  };
}

function productExecutor(
  client: SqlExecutor,
  statements: string[],
): ConversationProductPostgresExecutor {
  return {
    async query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
      statement: string,
      parameters: readonly ConversationProductPostgresScalar[] = [],
    ): Promise<readonly Row[]> {
      statements.push(statement);
      return await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      ) as unknown as readonly Row[];
    },
  };
}

function productConnection(
  client: SqlClient,
  statements: string[],
): ConversationProductPostgresConnection {
  return {
    ...productExecutor(client, statements),
    transaction: <Result>(
      callback: (transaction: ConversationProductPostgresExecutor) => Promise<Result>,
      options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
    ) => client.begin(
      `isolation level ${options.isolationLevel}`,
      (transaction) => callback(productExecutor(transaction, statements)),
    ) as unknown as Promise<Result>,
  };
}

function humanProductConnection(
  client: SqlClient,
  statements: string[],
  userId: string,
): ConversationProductPostgresConnection {
  return {
    ...productExecutor(client, statements),
    transaction: <Result>(
      callback: (transaction: ConversationProductPostgresExecutor) => Promise<Result>,
      options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
    ) => client.begin(
      `isolation level ${options.isolationLevel}`,
      async (transaction) => {
        await transaction.unsafe(
          "SELECT set_config('app.current_user_id', $1, true)",
          [userId],
        );
        await transaction.unsafe(
          "SELECT set_config('app.current_agent_id', '', true)",
        );
        return callback(productExecutor(transaction, statements));
      },
    ) as unknown as Promise<Result>,
  };
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e37_79b9;
  return {
    bytes(length: number): Uint8Array {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        output[index] = state & 0xff;
      }
      return output;
    },
  };
}

function exactAccessBinding(input: Readonly<{
  crypto: LatticeCrypto;
  namespaceValue: string;
  domainValue: string;
  deviceValue: string;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  marker: number;
}>) {
  const created = createInitialNamespaceKeyrings(
    input.crypto,
    namespaceId(input.namespaceValue),
  );
  const humanKeyring = appendNamespaceGeneration(input.crypto, created.human);
  const metadata = {
    domainId: cryptoDomainId(input.domainValue),
    domainEpoch: domainEpoch(0),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId(input.deviceValue),
  } as const;
  const resolve = () => input.signingPublicKey;
  const humanEnvelope = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: new Uint8Array(32).fill(input.marker),
    keyring: humanKeyring,
    metadata,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: resolve,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: new Uint8Array(32).fill(input.marker + 1),
    keyring: created.ai,
    metadata,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: resolve,
  });
  const binding = createNamespaceBinding({
    crypto: input.crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: input.signingPrivateKey,
    resolveCurrentCommitter: resolve,
  });
  const result = Object.freeze({
    bytes: serializeNamespaceBindingV2(binding),
    hash: namespaceBindingHash(binding),
    humanEnvelopeBytes: serializeNamespaceKeyringEnvelopeV2(humanEnvelope),
    aiEnvelopeBytes: serializeNamespaceKeyringEnvelopeV2(aiEnvelope),
  });
  [...created.human.generations, ...created.ai.generations,
    ...humanKeyring.generations].forEach((entry) => entry.key.fill(0));
  return result;
}

beforeAll(() => {
  admin = sqlClient(adminUrl);
});

afterAll(async () => {
  await admin.end();
});

describe("Postgres protected Artifact blob foundation", () => {
  test("publishes and opens a Human 0 -> Agent 1 -> Human 2 Artifact chain under real roles", async () => {
    const artifactId = randomUUID();
    const artifactRowId = randomUUID();
    const blobId = randomUUID();
    const namespaceIds = [randomUUID(), randomUUID()].sort();
    const targetNamespaceId = randomUUID();
    const allNamespaceIds = [...namespaceIds, targetNamespaceId].sort();
    const domainIds = allNamespaceIds.map((_, index) =>
      `artifact-access-domain-${index}-${randomUUID()}`
    );
    const operationId = `artifact-create:${randomUUID()}`;
    const controlOperationId = `artifact-control:${randomUUID()}`;
    const accessOperationId = `artifact-access:${randomUUID()}`;
    const userId = randomUUID();
    const actorId = randomUUID();
    const humanValue = `artifact-human:${randomUUID()}`;
    const deviceId = `artifact-device:${randomUUID()}`;
    const plaintext = new TextEncoder().encode(
      `artifact-plaintext-canary:${randomUUID()}:`.repeat(90_000),
    );
    const crypto = new LatticeCrypto(seededRng(
      Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16),
    ), { now: () => NOW });
    const signer = crypto.generateSigningKeyPair();
    const deviceEncryption = await crypto.generateEncryptionKeyPair();
    const blobDek = crypto.randomBytes(32);
    const namespaceKeys = namespaceIds.map((_, index) =>
      new Uint8Array(32).fill(0x41 + index)
    );
    const transientSecrets = [
      plaintext,
      blobDek,
      signer.privateKey,
      deviceEncryption.privateKey,
      ...namespaceKeys,
    ];
    const root = await mkdtemp(join(tmpdir(), "nautilo-artifact-m261-"));
    const productStatements: string[] = [];
    const blobStore = createFilesystemEncryptedArtifactBlobStoreV1({
      rootDirectory: root,
    });
    const cryptoClient = sqlClient(cryptoUrl);
    const productClient = sqlClient(appUrl);
    const objectIdValue = deriveArtifactControlObjectIdV1({
      artifactId,
      artifactRevision: 1,
    });
    const controlObjectId = deriveArtifactControlObjectIdV1({
      artifactId,
      artifactRevision: 2,
    });
    const objectIds = [objectIdValue, controlObjectId];
    const exactBindings = allNamespaceIds.map((namespaceValue, index) =>
      exactAccessBinding({
        crypto,
        namespaceValue,
        domainValue: domainIds[index]!,
        deviceValue: deviceId,
        signingPrivateKey: signer.privateKey,
        signingPublicKey: signer.publicKey,
        marker: 0x61 + index * 2,
      })
    );
    try {
      const createdAt = new Date(NOW);
      await admin.begin(async (transaction) => {
        await transaction.unsafe(
          `INSERT INTO users (id, name)
           VALUES ($1, 'Artifact Wave 18 integration user')`,
          [userId],
        );
        await transaction.unsafe(
          `INSERT INTO actors (
             id, owner_id, display_name, trust_state, kind, agent_id
           ) VALUES ($1, $2, 'Artifact Wave 18 Human', 'verified', 'user', NULL)`,
          [actorId, userId],
        );
        await transaction.unsafe(
          `INSERT INTO human_crypto_custodies (
             human_id, user_id, human_actor_id,
             initial_installation_lineage_digest, state, ever_initialized_at,
             first_device_id, current_recovery_generation,
             current_recovery_public_key_digest, revision, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
          [humanValue, userId, actorId, crypto.hash(new Uint8Array([0x81])),
            createdAt, deviceId, crypto.hash(new Uint8Array([0x82]))],
        );
        await transaction.unsafe(
          `INSERT INTO human_crypto_devices (
             device_id, human_id, user_id, human_actor_id, client_kind,
             installation_lineage_digest, device_generation,
             signing_public_key, encryption_public_key, public_fingerprint,
             state, authorization_kind, recovery_generation,
             authorization_evidence_digest, key_package_generation,
             key_package_count, revision, created_at, activated_at
           ) VALUES ($1, $2, $3, $4, 'electron', $5, 1, $6, $7, $8,
             'active', 'first_bootstrap', 1, $9, 1, 0, 2, $10, $10)`,
          [deviceId, humanValue, userId, actorId,
            crypto.hash(new Uint8Array([0x83])), signer.publicKey,
            deviceEncryption.publicKey, crypto.hash(signer.publicKey),
            crypto.hash(new Uint8Array([0x84])), createdAt],
        );
      });
      for (const [index, id] of allNamespaceIds.entries()) {
        await admin.unsafe(
          `INSERT INTO namespaces (id, scope, label)
           VALUES ($1, 'room', $2)`,
          [id, `Artifact M261 integration ${index}`],
        );
        await admin.unsafe(
          `INSERT INTO crypto_domains (
             id, participant_digest, participants, epoch,
             authorization_revision, roster_bytes
           ) VALUES ($1, $2, ARRAY[$3]::text[], 0, 1, $4)`,
          [domainIds[index]!, crypto.hash(new TextEncoder().encode(humanValue)),
            humanValue, new Uint8Array([0x70 + index])],
        );
        await admin.unsafe(
          `INSERT INTO namespace_crypto_bindings (
             namespace_id, revision, binding_hash, previous_binding_hash,
             signed_binding_bytes, human_keyring_envelope_bytes,
             ai_keyring_envelope_bytes
           ) VALUES ($1, 0, $2, NULL, $3, $4, $5)`,
          [id, exactBindings[index]!.hash, exactBindings[index]!.bytes,
            exactBindings[index]!.humanEnvelopeBytes,
            exactBindings[index]!.aiEnvelopeBytes],
        );
        await admin.unsafe(
          `INSERT INTO namespace_crypto_heads (
             namespace_id, access_revision, binding_hash, domain_id, domain_epoch
           ) VALUES ($1, 0, $2, $3, 0)`,
          [id, exactBindings[index]!.hash, domainIds[index]!],
        );
      }
      const publication = await blobStore.publish({
        crypto,
        artifactId,
        blobId,
        blobGeneration: 1,
        plaintextLength: plaintext.length,
        blobDek,
        plaintext: [plaintext],
      });
      expect(publication.status).toBe("published");
      if (publication.status === "quarantined") throw new Error("blob collision");
      const reference = publication.reference;
      const controlBytes = encodeArtifactControlV1({
        formatVersion: 1,
        artifactId,
        artifactRevision: 1,
        blobGeneration: 1,
        blobDek,
        logicalPath: "documents/private.txt",
        mimeType: "text/plain; charset=utf-8",
        plaintextLength: plaintext.length,
        plaintextSha256: crypto.hash(plaintext),
        blobId,
        ciphertextLength: reference.ciphertextLength,
        ciphertextSha256: reference.ciphertextSha256,
        chunkPlaintextBytes: reference.chunkPlaintextBytes,
        chunkCount: reference.chunkCount,
      });
      const encrypted = encryptObjectPayload(crypto, {
        objectId: objectId(objectIdValue),
        keyClass: "ai",
        objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
        createdAt: unixTimestamp(NOW),
      }, controlBytes);
      const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
      transientSecrets.push(controlBytes, encrypted.dek, payloadBytes);
      const envelopes = namespaceIds.map((id, index) =>
        encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
          crypto,
          namespaceKeys[index]!,
          {
            objectId: objectId(objectIdValue),
            namespaceId: namespaceId(id),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(0),
            bindingRevisionAtWrap: accessRevision(0),
          },
          encrypted.dek,
        ))
      );
      const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
        objectId: objectId(objectIdValue),
        payloadHash: crypto.hash(payloadBytes),
        envelopeBytes: envelopes,
        sourceAuthorized: true,
        targetAuthorized: true,
        subjectHumanId: humanValue,
        committerDeviceId: cryptoDeviceId(deviceId),
        hostAuthorizationRevision: authorizationRevision(1),
        committerSigningPublicKey: signer.publicKey,
        committerSigningPrivateKey: signer.privateKey,
      });
      const resolveCurrentAuthorization = (context: Parameters<
        NonNullable<Parameters<typeof createPreparedArtifactCryptoRevision>[0]["resolveCurrentAuthorization"]>
      >[0]) => ({
        ...context,
        sourceAuthorized: true as const,
        targetAuthorized: true as const,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: signer.publicKey,
      });
      const prepared = createPreparedArtifactCryptoRevision({
        revision: Object.freeze({
          artifactId,
          artifactRevision: 1,
          blobGeneration: 1,
          objectId: objectIdValue,
          objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
          controlVersion: ARTIFACT_CONTROL_VERSION_V1,
          blobId,
          plaintextLength: plaintext.length,
          ciphertextLength: reference.ciphertextLength,
          ciphertextSha256: reference.ciphertextSha256,
          chunkPlaintextBytes: reference.chunkPlaintextBytes,
          chunkCount: reference.chunkCount,
          requiredNamespaceIds: namespaceIds,
        }),
        object: encryptedObjectWriteRecord(payloadBytes),
        access,
        resolveCurrentAuthorization,
      });
      const cryptoHandle = await verifyCryptoPostgresHandle(
        cryptoConnection(cryptoClient),
      );
      const completion = createPostgresArtifactCryptoCompletion({
        handle: cryptoHandle,
        crypto,
        resolveHistoricalSigner: (context) => ({
          ...context,
          committerSigningPublicKey: signer.publicKey,
        }),
      });
      const productHandle = await verifyConversationProductPostgresHandle(
        productConnection(productClient, productStatements),
      );
      const product = new PostgresArtifactProductPublication(productHandle);
      const withoutDigest = Object.freeze({
        operationId,
        artifactRowId,
        anchorNamespaceId: namespaceIds[0]!,
        operationType: "create" as const,
        expectedArtifactRevision: 0,
        expectedAccessRevision: 0,
        expectedBlobGeneration: 0,
        expectedBlobId: null,
        expectedRequiredNamespaceFingerprint: null,
        revision: prepared,
        blob: Object.freeze({
          artifactId,
          blobId,
          blobGeneration: 1,
          storageRef: `${blobId}.artifact-blob-v1`,
          ciphertextLength: reference.ciphertextLength,
          ciphertextSha256: reference.ciphertextSha256,
        }),
        mimeClass: "text" as const,
        sizeBucket: "le_10_mib" as const,
        requiredNamespaceFingerprint:
          fingerprintRequiredArtifactNamespaces(namespaceIds),
      });
      const repository = createDormantArtifactShadowRepository({
        product,
        crypto: completion,
        blobs: blobStore,
      });
      expect(await repository.publish(withoutDigest)).toMatchObject({
        status: "published",
      });
      const restarted = createDormantArtifactShadowRepository({
        product: new PostgresArtifactProductPublication(productHandle),
        crypto: createPostgresArtifactCryptoCompletion({
          handle: cryptoHandle,
          crypto,
          resolveHistoricalSigner: (context) => ({
            ...context,
            committerSigningPublicKey: signer.publicKey,
          }),
        }),
        blobs: createFilesystemEncryptedArtifactBlobStoreV1({ rootDirectory: root }),
      });
      expect(await restarted.publish(withoutDigest)).toMatchObject({
        status: "replayed",
      });

      // A control-only revision rotates the encrypted control object and its
      // wrapped DEK while retaining the exact immutable blob generation.
      const controlRevisionBytes = encodeArtifactControlV1({
        formatVersion: 1,
        artifactId,
        artifactRevision: 2,
        blobGeneration: 1,
        blobDek,
        logicalPath: "documents/renamed-private.txt",
        mimeType: "text/plain; charset=utf-8",
        plaintextLength: plaintext.length,
        plaintextSha256: crypto.hash(plaintext),
        blobId,
        ciphertextLength: reference.ciphertextLength,
        ciphertextSha256: reference.ciphertextSha256,
        chunkPlaintextBytes: reference.chunkPlaintextBytes,
        chunkCount: reference.chunkCount,
      });
      const controlEncrypted = encryptObjectPayload(crypto, {
        objectId: objectId(controlObjectId),
        keyClass: "ai",
        objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
        createdAt: unixTimestamp(NOW + 1),
      }, controlRevisionBytes);
      const controlPayloadBytes = encodeEncryptedPayloadV2(
        controlEncrypted.payload,
      );
      transientSecrets.push(
        controlRevisionBytes,
        controlEncrypted.dek,
        controlPayloadBytes,
      );
      const controlEnvelopes = namespaceIds.map((id, index) =>
        encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
          crypto,
          namespaceKeys[index]!,
          {
            objectId: objectId(controlObjectId),
            namespaceId: namespaceId(id),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(0),
            bindingRevisionAtWrap: accessRevision(0),
          },
          controlEncrypted.dek,
        ))
      );
      const controlAccess = prepareHumanObjectAccessManifestGenesisSet(crypto, {
        objectId: objectId(controlObjectId),
        payloadHash: crypto.hash(controlPayloadBytes),
        envelopeBytes: controlEnvelopes,
        sourceAuthorized: true,
        targetAuthorized: true,
        subjectHumanId: humanValue,
        committerDeviceId: cryptoDeviceId(deviceId),
        hostAuthorizationRevision: authorizationRevision(1),
        committerSigningPublicKey: signer.publicKey,
        committerSigningPrivateKey: signer.privateKey,
      });
      // Publication consumes and wipes the prepared handle. Retain only the
      // public chain coordinates needed to construct the later Agent append.
      const controlPayloadHash = controlAccess.manifest.payloadHash.slice();
      const controlManifestHash = controlAccess.manifestHash.slice();
      transientSecrets.push(controlPayloadHash, controlManifestHash);
      const preparedControl = createPreparedArtifactCryptoRevision({
        revision: Object.freeze({
          artifactId,
          artifactRevision: 2,
          blobGeneration: 1,
          objectId: controlObjectId,
          objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
          controlVersion: ARTIFACT_CONTROL_VERSION_V1,
          blobId,
          plaintextLength: plaintext.length,
          ciphertextLength: reference.ciphertextLength,
          ciphertextSha256: reference.ciphertextSha256,
          chunkPlaintextBytes: reference.chunkPlaintextBytes,
          chunkCount: reference.chunkCount,
          requiredNamespaceIds: namespaceIds,
        }),
        object: encryptedObjectWriteRecord(controlPayloadBytes),
        access: controlAccess,
        resolveCurrentAuthorization,
      });
      expect(await restarted.publish(Object.freeze({
        ...withoutDigest,
        operationId: controlOperationId,
        operationType: "control" as const,
        expectedArtifactRevision: 1,
        expectedBlobGeneration: 1,
        expectedBlobId: blobId,
        expectedRequiredNamespaceFingerprint:
          fingerprintRequiredArtifactNamespaces(namespaceIds),
        revision: preparedControl,
      }))).toMatchObject({ status: "published" });
      const generationRows = await admin.unsafe<{
        revision_count: number;
        blob_count: number;
      }[]>(
        `SELECT
           (SELECT count(*)::int FROM artifact_crypto_revisions
             WHERE artifact_row_id = $1) AS revision_count,
           (SELECT count(*)::int FROM artifact_crypto_blobs
             WHERE artifact_row_id = $1) AS blob_count`,
        [artifactRowId],
      );
      expect([...generationRows]).toEqual([{
        revision_count: 2,
        blob_count: 1,
      }]);

      // Change the exact audience on the current control object without
      // touching the immutable blob or advancing the Artifact revision. The
      // product commit is deliberately delayed until after both role clients
      // restart, proving crypto-first recovery rather than a happy-path-only
      // transaction.
      const bindingFact = (id: (typeof allNamespaceIds)[number]) => {
        const index = allNamespaceIds.indexOf(id);
        if (index < 0) throw new Error("missing exact-access binding fixture");
        return Object.freeze({
          namespaceId: id,
          domainId: domainIds[index]!,
          expectedAccessRevision: 0,
          expectedPolicyRevision: 1,
          bindingHash: exactBindings[index]!.hash,
        });
      };
      const originalBindingFacts = namespaceIds.map(bindingFact);
      const agentTargetNamespaceIds = [namespaceIds[1]!, targetNamespaceId]
        .sort();
      const agentTargetBindingFacts = agentTargetNamespaceIds.map(bindingFact);
      const currentEnvelopeByNamespace = new Map(namespaceIds.map(
        (id, index) => [id, controlEnvelopes[index]!] as const,
      ));
      const targetEnvelope = encodeNamespaceObjectEnvelopeV2(
        wrapObjectDekForNamespace(
          crypto,
          new Uint8Array(32).fill(0x73),
          {
            objectId: objectId(controlObjectId),
            namespaceId: namespaceId(targetNamespaceId),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(0),
            bindingRevisionAtWrap: accessRevision(0),
          },
          controlEncrypted.dek,
        ),
      );
      transientSecrets.push(targetEnvelope);
      const agentTargetEnvelopeBytes = agentTargetNamespaceIds.map((id) =>
        id === targetNamespaceId
          ? targetEnvelope
          : currentEnvelopeByNamespace.get(id)!
      );

      // Wave 18 has no Agent Artifact product route. Exercise the common
      // protocol under the actual restricted/product roles by advancing only
      // the existing generic crypto rows and exact product mapping, then make
      // the canonical Human adapter authenticate and extend that Agent head.
      const artifactAgentValue = agentId(`artifact-agent:${randomUUID()}`);
      const initializedAgent = await prepareAgentRuntimeInitialization({
        crypto,
        operationId: `artifact-runtime:${randomUUID()}`,
        agentId: artifactAgentValue,
        authorizationRevision: authorizationRevision(3),
        configObjects: [{
          objectId: `artifact-config:${randomUUID()}`,
          configRevision: authorizationRevision(1),
          plaintextDek: new Uint8Array(32).fill(0x79),
        }],
        domains: [{
          domainId: cryptoDomainId(domainIds[1]!),
          domainEpoch: domainEpoch(0),
          agentAuthorizationRevision: authorizationRevision(1),
          committerDeviceId: cryptoDeviceId(deviceId),
          domainRoot: new Uint8Array(32).fill(0x7a),
          committerSigningPrivateKey: signer.privateKey,
        }],
        resolveCurrentDomainCommitterAuthority: () => signer.publicKey,
        manager: {
          managerHumanId: humanId(humanValue),
          managerAuthorizationRevision: authorizationRevision(1),
          managerDeviceId: cryptoDeviceId(deviceId),
        },
        managerSigningPrivateKey: signer.privateKey,
        resolveCurrentManagerAuthority: () => signer.publicKey,
      });
      const runtimePublication: AgentRuntimeSignerPublication =
        initializedAgent.signerPublication;
      const agentAccess = createCommonAgentObjectAccessManifest(crypto, {
        objectId: objectId(controlObjectId),
        payloadHash: controlPayloadHash,
        accessRevision: accessRevision(1),
        previousManifestHash: controlManifestHash,
        envelopeHashes: agentTargetEnvelopeBytes.map((bytes) =>
          crypto.hash(bytes)
        ),
        signer: {
          kind: "agent_runtime",
          agentId: agentId(String(runtimePublication.agentId)),
          runtimeGeneration: agentRuntimeGeneration(
            Number(runtimePublication.runtimeGeneration),
          ),
          signerKeyId: String(runtimePublication.signerKeyId),
        },
        signerAuthorizationHash: null,
        hostAuthorizationRevision: authorizationRevision(
          Number(runtimePublication.authorizationRevision),
        ),
      }, initializedAgent.runtime);
      const decodedAgentAccess = decodeObjectAccessManifestV5(
        agentAccess.bytes,
      );
      expect(decodedAgentAccess.previousManifestHash).not.toBeNull();
      expect([...(decodedAgentAccess.previousManifestHash ?? [])]).toEqual([
        ...controlManifestHash,
      ]);
      const durableControlHead = await admin.unsafe<{
        manifest_hash: Uint8Array;
      }[]>(
        `SELECT manifest_hash
           FROM object_crypto_access_heads
          WHERE object_id = $1`,
        [controlObjectId],
      );
      expect(durableControlHead).toHaveLength(1);
      expect([...durableControlHead[0]!.manifest_hash]).toEqual([
        ...controlManifestHash,
      ]);
      const verifiedAgentChain = verifyCommonObjectAccessManifestChain(crypto, {
        manifestBytes: agentAccess.bytes,
        proof: [],
        trustedMinimumHead: {
          objectId: controlAccess.manifest.objectId,
          payloadHash: controlPayloadHash,
          accessRevision: controlAccess.manifest.accessRevision,
          manifestHash: controlManifestHash,
        },
        resolveHistoricalHumanDeviceSigningPublicKey: () => signer.publicKey,
        resolveAgentRuntimeSignerPublicKey: () =>
          new Uint8Array(runtimePublication.signerPublicKey),
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      });
      verifiedAgentChain.manifestBytes.fill(0);
      verifiedAgentChain.manifestHash.fill(0);
      await cryptoClient.begin(async (transaction) => {
        await transaction.unsafe(
          `INSERT INTO agent_crypto_runtime_states (
             agent_id, authorization_revision, runtime_generation,
             config_object_count, config_inventory_digest
           ) VALUES ($1,$2,$3,$4,$5)`,
          [runtimePublication.agentId,
            runtimePublication.authorizationRevision,
            runtimePublication.runtimeGeneration,
            initializedAgent.intended.configInventory.objectCount,
            initializedAgent.intended.configInventory.digest],
        );
        await transaction.unsafe(
          `INSERT INTO agent_crypto_runtime_signers (
             agent_id, runtime_generation, authorization_revision,
             transition_kind, operation_id, signer_key_id,
             signer_public_key, publication_bytes
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [runtimePublication.agentId, runtimePublication.runtimeGeneration,
            runtimePublication.authorizationRevision,
            runtimePublication.transitionKind,
            runtimePublication.operationId, runtimePublication.signerKeyId,
            runtimePublication.signerPublicKey,
            encodeAgentRuntimeSignerPublicationV1(runtimePublication)],
        );
        await transaction.unsafe(
          `INSERT INTO object_crypto_access_manifests (
             object_id, access_revision, manifest_hash,
             previous_manifest_hash, payload_hash, manifest_bytes
           ) VALUES ($1,1,$2,$3,$4,$5)`,
          [controlObjectId, agentAccess.hash, controlManifestHash,
            controlPayloadHash, agentAccess.bytes],
        );
        for (const [ordinal, bytes] of agentTargetEnvelopeBytes.entries()) {
          await transaction.unsafe(
            `INSERT INTO object_crypto_namespace_envelopes (
               object_id, access_revision, namespace_id, ordinal,
               envelope_hash, envelope_bytes
             ) VALUES ($1,1,$2,$3,$4,$5)`,
            [controlObjectId,
              decodeNamespaceObjectEnvelopeV2(bytes).context.namespaceId,
              ordinal, crypto.hash(bytes), bytes],
          );
        }
        const advanced = await transaction.unsafe(
          `UPDATE object_crypto_access_heads
              SET access_revision=1, manifest_hash=$2
            WHERE object_id=$1 AND access_revision=0 AND manifest_hash=$3
          RETURNING object_id`,
          [controlObjectId, agentAccess.hash, controlManifestHash],
        );
        expect(advanced).toHaveLength(1);
      });
      const durableAgentAccess = await admin.unsafe<{
        previous_manifest_hash: Uint8Array;
        manifest_bytes: Uint8Array;
      }[]>(
        `SELECT previous_manifest_hash, manifest_bytes
           FROM object_crypto_access_manifests
          WHERE object_id = $1 AND access_revision = 1`,
        [controlObjectId],
      );
      expect(durableAgentAccess).toHaveLength(1);
      expect([...durableAgentAccess[0]!.previous_manifest_hash]).toEqual([
        ...controlManifestHash,
      ]);
      expect([...
        (decodeObjectAccessManifestV5(
          durableAgentAccess[0]!.manifest_bytes,
        ).previousManifestHash ?? [])
      ]).toEqual([...controlManifestHash]);
      await productClient.begin(async (transaction) => {
        await transaction.unsafe(
          "SELECT set_config('app.current_user_id', $1, true)", [userId],
        );
        await transaction.unsafe(
          "SELECT set_config('app.current_agent_id', '', true)",
        );
        await transaction.unsafe(
          `DELETE FROM artifact_namespaces
            WHERE artifact_id=$1 AND namespace_id=$2`,
          [artifactRowId, namespaceIds[0]!],
        );
        await transaction.unsafe(
          `INSERT INTO artifact_namespaces (artifact_id,namespace_id)
           VALUES ($1,$2)`, [artifactRowId, targetNamespaceId],
        );
        const mapped = await transaction.unsafe(
          `UPDATE artifacts SET crypto_access_revision=1,
              crypto_required_namespace_fingerprint=$2
            WHERE id=$1 AND revision=2 AND crypto_access_revision=0
              AND crypto_object_id=$3
          RETURNING id`,
          [artifactRowId,
            fingerprintRequiredArtifactNamespaces(agentTargetNamespaceIds),
            controlObjectId],
        );
        expect(mapped).toHaveLength(1);
      });
      const preparedAccess = prepareHumanObjectAccessManifestUpdateSet(crypto, {
        operationId: accessOperationId,
        expectedContentRevision: 2,
        subjectHumanId: humanId(humanValue),
        currentManifestBytes: agentAccess.bytes,
        currentEnvelopeBytes: agentTargetEnvelopeBytes,
        targetEnvelopeBytes: controlEnvelopes,
        trustedMinimumHead: {
          objectId: controlAccess.manifest.objectId,
          payloadHash: controlPayloadHash,
          accessRevision: controlAccess.manifest.accessRevision,
          manifestHash: controlManifestHash,
        },
        proof: [],
        resolveHistoricalHumanDeviceSigningPublicKey: () => signer.publicKey,
        resolveAgentRuntimeSignerPublicKey: () =>
          new Uint8Array(runtimePublication.signerPublicKey),
        currentNamespaceBindings: agentTargetBindingFacts,
        targetNamespaceBindings: originalBindingFacts,
        sourceAuthorized: true,
        targetAuthorized: true,
        committerDeviceId: cryptoDeviceId(deviceId),
        hostAuthorizationRevision: authorizationRevision(2),
        committerSigningPublicKey: signer.publicKey,
        committerSigningPrivateKey: signer.privateKey,
      });
      const inventory = (
        bindings: ReadonlyArray<(typeof originalBindingFacts)[number]>,
        envelopes: typeof preparedAccess.authority.currentEnvelopes,
      ) => bindings.map((binding, index) => Object.freeze({
        namespaceId: namespaceId(binding.namespaceId),
        domainId: cryptoDomainId(binding.domainId),
        expectedNamespaceAccessRevision: binding.expectedAccessRevision,
        expectedPolicyRevision: binding.expectedPolicyRevision,
        bindingHash: binding.bindingHash,
        keyGeneration: envelopes[index]!.keyGeneration,
        bindingRevisionAtWrap: envelopes[index]!.bindingRevisionAtWrap,
        envelopeHash: envelopes[index]!.envelopeHash,
      }));
      const signedAccess = prepareHumanArtifactExactAccessRequest(crypto, {
        subjectHumanId: humanId(humanValue),
        operationId: accessOperationId,
        artifactId,
        artifactRevision: 2,
        cryptoObjectId: objectId(controlObjectId),
        blobId,
        blobGeneration: 1,
        payloadHash: controlPayloadHash,
        expectedAccessRevision: 1,
        nextAccessRevision: 2,
        currentManifestHash: agentAccess.hash,
        nextManifestHash: preparedAccess.manifestHash,
        currentInventoryHash: fingerprintHumanArtifactAccessInventory(
          inventory(
            agentTargetBindingFacts,
            preparedAccess.authority.currentEnvelopes,
          ),
        ),
        targetInventoryHash: fingerprintHumanArtifactAccessInventory(
          inventory(
            originalBindingFacts,
            preparedAccess.authority.targetEnvelopes,
          ),
        ),
        issuedAt: unixTimestamp(NOW),
        deadlineAt: unixTimestamp(NOW + 30_000),
        committerDeviceId: cryptoDeviceId(deviceId),
        hostAuthorizationRevision: authorizationRevision(2),
        committerSigningPublicKey: signer.publicKey,
        committerSigningPrivateKey: signer.privateKey,
      });
      transientSecrets.push(signedAccess.bytes);
      const authority = Object.freeze({
        userId,
        subjectHumanId: humanValue,
        actorId,
        agentId: null,
        readableNamespaceIds: allNamespaceIds,
        mutableNamespaceIds: allNamespaceIds,
        writableNamespaceIds: namespaceIds,
      });
      const resolveCryptoAuthority = async () => ({
        currentBindings: agentTargetBindingFacts,
        targetBindings: originalBindingFacts,
        sourceAuthorized: true as const,
        targetAuthorized: true as const,
      });
      const accessProductClient = sqlClient(appUrl);
      const accessCryptoClient = sqlClient(cryptoUrl);
      let accessPlan;
      try {
        const accessProduct = new PostgresHumanArtifactExactAccessProduct({
          handle: await verifyConversationProductPostgresHandle(
            humanProductConnection(accessProductClient, productStatements, userId),
          ),
          resolveCryptoAuthority,
        });
        accessPlan = await accessProduct.plan({
          authority,
          operationId: accessOperationId,
          artifactId,
          target: { kind: "replace_exact", namespaceIds },
        });
        if (accessPlan.status !== "prepared") {
          throw new Error("Artifact exact access plan was unavailable");
        }
        const preparedRequest = Object.freeze({
          requestVersion: 1 as const,
          operationId: accessOperationId,
          artifactId,
          artifactRevision: 2,
          expectedCryptoAccessRevision: 1,
          nextCryptoAccessRevision: 2,
          cryptoObjectId: controlObjectId,
          blobId,
          blobGeneration: 1,
          currentNamespaceIds: agentTargetNamespaceIds,
          targetNamespaceIds: namespaceIds,
          accessManifestBytesBase64url:
            Buffer.from(preparedAccess.manifestBytes).toString("base64url"),
          signedAccessRequestBytesBase64url:
            Buffer.from(signedAccess.bytes).toString("base64url"),
          namespaceEnvelopes: namespaceIds.map((id, index) => ({
            namespaceId: id,
            envelopeBytesBase64url:
              Buffer.from(controlEnvelopes[index]!).toString("base64url"),
          })),
        });
        const accessCrypto = new PostgresHumanArtifactExactAccessCryptoCompletion({
          handle: await verifyCryptoPostgresHandle(
            cryptoConnection(accessCryptoClient),
          ),
          crypto,
          resolveSigningPublicKey: () => signer.publicKey,
          resolveHistoricalBindingCommitter: () => signer.publicKey,
          resolvePolicyRevision: async () => 1,
          resolveCurrentAuthority: () => signer.publicKey,
          resolveHistoricalAgentSignerAuthority: (context) => ({
            ...context,
            managerSigningPublicKey: signer.publicKey,
          }),
        });
        const authenticated = await accessCrypto.authenticate({
          plan: accessPlan,
          prepared: preparedRequest,
          now: NOW + 1,
        });
        expect(await accessProduct.reserve({
          authority,
          plan: accessPlan,
          signedRequestDigest: authenticated.signedRequestDigest,
        })).toBe("reserved");
        expect(await accessCrypto.complete(authenticated.handle)).toMatchObject({
          status: "applied",
          resultAccessRevision: 2,
          targetNamespaceIds: namespaceIds,
        });
      } finally {
        await accessProductClient.end();
        await accessCryptoClient.end();
      }
      const restartedAccessProductClient = sqlClient(appUrl);
      const restartedAccessCryptoClient = sqlClient(cryptoUrl);
      try {
        const restartedAccessProduct = new PostgresHumanArtifactExactAccessProduct({
          handle: await verifyConversationProductPostgresHandle(
            humanProductConnection(
              restartedAccessProductClient,
              productStatements,
              userId,
            ),
          ),
          resolveCryptoAuthority,
        });
        const restartedAccessCrypto =
          new PostgresHumanArtifactExactAccessCryptoCompletion({
            handle: await verifyCryptoPostgresHandle(
              cryptoConnection(restartedAccessCryptoClient),
            ),
            crypto,
            resolveSigningPublicKey: () => signer.publicKey,
            resolveHistoricalBindingCommitter: () => signer.publicKey,
            resolvePolicyRevision: async () => 1,
            resolveCurrentAuthority: () => signer.publicKey,
            resolveHistoricalAgentSignerAuthority: (context) => ({
              ...context,
              managerSigningPublicKey: signer.publicKey,
            }),
          });
        expect(await restartedAccessProduct.reconcile({
          authority,
          operationId: accessOperationId,
          artifactId,
          crypto: await restartedAccessCrypto.observe(controlObjectId),
        })).toEqual({
          status: "completed",
          cryptoAccessRevision: 2,
          requiredNamespaceIds: namespaceIds,
        });
        expect(await restartedAccessProduct.lookupReplay({
          authority,
          operationId: accessOperationId,
          artifactId,
          signedRequestDigest: crypto.hash(signedAccess.bytes),
        })).toEqual({
          status: "completed",
          cryptoAccessRevision: 2,
          requiredNamespaceIds: namespaceIds,
        });
      } finally {
        await restartedAccessProductClient.end();
        await restartedAccessCryptoClient.end();
      }
      const accessRows = await admin.unsafe<{
        revision: number;
        crypto_access_revision: number;
        blob_id: string;
        blob_generation: number;
        namespace_ids: string[];
      }[]>(
        `SELECT a.revision, a.crypto_access_revision, a.blob_id,
                a.blob_generation,
                ARRAY(SELECT an.namespace_id::text FROM artifact_namespaces an
                  WHERE an.artifact_id=a.id ORDER BY an.namespace_id) AS namespace_ids
           FROM artifacts a WHERE a.id=$1`,
        [artifactRowId],
      );
      expect([...accessRows]).toEqual([{
        revision: 2,
        crypto_access_revision: 2,
        blob_id: blobId,
        blob_generation: 1,
        namespace_ids: namespaceIds,
      }]);
      const afterAccessCounts = await admin.unsafe<{
        revision_count: number;
        blob_count: number;
      }[]>(
        `SELECT
           (SELECT count(*)::int FROM artifact_crypto_revisions
             WHERE artifact_row_id = $1) AS revision_count,
           (SELECT count(*)::int FROM artifact_crypto_blobs
             WHERE artifact_row_id = $1) AS blob_count`,
        [artifactRowId],
      );
      expect([...afterAccessCounts]).toEqual([{
        revision_count: 2,
        blob_count: 1,
      }]);
      const opened = await blobStore.openRange({
        crypto,
        blobDek,
        reference,
        start: 1_048_570,
        endExclusive: 1_048_590,
        consume: (value) => value.slice(),
      });
      expect(opened).toEqual({
        status: "opened",
        value: plaintext.slice(1_048_570, 1_048_590),
      });
      const rows = await admin.unsafe<{
        path: string | null;
        mime_type: string | null;
        size: number | null;
        storage_uri: string | null;
      }[]>(
        `SELECT path, mime_type, size, storage_uri
           FROM artifacts WHERE id = $1`,
        [artifactRowId],
      );
      expect([...rows]).toEqual([{
        path: null,
        mime_type: null,
        size: null,
        storage_uri: null,
      }]);
      const stored = await admin.unsafe<{ rendered: string }[]>(
        `SELECT concat_ws('|', o.artifact_id, o.operation_id,
                 b.storage_ref, r.mime_class, r.size_bucket) AS rendered
           FROM artifact_crypto_operations o
           JOIN artifact_crypto_revisions r USING (artifact_row_id, artifact_id)
           JOIN artifact_crypto_blobs b USING (artifact_row_id, artifact_id, blob_generation)
          WHERE o.operation_id = $1`,
        [operationId],
      );
      expect(stored[0]?.rendered).not.toContain("private.txt");
      expect(stored[0]?.rendered).not.toContain("text/plain");

      for (const statement of productStatements) {
        expect(statement).not.toMatch(
          /\b(?:crypto_objects|object_crypto_access_manifests|object_crypto_namespace_envelopes|object_crypto_access_heads)\b/i,
        );
      }
      let cryptoProductReadDenied = false;
      try {
        await cryptoClient.unsafe(
          "SELECT path, mime_type FROM artifacts LIMIT 1",
        );
      } catch {
        cryptoProductReadDenied = true;
      }
      expect(cryptoProductReadDenied).toBe(true);

      const leakRows = await admin.unsafe<{ rendered: string }[]>(
        `SELECT concat_ws('|', row_to_json(a)::text, row_to_json(o)::text,
                   row_to_json(r)::text, row_to_json(b)::text) AS rendered
           FROM artifacts a
           JOIN artifact_crypto_operations o ON o.artifact_row_id = a.id
           JOIN artifact_crypto_revisions r
             ON r.artifact_row_id = a.id
            AND r.artifact_revision = o.result_artifact_revision
           JOIN artifact_crypto_blobs b
             ON b.artifact_row_id = a.id
            AND b.blob_id = o.result_blob_id
          WHERE a.id = $1`,
        [artifactRowId],
      );
      for (const row of leakRows) {
        expect(row.rendered).not.toContain("artifact-plaintext-canary");
        expect(row.rendered).not.toContain("renamed-private.txt");
        expect(row.rendered).not.toContain("text/plain");
      }

      const blobPath = join(root, `${blobId}.artifact-blob-v1`);
      const corrupt = await openFile(blobPath, "r+");
      try {
        const tail = new Uint8Array(1);
        await corrupt.read(tail, 0, 1, reference.ciphertextLength - 1);
        tail[0] = tail[0]! ^ 0xff;
        await corrupt.write(tail, 0, 1, reference.ciphertextLength - 1);
        await corrupt.sync();
        tail.fill(0);
      } finally {
        await corrupt.close();
      }
      expect(await restarted.reconcile(controlOperationId)).toEqual({
        status: "quarantined",
        reason: "blob_mismatch",
      });
      const quarantineRows = await admin.unsafe<{
        crypto_lifecycle_state: string;
      }[]>(
        `SELECT crypto_lifecycle_state FROM artifacts WHERE id = $1`,
        [artifactRowId],
      );
      expect([...quarantineRows]).toEqual([{
        crypto_lifecycle_state: "quarantined",
      }]);
    } finally {
      transientSecrets.forEach((bytes) => bytes.fill(0));
      await admin.unsafe("DELETE FROM artifacts WHERE id = $1", [artifactRowId]);
      await admin.unsafe(
        "DELETE FROM artifact_crypto_operations WHERE operation_id = $1",
        [operationId],
      );
      await admin.unsafe(
        "DELETE FROM artifact_crypto_operations WHERE operation_id = $1",
        [controlOperationId],
      );
      await admin.unsafe(
        "DELETE FROM artifact_crypto_operations WHERE operation_id = $1",
        [accessOperationId],
      );
      await admin.unsafe(
        "DELETE FROM artifact_crypto_revisions WHERE artifact_row_id = $1",
        [artifactRowId],
      );
      await admin.unsafe(
        "DELETE FROM artifact_crypto_blobs WHERE artifact_row_id = $1",
        [artifactRowId],
      );
      await admin.unsafe(
        "DELETE FROM object_crypto_access_heads WHERE object_id = ANY($1::text[])",
        [objectIds],
      );
      await admin.unsafe(
        "DELETE FROM object_crypto_namespace_envelopes WHERE object_id = ANY($1::text[])",
        [objectIds],
      );
      await admin.unsafe(
        "DELETE FROM object_crypto_access_manifests WHERE object_id = ANY($1::text[])",
        [objectIds],
      );
      await admin.unsafe(
        "DELETE FROM crypto_objects WHERE object_id = ANY($1::text[])",
        [objectIds],
      );
      await admin.unsafe(
        "DELETE FROM namespace_crypto_heads WHERE namespace_id = ANY($1::text[])",
        [allNamespaceIds],
      );
      await admin.unsafe(
        "DELETE FROM namespace_crypto_bindings WHERE namespace_id = ANY($1::text[])",
        [allNamespaceIds],
      );
      await admin.unsafe(
        "DELETE FROM crypto_domains WHERE id = ANY($1::text[])",
        [domainIds],
      );
      await admin.unsafe(
        "DELETE FROM namespaces WHERE id = ANY($1::uuid[])",
        [allNamespaceIds],
      );
      await Promise.all([cryptoClient.end(), productClient.end()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
