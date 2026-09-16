import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  mintGrant,
  namespaceBindingHash,
  namespaceId,
  objectId,
  participantDigest,
  prepareAgentRuntimeInitialization,
  sealNamespaceKeyring,
} from "@nautilo/lattice-crypto";
import {
  encodeAgentRuntimeSignerPublicationV1,
  serializeGrantV2,
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
  storageAdapterSupportV2,
  type AgentRuntimeAtomicStorageWireV2,
} from "@nautilo/lattice-crypto/wire";
import {
  prepareAgentConversationCryptoRevision,
} from "../../src/message/agent-conversation-crypto.ts";
import {
  readPreparedConversationCryptoRevisionSnapshot,
} from "../../src/message/conversation-prepared-revision.ts";
import {
  AgentRuntimeSignerHistoryInvalidError,
  type ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "../../src/server/storage/agent-runtime-signer-history.ts";
import {
  ConversationCryptoCompletionConflictError,
  createPostgresConversationCryptoCompletion,
} from "../../src/server/storage/postgres-conversation-crypto-completion.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

type StoredObject = Readonly<{
  objectId: string;
  payloadHash: Uint8Array;
  payloadBytes: Uint8Array;
}>;

type StoredAccess = Readonly<{
  objectId: string;
  accessRevision: number;
  manifestHash: Uint8Array;
  previousManifestHash: Uint8Array | null;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  envelopes: readonly Readonly<{
    namespaceId: string;
    envelopeHash: Uint8Array;
    envelopeBytes: Uint8Array;
  }>[];
}>;

type DurableState = {
  object: StoredObject | null;
  access: StoredAccess | null;
};

type AgentAuthorityRows = Readonly<{
  grant: DatabaseRow;
  namespace: DatabaseRow;
  domain: DatabaseRow & Readonly<{ participants: string[] }>;
  runtime: AgentRuntimeAtomicStorageWireV2;
  signer: DatabaseRow;
}>;

function cloneBytes(value: Uint8Array): Uint8Array {
  return value.slice();
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function cloneState(state: DurableState): DurableState {
  return {
    object: state.object === null
      ? null
      : {
        ...state.object,
        payloadHash: cloneBytes(state.object.payloadHash),
        payloadBytes: cloneBytes(state.object.payloadBytes),
      },
    access: state.access === null
      ? null
      : {
        ...state.access,
        manifestHash: cloneBytes(state.access.manifestHash),
        previousManifestHash:
          state.access.previousManifestHash?.slice() ?? null,
        payloadHash: cloneBytes(state.access.payloadHash),
        manifestBytes: cloneBytes(state.access.manifestBytes),
        envelopes: state.access.envelopes.map((envelope) => ({
          ...envelope,
          envelopeHash: cloneBytes(envelope.envelopeHash),
          envelopeBytes: cloneBytes(envelope.envelopeBytes),
        })),
      },
  };
}

class AgentCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = { object: null, access: null };
  readonly statements: string[] = [];
  loseNextCommitResponse = false;
  signerAvailable = true;

  constructor(readonly authority: AgentAuthorityRows) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as unknown as Row[]);
    }
    throw new Error("Queries must run through the transaction executor");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const manifestDraft: {
      row: Omit<StoredAccess, "envelopes"> | null;
      envelopes: StoredAccess["envelopes"];
    } = { row: null, envelopes: [] };
    const transaction: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [{
            object_id: working.object.objectId,
            payload_hash: cloneBytes(working.object.payloadHash),
            payload_bytes: cloneBytes(working.object.payloadBytes),
          }]) as unknown as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          working.object = {
            objectId: parameters[0] as string,
            payloadHash: cloneBytes(parameters[1] as Uint8Array),
            payloadBytes: cloneBytes(parameters[2] as Uint8Array),
          };
          return [];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          return (working.access === null ? [] : [{
            object_id: working.access.objectId,
            access_revision: working.access.accessRevision,
            manifest_hash: cloneBytes(working.access.manifestHash),
            previous_manifest_hash:
              working.access.previousManifestHash?.slice() ?? null,
            payload_hash: cloneBytes(working.access.payloadHash),
            manifest_bytes: cloneBytes(working.access.manifestBytes),
          }]) as unknown as Row[];
        }
        if (normalized.includes(
          "from object_crypto_namespace_envelopes",
        )) {
          return (working.access?.envelopes ?? []).map((envelope) => ({
            namespace_id: envelope.namespaceId,
            envelope_hash: cloneBytes(envelope.envelopeHash),
            envelope_bytes: cloneBytes(envelope.envelopeBytes),
          })) as unknown as Row[];
        }
        if (normalized.includes("from crypto_grants")) {
          return [this.authority.grant] as Row[];
        }
        if (normalized.includes("from namespace_crypto_heads")) {
          return [this.authority.namespace] as Row[];
        }
        if (normalized.includes("from crypto_domains")) {
          return [this.authority.domain] as unknown as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_states")) {
          const state = this.authority.runtime;
          return [{
            agent_id: state.runtime.agentId,
            authorization_revision: state.runtime.authorizationRevision,
            runtime_generation: state.runtime.runtimeGeneration,
            config_object_count: state.configInventory.objectCount,
            config_inventory_digest:
              cloneBytes(state.configInventory.digest),
          }] as unknown as Row[];
        }
        if (normalized.includes(
          "from agent_crypto_runtime_config_objects",
        )) {
          return this.authority.runtime.configObjects.map((record) => ({
            agent_id: record.agentId,
            object_id: record.objectId,
            config_revision: record.configRevision,
            runtime_generation: record.runtimeGeneration,
            wrapped_dek_hash: cloneBytes(record.wrappedDekHash),
            wrapped_dek_bytes: cloneBytes(record.wrappedDekBytes),
          })) as unknown as Row[];
        }
        if (normalized.includes(
          "from agent_crypto_runtime_domain_envelopes",
        )) {
          return this.authority.runtime.domainEnvelopes.map((record) => ({
            agent_id: record.agentId,
            domain_id: record.domainId,
            domain_epoch: record.domainEpoch,
            agent_authorization_revision:
              record.agentAuthorizationRevision,
            runtime_generation: record.runtimeGeneration,
            committer_device_id: record.committerDeviceId,
            envelope_hash: cloneBytes(record.envelopeHash),
            envelope_bytes: cloneBytes(record.envelopeBytes),
          })) as unknown as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_challenges")) {
          return this.authority.runtime.challengeConsumptions.map(
            (record) => ({
              challenge_hash: cloneBytes(record.challengeHash),
              consumed: record.consumed,
            }),
          ) as unknown as Row[];
        }
        if (
          normalized.includes("from agent_crypto_runtime_signers")
        ) {
          return (this.signerAvailable ? [this.authority.signer] : []) as Row[];
        }
        if (normalized.includes(
          "insert into object_crypto_access_manifests",
        )) {
          manifestDraft.row = {
            objectId: parameters[0] as string,
            accessRevision: parameters[1] as number,
            manifestHash: cloneBytes(parameters[2] as Uint8Array),
            previousManifestHash:
              (parameters[3] as Uint8Array | null)?.slice() ?? null,
            payloadHash: cloneBytes(parameters[4] as Uint8Array),
            manifestBytes: cloneBytes(parameters[5] as Uint8Array),
          };
          return [];
        }
        if (normalized.includes(
          "insert into object_crypto_namespace_envelopes",
        )) {
          manifestDraft.envelopes = [
            ...manifestDraft.envelopes,
            {
              namespaceId: parameters[2] as string,
              envelopeHash: cloneBytes(parameters[4] as Uint8Array),
              envelopeBytes: cloneBytes(parameters[5] as Uint8Array),
            },
          ];
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          if (manifestDraft.row === null) {
            throw new Error("access head inserted without manifest");
          }
          working.access = {
            ...manifestDraft.row,
            envelopes: manifestDraft.envelopes,
          };
          return [];
        }
        throw new Error(
          `Unexpected SQL in Agent conversation completion test: ${
            statement.trim()
          }`,
        );
      },
    };
    const result = await callback(transaction);
    this.state = working;
    if (this.loseNextCommitResponse) {
      this.loseNextCommitResponse = false;
      throw new Error("commit response lost (injected)");
    }
    return result;
  }
}

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

