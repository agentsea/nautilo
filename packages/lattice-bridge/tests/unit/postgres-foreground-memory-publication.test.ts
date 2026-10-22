import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { LatticeCrypto, agentId, agentRuntimeGeneration, authorizationRevision, deriveAgentRuntimeObjectSignerPublic,
  type AgentRuntimeKeyGeneration } from "@nautilo/lattice-crypto";
import { createForegroundAgentObjectRepairer } from "../../src/object/foreground-agent-object-repair.ts";
import { decodeMemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";
import { prepareDeviceWrappedAgentObject } from "../../src/object/device-wrapped-agent-object-crypto.ts";
import { encodeMemoryPayloadV1, type MemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";
import { commitMemoryMutationV1 } from "../../src/memory/memory-mutation-commitment.ts";
import { deriveMemoryCryptoObjectIdV1, fingerprintRequiredMemoryNamespaces, MEMORY_OBJECT_TYPE } from "../../src/memory/memory-repository.ts";
import { PostgresAgentMemoryProductPort, readVerifiedForegroundMemoryPublicationReservation, type VerifiedForegroundMemoryPublicationReservation } from "../../src/server/memory/postgres-agent-memory-product-port.ts";
import { verifyConversationProductPostgresHandle, bindConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresConnection } from "../../src/server/message/postgres-conversation-product-store.ts";
import { createPostgresForegroundMemoryPublication } from "../../src/server/memory/postgres-foreground-memory-publication.ts";
import { verifyCryptoPostgresHandle, type CryptoPostgresConnection, type CryptoPostgresExecutor } from "../../src/server/storage/postgres-lattice-storage.ts";
import type { DatabaseRow, DatabaseScalar } from "../../src/server/storage/postgres-record-codecs.ts";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
const USER = "10000000-0000-4000-8000-000000000001";
const AGENT = "10000000-0000-4000-8000-000000000002";
const MEMORY = "10000000-0000-4000-8000-000000000003";
const NS = "10000000-0000-4000-8000-000000000004";
const NOW = 1_800_000_000_000;
const payload = Object.freeze({ formatVersion: 1 as const, type: "fact", content: "sealed projection" });
const authority = Object.freeze({ mode: "namespace" as const, subjectUserId: USER, agentId: AGENT,
  readableNamespaceIds: [NS], mutableNamespaceIds: [NS], writableNamespaceId: NS });
const requestDigest = sha256(new TextEncoder().encode(JSON.stringify({ version: 1,
  operationId: "projection.1", mutationKind: "save", subjectUserId: USER, agentId: AGENT,
  logicalWritableNamespaceId: NS, importance: 0.8,
  mutationCommitment: [...commitMemoryMutationV1({ kind: "save", payload })] })));
const plan = Object.freeze({ operationId: "projection.1", action: "created" as const,
  mutationKind: "save" as const, memoryId: MEMORY, contentRevision: 1, cryptoAccessRevision: 0,
  expectedPriorAccessRevision: 0, cryptoObjectId: deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY, contentRevision: 1 }),
  requiredNamespaceIds: [NS], reservationDigest: requestDigest,
  mutationCommitment: commitMemoryMutationV1({ kind: "save", payload }), importance: 0.8, createdAt: NOW });
async function reservation(overrides: Record<string, unknown> = {}, source: MemoryPayloadV1 = payload,
  mutate?: (input: { plan: typeof plan; authority: typeof authority }) => void) {
  const mutablePlan = structuredClone(plan);
  const mutableAuthority = structuredClone(authority);
  const rows = [
    [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
    [{ current_user_id: USER, current_agent_id: AGENT }],
    [{ operation_id: plan.operationId, memory_id: MEMORY, anchor_namespace_id: NS,
      operation_type: "update", expected_content_revision: 0, result_content_revision: 1,
      expected_access_revision: 0, request_digest: requestDigest, completion: "pending",
      foreground_stable_request_digest: requestDigest, foreground_mutation_kind: "save",
      foreground_required_namespace_ids: [NS], foreground_save_similarity: null,
      ordinary_fallback_reason: null, created_at: new Date(NOW).toISOString(), ...overrides }],
    [{ crypto_object_id: plan.cryptoObjectId, allocation_request_digest: requestDigest,
      required_namespace_fingerprint: fingerprintRequiredMemoryNamespaces([NS]),
      completion: "pending", disposition: "active" }],
  ];
  const connection: ConversationProductPostgresConnection = {
    query: async <Row>() => (rows.shift() ?? []) as Row[],
    transaction: use => use(connection),
  };
  const handle = await verifyConversationProductPostgresHandle(connection);
  const runner = bindConversationProductCanonicalTransactionRunner(handle, {
    transaction: use => use({ execute: async () => [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }] } as unknown as CanonicalTranscriptTx, connection),
  });
  const port = new PostgresAgentMemoryProductPort({ handle, canonicalRunner: runner,
    readableNamespaceIds: [NS], publication: { representation: "protected_only", beforeLocks: async () => { mutate?.({ plan: mutablePlan, authority: mutableAuthority }); } },
    cryptoCompletion: { complete: async () => "created" } });
  return port.inspectFreshProjectionReservation({ authority: mutableAuthority, plan: mutablePlan, payload: source });
}
type State = { object: DatabaseRow | null; head: DatabaseRow | null;
  manifest: DatabaseRow | null; envelopes: DatabaseRow[]; receipt: DatabaseRow | null };
