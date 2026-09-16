import {ClassifiedDataOperationError} from "../../transition/encryption-data-operation-owner.ts";
import {
  acquireEncryptionConsumptionFence, createPostgresJsCanonicalBridgeConnection, type DirectDatabase, and, asc, eq, inArray, isNull, memories, memoryNamespaces, memoryScopes,
  objectCryptoAccessHeads, objectCryptoNamespaceEnvelopes,
  reflectionRecordAuthorityAlternatives, reflectionRecordAuthorityBlocks, reflectionRecordAuthorityClosure,
  reflectionRecordAuthorityProjections, reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations, reflectionRecordSemanticWork, reflectionRecords,
  rooms, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import {assertPortableId, type LatticeCrypto} from "@nautilo/lattice-crypto";
import {
  BACKGROUND_REFLECTION_MAX_NAMESPACES_V2, REFLECTION_BACKGROUND_MAX_INPUTS_V2, REFLECTION_BACKGROUND_MAX_OUTPUT_NAMESPACES_V2, type BackgroundNamespaceAuthorityV2,
  type BackgroundReflectionSemanticInputBindingV2, type BackgroundReflectionWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {PostgresProtectedReflectionMessageMetadata} from "./protected-message-metadata.ts";
import {fingerprintRequiredMemoryNamespaces} from "../../memory/memory-repository.ts";
import {resolveRequiredMemoryNamespaceIds} from "../../memory/required-namespace-set.ts";
import {PostgresDomainKeyAuthorityRepository} from "../delivery/postgres-domain-key-authority.ts";
import {advanceAuthorityAlternatives} from "@nautilo/reflection/authority";
import {cryptoTypedDb, executeTypedCryptoQuery} from "../storage/postgres-lattice-storage.ts";

const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export interface ReflectionSemanticPlanCoordinates {
  readonly recordRef: string;
  readonly claimGeneration: number;
  readonly workKind?: "reflection.search_projection" | "reflection.organization" | "reflection.dependency_rewrite";
  readonly inputBindings: readonly BackgroundReflectionSemanticInputBindingV2[];
  readonly outputNamespaceIds: readonly string[];
}

export interface ReflectionSemanticSourcePlan {
  readonly fingerprint: Uint8Array;
  readonly stage: string;
  readonly audience: Readonly<{humanRefs: readonly string[]; includesPublicBoundary: boolean}>;
  readonly namespaceRooms: readonly Readonly<{namespaceId: string; roomId: string}>[];
}

/** Exact metadata proof; no Record/Memory body or provider is accessed here. */
export async function readPostgresReflectionSemanticSourcePlan(input: Readonly<{
  product: Pick<PostgresJsBridgeConnection, "query">;
  restricted: Pick<PostgresJsBridgeConnection, "query">;
  crypto: Pick<LatticeCrypto, "hash">;
  coordinates: ReflectionSemanticPlanCoordinates;
  lock?: boolean;
}>): Promise<ReflectionSemanticSourcePlan | null> {
  const c = {...input.coordinates, inputBindings: input.coordinates.inputBindings.map(binding => ({...binding})), outputNamespaceIds: [...input.coordinates.outputNamespaceIds]};
  try {
    for (const value of [c.recordRef, ...c.inputBindings.flatMap(binding => [binding.objectId, binding.namespaceId]), ...c.outputNamespaceIds]) assertPortableId("Reflection semantic coordinate", value);
  } catch {return null;}
  if (JSON.stringify(c.outputNamespaceIds) !== JSON.stringify(sorted(c.outputNamespaceIds))
    || c.inputBindings.some(binding => !["nautilo.reflection.record.v1", "nautilo-memory-v1", "nautilo-message-v2"].includes(binding.objectType))) return null;
  if (!Number.isSafeInteger(c.claimGeneration) || c.claimGeneration < 1
    || c.inputBindings.length < 1 || c.inputBindings.length > REFLECTION_BACKGROUND_MAX_INPUTS_V2
    || c.outputNamespaceIds.length > REFLECTION_BACKGROUND_MAX_OUTPUT_NAMESPACES_V2
    || new Set(c.inputBindings.map(entry => entry.objectId)).size !== c.inputBindings.length) return null;
  const work = reflectionRecordSemanticWork;
  const claimed = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
    generation: work.generation, completedGeneration: work.completedGeneration, state: work.state, stage: work.stage,
    changeReason: work.changeReason,
  }).from(work).where(eq(work.recordId, c.recordRef)).limit(1));
  const claim = claimed[0];
  if (claim === undefined || claim.generation !== c.claimGeneration || claim.completed_generation >= c.claimGeneration
    || claim.state === "complete" || claim.state === "quarantined") return null;
  const facts: unknown[] = [];
  const terminalLeaves: string[] = [];
  const recordAudiences: {namespaceId: string; leaves: string[]; includesPublicBoundary: boolean}[] = [];
  const namespaceIds = sorted([...c.inputBindings.map(entry => entry.namespaceId), ...c.outputNamespaceIds]);
  let anchorPresent = false;
  for (const binding of c.inputBindings) {
    const head = await executeTypedCryptoQuery(input.restricted, cryptoTypedDb.select({
      manifestHash: objectCryptoAccessHeads.manifestHash, accessRevision: objectCryptoAccessHeads.accessRevision,
    }).from(objectCryptoAccessHeads).innerJoin(objectCryptoNamespaceEnvelopes, and(
      eq(objectCryptoNamespaceEnvelopes.objectId, objectCryptoAccessHeads.objectId),
      eq(objectCryptoNamespaceEnvelopes.accessRevision, objectCryptoAccessHeads.accessRevision),
    )).where(and(eq(objectCryptoAccessHeads.objectId, binding.objectId),
      eq(objectCryptoNamespaceEnvelopes.namespaceId, binding.namespaceId))).limit(1));
    if (head.length !== 1) return null;
    if (binding.objectType === "nautilo.reflection.record.v1") {
      const records = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
        recordId: reflectionRecords.recordId, processingGeneration: reflectionRecords.processingGeneration,
        structuralHeight: reflectionRecords.structuralHeight, lifecycle: reflectionRecords.lifecycle,
        disposition: reflectionRecords.disposition,
        representationGeneration: reflectionRecordPayloadRepresentations.representationGeneration,
        projectionGeneration: reflectionRecordAuthorityProjections.projectionGeneration,
        sourceChangeGeneration: reflectionRecordAuthorityProjections.sourceChangeGeneration,
        processingState: reflectionRecordAuthorityProjections.processingState,
      }).from(reflectionRecordPayloadRepresentations)
        .innerJoin(reflectionRecords, eq(reflectionRecords.recordId, reflectionRecordPayloadRepresentations.recordId))
        .innerJoin(reflectionRecordPayloadRepresentationHeads, and(
          eq(reflectionRecordPayloadRepresentationHeads.recordId, reflectionRecords.recordId),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
          eq(reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration, reflectionRecordPayloadRepresentations.representationGeneration),
        )).innerJoin(reflectionRecordAuthorityProjections, and(
          eq(reflectionRecordAuthorityProjections.recordId, reflectionRecords.recordId),
          eq(reflectionRecordAuthorityProjections.current, true),
        )).where(and(eq(reflectionRecordPayloadRepresentations.cryptoObjectId, binding.objectId),
          eq(reflectionRecordPayloadRepresentations.representation, "protected"))).limit(2));
      const record = records[0];
      if (records.length !== 1 || record === undefined || record.disposition !== "available"
        || (record.lifecycle !== "current" && !(record.lifecycle === "stale" && record.record_id === c.recordRef
          && c.workKind === "reflection.dependency_rewrite" && claim.change_reason === "dependency_lost"))
        || record.processing_state !== "current") return null;
      if (record.record_id === c.recordRef) anchorPresent = true;
      const leaves = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
        leaf: reflectionRecordAuthorityClosure.terminalLeafHandle,
      }).from(reflectionRecordAuthorityClosure).where(and(
        eq(reflectionRecordAuthorityClosure.recordId, record.record_id),
        eq(reflectionRecordAuthorityClosure.closureGeneration, record.projection_generation),
      )).orderBy(asc(reflectionRecordAuthorityClosure.terminalLeafHandle)).limit(BACKGROUND_REFLECTION_MAX_NAMESPACES_V2 + 1));
      if (leaves.length === 0 || leaves.length > BACKGROUND_REFLECTION_MAX_NAMESPACES_V2) return null;
      const handles = leaves.map(row => row.terminal_leaf_handle);
      const blockedRecord = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
        id: reflectionRecordAuthorityBlocks.blockId,
      }).from(reflectionRecordAuthorityBlocks).where(eq(reflectionRecordAuthorityBlocks.recordId, record.record_id)).limit(1));
      if (blockedRecord.length !== 0) return null;
      const alternatives = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
        namespaceId: reflectionRecordAuthorityAlternatives.accessNamespaceId,
        includesPublicBoundary: reflectionRecordAuthorityAlternatives.includesPublicBoundary,
        commitment: reflectionRecordAuthorityAlternatives.alternativeCommitment,
      }).from(reflectionRecordAuthorityAlternatives).where(and(
        eq(reflectionRecordAuthorityAlternatives.recordId, record.record_id),
        eq(reflectionRecordAuthorityAlternatives.projectionGeneration, record.projection_generation),
      )).limit(2));
      const alternative = alternatives[0];
      if (alternatives.length !== 1 || alternative === undefined || alternative.access_namespace_id !== binding.namespaceId) return null;
      recordAudiences.push({namespaceId: binding.namespaceId, leaves: handles, includesPublicBoundary: alternative.includes_public_boundary});
      terminalLeaves.push(...handles);
      facts.push([binding, record, handles, [alternative.access_namespace_id, alternative.includes_public_boundary, Array.from(alternative.alternative_commitment)], Array.from(head[0]!.manifest_hash), head[0]!.access_revision]);
    } else if (binding.objectType === "nautilo-message-v2") {
      if (c.workKind !== "reflection.dependency_rewrite" || claim.change_reason !== "dependency_lost") return null;
      const message = await new PostgresProtectedReflectionMessageMetadata(input.product)
        .resolveMessageObject({objectId: binding.objectId, namespaceId: binding.namespaceId});
      if (message === null) return null;
      terminalLeaves.push(binding.namespaceId);
      facts.push([binding, message, Array.from(head[0]!.manifest_hash), head[0]!.access_revision]);
    } else {
      const rows = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
        id: memories.id, contentRevision: memories.contentRevision,
        mappingState: memories.cryptoMappingState, cryptoAccessRevision: memories.cryptoAccessRevision,
        requiredNamespaceFingerprint: memories.cryptoRequiredNamespaceFingerprint, scopeOriginNamespaceId: memories.scopeOriginNamespaceId,
      }).from(memories).where(eq(memories.cryptoObjectId, binding.objectId)).limit(2));
      const memory = rows[0];
      if (rows.length !== 1 || memory === undefined || memory.crypto_mapping_state !== "verified"
        || memory.content_revision < 1 || String(memory.crypto_access_revision) !== String(head[0]!.access_revision)) return null;
      const attachments = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
        namespaceId: memoryNamespaces.namespaceId,
      }).from(memoryNamespaces).where(eq(memoryNamespaces.memoryId, memory.id))
        .orderBy(asc(memoryNamespaces.namespaceId)));
      const handles = attachments.map(row => row.namespace_id);
      if (!handles.includes(binding.namespaceId)) return null;
      const scopes = await executeTypedCryptoQuery(input.product, cryptoTypedDb.selectDistinct({origin: memoryScopes.origin})
        .from(memoryScopes).where(eq(memoryScopes.memoryId, memory.id)).orderBy(asc(memoryScopes.origin)));
      if (scopes.some(scope => scope.origin !== "seed" && scope.origin !== "scope")) return null;
      let fingerprint: Uint8Array;
      try {
        const required = resolveRequiredMemoryNamespaceIds({namespaceIds: handles,
          scopeOrigins: scopes.map(scope => scope.origin as "seed" | "scope"), originWritableNamespaceId: memory.scope_origin_namespace_id});
        fingerprint = fingerprintRequiredMemoryNamespaces(required);
      } catch {return null;}
      try {
        if (!(memory.crypto_required_namespace_fingerprint instanceof Uint8Array) || !equal(memory.crypto_required_namespace_fingerprint, fingerprint)) return null;
      } finally {fingerprint.fill(0);}
      // A Memory can have several attachment alternatives. This attempt uses
      // the exact selected Namespace; all attachments still enter its fence.
      terminalLeaves.push(binding.namespaceId);
      facts.push([binding, memory, handles, scopes, Array.from(head[0]!.manifest_hash), head[0]!.access_revision]);
    }
  }
  if (!anchorPresent) return null;
  const leaves = sorted(terminalLeaves);
  if (leaves.length > BACKGROUND_REFLECTION_MAX_NAMESPACES_V2) return null;
  const blockedLeaf = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({id: reflectionRecordAuthorityBlocks.blockId})
    .from(reflectionRecordAuthorityBlocks).where(inArray(reflectionRecordAuthorityBlocks.terminalLeafHandle, leaves)).limit(1));
  if (blockedLeaf.length !== 0) return null;
  const roomNamespaces = sorted([...namespaceIds, ...leaves]);
  if (roomNamespaces.length > BACKGROUND_REFLECTION_MAX_NAMESPACES_V2) return null;
  const query = cryptoTypedDb.select({id: rooms.id, namespaceId: rooms.namespaceId, humanActorIds: rooms.humanActorIds,
    kind: rooms.kind, archivedAt: rooms.archivedAt}).from(rooms)
    .where(and(inArray(rooms.namespaceId, roomNamespaces), isNull(rooms.parentRoomId))).orderBy(asc(rooms.id));
  const roomRows = await executeTypedCryptoQuery(input.product, input.lock === true ? query.for("update") : query);
  const byNamespace = new Map(roomRows.map(row => [row.namespace_id, row]));
  if (roomRows.length !== roomNamespaces.length || byNamespace.size !== roomNamespaces.length
    || roomRows.some(row => row.archived_at !== null)) return null;
  for (const record of recordAudiences) {
    const current = advanceAuthorityAlternatives({leaves: record.leaves.map(leaf => {
      const room = byNamespace.get(leaf)!;
      return {terminalAuthorityLeafHandle: leaf, alternatives: [{humanRefs: sorted(room.human_actor_ids), includesPublicBoundary: room.kind === "open"}]};
    }), budget: {maxOperations: record.leaves.length * 2}});
    const selected = byNamespace.get(record.namespaceId)!;
    if (current.status !== "complete" || current.outcome.kind !== "available" || current.outcome.alternatives.length !== 1
      || selected.kind !== "access" || JSON.stringify(sorted(selected.human_actor_ids)) !== JSON.stringify(current.outcome.alternatives[0]!.humanRefs)
      || record.includesPublicBoundary !== current.outcome.alternatives[0]!.includesPublicBoundary) return null;
  }
  const authority = advanceAuthorityAlternatives({leaves: leaves.map(leaf => {
    const room = byNamespace.get(leaf)!;
    return {terminalAuthorityLeafHandle: leaf, alternatives: [{humanRefs: sorted(room.human_actor_ids), includesPublicBoundary: room.kind === "open"}]};
  }), budget: {maxOperations: leaves.length * 2}});
  if (authority.status !== "complete" || authority.outcome.kind !== "available" || authority.outcome.alternatives.length !== 1) return null;
  const audience = authority.outcome.alternatives[0]!;
  for (const output of c.outputNamespaceIds) {
    const room = byNamespace.get(output)!;
    if (room.kind !== "access" || JSON.stringify(sorted(room.human_actor_ids)) !== JSON.stringify(audience.humanRefs)) return null;
  }
  const canonical = new TextEncoder().encode(JSON.stringify([
    "nautilo/reflection/semantic-source/v2", c.recordRef, c.claimGeneration, claim.stage, facts,
    c.outputNamespaceIds, roomRows,
  ]));
  try {
    const fingerprint = input.crypto.hash(canonical);
    if (input.lock === true) {
      // Discovery precedes Room locks. Re-read all metadata after acquiring the
      // union; reject concurrent source/head/closure drift instead of blessing
      // a mixed snapshot. Entity mutation/claim fencing remains with the owner.
      const current = await readPostgresReflectionSemanticSourcePlan({...input, coordinates: c, lock: false});
      const matches = current !== null && equal(fingerprint, current.fingerprint);
      current?.fingerprint.fill(0);
      if (!matches) {fingerprint.fill(0); return null;}
    }
    return {fingerprint, stage: claim.stage, audience,
      namespaceRooms: namespaceIds.map(namespaceId => ({namespaceId, roomId: byNamespace.get(namespaceId)!.id}))};
  } finally {canonical.fill(0);}
}