async function fixture() {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x237_91) },
    { now: () => 1_800_000_000_000 },
  );
  const namespaceValue = namespaceId("namespace-agent-conversation");
  const domainValue = cryptoDomainId("domain-agent-conversation");
  const agentValue = agentId("agent-conversation-writer");
  const managerHuman = humanId("human-conversation-manager");
  const manager = crypto.generateSigningKeyPair();
  const committer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domainRoot = new Uint8Array(32).fill(0x91);
  const keyrings = createInitialNamespaceKeyrings(crypto, namespaceValue);
  const namespaceMetadata = {
    domainId: domainValue,
    domainEpoch: domainEpoch(2),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("device-domain-committer"),
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot,
    keyring: keyrings.human,
    metadata: namespaceMetadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot,
    keyring: keyrings.ai,
    metadata: namespaceMetadata,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: committer.privateKey,
    resolveCurrentCommitter: () => committer.publicKey,
  });
  const bindingHash = namespaceBindingHash(binding);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-agent-conversation-runtime",
    agentId: agentValue,
    authorizationRevision: authorizationRevision(8),
    configObjects: [{
      objectId: objectId("config-agent-conversation"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x92),
    }],
    domains: [{
      domainId: domainValue,
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(8),
      committerDeviceId: cryptoDeviceId("device-domain-committer"),
      domainRoot,
      committerSigningPrivateKey: committer.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () => committer.publicKey,
    manager: {
      managerHumanId: managerHuman,
      managerAuthorizationRevision: authorizationRevision(4),
      managerDeviceId: cryptoDeviceId("device-conversation-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const grant = await mintGrant(crypto, {
    id: grantId("grant-agent-conversation"),
    issuingDeviceId: cryptoDeviceId("device-conversation-manager"),
    issuingHumanId: managerHuman,
    issuingDeviceSigningPrivateKey: manager.privateKey,
    recipientAgentId: agentValue,
    recipientKeyId: "recipient-agent-conversation",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [managerHuman],
    operations: ["encrypt"],
    issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_060_000,
    coveredDomains: [{
      domainId: domainValue,
      domainEpoch: domainEpoch(2),
      agentAuthorizationRevision: authorizationRevision(8),
      aiRoot: domainRoot,
    }],
    singleUse: false,
  });
  const grantBytes = serializeGrantV2(grant);
  const runtimeWire =
    storageAdapterSupportV2.validateAgentRuntimeAtomicState(
      initialized.intended,
    );
  const publication = initialized.signerPublication;
  const publicationBytes =
    encodeAgentRuntimeSignerPublicationV1(publication);
  const authorityRows: AgentAuthorityRows = {
    grant: {
      grant_id: grant.id,
      grant_bytes: grantBytes,
      consumed: false,
    },
    namespace: {
      namespace_id: binding.namespaceId,
      access_revision: binding.accessRevision,
      binding_hash: bindingHash,
      domain_id: binding.domainId,
      domain_epoch: binding.domainEpoch,
      revision: binding.accessRevision,
      previous_binding_hash: binding.previousBindingHash,
      signed_binding_bytes: serializeNamespaceBindingV2(binding),
      human_keyring_envelope_bytes:
        serializeNamespaceKeyringEnvelopeV2(humanEnvelope),
      ai_keyring_envelope_bytes:
        serializeNamespaceKeyringEnvelopeV2(aiEnvelope),
    },
    domain: {
      id: domainValue,
      participant_digest: participantDigest([managerHuman]),
      participants: [managerHuman],
      epoch: 2,
      authorization_revision: 8,
      roster_bytes: new Uint8Array([1, 2, 3]),
    },
    runtime: runtimeWire,
    signer: {
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: publicationBytes,
    },
  };
  const connection = new AgentCryptoConnection(authorityRows);
  const handle = await verifyCryptoPostgresHandle(connection);
  let currentAuthority = true;
  let historyMode: "exact" | "missing" | "substituted" = "exact";
  const resolveHistoricalAgentSignerAuthority:
    ResolveHistoricalAgentRuntimeSignerManagerAuthority =
      (context) => {
        if (historyMode === "missing") return null;
        return {
          ...context,
          managerSigningPublicKey: historyMode === "exact"
            ? manager.publicKey.slice()
            : committer.publicKey.slice(),
        };
      };
  const resolveCurrentAuthorization = (
    context: Parameters<
      Parameters<typeof prepareAgentConversationCryptoRevision>[0][
        "resolveCurrentAuthorization"
      ]
    >[0],
  ) =>
    currentAuthority
      ? {
        context,
        grantAuthorized: true,
        namespaceAuthorized: true,
        domainAuthorized: true,
        agentAuthorized: true,
        hostAllowsOperation: true,
        currentRuntime: {
          agentId: agentValue,
          authorizationRevision: authorizationRevision(8),
          runtimeGeneration: initialized.runtime.generation,
        },
        signerPublication: publication,
        currentManagerSigningPublicKey: manager.publicKey,
      }
      : null;
  const revision = prepareAgentConversationCryptoRevision({
    crypto,
    objectId: "conversation-message-agent-durable",
    payload: {
      role: "assistant",
      content: "durable Agent response",
      toolCalls: [{
        id: "call-durable",
        name: "search",
        args: { query: "encrypted" },
      }],
    },
    createdAt: 1_800_000_000_000,
    namespace: {
      namespaceId: namespaceValue,
      accessRevision: binding.accessRevision,
      bindingHash,
      domainId: domainValue,
      domainEpoch: 2,
      keyGeneration: keyrings.ai.currentGeneration,
      aiKey: keyrings.ai.generations[0]!.key,
    },
    grant: {
      grantId: grant.id,
      grantHash: crypto.hash(grantBytes),
      useStatus: "reusable",
    },
    runtime: initialized.runtime,
    signerPublication: publication,
    resolveCurrentAuthorization,
  });
  const adapter = createPostgresConversationCryptoCompletion({
    handle,
    crypto,
    resolveCurrentWriteAuthorization: () => null,
    resolveHistoricalSigner: () => null,
    resolveHistoricalAgentSignerAuthority,
  });
  return {
    crypto,
    connection,
    adapter,
    revision,
    setCurrentAuthority(value: boolean) {
      currentAuthority = value;
    },
    setHistoryMode(value: typeof historyMode) {
      historyMode = value;
    },
  };
}

describe("Postgres Agent conversation crypto completion", () => {
  test("atomically creates v3 object access and replays it through retained signer history", async () => {
    const state = await fixture();

    expect(await state.adapter.complete(state.revision)).toBe("created");
    state.setCurrentAuthority(false);
    expect(await state.adapter.complete(state.revision)).toBe("duplicate");
    expect(await state.adapter.verify(state.revision.objectId)).toMatchObject({
      objectId: state.revision.objectId,
      namespaceId: "namespace-agent-conversation",
      keyClass: "ai",
    });
    expect(state.connection.statements.every((statement) =>
      !/session_messages|session_message_crypto_revisions|rooms|sessions/
        .test(statement)
    )).toBe(true);
  });

  test("does not finish a payload-only old-generation write after current authority is gone", async () => {
    const state = await fixture();
    const snapshot =
      readPreparedConversationCryptoRevisionSnapshot(state.revision);
    if (snapshot.kind !== "agent-v3") throw new Error("expected Agent revision");
    const payloadBytes = snapshot.value.object.payloadBytes.ciphertext;
    state.connection.state = {
      object: {
        objectId: snapshot.value.objectId,
        payloadHash: sha256(payloadBytes),
        payloadBytes: payloadBytes.slice(),
      },
      access: null,
    };
    state.setCurrentAuthority(false);

    expect(state.adapter.complete(state.revision)).rejects.toBeInstanceOf(
      ConversationCryptoCompletionConflictError,
    );
    expect(state.connection.state.object).not.toBeNull();
    expect(state.connection.state.access).toBeNull();
  });

  test("rejects an Agent Namespace envelope substituted beneath a valid signed manifest", async () => {
    const state = await fixture();
    expect(await state.adapter.complete(state.revision)).toBe("created");
    const access = state.connection.state.access;
    if (access === null) throw new Error("expected durable Agent access");
    const originalEnvelope = access.envelopes[0]!;
    const substitutedBytes = originalEnvelope.envelopeBytes.slice();
    substitutedBytes[substitutedBytes.length - 1] =
      substitutedBytes[substitutedBytes.length - 1]! ^ 0xff;
    state.connection.state = {
      ...state.connection.state,
      access: {
        ...access,
        envelopes: [{
          ...originalEnvelope,
          envelopeBytes: substitutedBytes,
        }],
      },
    };

    expect(state.adapter.verify(state.revision.objectId)).rejects.toThrow();
  });

  test("fails closed for missing or substituted history and survives a lost commit response", async () => {
    const state = await fixture();
    state.connection.loseNextCommitResponse = true;

    expect(state.adapter.complete(state.revision)).rejects.toThrow(
      "commit response lost",
    );
    state.setCurrentAuthority(false);
    expect(await state.adapter.complete(state.revision)).toBe("duplicate");

    state.setHistoryMode("missing");
    expect(state.adapter.verify(state.revision.objectId)).rejects
      .toBeInstanceOf(AgentRuntimeSignerHistoryInvalidError);
    state.setHistoryMode("substituted");
    expect(state.adapter.verify(state.revision.objectId)).rejects
      .toBeInstanceOf(AgentRuntimeSignerHistoryInvalidError);
    state.setHistoryMode("exact");
    state.connection.signerAvailable = false;
    expect(state.adapter.verify(state.revision.objectId)).rejects
      .toBeInstanceOf(AgentRuntimeSignerHistoryInvalidError);
  });
});
