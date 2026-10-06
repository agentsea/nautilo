import { describe, expect, spyOn, test } from "bun:test";
import type { PostgresJsBridgeConnection, PostgresJsBridgeRow, PostgresJsBridgeScalar } from "@nautilo/db";
import {
  LatticeCrypto, accessRevision, agentId, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  assertAuthenticPreparedTaskRuntimeResultObject, decryptObjectThroughNamespace,
  domainNamespaceRetainedAuthoritySetDigest, humanId, namespaceGeneration, namespaceId,
  prepareAgentRuntimeInitialization, prepareDomainNamespaceBundle, prepareNativeTaskRuntimeResultObject,
  type DomainForegroundSecretEntry, type PrepareNativeTaskRuntimeResultObjectInput,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2, DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
  decodeEncryptedPayloadV2, decodeNamespaceObjectEnvelopeV2, encodeAgentRuntimeSignerPublicationV1,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { deriveTaskContentCryptoObjectIdV1, fingerprintTaskContentAuthorityIdentityV1, fingerprintTaskContentAuthorityV1, TASK_RUN_RESULT_OBJECT_TYPE_V1 } from "../../src/task/task-content-repository.ts";
import { readPreparedTaskContentCryptoRevisionSnapshotV1 } from "../../src/task/task-content-prepared-revision.ts";
import { decodeTaskRunResultPayloadV1, encodeTaskRunResultPayloadV1 } from "../../src/task/task-payload-v1.ts";
import { taskRuntimePreparedResultDigestV1 } from "../../src/task/task-run-result-preparation.ts";
import {
  prepareNativeTaskRuntimeRunResult, type PrepareNativeTaskRuntimeRunResultInput,
} from "../../src/server/task/native-task-run-result-preparation.ts";

import { createPostgresTaskContentCryptoCompletion } from "../../src/server/task/postgres-task-content-crypto-completion.ts";
import { verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor } from "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow, DatabaseScalar } from "../../src/server/storage/postgres-record-codecs.ts";

const NOW = 1_920_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000711";
const RUN = "20000000-0000-4000-8000-000000000711";
const HUMAN = "30000000-0000-4000-8000-000000000711";
const NAMESPACE = "40000000-0000-4000-8000-000000000711";
const DOMAIN = "50000000-0000-4000-8000-000000000711";
const AGENT = "60000000-0000-4000-8000-000000000711";
const DEVICE = "task-native-result-device";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
type Adjust = (stage: string, rows: readonly PostgresJsBridgeRow[]) => readonly PostgresJsBridgeRow[];

async function fixture(adjust: Adjust = (_stage, rows) => rows) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKey = bytes(0x42);
  const retained = [{ generation: namespaceGeneration(0), accessRevision: accessRevision(0), headDigest: bytes(0x43), generationKey }];
  const retainedDigest = domainNamespaceRetainedAuthoritySetDigest(crypto, retained);
  const domainRequirement = { domainId: DOMAIN, sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x61), participantCount: 1, keyClass: "ai" as const,
    domainKeyGeneration: 4, authorizationRevision: authorizationRevision(9), headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63), activeNamespaceBindingCount: 1 };
  const domain: DomainForegroundSecretEntry = { ...domainRequirement, domainKey };
  const current = { serverId: SERVER, cryptoDomainId: cryptoDomainId(DOMAIN), participantDigest: domain.participantDigest,
    participantCount: 1, keyClass: "ai" as const, domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9), domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NAMESPACE), namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0), bundleRevision: 1, retainedAuthoritySetDigest: retainedDigest };
  const native = prepareDomainNamespaceBundle(crypto, {
    operationId: "native-task-result-binding", previousBindingDigest: null,
    bundle: { ...current, formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
      purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2, retainedGenerationCount: 1, retainedGenerations: retained },
    issuerHumanId: humanId(HUMAN), issuerDeviceId: cryptoDeviceId(DEVICE), issuerDeviceSigningGeneration: 1,
    issuerSigningPrivateKey: issuer.privateKey, issuerSigningPublicKey: issuer.publicKey, domainKey, issuedAt: NOW,
  });
  const initialized = await prepareAgentRuntimeInitialization({ crypto, operationId: "native-result-initialization", agentId: agentId(AGENT),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "task-native-agent-config", configRevision: authorizationRevision(1), plaintextDek: bytes(0x21) }],
    domains: [], resolveCurrentDomainCommitterAuthority: () => null,
    manager: { managerHumanId: humanId(HUMAN), managerAuthorizationRevision: authorizationRevision(2), managerDeviceId: cryptoDeviceId(DEVICE) },
    managerSigningPrivateKey: manager.privateKey, resolveCurrentManagerAuthority: () => manager.publicKey });
  const coordinate = { kind: "run_result" as const, taskId: TASK, taskRunId: RUN, contentRevision: 1 as const };
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: "native-result-request", workId: RUN, claimId: "native-result-claim", claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000, expiresAt: NOW + 60_000, recipientGeneration: 1,
    recipientKeyId: "native-result-recipient", authorizationDigest: bytes(0x51), policyRevision: 3,
    episodeId: "native-result-episode", sourceRoomId: "native-result-room", hostAuthorizationRevision: 5, recipientAuthorizationRevision: 6,
    result: { taskId: TASK, taskRunId: RUN, contentRevision: 1, objectId: deriveTaskContentCryptoObjectIdV1(coordinate), signerAgentId: AGENT,
      namespace: { namespaceId: NAMESPACE, domainId: DOMAIN, operations: ["encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 } },
    domainRequirements: [domainRequirement], namespaceRequirements: [{ ordinal: 0, namespaceId: NAMESPACE,
      domainId: DOMAIN, operations: ["decrypt", "encrypt"], expectedAccessRevision: 0, expectedPolicyRevision: 3 }],
  };
  const stages: string[] = [];
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let stage: string; let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        stage = "role"; rows = [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }];
      } else if (statement.includes('from "namespace_domain_key_heads"') && statement.includes('inner join')) {
        stage = "native-binding"; rows = [{ binding_bytes: native.bytes, binding_digest: native.bindingDigest, signing_public_key: issuer.publicKey }];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace"; rows = [{ namespace_id: NAMESPACE, namespace_access_revision: 0, namespace_current_generation: 0,
          domain_id: DOMAIN, domain_key_generation: 4, domain_authorization_revision: 9, domain_head_digest: domain.headDigest,
          bundle_revision: 1, retained_generation_count: 1, retained_authority_set_digest: retainedDigest, binding_digest: native.bindingDigest }];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain"; rows = [{ domain_id: DOMAIN, domain_key_generation: "4", authorization_revision: "9",
          head_digest: domain.headDigest, participant_digest: domain.participantDigest, participant_count: "1" }];
      } else throw new Error(`Unexpected native result query: ${statement}`);
      stages.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async (use) => use(restricted), transactionOnce: async (use) => use(restricted),
  };
  const base = { restricted, crypto, serverScope: SERVER, domains: [domain], signal: new AbortController().signal,
    payload: { formatVersion: 1 as const, resultText: "Native protected result", lastError: null },
    authority: { authorityVersion: 1 as const, kind: "requester_private_namespace" as const, keyClass: "ai" as const,
      requesterHumanId: HUMAN, namespaceId: NAMESPACE, domainId: DOMAIN, expectedAccessRevision: 0, expectedPolicyRevision: 3 },
    createdAt: NOW, agentAuthorizationRevision: 7, runtime: initialized.runtime,
    signerPublication: initialized.signerPublication, resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    assertCurrentTaskAuthority: () => { stages.push("product"); return Promise.resolve(); } };
  const prepare = (overrides: Partial<PrepareNativeTaskRuntimeRunResultInput> = {}) => withTaskRuntimeExecutionEvidenceV1({
    evidence: evidenceInput, signal: base.signal, now: () => NOW,
    execute: (evidence) => prepareNativeTaskRuntimeRunResult({ ...base, evidence, ...overrides }),
  });
  const nativeSource: PrepareNativeTaskRuntimeResultObjectInput["namespace"] = {
    current, bindingBytes: native.bytes, expectedBindingDigest: native.bindingDigest,
    issuerSigningPublicKey: issuer.publicKey, domainKey,
  };
  return { crypto, coordinate, generationKey, base, evidenceInput, nativeSource, prepare, stages };
}

