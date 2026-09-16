import {fingerprintRequiredMemoryNamespaces} from "../../src/memory/memory-repository.ts";
import {describe, expect, test} from "bun:test";
import type {DirectDatabase, PostgresJsBridgeConnection, PostgresJsBridgeRow, PostgresJsBridgeScalar} from "@nautilo/db";
import {LatticeCrypto} from "@nautilo/lattice-crypto";
import {REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2, REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2,
  type BackgroundReflectionSemanticWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {CROSS_ROOM_EXECUTION_PLAN_LIMITS} from "@nautilo/reflection-bridge/server";
import {readPostgresReflectionSemanticSourcePlan, validatePostgresReflectionSemanticPlan, withPostgresReflectionSemanticSourcePlan,
  type ReflectionSemanticPlanCoordinates, type ReflectionSemanticSourcePlan} from "../../src/server/reflection/postgres-semantic-plan.ts";

const digest = (value: number) => new Uint8Array(32).fill(value);
const coordinates: ReflectionSemanticPlanCoordinates = {recordRef: "record-1", claimGeneration: 4,
  inputBindings: [{objectId: "object-1", namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1"}], outputNamespaceIds: ["namespace-2"]};
function harness() {
  const state = {lifecycle: "current", changeReason: "changed", generation: 4, completedGeneration: 3, workState: "claimed", stage: "organization", recordGeneration: 2,
    alternativeNamespace: "namespace-1", alternatives: 1, publicBoundary: false, blocked: false, headRevision: 0, headRevisionAsText: false, memoryAccessRevision: 0, messageAccessRevision: 0,
    missingBundle: false, memoryRevision: 1, memoryMappingCurrent: true, messageRevision: 0, messageHeadObject: "message-object", memoryAttachments: ["33000000-0000-4000-8000-000000000001"],
    rooms: [
      {id: "room-1", namespace_id: "namespace-1", human_actor_ids: ["alice", "bob"], kind: "access", archived_at: null},
      {id: "room-2", namespace_id: "namespace-2", human_actor_ids: ["alice", "bob"], kind: "access", archived_at: null},
      {id: "room-3", namespace_id: "namespace-leaf", human_actor_ids: ["alice", "bob"], kind: "access", archived_at: null},
      {id: "room-4", namespace_id: "33000000-0000-4000-8000-000000000001", human_actor_ids: ["alice", "bob"], kind: "access", archived_at: null},
      {id: "55000000-0000-4000-8000-000000000001", namespace_id: "44000000-0000-4000-8000-000000000001", human_actor_ids: ["alice", "bob"], kind: "private", archived_at: null},
    ],
  };
  const queries: string[] = [];
  let onRoomLock: (() => void) | undefined;
  const product: PostgresJsBridgeConnection = {
    async query<Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly PostgresJsBridgeScalar[] = []): Promise<readonly Row[]> {
      const sql = statement.replaceAll('"', "").replaceAll(/\s+/gu, " ").toLowerCase(); queries.push(sql);
      let rows: unknown[];
      if (sql.includes("from reflection_record_semantic_work")) rows = [{generation: state.generation, completed_generation: state.completedGeneration, state: state.workState, stage: state.stage, change_reason: state.changeReason}];
      else if (sql.includes("from reflection_record_payload_representations")) rows = [{record_id: String(parameters.find(value => typeof value === "string" && value.startsWith("object-"))).replace("object-", "record-"),
        processing_generation: state.recordGeneration, structural_height: 0, lifecycle: state.lifecycle, disposition: "available", representation_generation: 1,
        projection_generation: 1, source_change_generation: 1, processing_state: "current"}];
      else if (sql.includes("from reflection_record_authority_closure")) rows = [{terminal_leaf_handle: "namespace-leaf"}];
      else if (sql.includes("from reflection_record_authority_blocks")) rows = state.blocked ? [{block_id: "blocked"}] : [];
      else if (sql.includes("from reflection_record_authority_alternatives")) rows = Array.from({length: state.alternatives}, () => ({access_namespace_id: state.alternativeNamespace, includes_public_boundary: state.publicBoundary, alternative_commitment: digest(7)}));
      else if (sql.includes("from session_messages")) rows = [{id: 17, session_id: "66000000-0000-4000-8000-000000000001", edit_revision: state.messageRevision, role: "assistant",
        crypto_object_id: state.messageHeadObject, room_id: "55000000-0000-4000-8000-000000000001",
        namespace_id: "44000000-0000-4000-8000-000000000001", namespace_access_revision: 9,
        lifecycle_object_id: "message-object", namespace_id_at_allocation: "44000000-0000-4000-8000-000000000001",
        payload_version: 2, key_class: "ai", completion: "complete", disposition: "mapped"}];
      else if (sql.includes("from memories")) rows = [{id: "memory-1", content_revision: state.memoryRevision, crypto_mapping_state: "verified", crypto_access_revision: state.memoryAccessRevision, scope_origin_namespace_id: null, crypto_required_namespace_fingerprint: state.memoryMappingCurrent ? fingerprintRequiredMemoryNamespaces(state.memoryAttachments) : digest(9)}];
      else if (sql.includes("from memory_scopes")) rows = [];
      else if (sql.includes("from memory_namespaces")) rows = state.memoryAttachments.map(namespace_id => ({namespace_id}));
      else if (sql.includes("from rooms")) {if (sql.endsWith("for update")) onRoomLock?.(); rows = state.rooms.filter(room => parameters.includes(room.namespace_id));}
      else throw new Error(`Unexpected product SQL: ${sql}`);
      return structuredClone(rows) as readonly Row[];
    },
    transaction: use => use(product), transactionOnce: use => use(product),
  };
  const restricted: PostgresJsBridgeConnection = {
    async query<Row extends PostgresJsBridgeRow>(statement: string, parameters: readonly PostgresJsBridgeScalar[] = []): Promise<readonly Row[]> {
      const sql = statement.replaceAll('"', "").replaceAll(/\s+/gu, " ").toLowerCase(); queries.push(sql);
      if (sql.includes("from object_crypto_access_heads")) return [{manifest_hash: digest(3),
        access_revision: parameters.includes("message-object") ? state.messageAccessRevision : state.headRevisionAsText ? String(state.headRevision) : state.headRevision}] as unknown as readonly Row[];
      if (sql.includes("from namespace_domain_key_heads")) return (state.missingBundle ? [] : [{namespace_id: parameters[0], namespace_access_revision: 11, namespace_current_generation: 2,
        domain_id: `domain:${String(parameters[0])}`, domain_key_generation: 3, domain_authorization_revision: 4, domain_head_digest: digest(31), bundle_revision: 5,
        retained_generation_count: 3, retained_authority_set_digest: digest(32), binding_digest: digest(33)}]) as unknown as readonly Row[];
      throw new Error(`Unexpected restricted SQL: ${sql}`);
    }, transaction: use => use(restricted), transactionOnce: use => use(restricted),
  };
  return {state, product, restricted, crypto: new LatticeCrypto(), coordinates, queries, onRoomLock: (change: () => void) => {onRoomLock = change;}};
}
function descriptor(
  plan: ReflectionSemanticSourcePlan,
  selected: ReflectionSemanticPlanCoordinates = coordinates,
): BackgroundReflectionSemanticWorkDescriptorV2 {
  const operation = selected.workKind === "reflection.dependency_rewrite"
    ? {workKind: "reflection.dependency_rewrite" as const, purpose: "record.dependency_rewrite" as const}
    : {workKind: "reflection.organization" as const, purpose: "record.organize" as const};
  return {formatVersion: 2, requestId: "request-1", workId: "work-1", recipientGeneration: 0, anchorNamespaceId: "namespace-1", anchorDomainId: "domain:namespace-1",
    subject: {kind: "processor", processorKind: "reflection", processorVersion: 1}, ...operation, operations: ["decrypt", "encrypt"],
    source: {kind: "reflection_semantic", recordRef: selected.recordRef, claimGeneration: selected.claimGeneration, fingerprint: plan.fingerprint.slice()}, namespaceRequirements: plan.namespaceRooms.map(entry => ({authority: {
      serverId: "server-1", ...entry, namespaceAccessRevision: 11, namespaceKeyGeneration: 2, namespaceHeadDigest: digest(32), domainId: `domain:${entry.namespaceId}`,
      domainKeyGeneration: 3, domainAuthorizationRevision: 4, domainHeadDigest: digest(31), bundleRevision: 5, bundleDigest: digest(33),
    }, operations: selected.outputNamespaceIds.includes(entry.namespaceId) ? ["encrypt"] : ["decrypt"]})), policyRevision: 12, inputBindings: selected.inputBindings,
    outputSlots: [{objectId: "new-object", objectType: "nautilo.reflection.record.v1", createdAt: 1000, namespaceIds: selected.outputNamespaceIds}],
    maximumPlaintextBytes: 1024, maximumCiphertextBytes: 4096, recipientKeyId: "recipient-1", recipientPublicKey: new Uint8Array(65), issuedAt: 1000, notBefore: 1000, expiresAt: 2000, idempotencyId: "idempotency-1"};
}

describe("Reflection semantic metadata source plan", () => {
  test("preserves the existing candidate-plan input/output byte policy", () => {
    expect(REFLECTION_SEMANTIC_MAX_INPUT_PLAINTEXT_BYTES_V2).toBe(CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes);
    expect(REFLECTION_SEMANTIC_MAX_OUTPUT_PLAINTEXT_BYTES_V2).toBe(CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes);
  });
  test("survives waiting lease release but fences stage and source revision", async () => {
    const f = harness(); const first = await readPostgresReflectionSemanticSourcePlan(f); expect(first).not.toBeNull();
    f.state.workState = "pending";
    const waiting = await readPostgresReflectionSemanticSourcePlan(f); expect(waiting?.fingerprint).toEqual(first!.fingerprint);
    const d = descriptor(first!); expect(await validatePostgresReflectionSemanticPlan({...f, descriptor: d})).toBe(true);
    f.state.stage = "search_projection"; expect(await validatePostgresReflectionSemanticPlan({...f, descriptor: d})).toBe(false);
    f.state.stage = "organization"; f.state.recordGeneration += 1; expect(await validatePostgresReflectionSemanticPlan({...f, descriptor: d})).toBe(false);
    expect(f.queries.every(sql => !/payload_bytes|envelope_bytes|select .*\bcontent\b/u.test(sql))).toBe(true);
  });
  test("requires selected current projection alternative and consistent audience/public boundary", async () => {
    for (const mode of ["alternative", "multiple", "narrow", "public"] as const) {
      const f = harness();
      if (mode === "alternative") f.state.alternativeNamespace = "foreign";
      if (mode === "multiple") f.state.alternatives = 2;
      if (mode === "narrow") f.state.rooms[0]!.human_actor_ids = ["alice"];
      if (mode === "public") f.state.publicBoundary = true;
      expect(await readPostgresReflectionSemanticSourcePlan(f)).toBeNull();
    }
  });
  test("locks the complete Room union then rejects metadata changed during lock acquisition", async () => {
    const f = harness(); f.onRoomLock(() => {f.state.recordGeneration += 1;});
    expect(await readPostgresReflectionSemanticSourcePlan({...f, lock: true})).toBeNull();
    expect(f.queries.filter(sql => sql.includes("from reflection_record_semantic_work"))).toHaveLength(2);
    expect(f.queries.some(sql => sql.includes("from rooms") && sql.endsWith("for update"))).toBe(true);
  });
  test("supports exact dependency inventories beyond model candidate count and multiple exact output Namespaces", async () => {
    const f = harness();
    const inputBindings = Array.from({length: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputItems + 1}, (_, i) => ({objectId: `object-${i + 1}`, namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1" as const}));
    expect(await readPostgresReflectionSemanticSourcePlan({...f, coordinates: {...coordinates, inputBindings, outputNamespaceIds: ["namespace-1", "namespace-2"]}})).not.toBeNull();
  });

  test("binds an exact current Message only for dependency repair without selecting content", async () => {
    const f = harness();
    f.state.changeReason = "dependency_lost";
    const repair: ReflectionSemanticPlanCoordinates = {
      ...coordinates,
      workKind: "reflection.dependency_rewrite",
      inputBindings: [
        ...coordinates.inputBindings,
        {
          objectId: "message-object",
          namespaceId: "44000000-0000-4000-8000-000000000001",
          objectType: "nautilo-message-v2",
        },
      ],
    };
    const initial = await readPostgresReflectionSemanticSourcePlan({
      ...f,
      coordinates: repair,
    });
    expect(initial).not.toBeNull();
    expect(await validatePostgresReflectionSemanticPlan({
      ...f,
      descriptor: descriptor(initial!, repair),
    })).toBe(true);
    expect(f.queries.some(sql => sql.includes("from session_messages"))).toBe(true);
    expect(f.queries.every(sql => !/session_messages\.(?:content|tool_calls)|payload_bytes|envelope_bytes/u.test(sql))).toBe(true);

    f.state.messageAccessRevision = 1;
    expect(await validatePostgresReflectionSemanticPlan({
      ...f,
      descriptor: descriptor(initial!, repair),
    })).toBe(false);
    const rewrapped = await readPostgresReflectionSemanticSourcePlan({
      ...f,
      coordinates: repair,
    });
    expect(rewrapped).not.toBeNull();
    expect(rewrapped!.fingerprint).not.toEqual(initial!.fingerprint);
    f.state.messageAccessRevision = 0;

    f.state.messageRevision = 1;
    const edited = await readPostgresReflectionSemanticSourcePlan({
      ...f,
      coordinates: repair,
    });
    expect(edited).not.toBeNull();
    expect(edited!.fingerprint).not.toEqual(initial!.fingerprint);
    f.state.messageHeadObject = "different-message-object";
    expect(await readPostgresReflectionSemanticSourcePlan({
      ...f,
      coordinates: repair,
    })).toBeNull();

    f.state.messageHeadObject = "message-object";
    f.state.messageRevision = 0;
    expect(await readPostgresReflectionSemanticSourcePlan({
      ...f,
      coordinates: {...repair, workKind: "reflection.organization"},
    })).toBeNull();
  });

  test("accepts PostgreSQL bigint text for matching Memory access revision and rejects a different revision", async () => {
    const f = harness();
    f.state.headRevisionAsText = true;
    const selected = {...coordinates, inputBindings: [...coordinates.inputBindings, {objectId: "memory-object", namespaceId: "33000000-0000-4000-8000-000000000001", objectType: "nautilo-memory-v1" as const}]};
    expect(await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected})).not.toBeNull();
    f.state.memoryAccessRevision = 1;
    expect(await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected})).toBeNull();
  });
  test("all Memory attachments enter the fence while the selected alternative constrains disclosure", async () => {
    const f = harness(); const selected = {...coordinates, inputBindings: [...coordinates.inputBindings, {objectId: "memory-object", namespaceId: "33000000-0000-4000-8000-000000000001", objectType: "nautilo-memory-v1" as const}]};
    const first = await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected}); expect(first).not.toBeNull();
    f.state.memoryAttachments.push("33000000-0000-4000-8000-000000000002");
    const next = await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected}); expect(next).not.toBeNull(); expect(next!.fingerprint).not.toEqual(first!.fingerprint);
    f.state.memoryMappingCurrent = false;
    expect(await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected})).toBeNull();
    f.state.memoryMappingCurrent = true;
    f.state.memoryAttachments = ["33000000-0000-4000-8000-000000000002"];
    expect(await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected})).toBeNull();
  });
  test("rejects oversized Memory attachment authority instead of trusting a truncated fingerprint", async () => {
    const f = harness();
    f.state.memoryAttachments = Array.from({length: 258}, (_, i) => `33000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    f.state.memoryMappingCurrent = false;
    const selected = {...coordinates, inputBindings: [...coordinates.inputBindings, {objectId: "memory-object", namespaceId: f.state.memoryAttachments[0]!, objectType: "nautilo-memory-v1" as const}]};
    expect(await readPostgresReflectionSemanticSourcePlan({...f, coordinates: selected})).toBeNull();
    expect(f.queries.filter(sql => sql.includes("from memory_namespaces")).every(sql => !sql.includes("limit"))).toBe(true);
  });
  test.each([false, true])("preparation shares policy/Room fences and wakes missing keys after release missing=%s", async missing => {
    const f = harness(); f.state.missingBundle = missing;
    let transactionOpen = false; let woke = false; const events: string[] = [];
    const transactionClient = Object.assign(() => undefined, {unsafe: (sql: string, params: readonly PostgresJsBridgeScalar[] = []) => f.product.query(sql, params), savepoint: async () => undefined});
    const poolClient = Object.assign(() => undefined, {unsafe: transactionClient.unsafe, begin: async () => undefined});
    const selection = {from: () => selection, where: async () => [{mode: "shadow_encryption", shadowBehavior: "fallback", revision: 12}]};
    const transaction = {session: {client: transactionClient}, execute: async () => {events.push("policy");}, select: () => selection};
    const db = {$client: poolClient, transaction: async <Value>(use: (tx: typeof transaction) => Promise<Value>) => {transactionOpen = true; try {return await use(transaction);} finally {transactionOpen = false; events.push("released");}}} as unknown as DirectDatabase;
    const result = await withPostgresReflectionSemanticSourcePlan({db, restricted: f.restricted, crypto: f.crypto, coordinates, serverScope: "server-1",
      namespaceReadinessRequested: async () => {expect(transactionOpen).toBe(false); woke = true; events.push("wake");},
      use: async ({namespaces, policyRevision, plan}) => {expect(transactionOpen).toBe(true); expect(namespaces).toHaveLength(2); expect(policyRevision).toBe(12); expect(plan.audience.humanRefs).toEqual(["alice", "bob"]); return "prepared";},
    });
    expect(result).toBe(missing ? null : "prepared"); expect(woke).toBe(missing); expect(events[0]).toBe("policy"); expect(events.at(-1)).toBe(missing ? "wake" : "released");
  });
});

test("only dependency-loss work can grant a stale anchor, never stale supporting Records", async () => {
  const h = harness(); h.state.lifecycle = "stale"; h.state.changeReason = "dependency_lost";
  expect(await readPostgresReflectionSemanticSourcePlan(h)).toBeNull();
  const repair = {...h.coordinates, workKind: "reflection.dependency_rewrite" as const};
  const admitted = await readPostgresReflectionSemanticSourcePlan({...h, coordinates: repair});
  expect(admitted).not.toBeNull(); admitted?.fingerprint.fill(0);
  h.state.changeReason = "changed";
  expect(await readPostgresReflectionSemanticSourcePlan({...h, coordinates: repair})).toBeNull();
  h.state.changeReason = "dependency_lost";
  expect(await readPostgresReflectionSemanticSourcePlan({...h, coordinates: {...repair,
    inputBindings: [...repair.inputBindings, {objectId: "object-2", namespaceId: "namespace-1", objectType: "nautilo.reflection.record.v1"}],
  }})).toBeNull();
});
