import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  coordinateGrantAuthoritySetUse,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  grantWriteRecord,
  humanId,
  InMemoryLatticeStore,
  mintGrant,
  namespaceId,
  preflightGrantAuthoritySetUse,
  prepareAgentRuntimeInitialization,
  type GrantAuthoritySetAuthorization,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeAgentRuntimeSignerPublicationV1,
  serializeGrantV2,
} from "@nautilo/lattice-crypto/wire";

import {
  prepareAgentMemoryCryptoRevision,
} from "../../src/memory/agent-memory-crypto.ts";
import {
  fingerprintRequiredMemoryNamespaces,
  type MemoryCryptoRevisionReference,
} from "../../src/memory/memory-repository.ts";
import {
  AgentRuntimeSignerHistoryInvalidError,
} from "../../src/server/storage/agent-runtime-signer-history.ts";
import {
  MemoryCryptoCompletionConflictError,
  createPostgresAgentMemoryExactAccessCryptoCompletion,
  createPostgresMemoryCryptoCompletion,
} from "../../src/server/memory/postgres-memory-crypto-completion.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const NOW = 1_810_000_000_000;
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NAMESPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seededRng(seed: number): Rng {
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

type StoredState = {
  object: DatabaseRow | null;
  manifests: Map<number, DatabaseRow>;
  envelopes: DatabaseRow[];
  head: DatabaseRow | null;
};

function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? value.slice() : value,
  ]))) as DatabaseRow;
}

function cloneState(state: StoredState): StoredState {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    manifests: new Map([...state.manifests].map(([key, row]) => [key, cloneRow(row)])),
    envelopes: state.envelopes.map(cloneRow),
    head: state.head === null ? null : cloneRow(state.head),
  };
}

type AuthorityState = {
  grant: DatabaseRow | null;
  namespaces: DatabaseRow[];
  domains: DatabaseRow[];
  runtime: DatabaseRow | null;
  signer: DatabaseRow | null;
};

class MemoryCryptoConnection implements CryptoPostgresConnection {
  state: StoredState = {
    object: null,
    manifests: new Map(),
    envelopes: [],
    head: null,
  };
  loseNextCommitResponse = false;
  readonly statements: string[] = [];