class CryptoConnection implements CryptoPostgresConnection {
  state: State = { object: null, head: null, manifest: null, envelopes: [], receipt: null };
  failReceipt = false;
  queries: string[] = [];
  namespace = { domain_id: "domain", domain_key_generation: 1, domain_authorization_revision: 1,
    domain_head_digest: new Uint8Array(32).fill(2), namespace_current_generation: 1,
    namespace_access_revision: 2, retained_authority_set_digest: new Uint8Array(32).fill(3), state: "active" };
  async query<Row extends DatabaseRow>(statement: string): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) return [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }] as unknown as Row[];
    throw new Error("query must be transactional");
  }
  async transaction<Result>(use: (executor: CryptoPostgresExecutor) => Promise<Result>): Promise<Result> {
    const state = structuredClone(this.state);
    const executor: CryptoPostgresExecutor = { query: async <Row extends DatabaseRow>(query: string, p: readonly DatabaseScalar[] = []) => {
      this.queries.push(query);
      const sql = query.toLowerCase().replaceAll('"', '');
      let rows: DatabaseRow[];
      if (sql.includes("pg_advisory_xact_lock")) rows = [];
      else if (sql.startsWith("select") && sql.includes("foreground_memory_crypto_publication_receipts")) rows = state.receipt === null ? [] : [state.receipt];
      else if (sql.startsWith("select") && sql.includes("namespace_domain_key_heads")) rows = [this.namespace];
      else if (sql.startsWith("select") && sql.includes("from crypto_objects")) rows = state.object === null ? [] : [state.object];
      else if (sql.startsWith("select") && sql.includes("object_crypto_access_heads")) rows = state.head === null ? [] : [{ ...state.manifest, ...state.head }];
      else if (sql.startsWith("select") && sql.includes("object_crypto_access_manifests")) rows = state.manifest === null ? [] : [state.manifest];
      else if (sql.startsWith("select") && sql.includes("object_crypto_namespace_envelopes")) rows = state.envelopes;
      else if (sql.startsWith("insert into crypto_objects")) {
        state.object = { object_id: p[0]!, payload_hash: p[1]!, payload_bytes: p[2]! }; rows = [];
      } else if (sql.startsWith("insert into object_crypto_access_manifests")) {
        state.manifest = { object_id: p[0]!, access_revision: p[1]!, manifest_hash: p[2]!,
          previous_manifest_hash: p[3]!, payload_hash: p[4]!, manifest_bytes: p[5]! }; rows = [];
      } else if (sql.startsWith("insert into object_crypto_namespace_envelopes")) {
        state.envelopes.push({ object_id: p[0]!, access_revision: p[1]!, namespace_id: p[2]!,
          ordinal: p[3]!, envelope_hash: p[4]!, envelope_bytes: p[5]! }); rows = [];
      } else if (sql.startsWith("insert into object_crypto_access_heads")) {
        state.head = { object_id: p[0]!, access_revision: p[1]!, manifest_hash: p[2]! }; rows = [];
      } else if (sql.startsWith("insert into foreground_memory_crypto_publication_receipts")) {
        if (this.failReceipt) throw new Error("receipt insert failed");
        state.receipt = { operation_id: p[0]!, crypto_object_id: p[1]!, memory_id: p[2]!, content_revision: p[3]!,
          agent_id: p[4]!, reservation_digest: p[5]!, required_namespace_fingerprint: p[6]!, genesis_manifest_hash: p[7]! }; rows = [];
      } else throw new Error(`Unexpected SQL: ${query}`);
      return structuredClone(rows) as Row[];
    } };
    const result = await use(executor);
    this.state = structuredClone(state);
    return result;
  }
}
async function fixture() {
  const crypto = new LatticeCrypto();
  const runtime = { agentId: agentId(AGENT), keyClass: "runtime" as const,
    generation: agentRuntimeGeneration(1), key: new Uint8Array(32).fill(1) } as AgentRuntimeKeyGeneration;
  const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
  const connection = new CryptoConnection();
  const handle = await verifyCryptoPostgresHandle(connection);
  const proof = await reservation();
  if (proof === null) throw new Error("reservation unavailable");
  const owner = () => createPostgresForegroundMemoryPublication({ handle, crypto,
    resolveCurrentAuthorization: async context => ({ context, grantAuthorized: true,
      namespacesAuthorized: true, agentAuthorized: true, hostAllowsOperation: true,
      currentRuntime: { agentId: agentId(context.agentId), authorizationRevision: authorizationRevision(context.agentAuthorizationRevision), runtimeGeneration: agentRuntimeGeneration(context.runtimeGeneration) }, signerPublicKey: signer.publicKey }),
    resolveHistoricalAgentSignerAuthority: async () => null,
    resolveLiveShadowAgentSigner: principal => principal.agentId === AGENT
      && principal.runtimeGeneration === 1 && principal.signerKeyId === signer.principal.signerKeyId ? Uint8Array.from(signer.publicKey) : null,
  });
  const source = { objectId: plan.cryptoObjectId, objectType: MEMORY_OBJECT_TYPE,
    existingObjectId: null, expectedAccessRevision: 0, createdAt: NOW, namespaceIds: [NS],
    plaintextBytes: encodeMemoryPayloadV1(payload) } as const;
  const namespace = { namespaceId: NS, accessRevision: 2, keyGeneration: 1,
    domainId: "domain", domainKeyGeneration: 1, domainAuthorizationRevision: 1,
    domainHeadDigest: new Uint8Array(32).fill(2), headDigest: new Uint8Array(32).fill(3),
    publicationDigest: new Uint8Array(32).fill(3), publicationSetDigest: new Uint8Array(32).fill(3),
    audienceFingerprint: new Uint8Array(32).fill(3), key: new Uint8Array(32).fill(4) };
  const namespaces = [{ namespaceId: NS, namespaceAccessRevision: 2, namespaceKeyGeneration: 1,
    domainId: "domain", domainKeyGeneration: 1, domainAuthorizationRevision: 1,
    domainHeadDigest: namespace.domainHeadDigest, namespaceHeadDigest: namespace.headDigest,
    namespacePublicationDigest: namespace.publicationDigest, namespacePublicationSetDigest: namespace.publicationSetDigest,
    namespaceAudienceFingerprint: namespace.audienceFingerprint }];
  const prepare = (plaintextBytes = source.plaintextBytes) => prepareDeviceWrappedAgentObject({ crypto, ...source, plaintextBytes, namespaceSet: [namespace],
    operationId: "wake-operation", grant: { grantId: "wake-grant", grantHash: new Uint8Array(32).fill(9), recipientKeyId: "recipient" },
    runtime, signerKeyId: signer.principal.signerKeyId, signerPublicKey: signer.publicKey, agentAuthorizationRevision: 1 });
  const prepared = prepare();
  const operations: string[][] = [];
  const repairer = (grantId: string) => createForegroundAgentObjectRepairer({ crypto,
    entities: { signal: new AbortController().signal,
      use: async () => { throw new Error("encrypt-only destination must never decrypt"); },
      useCurrentSet: async request => {
        operations.push([...request.operations]);
        return { status: "executed" as const, value: await request.execute([
          { authority: namespaces[0]!, namespaceKey: namespace.key },
        ]) };
      } },
    publication: { operationId: "wake-operation", grantId, grantDigest: new Uint8Array(32).fill(9),
      recipientKeyId: "recipient", runtime, signerKeyId: signer.principal.signerKeyId,
      signerPublicKey: signer.publicKey, agentAuthorizationRevision: 1 },
    freshPublication: owner().forReservation(proof),
    persist: async () => { throw new Error("receipt persistence must be used"); },
    read: async () => owner().forReservation(proof).recover({ source, namespaces }),
  });
  return { connection, proof, owner, source, namespaces, prepared, operations, repairer, prepare };
}

