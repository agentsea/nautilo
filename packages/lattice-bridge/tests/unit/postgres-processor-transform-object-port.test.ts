import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  createAgentObjectAccessManifest,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  deriveAgentRuntimeObjectSignerPublic,
  domainEpoch,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareAgentRuntimeInitialization,
  prepareObjectAccessManifestGenesis,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type ProcessorTransformObjectPort,
} from "@nautilo/lattice-crypto";
import {
  BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
  backgroundWorkDescriptorDigestV1,
  createProcessorObjectAccessManifestV4,
  createProcessorObjectSignerPublicV1,
  createProcessorSignerAuthorizationV1,
  decodeObjectAccessManifestV3,
  encodeBackgroundWorkDescriptorV1,
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encodeObjectAccessManifestV3,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  createPostgresProcessorTransformObjectPort,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";

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

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

type StoredOutput = Readonly<{
  objectId: string;
  payloadHash: Uint8Array;
  payloadBytes: Uint8Array;
  manifestHash: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeHash: Uint8Array;
  envelopeBytes: Uint8Array;
  namespaceId: string;
  tombstoneManifestHash?: Uint8Array;
  tombstoneManifestBytes?: Uint8Array;
}>;

type StoredTransformCommit = Readonly<{
  claimId: string;
  descriptorHash: Uint8Array;
  recipientGeneration: number;
  outputCount: number;
  committedAt: Date;
}>;

type State = {
  readonly outputs: Map<string, StoredOutput>;
  transformCommit: StoredTransformCommit | null;
};

function cloneBytes(value: Uint8Array): Uint8Array {
  return value.slice();
}

function cloneState(state: State): State {
  return {
    outputs: new Map(
      [...state.outputs].map(([key, value]) => [key, {
        ...value,
        payloadHash: cloneBytes(value.payloadHash),
        payloadBytes: cloneBytes(value.payloadBytes),
        manifestHash: cloneBytes(value.manifestHash),
        manifestBytes: cloneBytes(value.manifestBytes),
        envelopeHash: cloneBytes(value.envelopeHash),
        envelopeBytes: cloneBytes(value.envelopeBytes),
        ...(value.tombstoneManifestHash === undefined ? {} : {
          tombstoneManifestHash:
            cloneBytes(value.tombstoneManifestHash),
        }),
        ...(value.tombstoneManifestBytes === undefined ? {} : {
          tombstoneManifestBytes:
            cloneBytes(value.tombstoneManifestBytes),
        }),
      }]),
    ),
    transformCommit: state.transformCommit === null
      ? null
      : {
        ...state.transformCommit,
        descriptorHash: state.transformCommit.descriptorHash.slice(),
        committedAt: new Date(state.transformCommit.committedAt),
      },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

class StatefulCryptoConnection implements CryptoPostgresConnection {
  state: State = { outputs: new Map(), transformCommit: null };
  readonly queries: Query[] = [];
  transactionCount = 0;
  failInsertTable: string | null = null;
  failCommitWithSerialization = false;
  textualCommitTimestamp = false;
  humanDeviceRows: Record<string, unknown>[];
  agentSignerRows: Record<string, unknown>[];
  readonly #fixture: Fixture;

  constructor(value: Fixture) {
    this.#fixture = value;
    this.humanDeviceRows = value.humanDeviceRows;
    this.agentSignerRows = value.agentSignerRows;
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as Row[]);
    }
    if (
      statement.replaceAll('"', "").toLowerCase()
        .includes("from namespace_crypto_heads")
    ) {
      return Promise.resolve([this.#fixture.namespaceHeadRow] as Row[]);
    }
    throw new Error("Processor transform SQL must use a transaction");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    const working = cloneState(this.state);
    const drafts = new Map<string, Partial<StoredOutput>>();
    const transaction: CryptoPostgresExecutor = {
      query: async <Row>(
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<readonly Row[]> => {
        this.queries.push({ statement, parameters });
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (
          statement.includes("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
        ) return [];
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (
          normalized.includes("from background_crypto_authorization_requests")
        ) {
          const commit = working.transformCommit;
          return [{
            ...this.#fixture.requestRow,
            transform_commit_claim_id: commit?.claimId ?? null,
            transform_commit_descriptor_hash:
              commit?.descriptorHash.slice() ?? null,
            transform_commit_recipient_generation:
              commit?.recipientGeneration ?? null,
            transform_commit_output_count: commit?.outputCount ?? null,
            transform_committed_at:
              commit === null ? null : this.textualCommitTimestamp
                ? new Date(commit.committedAt).toISOString().replace("T", " ").replace("Z", "+00")
                : new Date(commit.committedAt),
          }] as Row[];
        }
        if (
          normalized.includes("from processor_crypto_signer_authorizations")
        ) {
          return [this.#fixture.signerEvidenceRow] as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_signers")) {
          // The canonical crypto role may SELECT/INSERT this append-only ledger,
          // but cannot request a row lock, which requires UPDATE privilege.
          if (/for (?:share|update|key share|no key update)/u.test(normalized)) {
            throw new Error("permission denied for table agent_crypto_runtime_signers");
          }
          return this.agentSignerRows.filter((row) =>
            row["agent_id"] === parameters[0]
            && row["runtime_generation"] === parameters[1]
          ) as Row[];
        }
        if (normalized.includes("from human_crypto_devices")) {
          return this.humanDeviceRows.filter(
            (row) => row["device_id"] === parameters[0],
          ) as Row[];
        }
        if (statement.includes("FROM namespace_crypto_heads")) {
          return [this.#fixture.namespaceHeadRow] as Row[];
        }
        const exactObjectId = parameters[0] as string;
        const stored = working.outputs.get(exactObjectId);
        if (normalized.includes("from crypto_objects")) {
          return stored === undefined ? [] : [{
            object_id: stored.objectId,
            payload_hash: cloneBytes(stored.payloadHash),
            payload_bytes: cloneBytes(stored.payloadBytes),
          }] as Row[];
        }
        if (statement.includes("FROM object_crypto_access_heads")) {
          return stored === undefined ? [] : [{
            object_id: stored.objectId,
            access_revision: 0,
            manifest_hash: cloneBytes(stored.manifestHash),
            previous_manifest_hash: null,
            payload_hash: cloneBytes(stored.payloadHash),
            manifest_bytes: cloneBytes(stored.manifestBytes),
          }] as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          return stored === undefined ? [] : [{
            namespace_id: stored.namespaceId,
            ordinal: 0,
            envelope_hash: cloneBytes(stored.envelopeHash),
            envelope_bytes: cloneBytes(stored.envelopeBytes),
          }] as Row[];
        }
        if (
          normalized.includes("from object_crypto_access_manifests")
          && (normalized.includes("access_revision = 1")
            || parameters[1] === 1)
        ) {
          return stored?.tombstoneManifestBytes === undefined
            || stored.tombstoneManifestHash === undefined
            ? []
            : [{
              object_id: stored.objectId,
              access_revision: 1,
              manifest_hash: cloneBytes(stored.tombstoneManifestHash),
              previous_manifest_hash: cloneBytes(stored.manifestHash),
              payload_hash: cloneBytes(stored.payloadHash),
              manifest_bytes: cloneBytes(stored.tombstoneManifestBytes),
            }] as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          this.#fail("crypto_objects");
          drafts.set(exactObjectId, {
            objectId: exactObjectId,
            payloadHash: cloneBytes(parameters[1] as Uint8Array),
            payloadBytes: cloneBytes(parameters[2] as Uint8Array),
          });
          return [];
        }
        if (
          normalized.includes("insert into object_crypto_access_manifests")
        ) {
          this.#fail("object_crypto_access_manifests");
          if (parameters[1] === 1) {
            Object.assign(drafts.get(exactObjectId)!, {
              tombstoneManifestHash:
                cloneBytes(parameters[2] as Uint8Array),
              tombstoneManifestBytes:
                cloneBytes(parameters[5] as Uint8Array),
            });
          } else {
            Object.assign(drafts.get(exactObjectId)!, {
              manifestHash: cloneBytes(parameters[2] as Uint8Array),
              payloadHash: cloneBytes(parameters[4] as Uint8Array),
              manifestBytes: cloneBytes(parameters[5] as Uint8Array),
            });
          }
          return [];
        }
        if (
          normalized.includes("insert into object_crypto_namespace_envelopes")
        ) {
          this.#fail("object_crypto_namespace_envelopes");
          Object.assign(drafts.get(exactObjectId)!, {
            namespaceId: parameters[2] as string,
            envelopeHash: cloneBytes(parameters[4] as Uint8Array),
            envelopeBytes: cloneBytes(parameters[5] as Uint8Array),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          this.#fail("object_crypto_access_heads");
          working.outputs.set(
            exactObjectId,
            drafts.get(exactObjectId) as StoredOutput,
          );
          return [];
        }
        if (
          normalized.includes(
            "update background_crypto_authorization_requests",
          )
          && normalized.includes("transform_committed_at")
        ) {
          working.transformCommit = {
            claimId: parameters[0] as string,
            descriptorHash: cloneBytes(parameters[1] as Uint8Array),
            recipientGeneration: parameters[2] as number,
            outputCount: parameters[3] as number,
            committedAt: new Date(parameters[4] as string),
          };
          return [{ request_id: parameters[5] }] as Row[];
        }
        throw new Error(`Unexpected processor transform SQL: ${
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
    this.state = working;
    return result;
  }

  #fail(table: string): void {
    if (this.failInsertTable === table) {
      this.failInsertTable = null;
      throw new Error(`injected ${table} failure`);
    }
  }
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(91_241));
  const issuer = crypto.generateSigningKeyPair();
  const signer = crypto.generateSigningKeyPair();
  const issuingHumanId = humanId("human-transform-issuer");
  const issuingDeviceId = cryptoDeviceId("device-transform-issuer");
  const exactNamespaceId = namespaceId("namespace-transform");
  const exactDomainId = cryptoDomainId("domain-transform");
  const outputObjectIds = [
    objectId("journal-output-0001"),
    objectId("journal-output-0002"),
  ];
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: BACKGROUND_WORK_DESCRIPTOR_FORMAT_VERSION_V1,
    requestId: "request-transform",
    recipientGeneration: 2,
    workKind: "stenographer.extraction",
    workId: "work-transform",
    namespaceId: exactNamespaceId,
    domainId: exactDomainId,
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
      startSequence: 1,
      endSequence: 2,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [objectId("message-input-0001")],
    outputObjectIds,
    outputObjectMetadata: outputObjectIds.map((id, index) => ({
      objectId: id,
      objectType: "nautilo-journal-event-v1",
      createdAt: unixTimestamp(10_000 + index),
    })),
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 4_096,
    maximumCiphertextBytes: 32_768,
    expectedDomainEpoch: domainEpoch(4),
    expectedNamespaceAccessRevision: accessRevision(0),
    expectedPolicyRevision: authorizationRevision(6),
    recipientKeyId: "recipient-transform",
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    issuedAt: 10_000,
    notBefore: 10_000,
    expiresAt: 70_000,
    idempotencyId: "idempotency-transform",
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash = backgroundWorkDescriptorDigestV1(crypto, descriptor);
  const principal = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: "signer-authorization-transform",
    workDescriptorHash: descriptorHash,
    signerPrivateKey: signer.privateKey,
  }).principal;
  const authorization = createProcessorSignerAuthorizationV1(
    crypto,
    {
      formatVersion: 1,
      id: "signer-authorization-transform",
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
      issuingHumanId,
      issuingDeviceId,
      issuingDeviceAuthorizationRevision: authorizationRevision(9),
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
      signer: principal,
      signerPublicKey: signer.publicKey,
      workDescriptorHash: descriptorHash,
      credentialHash: new Uint8Array(32).fill(0x43),
      outputObjectIds: descriptor.outputObjectIds,
      maxOutputObjects: descriptor.maximumOutputObjectCount,
      maxOutputPlaintextBytes: descriptor.maximumPlaintextBytes,
      maxOutputCiphertextBytes: descriptor.maximumCiphertextBytes,
      issuedAt: descriptor.issuedAt,
      expiresAt: descriptor.expiresAt,
    },
    issuer.privateKey,
  );
  const preparedRuntime = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-transform-agent-runtime-initialization",
    agentId: agentId("agent-transform-input"),
    authorizationRevision: authorizationRevision(2),
    configObjects: [{
      objectId: objectId("config-transform-agent-runtime"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x49),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: issuingHumanId,
      managerAuthorizationRevision: authorizationRevision(2),
      managerDeviceId: issuingDeviceId,
    },
    managerSigningPrivateKey: issuer.privateKey,
    resolveCurrentManagerAuthority: () => issuer.publicKey,
  });
  const namespaceKey = new Uint8Array(32).fill(0x44);
  const outputs = descriptor.outputObjectMetadata.map((metadata, index) => {
    const encrypted = encryptObjectPayload(
      crypto,
      {
        objectId: metadata.objectId,
        keyClass: "ai",
        objectType: metadata.objectType,
        createdAt: metadata.createdAt,
      },
      new TextEncoder().encode(`output-${index}`),
    );
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        crypto,
        namespaceKey,
        {
          objectId: metadata.objectId,
          namespaceId: descriptor.namespaceId,
          keyClass: "ai",
          keyGeneration: namespaceGeneration(3),
          bindingRevisionAtWrap:
            descriptor.expectedNamespaceAccessRevision,
        },
        encrypted.dek,
      ),
    );
    encrypted.dek.fill(0);
    const manifest = createProcessorObjectAccessManifestV4(
      crypto,
      {
        objectId: metadata.objectId,
        payloadHash: crypto.hash(payloadBytes),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [crypto.hash(envelopeBytes)],
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
    const tombstoneManifest = createProcessorObjectAccessManifestV4(
      crypto,
      {
        objectId: metadata.objectId,
        payloadHash: manifest.manifest.payloadHash,
        accessRevision: accessRevision(1),
        previousManifestHash: manifest.hash,
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
    return Object.freeze({
      objectId: metadata.objectId,
      payloadBytes,
      envelopeBytes,
      manifestBytes: manifest.bytes,
      tombstoneManifestBytes: tombstoneManifest.bytes,
      signerAuthorizationBytes: authorization.bytes,
    });
  });
  const keyrings = createInitialNamespaceKeyrings(
    crypto,
    descriptor.namespaceId,
  );
  const humanKeyringEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: new Uint8Array(32).fill(0x45),
    keyring: keyrings.human,
    metadata: {
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      previousBindingHash: null,
      committerDeviceId: issuingDeviceId,
    },
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const aiKeyringEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: new Uint8Array(32).fill(0x46),
    keyring: keyrings.ai,
    metadata: {
      domainId: descriptor.domainId,
      domainEpoch: descriptor.expectedDomainEpoch,
      previousBindingHash: null,
      committerDeviceId: issuingDeviceId,
    },
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope: humanKeyringEnvelope,
    aiEnvelope: aiKeyringEnvelope,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const bindingBytes = serializeNamespaceBindingV2(binding);
  return {
    crypto,
    issuer,
    signer,
    issuingHumanId,
    issuingDeviceId,
    descriptor,
    descriptorBytes,
    descriptorHash,
    authorization,
    preparedRuntime,
    outputs,
    requestRow: {
      request_id: descriptor.requestId,
      idempotency_key: descriptor.idempotencyId,
      work_id: descriptor.workId,
      namespace_id: descriptor.namespaceId,
      domain_id: descriptor.domainId,
      expected_domain_epoch: descriptor.expectedDomainEpoch,
      expected_namespace_access_revision:
        descriptor.expectedNamespaceAccessRevision,
      expected_policy_revision: descriptor.expectedPolicyRevision,
      processor_authorization_revision:
        descriptor.subject.authorizationRevision,
      credential_hash: authorization.authorization.credentialHash,
      descriptor_hash: descriptorHash,
      descriptor_bytes: descriptorBytes,
      state: "running",
      recipient_generation: descriptor.recipientGeneration,
      claim_id: `claim-${descriptor.requestId}`,
      claim_expires_at: new Date(20_000),
    },
    signerEvidenceRow: {
      authorization_id: authorization.authorization.id,
      request_id: descriptor.requestId,
      recipient_generation: descriptor.recipientGeneration,
      processor_kind: "stenographer",
      processor_version: 1,
      authorization_hash: authorization.hash,
      authorization_bytes: authorization.bytes,
      issuing_human_id: issuingHumanId,
      issuing_device_id: issuingDeviceId,
      issuing_device_authorization_revision:
        authorization.authorization.issuingDeviceAuthorizationRevision,
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
    humanDeviceRows: [{
      device_id: issuingDeviceId,
      human_id: issuingHumanId,
      signing_public_key: issuer.publicKey,
      revision: 9,
      state: "revoked",
    }],
    agentSignerRows: [{
      agent_id: preparedRuntime.signerPublication.agentId,
      runtime_generation:
        preparedRuntime.signerPublication.runtimeGeneration,
      authorization_revision:
        preparedRuntime.signerPublication.authorizationRevision,
      transition_kind:
        preparedRuntime.signerPublication.transitionKind,
      operation_id: preparedRuntime.signerPublication.operationId,
      signer_key_id: preparedRuntime.signerPublication.signerKeyId,
      signer_public_key: preparedRuntime.signerPublication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(
        preparedRuntime.signerPublication,
      ),
    }],
    namespaceHeadRow: {
      namespace_id: descriptor.namespaceId,
      access_revision: descriptor.expectedNamespaceAccessRevision,
      binding_hash: crypto.hash(bindingBytes),
      domain_id: descriptor.domainId,
      domain_epoch: descriptor.expectedDomainEpoch,
      signed_binding_bytes: bindingBytes,
      human_keyring_envelope_bytes:
        serializeNamespaceKeyringEnvelopeV2(humanKeyringEnvelope),
      ai_keyring_envelope_bytes:
        serializeNamespaceKeyringEnvelopeV2(aiKeyringEnvelope),
    },
  };
}

async function portFixture(): Promise<{
  readonly value: Fixture;
  readonly connection: StatefulCryptoConnection;
  readonly port: ProcessorTransformObjectPort;
}> {
  const value = await fixture();
  const connection = new StatefulCryptoConnection(value);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    value,
    connection,
    port: createPostgresProcessorTransformObjectPort({
      handle,
      crypto: value.crypto,
    }),
  };
}

function publish(
  port: ProcessorTransformObjectPort,
  value: Fixture,
  input: Partial<Parameters<ProcessorTransformObjectPort["publishOutputs"]>[0]>
    = {},
) {
  return port.publishOutputs({
    idempotencyId: value.descriptor.idempotencyId,
    claimId: `claim-${value.descriptor.requestId}`,
    authorityCheckedAt: 10_001,
    authorizeCommit: async () => 10_002,
    outputs: value.outputs,
    signal: new AbortController().signal,
    ...input,
  });
}

function storeHumanV2Input(
  value: Fixture,
  connection: StatefulCryptoConnection,
): StoredOutput {
  const exactObjectId = objectId("legacy-input-authenticated");
  const encrypted = encryptObjectPayload(
    value.crypto,
    {
      objectId: exactObjectId,
      keyClass: "ai",
      objectType: "legacy-message",
      createdAt: unixTimestamp(20_000),
    },
    new TextEncoder().encode("legacy"),
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(
      value.crypto,
      new Uint8Array(32).fill(0x47),
      {
        objectId: exactObjectId,
        namespaceId: value.descriptor.namespaceId,
        keyClass: "ai",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap:
          value.descriptor.expectedNamespaceAccessRevision,
      },
      encrypted.dek,
    ),
  );
  encrypted.dek.fill(0);
  const prepared = prepareObjectAccessManifestGenesis(value.crypto, {
    objectId: exactObjectId,
    payloadHash: value.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: value.issuingDeviceId,
    hostAuthorizationRevision: authorizationRevision(1),
    signingPrivateKey: value.issuer.privateKey,
  });
  const stored = {
    objectId: exactObjectId,
    payloadHash: value.crypto.hash(payloadBytes),
    payloadBytes,
    manifestHash: prepared.manifestHash,
    manifestBytes: prepared.manifestBytes,
    envelopeHash: value.crypto.hash(envelopeBytes),
    envelopeBytes,
    namespaceId: value.descriptor.namespaceId,
  };
  connection.state.outputs.set(exactObjectId, stored);
  return stored;
}

function storeAgentV3Input(
  value: Fixture,
  connection: StatefulCryptoConnection,
): StoredOutput {
  const exactObjectId = objectId("agent-input-authenticated");
  const encrypted = encryptObjectPayload(
    value.crypto,
    {
      objectId: exactObjectId,
      keyClass: "ai",
      objectType: "agent-message",
      createdAt: unixTimestamp(20_001),
    },
    new TextEncoder().encode("agent"),
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
    wrapObjectDekForNamespace(
      value.crypto,
      new Uint8Array(32).fill(0x48),
      {
        objectId: exactObjectId,
        namespaceId: value.descriptor.namespaceId,
        keyClass: "ai",
        keyGeneration: namespaceGeneration(0),
        bindingRevisionAtWrap:
          value.descriptor.expectedNamespaceAccessRevision,
      },
      encrypted.dek,
    ),
  );
  encrypted.dek.fill(0);
  const manifest = createAgentObjectAccessManifest(
    value.crypto,
    {
      objectId: exactObjectId,
      payloadHash: value.crypto.hash(payloadBytes),
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [value.crypto.hash(envelopeBytes)],
      signer: deriveAgentRuntimeObjectSignerPublic(
        value.crypto,
        value.preparedRuntime.runtime,
      ).principal,
      hostAuthorizationRevision: authorizationRevision(2),
    },
    value.preparedRuntime.runtime,
  );
  const stored = {
    objectId: exactObjectId,
    payloadHash: value.crypto.hash(payloadBytes),
    payloadBytes,
    manifestHash: manifest.hash,
    manifestBytes: manifest.bytes,
    envelopeHash: value.crypto.hash(envelopeBytes),
    envelopeBytes,
    namespaceId: value.descriptor.namespaceId,
  };
  connection.state.outputs.set(exactObjectId, stored);
  return stored;
}

describe("Postgres processor transform object port", () => {
  test("requires an authentic verified crypto-role handle", async () => {
    const value = await fixture();
    expect(() =>
      createPostgresProcessorTransformObjectPort({
        handle: new StatefulCryptoConnection(value) as never,
        crypto: value.crypto,
      })
    ).toThrow("verified nautilo_crypto handle");
  });

  test("loads only the exact current AI Namespace keyring binding", async () => {
    const { value, port } = await portFixture();
    const loaded = await port.loadNamespaceKeyring({
      namespaceId: value.descriptor.namespaceId,
      signal: new AbortController().signal,
    });

    expect(loaded.envelope.keyClass).toBe("ai");
    expect(loaded.envelope.namespaceId).toBe(value.descriptor.namespaceId);
    expect(loaded.envelope.accessRevision).toBe(
      value.descriptor.expectedNamespaceAccessRevision,
    );
    expect(loaded.envelope.domainId).toBe(value.descriptor.domainId);
  });

  test("rejects non-portable lookup ids before querying durable storage", async () => {
    const { connection, port } = await portFixture();
    const before = connection.queries.length;
    expect(port.loadNamespaceKeyring({
      namespaceId: "",
      signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(port.openInput({
      objectId: "x".repeat(1_025),
      signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(connection.queries).toHaveLength(before);
  });

  test("opens hash-bound v2, Agent v3, and processor v4 objects without changing generic storage", async () => {
    const { value, connection, port } = await portFixture();
    const v4 = value.outputs[0]!;
    connection.state.outputs.set(v4.objectId, {
      objectId: v4.objectId,
      payloadHash: value.crypto.hash(v4.payloadBytes),
      payloadBytes: v4.payloadBytes.slice(),
      manifestHash: value.crypto.hash(v4.manifestBytes),
      manifestBytes: v4.manifestBytes.slice(),
      envelopeHash: value.crypto.hash(v4.envelopeBytes),
      envelopeBytes: v4.envelopeBytes.slice(),
      namespaceId: value.descriptor.namespaceId,
    });
    const openedV4 = await port.openInput({
      objectId: v4.objectId,
      signal: new AbortController().signal,
    });
    expect(openedV4.payload.context.objectId).toBe(v4.objectId);
    expect(openedV4.envelope.context.namespaceId).toBe(
      value.descriptor.namespaceId,
    );

    const legacyObjectId = objectId("legacy-input-0001");
    const encrypted = encryptObjectPayload(
      value.crypto,
      {
        objectId: legacyObjectId,
        keyClass: "ai",
        objectType: "legacy-message",
        createdAt: unixTimestamp(20_000),
      },
      new TextEncoder().encode("legacy"),
    );
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        value.crypto,
        new Uint8Array(32).fill(0x47),
        {
          objectId: legacyObjectId,
          namespaceId: value.descriptor.namespaceId,
          keyClass: "ai",
          keyGeneration: namespaceGeneration(0),
          bindingRevisionAtWrap:
            value.descriptor.expectedNamespaceAccessRevision,
        },
        encrypted.dek,
      ),
    );
    encrypted.dek.fill(0);
    const prepared = prepareObjectAccessManifestGenesis(value.crypto, {
      objectId: legacyObjectId,
      payloadHash: value.crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      committerDeviceId: value.issuingDeviceId,
      hostAuthorizationRevision: authorizationRevision(1),
      signingPrivateKey: value.issuer.privateKey,
    });
    connection.state.outputs.set(legacyObjectId, {
      objectId: legacyObjectId,
      payloadHash: value.crypto.hash(payloadBytes),
      payloadBytes,
      manifestHash: prepared.manifestHash,
      manifestBytes: prepared.manifestBytes,
      envelopeHash: value.crypto.hash(envelopeBytes),
      envelopeBytes,
      namespaceId: value.descriptor.namespaceId,
    });

    const openedV2 = await port.openInput({
      objectId: legacyObjectId,
      signal: new AbortController().signal,
    });
    expect(openedV2.payload.context.objectType).toBe("legacy-message");
    expect(openedV2.envelope.context.objectId).toBe(legacyObjectId);

    const v3ObjectId = objectId("agent-input-0001");
    const v3Encrypted = encryptObjectPayload(
      value.crypto,
      {
        objectId: v3ObjectId,
        keyClass: "ai",
        objectType: "agent-message",
        createdAt: unixTimestamp(20_001),
      },
      new TextEncoder().encode("agent"),
    );
    const v3PayloadBytes = encodeEncryptedPayloadV2(v3Encrypted.payload);
    const v3EnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        value.crypto,
        new Uint8Array(32).fill(0x48),
        {
          objectId: v3ObjectId,
          namespaceId: value.descriptor.namespaceId,
          keyClass: "ai",
          keyGeneration: namespaceGeneration(0),
          bindingRevisionAtWrap:
            value.descriptor.expectedNamespaceAccessRevision,
        },
        v3Encrypted.dek,
      ),
    );
    v3Encrypted.dek.fill(0);
    const runtime = value.preparedRuntime.runtime;
    const v3Manifest = createAgentObjectAccessManifest(
      value.crypto,
      {
        objectId: v3ObjectId,
        payloadHash: value.crypto.hash(v3PayloadBytes),
        accessRevision: accessRevision(0),
        previousManifestHash: null,
        envelopeHashes: [value.crypto.hash(v3EnvelopeBytes)],
        signer:
          deriveAgentRuntimeObjectSignerPublic(value.crypto, runtime).principal,
        hostAuthorizationRevision: authorizationRevision(2),
      },
      runtime,
    );
    connection.state.outputs.set(v3ObjectId, {
      objectId: v3ObjectId,
      payloadHash: value.crypto.hash(v3PayloadBytes),
      payloadBytes: v3PayloadBytes,
      manifestHash: v3Manifest.hash,
      manifestBytes: v3Manifest.bytes,
      envelopeHash: value.crypto.hash(v3EnvelopeBytes),
      envelopeBytes: v3EnvelopeBytes,
      namespaceId: value.descriptor.namespaceId,
    });

    const openedV3 = await port.openInput({
      objectId: v3ObjectId,
      signal: new AbortController().signal,
    });
    expect(openedV3.payload.context.objectType).toBe("agent-message");
    const signerQueries = connection.queries.filter(({statement}) =>
      statement.replaceAll('"', "").toLowerCase().includes("from agent_crypto_runtime_signers"));
    expect(signerQueries).toHaveLength(1);
    expect(signerQueries[0]!.statement).not.toMatch(/FOR (?:SHARE|UPDATE|KEY SHARE|NO KEY UPDATE)/iu);
  });

  test("rejects a Human v2 signature corruption even when every durable hash is recomputed", async () => {
    const { value, connection, port } = await portFixture();
    const stored = storeHumanV2Input(value, connection);
    stored.manifestBytes[stored.manifestBytes.length - 1] =
      stored.manifestBytes[stored.manifestBytes.length - 1]! ^ 0xff;
    (stored as { manifestHash: Uint8Array }).manifestHash =
      value.crypto.hash(stored.manifestBytes);

    expect(port.openInput({
      objectId: stored.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/signature|historical/i);
  });

  test("rejects Agent v3 manifest signature, signer, and publication substitution", async () => {
    const signatureCase = await portFixture();
    const signatureStored = storeAgentV3Input(
      signatureCase.value,
      signatureCase.connection,
    );
    signatureStored.manifestBytes[signatureStored.manifestBytes.length - 1] =
      signatureStored.manifestBytes[
        signatureStored.manifestBytes.length - 1
      ]! ^ 0xff;
    (signatureStored as { manifestHash: Uint8Array }).manifestHash =
      signatureCase.value.crypto.hash(signatureStored.manifestBytes);
    expect(signatureCase.port.openInput({
      objectId: signatureStored.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/signature|historical/i);

    const signerCase = await portFixture();
    const signerStored = storeAgentV3Input(
      signerCase.value,
      signerCase.connection,
    );
    const substituted = decodeObjectAccessManifestV3(
      signerStored.manifestBytes,
    );
    (signerStored as { manifestBytes: Uint8Array }).manifestBytes =
      encodeObjectAccessManifestV3({
      ...substituted,
      signer: {
        ...substituted.signer,
        signerKeyId: `agent_runtime_signer_${"f".repeat(64)}`,
      },
      });
    (signerStored as { manifestHash: Uint8Array }).manifestHash =
      signerCase.value.crypto.hash(signerStored.manifestBytes);
    expect(signerCase.port.openInput({
      objectId: signerStored.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/signer|historical/i);

    const publicationCase = await portFixture();
    const publicationStored = storeAgentV3Input(
      publicationCase.value,
      publicationCase.connection,
    );
    const publicationBytes = publicationCase.connection
      .agentSignerRows[0]!["publication_bytes"] as Uint8Array;
    publicationBytes[publicationBytes.length - 1] =
      publicationBytes[publicationBytes.length - 1]! ^ 0xff;
    expect(publicationCase.port.openInput({
      objectId: publicationStored.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/publication|historical|signature/i);
  });

  test("fails closed when retained Human or Agent signer history is missing or duplicated", async () => {
    const humanMissing = await portFixture();
    const missingHumanObject = storeHumanV2Input(
      humanMissing.value,
      humanMissing.connection,
    );
    humanMissing.connection.humanDeviceRows = [];
    expect(humanMissing.port.openInput({
      objectId: missingHumanObject.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/history|signing/i);

    const humanDuplicate = await portFixture();
    const duplicateHumanObject = storeHumanV2Input(
      humanDuplicate.value,
      humanDuplicate.connection,
    );
    humanDuplicate.connection.humanDeviceRows.push({
      ...humanDuplicate.connection.humanDeviceRows[0]!,
    });
    expect(humanDuplicate.port.openInput({
      objectId: duplicateHumanObject.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/more than one|history/i);

    const agentMissing = await portFixture();
    const missingAgentObject = storeAgentV3Input(
      agentMissing.value,
      agentMissing.connection,
    );
    agentMissing.connection.agentSignerRows = [];
    expect(agentMissing.port.openInput({
      objectId: missingAgentObject.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/history|publication/i);

    const agentDuplicate = await portFixture();
    const duplicateAgentObject = storeAgentV3Input(
      agentDuplicate.value,
      agentDuplicate.connection,
    );
    agentDuplicate.connection.agentSignerRows.push({
      ...agentDuplicate.connection.agentSignerRows[0]!,
    });
    expect(agentDuplicate.port.openInput({
      objectId: duplicateAgentObject.objectId,
      signal: new AbortController().signal,
    })).rejects.toThrow(/more than one|history|publication/i);
  });

  test("accepts retained historical signer keys after later device revocation", async () => {
    const human = await portFixture();
    const humanObject = storeHumanV2Input(human.value, human.connection);
    expect(human.connection.humanDeviceRows[0]).toMatchObject({
      state: "revoked",
      revision: 9,
    });
    expect(human.port.openInput({
      objectId: humanObject.objectId,
      signal: new AbortController().signal,
    })).resolves.toBeDefined();

    const agent = await portFixture();
    const agentObject = storeAgentV3Input(agent.value, agent.connection);
    expect(agent.connection.humanDeviceRows[0]).toMatchObject({
      state: "revoked",
      revision: 9,
    });
    expect(agent.port.openInput({
      objectId: agentObject.objectId,
      signal: new AbortController().signal,
    })).resolves.toBeDefined();
  });

  test("rejects processor signer history from an invalid device state or an older retained revision", async () => {
    const invalidState = await portFixture();
    invalidState.connection.humanDeviceRows[0]!["state"] = "pending";
    expect(publish(invalidState.port, invalidState.value)).rejects
      .toThrow(/device history/i);
    expect([...invalidState.connection.state.outputs]).toHaveLength(0);

    const staleRevision = await portFixture();
    staleRevision.connection.humanDeviceRows[0]!["revision"] = 8;
    expect(publish(staleRevision.port, staleRevision.value)).rejects
      .toThrow(/device history/i);
    expect([...staleRevision.connection.state.outputs]).toHaveLength(0);
  });

  test("authorizes once at the durable boundary and commits the exact prefix atomically", async () => {
    const { value, connection, port } = await portFixture();
    const events: string[] = [];

    await publish(port, value, {
      authorizeCommit: async () => {
        events.push("authorize");
        return 10_002;
      },
      outputs: value.outputs.slice(0, 1),
    });

    expect(events).toEqual(["authorize"]);
    expect(connection.queries.some(({ statement }) =>
      statement.includes("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
    )).toBeTrue();
    expect(connection.queries.filter(({ statement }) =>
      statement.replaceAll('"', "").toLowerCase().includes(
        "from processor_crypto_signer_authorizations",
      )
    ).every(({ statement }) => !statement.includes("FOR SHARE"))).toBeTrue();
    expect([...connection.state.outputs]).toHaveLength(1);
    const stored = connection.state.outputs.get(value.outputs[0]!.objectId);
    expect(stored?.tombstoneManifestBytes).toEqual(
      value.outputs[0]!.tombstoneManifestBytes,
    );
    const authorizationIndex = connection.queries.findIndex((query) =>
      query.statement.replaceAll('"', "").toLowerCase()
        .includes("insert into crypto_objects")
    );
    expect(authorizationIndex).toBeGreaterThan(0);
    expect(connection.queries.slice(authorizationIndex).map((query) =>
      query.statement.replaceAll('"', "").toLowerCase()
        .match(/(?:insert into|update) ([a-z_]+)/)?.[1]
    ).filter(Boolean)).toEqual([
      "crypto_objects",
      "object_crypto_access_manifests",
      "object_crypto_access_manifests",
      "object_crypto_namespace_envelopes",
      "object_crypto_access_heads",
      "background_crypto_authorization_requests",
    ]);
  });

  test("persists an authenticated transform commit even for an empty output prefix", async () => {
    const { value, connection, port } = await portFixture();

    await publish(port, value, { outputs: [] });

    expect([...connection.state.outputs]).toHaveLength(0);
    expect(connection.queries.some(({ statement, parameters }) =>
      statement.includes("transform_committed_at")
      && statement.includes("background_crypto_authorization_requests")
      && parameters.includes(value.descriptor.requestId)
      && parameters.includes(0)
    )).toBeTrue();
  });

  test("accepts raw PostgreSQL claim and committed-marker timestamps on publication replay", async () => {
    const { value, connection, port } = await portFixture();
    Object.assign(value.requestRow, {claim_expires_at: "1970-01-01 00:00:20+00"});
    connection.textualCommitTimestamp = true;
    await publish(port, value, {outputs: value.outputs.slice(0, 1)});
    await publish(port, value, {outputs: value.outputs.slice(0, 1)});
    expect([...connection.state.outputs]).toHaveLength(1);
  });

  test("rejects invalid or expired raw PostgreSQL claim timestamps", async () => {
    for (const timestamp of [null, "invalid", 20_000, "1970-01-01 00:00:10.002+00"]) {
      const { value, connection, port } = await portFixture();
      Object.assign(value.requestRow, {claim_expires_at: timestamp});
      expect(publish(port, value)).rejects.toThrow();
      expect([...connection.state.outputs]).toHaveLength(0);
    }
  });

  test("rejects a publication whose durable claim expires at the commit boundary", async () => {
    const { value, connection, port } = await portFixture();
    value.requestRow["claim_expires_at"] = new Date(10_002);

    expect(publish(port, value)).rejects.toThrow(/claim.*expired/i);
    expect([...connection.state.outputs]).toHaveLength(0);
  });

  test("exact replay is a no-op success but still checks current commit authority", async () => {
    const { value, connection, port } = await portFixture();
    await publish(port, value, { outputs: value.outputs.slice(0, 1) });
    const queryCount = connection.queries.length;
    let authorized = 0;

    await publish(port, value, {
      authorizeCommit: async () => {
        authorized += 1;
        return 10_003;
      },
      outputs: value.outputs.slice(0, 1),
    });

    expect(authorized).toBe(1);
    expect([...connection.state.outputs]).toHaveLength(1);
    expect(
      connection.queries.slice(queryCount).some((query) =>
        query.statement.includes("INSERT INTO")
      ),
    ).toBeFalse();
  });

  test("rejects a shorter replay after a longer prefix was committed", async () => {
    const { value, connection, port } = await portFixture();
    await publish(port, value);
    let authorized = 0;

    expect(
      publish(port, value, {
        outputs: value.outputs.slice(0, 1),
        authorizeCommit: async () => {
          authorized += 1;
          return 10_003;
        },
      }),
    ).rejects.toThrow(/commit marker|different durable output prefix/);
    expect(authorized).toBe(0);
    expect([...connection.state.outputs]).toHaveLength(2);
  });

  test("rejects a partial durable prefix or conflicting existing object before authorization", async () => {
    const { value, connection, port } = await portFixture();
    await publish(port, value, { outputs: value.outputs.slice(0, 1) });
    let authorized = 0;

    expect(
      publish(port, value, {
        authorizeCommit: async () => {
          authorized += 1;
          return 10_003;
        },
        outputs: value.outputs,
      }),
    ).rejects.toThrow(/commit marker|partial/);
    expect(authorized).toBe(0);

    const conflicting = connection.state.outputs.get(
      value.outputs[0]!.objectId,
    );
    if (conflicting === undefined) throw new Error("missing test output");
    conflicting.payloadBytes[0] = conflicting.payloadBytes[0]! ^ 0xff;
    expect(
      publish(port, value, {
        authorizeCommit: async () => {
          authorized += 1;
          return 10_004;
        },
        outputs: value.outputs.slice(0, 1),
      }),
    ).rejects.toThrow("conflict");
    expect(authorized).toBe(0);
  });

  test("rolls back every output when any insert fails", async () => {
    const { value, connection, port } = await portFixture();
    connection.failInsertTable = "object_crypto_namespace_envelopes";

    expect(publish(port, value)).rejects.toThrow(
      "injected object_crypto_namespace_envelopes failure",
    );
    expect([...connection.state.outputs]).toHaveLength(0);
  });

  test("never replays one-shot authority after a serialization abort", async () => {
    const { value, connection, port } = await portFixture();
    connection.failCommitWithSerialization = true;
    let authorized = 0;

    expect(publish(port, value, {
      authorizeCommit: async () => {
        authorized += 1;
        return 10_002;
      },
    })).rejects.toMatchObject({ code: "40001" });
    expect(authorized).toBe(1);
    expect(connection.transactionCount).toBe(1);
    expect([...connection.state.outputs]).toHaveLength(0);
  });

  test("rejects abort before and after the one-shot commit check without writes", async () => {
    const before = await portFixture();
    const beforeController = new AbortController();
    beforeController.abort();
    expect(
      publish(before.port, before.value, {
        signal: beforeController.signal,
      }),
    ).rejects.toThrow("aborted");
    expect([...before.connection.state.outputs]).toHaveLength(0);

    const after = await portFixture();
    const afterController = new AbortController();
    expect(
      publish(after.port, after.value, {
        signal: afterController.signal,
        authorizeCommit: async () => {
          afterController.abort();
          return 10_002;
        },
      }),
    ).rejects.toThrow("aborted");
    expect([...after.connection.state.outputs]).toHaveLength(0);
  });

  test("rejects skipped, repeated, or stale authorization callbacks", async () => {
    const { value, connection, port } = await portFixture();
    expect(
      publish(port, value, {
        authorizeCommit: async () => Number.NaN,
      }),
    ).rejects.toThrow("commit authorization");
    expect([...connection.state.outputs]).toHaveLength(0);

    expect(
      publish(port, value, {
        authorizeCommit: async () => 9_999,
      }),
    ).rejects.toThrow("older");
    expect([...connection.state.outputs]).toHaveLength(0);
  });

  test("rejects reordered, substituted, malformed, or foreign output material", async () => {
    const { value, connection, port } = await portFixture();
    expect(
      publish(port, value, {
        outputs: [...value.outputs].reverse(),
      }),
    ).rejects.toThrow("ordered prefix");
    expect(
      publish(port, value, {
        outputs: [{
          ...value.outputs[0]!,
          payloadBytes: value.outputs[1]!.payloadBytes,
        }],
      }),
    ).rejects.toThrow("payload");
    expect(
      publish(port, value, {
        outputs: [{
          ...value.outputs[0]!,
          signerAuthorizationBytes: value.outputs[0]!
            .signerAuthorizationBytes.slice(0, -1),
        }],
      }),
    ).rejects.toThrow();
    expect([...connection.state.outputs]).toHaveLength(0);
  });

  test("rejects a validly signed tombstone that is not chained to its exact genesis manifest", async () => {
    const { value, connection, port } = await portFixture();
    const output = value.outputs[0]!;
    const substituted = createProcessorObjectAccessManifestV4(
      value.crypto,
      {
        objectId: output.objectId,
        payloadHash: value.crypto.hash(output.payloadBytes),
        accessRevision: accessRevision(1),
        previousManifestHash: new Uint8Array(32).fill(0x7f),
        envelopeHashes: [],
        signer: value.authorization.authorization.signer,
        signerAuthorizationHash: value.authorization.hash,
        hostAuthorizationRevision:
          value.authorization.authorization.processorAuthorizationRevision,
      },
      {
        signerPrivateKey: value.signer.privateKey,
        signerAuthorizationBytes: value.authorization.bytes,
        now: value.descriptor.issuedAt,
        resolveCurrentIssuingDevicePublicKey: () => value.issuer.publicKey,
      },
    );

    expect(publish(port, value, {
      outputs: [{
        ...output,
        tombstoneManifestBytes: substituted.bytes,
      }],
    })).rejects.toThrow(/tombstone/i);
    expect([...connection.state.outputs]).toHaveLength(0);
  });

  test("rejects descriptor and recipient-attempt evidence substitution before authorization", async () => {
    const descriptorCase = await portFixture();
    descriptorCase.value.requestRow.descriptor_hash[0] =
      descriptorCase.value.requestRow.descriptor_hash[0]! ^ 0xff;
    let descriptorAuthorized = 0;
    expect(
      publish(descriptorCase.port, descriptorCase.value, {
        authorizeCommit: async () => {
          descriptorAuthorized += 1;
          return 10_002;
        },
      }),
    ).rejects.toThrow("durable request");
    expect(descriptorAuthorized).toBe(0);
    expect([...descriptorCase.connection.state.outputs]).toHaveLength(0);

    const claimCase = await portFixture();
    expect(
      publish(claimCase.port, claimCase.value, {
        claimId: "substituted-claim",
      }),
    ).rejects.toThrow("durable request");
    expect([...claimCase.connection.state.outputs]).toHaveLength(0);

    const generationCase = await portFixture();
    generationCase.value.requestRow.recipient_generation += 1;
    expect(publish(generationCase.port, generationCase.value)).rejects
      .toThrow("durable request");
    expect([...generationCase.connection.state.outputs]).toHaveLength(0);

    const evidenceCase = await portFixture();
    evidenceCase.value.signerEvidenceRow.recipient_generation += 1;
    let evidenceAuthorized = 0;
    expect(
      publish(evidenceCase.port, evidenceCase.value, {
        authorizeCommit: async () => {
          evidenceAuthorized += 1;
          return 10_002;
        },
      }),
    ).rejects.toThrow("recipient attempt");
    expect(evidenceAuthorized).toBe(0);
    expect([...evidenceCase.connection.state.outputs]).toHaveLength(0);

    const durableDescriptorCase = await portFixture();
    durableDescriptorCase.value.signerEvidenceRow.work_descriptor_bytes =
      new Uint8Array([1, 2, 3]);
    let durableDescriptorAuthorized = 0;
    expect(
      publish(durableDescriptorCase.port, durableDescriptorCase.value, {
        authorizeCommit: async () => {
          durableDescriptorAuthorized += 1;
          return 10_002;
        },
      }),
    ).rejects.toThrow("durable bytes");
    expect(durableDescriptorAuthorized).toBe(0);
  });
});