export async function validatePostgresReflectionSemanticPlan(input: Readonly<{
  product: Pick<PostgresJsBridgeConnection, "query">;
  restricted: Pick<PostgresJsBridgeConnection, "query">;
  crypto: Pick<LatticeCrypto, "hash">;
  descriptor: BackgroundReflectionWorkDescriptorV2;
}>): Promise<boolean> {
  const d = input.descriptor;
  if (d.workKind !== "reflection.search_projection" && d.workKind !== "reflection.organization" && d.workKind !== "reflection.dependency_rewrite") return false;
  const plan = await readPostgresReflectionSemanticSourcePlan({...input, lock: true, coordinates: {
    recordRef: d.source.recordRef, claimGeneration: d.source.claimGeneration, workKind: d.workKind,
    inputBindings: d.inputBindings,
    outputNamespaceIds: d.outputSlots.flatMap(slot => slot.namespaceIds),
  }});
  if (plan === null) return false;
  try {
    const stageMatches = d.workKind === "reflection.search_projection" ? plan.stage === "search_projection"
      : d.workKind === "reflection.organization" || d.workKind === "reflection.dependency_rewrite" ? plan.stage === "organization" : false;
    return stageMatches && equal(plan.fingerprint, d.source.fingerprint)
      && plan.namespaceRooms.length === d.namespaceRequirements.length
      && plan.namespaceRooms.every((entry, index) => entry.namespaceId === d.namespaceRequirements[index]!.authority.namespaceId
        && entry.roomId === d.namespaceRequirements[index]!.authority.roomId);
  } finally {plan.fingerprint.fill(0);}
}