describe("fresh foreground Memory publication receipt", () => {
  test("recovers an exact independently committed ciphertext after product rollback and a fresh owner", async () => {
    const f = await fixture();
    expect(await f.owner().forReservation(f.proof).recover({ source: f.source, namespaces: f.namespaces })).toBeNull();
    expect(await f.owner().forReservation(f.proof).persist(f.prepared, f.source)).toBe("created");
    const bytes = structuredClone(f.connection.state);
    const freshProof = await reservation();
    if (freshProof === null) throw new Error("fresh reservation failed");
    const recovered = await f.owner().forReservation(freshProof).recover({ source: f.source, namespaces: f.namespaces });
    expect(recovered?.objectId).toBe(plan.cryptoObjectId);
    expect(f.connection.state).toEqual(bytes);
    expect(await f.owner().forReservation(f.proof).persist(f.prepared, f.source)).toBe("duplicate");
  });
  test("publishes and resumes after fresh grant without destination decrypt or a second encryption", async () => {
    const f = await fixture();
    expect(await f.repairer("first-grant").publishFresh({ source: f.source, decode: decodeMemoryPayloadV1 }))
      .toMatchObject({ status: "verified", value: payload, provenance: "repaired" });
    const stored = structuredClone(f.connection.state);
    expect(await f.repairer("fresh-grant").publishFresh({ source: f.source, decode: decodeMemoryPayloadV1 }))
      .toMatchObject({ status: "verified", value: payload, provenance: "existing" });
    expect(f.connection.state).toEqual(stored);
    expect(f.operations).toEqual([["encrypt"], ["encrypt"]]);
    expect(decodeMemoryPayloadV1(f.source.plaintextBytes)).toEqual(payload);
    expect(f.connection.queries.filter(query => query.toLowerCase().startsWith('insert into "crypto_objects"'))).toHaveLength(1);
  });

  test("snapshots the genuine reservation before caller mutation during current authority validation", async () => {
    const proof = await reservation({}, payload, input => {
      Object.assign(input.plan, { operationId: "substituted", memoryId: USER, cryptoObjectId: "other" });
      input.plan.requiredNamespaceIds[0] = USER;
      input.plan.reservationDigest.fill(0);
      Object.assign(input.authority, { agentId: USER });
      input.authority.mutableNamespaceIds[0] = USER;
    });
    expect(proof).not.toBeNull();
    expect(readVerifiedForegroundMemoryPublicationReservation(proof!)).toMatchObject({
      operationId: plan.operationId, memoryId: MEMORY, cryptoObjectId: plan.cryptoObjectId,
      agentId: AGENT, namespaceIds: [NS], reservationDigest: requestDigest,
    });
  });

  test("rolls back object and receipt together", async () => {
    const f = await fixture(); f.connection.failReceipt = true;
    expect(f.owner().forReservation(f.proof).persist(f.prepared, f.source)).rejects.toThrow("receipt insert failed");
    expect(f.connection.state).toEqual({ object: null, head: null, manifest: null, envelopes: [], receipt: null });
  });
  test("refuses a bare object instead of adopting or reencrypting", async () => {
    const f = await fixture();
    await f.owner().forReservation(f.proof).persist(f.prepared, f.source);
    f.connection.state.receipt = null;
    expect(f.owner().forReservation(f.proof).recover({ source: f.source, namespaces: f.namespaces })).rejects.toThrow("receipt conflicts");
  });
  test("does not mint provenance for changed payload or completed operation", async () => {
    expect(await reservation({}, { ...payload, content: "changed" })).toBeNull();
    expect(await reservation({ completion: "complete" })).toBeNull();
    const f = await fixture();
    expect(() => f.owner().forReservation({} as VerifiedForegroundMemoryPublicationReservation)).toThrow("not authentic");
    expect(f.owner().forReservation(f.proof).persist(f.prepared, { ...f.source,
      plaintextBytes: encodeMemoryPayloadV1({ ...payload, content: "forged" }) })).rejects.toThrow("receipt conflicts");
  });
  for (const field of ["genesis_manifest_hash", "reservation_digest", "agent_id", "crypto_object_id"] as const) {
    test(`rejects substituted receipt ${field}`, async () => {
      const f = await fixture(); await f.owner().forReservation(f.proof).persist(f.prepared, f.source);
      f.connection.state.receipt = { ...f.connection.state.receipt!, [field]: field.endsWith("_id") ? "other" : new Uint8Array(32) };
      expect(f.owner().forReservation(f.proof).recover({ source: f.source, namespaces: f.namespaces })).rejects.toThrow();
    });
  }
  test("rejects genuine preparation of different bytes and revoked current write authority", async () => {
    const f = await fixture();
    const substituted = f.prepare(encodeMemoryPayloadV1({ ...payload, content: "different prepared plaintext" }));
    expect(f.owner().forReservation(f.proof).persist(substituted, f.source)).rejects.toThrow("plaintext changed");
    expect(f.connection.state.object).toBeNull();
    f.connection.namespace.state = "revoked";
    expect(f.owner().forReservation(f.proof).persist(f.prepared, f.source)).rejects.toThrow("authority changed");
    expect(f.connection.state.object).toBeNull();
    expect(f.connection.state.receipt).toBeNull();
  });
  test("rejects changed current wrapper without borrowing a decrypt key", async () => {
    const f = await fixture(); await f.owner().forReservation(f.proof).persist(f.prepared, f.source);
    expect(f.owner().forReservation(f.proof).recover({ source: f.source,
      namespaces: [{ ...f.namespaces[0]!, namespaceAccessRevision: 3 }] })).rejects.toThrow("receipt conflicts");
  });
});