  constructor(readonly authority: AuthorityState) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    if (statement.includes("current_user::text")) {
      const row: DatabaseRow = {
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      };
      return Promise.resolve([row] as Row[]);
    }
    throw new Error("Memory crypto queries must use the transaction executor");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const transaction: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = statement.toLowerCase();
        if (normalized.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes('from "crypto_objects"')) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes('from "object_crypto_access_heads"')) {
          return (working.head === null ? [] : [cloneRow(working.head)]) as Row[];
        }
        if (
          normalized.includes("from object_crypto_access_manifests")
          && normalized.includes("access_revision >=")
        ) {
          const minimum = parameters[1] as number;
          const maximum = parameters[2] as number;
          return [...working.manifests]
            .filter(([revision]) => revision >= minimum && revision <= maximum)
            .sort(([left], [right]) => left - right)
            .map(([, row]) => cloneRow(row)) as Row[];
        }
        if (
          normalized.includes("from")
          && normalized.includes("object_crypto_access_manifests")
        ) {
          const revision = parameters[1] as number;
          const row = working.manifests.get(revision);
          return (row === undefined ? [] : [cloneRow(row)]) as Row[];
        }
        if (
          normalized.includes("from")
          && normalized.includes("object_crypto_namespace_envelopes")
        ) {
          const revision = parameters[1] as number;
          return working.envelopes.filter((row) =>
            row["access_revision"] === revision
          ).map(cloneRow) as Row[];
        }
        if (normalized.includes("agent_crypto_runtime_signers")) {
          return (this.authority.signer === null
            ? []
            : [cloneRow(this.authority.signer)]) as Row[];
        }
        if (normalized.includes("crypto_grants")) {
          return (this.authority.grant === null
            ? []
            : [cloneRow(this.authority.grant)]) as Row[];
        }
        if (normalized.includes("namespace_crypto_heads")) {
          return this.authority.namespaces.map(cloneRow) as Row[];
        }
        if (normalized.includes("from crypto_domains")) {
          return this.authority.domains.map(cloneRow) as Row[];
        }
        if (normalized.includes("agent_crypto_runtime_states")) {
          return (this.authority.runtime === null
            ? []
            : [cloneRow(this.authority.runtime)]) as Row[];
        }
        if (normalized.includes('insert into "crypto_objects"')) {
          working.object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.includes('insert into "object_crypto_access_manifests"')) {
          const revision = parameters[1] as number;
          working.manifests.set(revision, {
            object_id: parameters[0] as string,
            access_revision: revision,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
            previous_manifest_hash: parameters[3] === null
              ? null
              : (parameters[3] as Uint8Array).slice(),
            payload_hash: (parameters[4] as Uint8Array).slice(),
            manifest_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes('insert into "object_crypto_namespace_envelopes"')) {
          working.envelopes.push({
            access_revision: parameters[1] as number,
            namespace_id: parameters[2] as string,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes('insert into "object_crypto_access_heads"')) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.includes('update "object_crypto_access_heads"')) {
          if (
            working.head !== null
            && working.head["object_id"] === parameters[2]
            && working.head["access_revision"] === parameters[3]
            && (working.head["manifest_hash"] as Uint8Array).every(
              (byte, index) => byte === (parameters[4] as Uint8Array)[index],
            )
          ) {
            working.head = {
              object_id: parameters[2] as string,
              access_revision: parameters[0] as number,
              manifest_hash: (parameters[1] as Uint8Array).slice(),
            };
            const row: DatabaseRow = {
              object_id: parameters[2] as string,
            };
            return [row] as Row[];
          }
          return [];
        }
        throw new Error(`Unexpected Memory crypto SQL: ${statement.trim()}`);
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

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x243_53), { now: () => NOW });
  const issuer = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const agentValue = agentId("memory-agent");
  const runtimeAuthorizationRevision = authorizationRevision(17);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "memory-agent-runtime-initialization",
    agentId: agentValue,
    authorizationRevision: runtimeAuthorizationRevision,
    configObjects: [{
      objectId: "memory-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x31),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("alice"),
      managerAuthorizationRevision: authorizationRevision(8),
      managerDeviceId: cryptoDeviceId("alice-device"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const domains = [
    {
      domainId: cryptoDomainId("domain-a"),
      domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(11),
      aiRoot: new Uint8Array(32).fill(0x41),
    },
    {
      domainId: cryptoDomainId("domain-b"),
      domainEpoch: domainEpoch(6),
      agentAuthorizationRevision: authorizationRevision(13),
      aiRoot: new Uint8Array(32).fill(0x42),
    },
  ] as const;
  const grant = await mintGrant(crypto, {
    id: grantId("memory-reusable-grant"),
    issuingDeviceId: cryptoDeviceId("alice-device"),
    issuingHumanId: humanId("alice"),
    issuingDeviceSigningPrivateKey: issuer.privateKey,
    recipientAgentId: agentValue,
    recipientKeyId: "memory-recipient",
    recipientEncryptionPublicKey: recipient.publicKey,
    scope: [humanId("alice")],
    operations: ["encrypt"],
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    coveredDomains: domains,
    singleUse: false,
  });
  const namespaceRequirements = [
    {
      namespaceId: namespaceId(NAMESPACE_A),
      domainId: domains[0].domainId,
      operations: ["encrypt"] as const,
      namespaceParticipants: [humanId("alice")],
      expectedAccessRevision: accessRevision(2),
      expectedPolicyRevision: authorizationRevision(21),
    },
    {
      namespaceId: namespaceId(NAMESPACE_B),
      domainId: domains[1].domainId,
      operations: ["encrypt"] as const,
      namespaceParticipants: [humanId("alice")],
      expectedAccessRevision: accessRevision(5),
      expectedPolicyRevision: authorizationRevision(22),
    },
  ];
  const authorization: GrantAuthoritySetAuthorization = {
    now: NOW + 1,
    expectedIssuingDeviceId: grant.issuingDeviceId,
    issuingDeviceHumanId: humanId("alice"),
    issuingDeviceSigningPublicKey: issuer.publicKey,
    issuingDeviceActive: true,
    recipientAgentId: agentValue,
    recipientKeyId: grant.recipientKeyId,
    recipientEncryptionPrivateKey: recipient.privateKey,
    singleUseAvailable: true,
    grantScope: grant.scope,
    namespaceRequirements,
    domainRequirements: domains.map((entry) => ({
      domainId: entry.domainId,
      expectedEpoch: entry.domainEpoch,
      expectedAgentAuthorizationRevision: entry.agentAuthorizationRevision,
    })),
    hostAllowsOperation: true,
  };
  const grantBytes = serializeGrantV2(grant);
  const store = new InMemoryLatticeStore();
  await store.putGrant(grantWriteRecord(grantBytes));
  const preflight = await preflightGrantAuthoritySetUse(
    crypto,
    grant,
    authorization,
  );
  if (preflight === null) throw new Error("expected Memory Grant preflight");
  const bindingHashes = [
    new Uint8Array(32).fill(0x81),
    new Uint8Array(32).fill(0x82),
  ];
  const coordinated = await coordinateGrantAuthoritySetUse({
    preflight,
    storage: store,
    resolveCurrentAuthorization: (context) => ({
      context,
      currentTime: context.preflightTime,
      issuingDeviceActive: true,
      recipientAgentAuthorized: true,
      requestedNamespacesAuthorized: true,
      requestedDomainsAuthorized: true,
      hostAllowsOperation: true,
      currentSingleUseStatus: context.singleUseStatus,
    }),
    execute: (_opened, evidence) => prepareAgentMemoryCryptoRevision({
      crypto,
      memoryId: MEMORY_ID,
      contentRevision: 3,
      payload: {
        formatVersion: 1,
        content: "private Memory content",
        type: "preference",
      },
      createdAt: NOW,
      namespaceSet: {
        recipientAgentId: agentValue,
        runtimeAuthorizationRevision,
        namespaces: namespaceRequirements.map((requirement, index) => ({
          namespaceId: requirement.namespaceId,
          domainId: requirement.domainId,
          domainEpoch: domains[index]!.domainEpoch,
          accessRevision: requirement.expectedAccessRevision,
          policyRevision: requirement.expectedPolicyRevision,
          domainAgentAuthorizationRevision:
            domains[index]!.agentAuthorizationRevision,
          bindingHash: bindingHashes[index]!,
          currentGeneration: index + 2,
          generations: [{
            generation: index + 2,
            key: new Uint8Array(32).fill(0x71 + index),
          }],
        })),
      },
      authoritySet: evidence,
      runtime: initialized.runtime,
      signerPublication: initialized.signerPublication,
    }),
  });
  if (coordinated.status !== "executed") throw new Error("expected preparation");
  const publication = initialized.signerPublication;
  const authority: AuthorityState = {
    grant: {
      grant_id: grant.id,
      grant_bytes: grantBytes,
      consumed: false,
    },
    namespaces: namespaceRequirements.map((requirement, index) => ({
      namespace_id: requirement.namespaceId,
      access_revision: requirement.expectedAccessRevision,
      binding_hash: bindingHashes[index]!,
      domain_id: requirement.domainId,
      domain_epoch: domains[index]!.domainEpoch,
      writes_paused: false,
    })),
    domains: domains.map((domain) => ({
      id: domain.domainId,
      epoch: domain.domainEpoch,
    })),
    runtime: {
      agent_id: agentValue,
      authorization_revision: runtimeAuthorizationRevision,
      runtime_generation: initialized.runtime.generation,
    },
    signer: {
      agent_id: publication.agentId,
      runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision,
      transition_kind: publication.transitionKind,
      operation_id: publication.operationId,
      signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    },
  };
  const connection = new MemoryCryptoConnection(authority);
  const handle = await verifyCryptoPostgresHandle(connection);
  let historyAvailable = true;
  const adapter = createPostgresMemoryCryptoCompletion({
    handle,
    crypto,
    resolveHistoricalAgentSignerAuthority: (context) =>
      historyAvailable
        ? { ...context, managerSigningPublicKey: manager.publicKey.slice() }
        : null,
  });
  const prepared = coordinated.value;
  const reference: MemoryCryptoRevisionReference = {
    memoryId: prepared.memoryId,
    contentRevision: prepared.contentRevision,
    objectId: prepared.objectId,
    expectedAccessRevision: 0,
    expectedActiveNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces(prepared.requiredNamespaceIds),
  };
  return {
    adapter,
    authority,
    connection,
    crypto,
    handle,
    managerSigningPublicKey: manager.publicKey,
    prepared,
    reference,
    setHistoryAvailable(value: boolean) {
      historyAvailable = value;
    },
  };
}

describe("Postgres Memory crypto completion", () => {
  test("atomically retains exact common-v5 current manifest and multi-envelopes", async () => {
    const state = await fixture();

    expect(await state.adapter.complete(state.prepared)).toBe("created");
    expect(state.connection.state.envelopes).toHaveLength(2);
    expect(state.connection.state.manifests.has(0)).toBe(true);
    expect(state.connection.state.manifests.has(1)).toBe(false);
    expect(state.connection.state.head?.["access_revision"]).toBe(0);
    const verified = await state.adapter.verify(state.reference);
    expect(verified).toMatchObject({
      memoryId: MEMORY_ID,
      contentRevision: 3,
      objectId: state.prepared.objectId,
      objectType: "nautilo-memory-v1",
      payloadVersion: 1,
      requiredNamespaceIds: [NAMESPACE_A, NAMESPACE_B],
    });
    expect(verified?.accessSignerEvidence?.map(({ kind }) => kind))
      .toEqual(["agent_runtime_publication"]);
    const readable = await state.adapter.read(state.reference);
    expect(readable).not.toBeNull();
    expect(readable?.memoryId).toBe(MEMORY_ID);
    expect(readable?.contentRevision).toBe(3);
    expect(readable?.accessRevision).toBe(0);
    expect(readable?.accessSignerEvidence?.map(({ kind }) => kind))
      .toEqual(["agent_runtime_publication"]);
    const storedManifest = state.connection.state.manifests
      .get(0)?.["manifest_bytes"];
    const storedManifestHash = state.connection.state.head?.["manifest_hash"];
    expect(storedManifest).toBeInstanceOf(Uint8Array);
    expect(storedManifestHash).toBeInstanceOf(Uint8Array);
    expect(readable?.accessManifestBytes).toEqual(storedManifest as Uint8Array);
    expect(readable?.accessManifestHash).toEqual(
      storedManifestHash as Uint8Array,
    );
    expect(readable?.requiredNamespaceIds).toEqual([NAMESPACE_A, NAMESPACE_B]);
    expect(readable?.namespaceEnvelopes.map((entry) => entry.namespaceId))
      .toEqual([NAMESPACE_A, NAMESPACE_B]);
    const storedPayload = state.connection.state.object?.["payload_bytes"];
    expect(storedPayload).toBeInstanceOf(Uint8Array);
    if (!(storedPayload instanceof Uint8Array)) throw new Error("unreachable");
    expect(readable?.payloadBytes).toEqual(storedPayload);

    state.authority.grant = null;
    state.authority.namespaces = [];
    state.authority.domains = [];
    state.authority.runtime = null;
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    expect(await state.adapter.verify(state.reference)).not.toBeNull();
    expect(await state.adapter.read(state.reference)).not.toBeNull();
  });

  test("exposes only an authenticated content-free head for restart reconciliation", async () => {
    const state = await fixture();
    await state.adapter.complete(state.prepared);
    const exact = createPostgresAgentMemoryExactAccessCryptoCompletion({
      handle: state.handle,
      crypto: state.crypto,
      resolveHistoricalAgentSignerAuthority: (context) => ({
        ...context,
        managerSigningPublicKey: state.managerSigningPublicKey.slice(),
      }),
      resolveHistoricalNamespaceCommitter: () => null,
      resolvePolicyRevision: () => Promise.resolve(null),
    });

    const observed = await exact.observe(state.prepared.objectId);
    expect(observed).toMatchObject({
      status: "active",
      objectId: state.prepared.objectId,
      accessRevision: 0,
      namespaceIds: [NAMESPACE_A, NAMESPACE_B],
    });
    if (observed.status !== "active") throw new Error("expected active head");
    const storedHash = state.connection.state.head?.["manifest_hash"];
    expect(storedHash).toBeInstanceOf(Uint8Array);
    if (!(storedHash instanceof Uint8Array)) throw new Error("missing head hash");
    expect(observed.manifestHash).toEqual(storedHash);
    observed.manifestHash.fill(0xff);
    expect(await exact.observe(state.prepared.objectId)).toMatchObject({
      status: "active",
      accessRevision: 0,
      namespaceIds: [NAMESPACE_A, NAMESPACE_B],
    });
  });

  test("rejects stale, partial, and extra current Namespace authority before insertion", async () => {
    const stale = await fixture();
    stale.authority.namespaces[0] = {
      ...stale.authority.namespaces[0]!,
      binding_hash: new Uint8Array(32).fill(0xff),
    };
    expect(stale.adapter.complete(stale.prepared)).rejects.toBeInstanceOf(
      MemoryCryptoCompletionConflictError,
    );
    expect(stale.connection.state.object).toBeNull();

    const partial = await fixture();
    partial.authority.namespaces.pop();
    expect(partial.adapter.complete(partial.prepared)).rejects.toBeInstanceOf(
      MemoryCryptoCompletionConflictError,
    );

    const extra = await fixture();
    extra.authority.namespaces.push({
      ...extra.authority.namespaces[0]!,
      namespace_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(extra.adapter.complete(extra.prepared)).rejects.toBeInstanceOf(
      MemoryCryptoCompletionConflictError,
    );
  });

  test("fails closed for partial or substituted durable exact-set bytes", async () => {
    const state = await fixture();
    await state.adapter.complete(state.prepared);
    state.connection.state.envelopes.pop();
    expect(state.adapter.verify(state.reference)).rejects.toBeInstanceOf(
      MemoryCryptoCompletionConflictError,
    );

  });

  test("survives lost commit response and requires retained historical signer authority", async () => {
    const state = await fixture();
    state.connection.loseNextCommitResponse = true;

    expect(state.adapter.complete(state.prepared)).rejects.toThrow(
      "commit response lost",
    );
    expect(await state.adapter.complete(state.prepared)).toBe("duplicate");
    state.setHistoryAvailable(false);
    expect(state.adapter.verify(state.reference)).rejects.toBeInstanceOf(
      AgentRuntimeSignerHistoryInvalidError,
    );
  });

  test("rejects a mismatched restart reference without disclosing content", async () => {
    const state = await fixture();
    await state.adapter.complete(state.prepared);
    const wrong = {
      ...state.reference,
      expectedActiveNamespaceFingerprint: new Uint8Array(32).fill(0xff),
    };
    expect(await state.adapter.verify(wrong)).toBeNull();
  });
});