/** Preparation shares the existing policy/Room/current-Namespace ownership order. */
export async function withPostgresReflectionSemanticSourcePlan<Value>(input: Readonly<{
  db: DirectDatabase; restricted: PostgresJsBridgeConnection; crypto: LatticeCrypto; serverScope: string;
  coordinates: ReflectionSemanticPlanCoordinates;
  reportKeyWait?: boolean;
  namespaceReadinessRequested?(coordinate: Readonly<{roomId: string; namespaceId: string}>): Promise<void>;
  use(input: Readonly<{plan: NonNullable<Awaited<ReturnType<typeof readPostgresReflectionSemanticSourcePlan>>>;
    namespaces: readonly BackgroundNamespaceAuthorityV2[]; policyRevision: number;
    product: Pick<PostgresJsBridgeConnection, "query">}>): Promise<Value>;
}>): Promise<Value | null> {
  let missingNamespace: Readonly<{roomId: string; namespaceId: string}> | undefined;
  let keyWaiting = false;
  const result = await createPostgresJsCanonicalBridgeConnection(input.db).transaction(async (tx, product) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode === "plaintext_only") return null;
    const initial = await readPostgresReflectionSemanticSourcePlan({product, restricted: input.restricted, crypto: input.crypto, coordinates: input.coordinates, lock: true});
    if (initial === null) return null;
    const namespaces: BackgroundNamespaceAuthorityV2[] = [];
    try {
      const domains = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
      for (const coordinate of initial.namespaceRooms) {
        const current = await domains.inspectForegroundNamespaceAuthority({namespaceId: coordinate.namespaceId, keyClass: "ai"});
        if (current.status !== "ready") {missingNamespace = coordinate; keyWaiting = current.reason === "namespace_bundle_unavailable"; return null;}
        namespaces.push({serverId: input.serverScope, roomId: coordinate.roomId, namespaceId: coordinate.namespaceId,
          namespaceAccessRevision: current.namespaceAccessRevision, namespaceKeyGeneration: current.namespaceKeyGeneration,
          namespaceHeadDigest: current.namespaceHeadDigest, domainId: current.domainId, domainKeyGeneration: current.domainKeyGeneration,
          domainAuthorizationRevision: current.domainAuthorizationRevision, domainHeadDigest: current.domainHeadDigest,
          bundleRevision: current.bundleRevision, bundleDigest: current.bundleDigest});
      }
      // The first metadata walk discovers the Room union. Re-read after locking
      // that union and resolving current Namespace metadata; no stale partial
      // discovery may become a descriptor. Publication also needs its exact
      // family source/lease fence inside the owning product transaction.
      const current = await readPostgresReflectionSemanticSourcePlan({product, restricted: input.restricted, crypto: input.crypto, coordinates: input.coordinates});
      if (current === null) return null;
      try {
        if (!equal(initial.fingerprint, current.fingerprint)) return null;
        return await input.use({plan: current, namespaces, policyRevision: policy.revision, product});
      } finally {current.fingerprint.fill(0);}
    } finally {
      initial.fingerprint.fill(0);
      for (const namespace of namespaces) {namespace.namespaceHeadDigest.fill(0); namespace.domainHeadDigest.fill(0); namespace.bundleDigest.fill(0);}
    }
  }, {isolationLevel: "read committed"});
  if (missingNamespace !== undefined) await input.namespaceReadinessRequested?.(missingNamespace);
  if (keyWaiting && input.reportKeyWait === true) throw new ClassifiedDataOperationError("key_waiting", "Reflection Namespace key bundle is pending");
  return result;
}