function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(
    ([key, value]) => [key, value instanceof Uint8Array ? value.slice() : value],
  ))) as DatabaseRow;
}

type DurableState = {
  object: DatabaseRow | null;
  manifests: Map<number, DatabaseRow>;
  envelopes: DatabaseRow[];
  head: DatabaseRow | null;
};

function cloneState(state: DurableState): DurableState {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    manifests: new Map([...state.manifests].map(
      ([revision, row]) => [revision, cloneRow(row)],
    )),
    envelopes: state.envelopes.map(cloneRow),
    head: state.head === null ? null : cloneRow(state.head),
  };
}

class NativeResultCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = {
    object: null,
    manifests: new Map(),
    envelopes: [],
    head: null,
  };

  constructor(readonly signer: DatabaseRow | null) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as unknown as Row[]);
    }
    throw new Error("Task crypto queries must use the transaction executor");
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
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (normalized.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          if (working.head === null) return [];
          const revision = working.head["access_revision"] as number;
          const manifest = working.manifests.get(revision);
          if (manifest === undefined) return [];
          return [{ ...cloneRow(working.head), ...cloneRow(manifest) }] as Row[];
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
        if (normalized.includes("from object_crypto_access_manifests")) {
          const revision = parameters[1] as number;
          const manifest = working.manifests.get(revision);
          return (manifest === undefined ? [] : [cloneRow(manifest)]) as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          const revision = parameters[1] as number;
          return working.envelopes.filter(
            (row) => row["access_revision"] === revision,
          ).map(cloneRow) as Row[];
        }
        if (normalized.includes("from agent_crypto_runtime_signers")) {
          return (this.signer === null ? [] : [cloneRow(this.signer)]) as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          working.object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_manifests")) {
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
        if (normalized.includes("insert into object_crypto_namespace_envelopes")) {
          working.envelopes.push({
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            namespace_id: parameters[2] as string,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        throw new Error(`Unexpected Task crypto SQL: ${statement.trim()}`);
      },
    };
    const result = await callback(transaction);
    this.state = working;
    return result;
  }
}

function change(stage: string, field: string, value: PostgresJsBridgeScalar): Adjust {
  return (current, rows) => current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}
async function fails(operation: Promise<unknown>): Promise<void> {
  expect(await operation.then(() => null, (error: unknown) => error)).toBeInstanceOf(Error);
}

describe("native Task Runtime result preparation", () => {
  test("seals an authentic compatible result revision and decrypts with the native generation", async () => {
    const value = await fixture();
    const revision = await value.prepare();
    const snapshot = readPreparedTaskContentCryptoRevisionSnapshotV1(revision);
    expect(revision.coordinate).toEqual(value.coordinate);
    expect(taskRuntimePreparedResultDigestV1(revision)).toEqual(value.crypto.hash(snapshot.access.manifestBytes));
    expect(snapshot.access.manifest.signer.kind).toBe("agent_runtime");
    const payload = decodeEncryptedPayloadV2(snapshot.object.payloadBytes.ciphertext);
    const envelope = decodeNamespaceObjectEnvelopeV2(snapshot.access.envelopeBytes[0]);
    const plaintext = decryptObjectThroughNamespace(value.crypto, value.generationKey, envelope, payload);
    expect(plaintext).not.toBeNull();
    try { expect(decodeTaskRunResultPayloadV1(plaintext!)).toEqual(value.base.payload); }
    finally { plaintext?.fill(0); }
    expect(value.stages[0]).toBe("product");
    expect(value.stages.filter((stage) => stage === "product")).toHaveLength(2);
    expect(value.stages.filter((stage) => stage === "domain")).toHaveLength(2);
  });

  test("production completion persists and verifies the native branded result", async () => {
    const value = await fixture();
    const publication = value.base.signerPublication;
    const connection = new NativeResultCryptoConnection({
      agent_id: publication.agentId, runtime_generation: publication.runtimeGeneration,
      authorization_revision: publication.authorizationRevision, transition_kind: publication.transitionKind,
      operation_id: publication.operationId, signer_key_id: publication.signerKeyId,
      signer_public_key: publication.signerPublicKey,
      publication_bytes: encodeAgentRuntimeSignerPublicationV1(publication),
    });
    const adapter = createPostgresTaskContentCryptoCompletion({
      handle: await verifyCryptoPostgresHandle(connection), crypto: value.crypto,
      resolveCurrentAuthority: () => Promise.resolve(value.base.authority),
      resolveHistoricalHumanDeviceSigningPublicKey: () => Promise.resolve(null),
      resolveHistoricalAgentSignerAuthority: (context) => ({ ...context,
        managerSigningPublicKey: value.base.resolveHistoricalSignerPublicationManager().slice() }),
    });
    const revision = await value.prepare();
    expect(await adapter.complete(revision)).toBe("created");
    expect(await adapter.complete(revision)).toBe("duplicate");
    expect(await adapter.verify({ coordinate: value.coordinate,
      objectId: revision.objectId, objectType: revision.objectType, expectedAccessRevision: 0,
      expectedAuthorityFingerprint: fingerprintTaskContentAuthorityV1(value.base.authority),
      expectedAuthorityIdentityFingerprint: fingerprintTaskContentAuthorityIdentityV1(value.base.authority),
    })).toMatchObject({ coordinate: value.coordinate, objectId: revision.objectId,
      objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1, namespaceId: NAMESPACE });
  });

  test("native crypto mint preserves its private preparation brand and detects mutation", async () => {
    const value = await fixture();
    const plaintext = encodeTaskRunResultPayloadV1(value.base.payload);
    try {
      await withTaskRuntimeExecutionEvidenceV1({ evidence: value.evidenceInput, signal: value.base.signal, now: () => NOW,
        execute: async (evidence) => {
          const prepared = await prepareNativeTaskRuntimeResultObject(value.crypto, { ...value.base, evidence,
            plaintext, objectType: TASK_RUN_RESULT_OBJECT_TYPE_V1, namespace: value.nativeSource });
          expect(prepared.access.authority.namespace.bindingHash).toEqual(value.nativeSource.expectedBindingDigest);
          expect(prepared.access.authority.namespace.bindingHash).not.toEqual(value.nativeSource.current.retainedAuthoritySetDigest);
          expect(() => assertAuthenticPreparedTaskRuntimeResultObject(prepared)).not.toThrow();
          expect(() => assertAuthenticPreparedTaskRuntimeResultObject({ ...prepared })).toThrow();
          prepared.access.manifestBytes[0] = prepared.access.manifestBytes[0]! ^ 1;
          expect(() => assertAuthenticPreparedTaskRuntimeResultObject(prepared)).toThrow();
        } });
    } finally { plaintext.fill(0); }
  });

  test("wipes plaintext copies and opened native bundle buffers", async () => {
    const value = await fixture(); const captured: Uint8Array[] = [];
    const originalSeal = value.crypto.aeadSeal.bind(value.crypto);
    const originalOpen = value.crypto.aeadOpen.bind(value.crypto);
    const seal = spyOn(value.crypto, "aeadSeal").mockImplementation((...args) => { captured.push(args[1]); return originalSeal(...args); });
    const open = spyOn(value.crypto, "aeadOpen").mockImplementation((...args) => {
      const result = originalOpen(...args); if (result !== null) captured.push(result); return result;
    });
    try {
      await value.prepare();
      expect(captured.length).toBeGreaterThan(0);
      for (const bytes of captured) expect(bytes.every((byte) => byte === 0)).toBe(true);
    } finally { seal.mockRestore(); open.mockRestore(); }
  });

  for (const [stage, field, replacement] of [
    ["namespace", "namespace_access_revision", 1], ["namespace", "domain_key_generation", 5],
    ["domain", "authorization_revision", 10], ["domain", "domain_key_generation", 5],
    ["domain", "participant_digest", bytes(7)], ["native-binding", "binding_digest", bytes(8)],
    ["native-binding", "signing_public_key", bytes(9)],
  ] as const) {
    test(`rejects substituted ${stage}.${field}`, async () => {
      const value = await fixture(change(stage, field, replacement)); await fails(value.prepare());
    });
  }

  test("rejects current Domain revocation after encryption even with an unchanged Namespace", async () => {
    let reads = 0;
    const value = await fixture((stage, rows) => stage === "domain" && ++reads === 2
      ? rows.map((row) => ({ ...row, authorization_revision: 10 })) : rows);
    await fails(value.prepare());
    expect(reads).toBe(2);
  });

  test("rejects product revocation and Namespace drift after encryption", async () => {
    let reads = 0;
    const value = await fixture((stage, rows) => stage === "namespace" && ++reads === 2
      ? rows.map((row) => ({ ...row, binding_digest: bytes(8) })) : rows);
    await fails(value.prepare());
    const second = await fixture(); let productChecks = 0;
    await fails(second.prepare({ assertCurrentTaskAuthority: () => ++productChecks === 2
      ? Promise.reject(new Error("Task revoked")) : Promise.resolve() }));
  });

  test("rejects substituted output, signer, Domain key and unsupported payload", async () => {
    const value = await fixture();
    await fails(value.prepare({ authority: { ...value.base.authority, namespaceId: TASK } }));
    await fails(value.prepare({ resolveHistoricalSignerPublicationManager: () => null }));
    await fails(value.prepare({ domains: [{ ...value.base.domains[0]!, domainKey: bytes(9) }] }));
    await fails(value.prepare({ payload: { ...value.base.payload, formatVersion: 2 } as unknown as PrepareNativeTaskRuntimeRunResultInput["payload"] }));
    await fails(value.prepare({ serverScope: "https://other.example" }));
    const swapped = { ...value.evidenceInput, result: { ...value.evidenceInput.result, objectId: "substituted" } };
    await fails(withTaskRuntimeExecutionEvidenceV1({ evidence: swapped, signal: value.base.signal, now: () => NOW,
      execute: (evidence) => prepareNativeTaskRuntimeRunResult({ ...value.base, evidence }) }));
  });
});
