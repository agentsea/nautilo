import {PostgresDomainKeyAuthorityRepository} from "../delivery/postgres-domain-key-authority.ts";
import {advanceAuthorityAlternatives} from "@nautilo/reflection/authority";
import {acquireEncryptionConsumptionFence, createPostgresJsCanonicalBridgeConnection, type DirectDatabase, and, asc, eq, inArray, isNull, or, reflectionRecordAuthorityBlocks,
  reflectionRecordAuthorityClosure, reflectionRecordAuthorityProjections, reflectionRecordAuthorityReconciliations,
  reflectionRecordPayloadRepresentationHeads, reflectionRecordPayloadRepresentations, reflectionRecords,
  objectCryptoAccessHeads, objectCryptoNamespaceEnvelopes, rooms,
  type PostgresJsBridgeConnection} from "@nautilo/db";
import type {LatticeCrypto} from "@nautilo/lattice-crypto";
import {BACKGROUND_REFLECTION_MAX_NAMESPACES_V2, type BackgroundNamespaceAuthorityV2, type BackgroundReflectionWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import {cryptoTypedDb, executeTypedCryptoQuery} from "../storage/postgres-lattice-storage.ts";

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const sameStrings = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

export interface ReflectionAuthorityPlanCoordinates {
  readonly recordRef: string;
  readonly sourceChangeGeneration: number;
  readonly expectedProjectionGeneration: number;
  readonly expectedRepresentationGeneration: number;
  readonly targetRepresentationGeneration: number;
  readonly exactAccessNamespaceIds: readonly string[];
}
export interface ReflectionAuthoritySourcePlan extends ReflectionAuthorityPlanCoordinates {
  readonly sourceObjectId: string;
  readonly sourceNamespaceId: string;
  readonly sourceManifestHash: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly namespaceRooms: readonly Readonly<{namespaceId: string; roomId: string}>[];
}

/** Metadata-only source/target proof. All confidential opening remains inside the one-run gate. */
export async function readPostgresReflectionAuthoritySourcePlan(input: Readonly<{
  product: Pick<PostgresJsBridgeConnection, "query">;
  restricted: Pick<PostgresJsBridgeConnection, "query">;
  crypto: Pick<LatticeCrypto, "hash">;
  coordinates: ReflectionAuthorityPlanCoordinates;
  /** Under a product transaction, lock the entire Room union before the Human Namespace owner. */
  lock?: boolean;
  selectedSourceNamespaceId?: string;
}>): Promise<ReflectionAuthoritySourcePlan | null> {
  const c = {...input.coordinates, exactAccessNamespaceIds: [...input.coordinates.exactAccessNamespaceIds]};
  if (!Number.isSafeInteger(c.expectedRepresentationGeneration) || c.expectedRepresentationGeneration < 1
    || c.targetRepresentationGeneration !== c.expectedRepresentationGeneration + 1
    || !Number.isSafeInteger(c.expectedProjectionGeneration) || c.expectedProjectionGeneration < 1
    || !Number.isSafeInteger(c.sourceChangeGeneration) || c.sourceChangeGeneration < 1
    || c.exactAccessNamespaceIds.length < 1 || c.exactAccessNamespaceIds.length > 256
    || !sameStrings(c.exactAccessNamespaceIds, sorted(c.exactAccessNamespaceIds))) return null;
  const projections = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
    generation: reflectionRecordAuthorityProjections.projectionGeneration,
    source: reflectionRecordAuthorityProjections.sourceChangeGeneration,
    state: reflectionRecordAuthorityProjections.processingState,
    disposition: reflectionRecords.disposition,
  }).from(reflectionRecordAuthorityProjections).innerJoin(reflectionRecords,
    eq(reflectionRecords.recordId, reflectionRecordAuthorityProjections.recordId))
    .where(and(eq(reflectionRecords.recordId, c.recordRef), eq(reflectionRecordAuthorityProjections.current, true))).limit(2));
  const projection = projections[0];
  if (projections.length !== 1 || projection === undefined || projection.disposition !== "available"
    || projection.source_change_generation !== c.sourceChangeGeneration || !["current", "dirty", "reconciling"].includes(projection.processing_state)
    || (projection.projection_generation !== c.expectedProjectionGeneration && projection.projection_generation !== c.expectedProjectionGeneration + 1)) return null;
  const closure = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({namespace: reflectionRecordAuthorityClosure.terminalLeafHandle})
    .from(reflectionRecordAuthorityClosure).where(and(eq(reflectionRecordAuthorityClosure.recordId, c.recordRef),
      eq(reflectionRecordAuthorityClosure.closureGeneration, projection.projection_generation)))
    .orderBy(asc(reflectionRecordAuthorityClosure.terminalLeafHandle)).limit(BACKGROUND_REFLECTION_MAX_NAMESPACES_V2 + 1));
  if (closure.length === 0 || closure.length > BACKGROUND_REFLECTION_MAX_NAMESPACES_V2) return null;
  const leaves = closure.map(row => row.terminal_leaf_handle);
  const blocked = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({id: reflectionRecordAuthorityBlocks.blockId})
    .from(reflectionRecordAuthorityBlocks).where(or(eq(reflectionRecordAuthorityBlocks.recordId, c.recordRef),
      inArray(reflectionRecordAuthorityBlocks.terminalLeafHandle, leaves))).limit(1));
  if (blocked.length !== 0) return null;
  const representations = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
    objectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
    head: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
  }).from(reflectionRecordPayloadRepresentations).innerJoin(reflectionRecordPayloadRepresentationHeads, and(
    eq(reflectionRecordPayloadRepresentationHeads.recordId, reflectionRecordPayloadRepresentations.recordId),
    eq(reflectionRecordPayloadRepresentationHeads.representation, "protected")))
    .where(and(eq(reflectionRecordPayloadRepresentations.recordId, c.recordRef), eq(reflectionRecordPayloadRepresentations.representation, "protected"),
      eq(reflectionRecordPayloadRepresentations.representationGeneration, c.expectedRepresentationGeneration))).limit(2));
  const representation = representations[0];
  if (representations.length !== 1 || representation?.crypto_object_id === null || representation?.crypto_object_id === undefined
    || (representation.current_representation_generation !== c.expectedRepresentationGeneration && representation.current_representation_generation !== c.targetRepresentationGeneration)) return null;
  if (projection.projection_generation !== c.expectedProjectionGeneration || representation.current_representation_generation !== c.expectedRepresentationGeneration) {
    const receipts = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({
      state: reflectionRecordAuthorityReconciliations.state,
      expected: reflectionRecordAuthorityReconciliations.expectedProjectionGeneration,
      targetGeneration: reflectionRecordAuthorityReconciliations.targetRepresentationGeneration,
      targetNamespaces: reflectionRecordAuthorityReconciliations.targetAccessNamespaceIds,
      targetObjectId: reflectionRecordAuthorityReconciliations.targetCryptoObjectId,
    }).from(reflectionRecordAuthorityReconciliations).where(and(eq(reflectionRecordAuthorityReconciliations.recordId, c.recordRef),
      eq(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, c.sourceChangeGeneration))).limit(2));
    const receipt = receipts[0];
    if (receipts.length !== 1 || receipt === undefined || receipt.expected_projection_generation !== c.expectedProjectionGeneration
      || !["complete", "crypto_complete"].includes(receipt.state)) return null;
    if (representation.current_representation_generation === c.targetRepresentationGeneration && (projection.projection_generation !== c.expectedProjectionGeneration + 1 || receipt.state !== "complete"
      || receipt.target_representation_generation !== c.targetRepresentationGeneration || receipt.target_access_namespace_ids === null
      || !sameStrings(receipt.target_access_namespace_ids, c.exactAccessNamespaceIds))) return null;
    if (representation.current_representation_generation === c.targetRepresentationGeneration) {
      const targets = await executeTypedCryptoQuery(input.product, cryptoTypedDb.select({objectId: reflectionRecordPayloadRepresentations.cryptoObjectId})
        .from(reflectionRecordPayloadRepresentations).where(and(eq(reflectionRecordPayloadRepresentations.recordId, c.recordRef),
          eq(reflectionRecordPayloadRepresentations.representation, "protected"),
          eq(reflectionRecordPayloadRepresentations.representationGeneration, c.targetRepresentationGeneration))).limit(2));
      if (targets.length !== 1 || targets[0]!.crypto_object_id !== receipt.target_crypto_object_id) return null;
    }
  }
  const envelopes = await executeTypedCryptoQuery(input.restricted, cryptoTypedDb.select({
    namespaceId: objectCryptoNamespaceEnvelopes.namespaceId, manifestHash: objectCryptoAccessHeads.manifestHash,
  }).from(objectCryptoAccessHeads).innerJoin(objectCryptoNamespaceEnvelopes, and(
    eq(objectCryptoNamespaceEnvelopes.objectId, objectCryptoAccessHeads.objectId),
    eq(objectCryptoNamespaceEnvelopes.accessRevision, objectCryptoAccessHeads.accessRevision)))
    .where(eq(objectCryptoAccessHeads.objectId, representation.crypto_object_id)).orderBy(asc(objectCryptoNamespaceEnvelopes.namespaceId)).limit(257));
  if (envelopes.length < 1 || envelopes.length > 256) return null;
  const roomNamespaces = sorted([...leaves, ...c.exactAccessNamespaceIds, ...envelopes.map(entry => entry.namespace_id)]);
  const query = cryptoTypedDb.select({roomId: rooms.id, namespaceId: rooms.namespaceId,
    kind: rooms.kind, humans: rooms.humanActorIds, archived: rooms.archivedAt})
    .from(rooms).where(and(inArray(rooms.namespaceId, roomNamespaces), isNull(rooms.parentRoomId))).orderBy(asc(rooms.id));
  const roomRows = await executeTypedCryptoQuery(input.product, input.lock === true ? query.for("update") : query);
  const byNamespace = new Map(roomRows.map(row => [row.namespace_id, row]));
  if (roomRows.length !== roomNamespaces.length || byNamespace.size !== roomNamespaces.length
    || roomRows.some(room => room.archived_at !== null)) return null;
  const sourceLeaves = leaves.map(namespace => {
    const room = byNamespace.get(namespace)!;
    return {terminalAuthorityLeafHandle: namespace,
      alternatives: [{humanRefs: sorted(room.human_actor_ids), includesPublicBoundary: room.kind === "open"}]};
  });
  // Each current Room leaf has one alternative: N normalization operations
  // and at most N-1 combinations, using the canonical public-boundary algebra.
  const algebra = advanceAuthorityAlternatives({leaves: sourceLeaves, budget: {maxOperations: leaves.length * 2}});
  if (algebra.status !== "complete" || algebra.outcome.kind !== "available"
    || algebra.outcome.alternatives.length !== 1 || c.exactAccessNamespaceIds.length !== 1) return null;
  const humans = algebra.outcome.alternatives[0]!.humanRefs;
  const outputRoom = byNamespace.get(c.exactAccessNamespaceIds[0]!)!;
  if (outputRoom.kind !== "access" || !sameStrings(sorted(outputRoom.human_actor_ids), humans)) return null;
  const sourceEnvelope = envelopes.find(entry => (input.selectedSourceNamespaceId === undefined || entry.namespace_id === input.selectedSourceNamespaceId)
    && humans.some(human => byNamespace.get(entry.namespace_id)!.human_actor_ids.includes(human)));
  if (sourceEnvelope === undefined) return null;
  const sourceManifestHash = Uint8Array.from(sourceEnvelope.manifest_hash);
  const canonical = new TextEncoder().encode(JSON.stringify([
    "nautilo/reflection/authority-source/v2", c.recordRef, c.sourceChangeGeneration, c.expectedProjectionGeneration,
    c.expectedRepresentationGeneration, c.targetRepresentationGeneration, representation.crypto_object_id, sourceEnvelope.namespace_id,
    Array.from(sourceManifestHash), leaves, c.exactAccessNamespaceIds,
    roomNamespaces.map(namespace => {const room = byNamespace.get(namespace)!; return [namespace, room.id, room.kind, sorted(room.human_actor_ids)];}),
  ]));
  const fingerprint = input.crypto.hash(canonical); canonical.fill(0);
  const requirements = sorted([sourceEnvelope.namespace_id, ...c.exactAccessNamespaceIds]);
  return {...c, sourceObjectId: representation.crypto_object_id, sourceNamespaceId: sourceEnvelope.namespace_id, sourceManifestHash, fingerprint,
    namespaceRooms: requirements.map(namespaceId => ({namespaceId, roomId: byNamespace.get(namespaceId)!.id}))};
}

export async function validatePostgresReflectionAuthorityReprojection(input: Readonly<{
  product: Pick<PostgresJsBridgeConnection, "query">; restricted: Pick<PostgresJsBridgeConnection, "query">;
  crypto: Pick<LatticeCrypto, "hash">; descriptor: BackgroundReflectionWorkDescriptorV2;
}>): Promise<boolean> {
  const d = input.descriptor;
  if (d.source.kind !== "reflection_authority" || d.outputSlots.length !== 1 || d.inputBindings.length !== 1) return false;
  const plan = await readPostgresReflectionAuthoritySourcePlan({...input, lock: true, selectedSourceNamespaceId: d.inputBindings[0]!.namespaceId,
    coordinates: {recordRef: d.source.recordRef, sourceChangeGeneration: d.source.sourceChangeGeneration,
      expectedProjectionGeneration: d.source.projectionGeneration, expectedRepresentationGeneration: d.source.expectedRepresentationGeneration,
      targetRepresentationGeneration: d.source.targetRepresentationGeneration, exactAccessNamespaceIds: d.outputSlots[0]!.namespaceIds}});
  if (plan === null) return false;
  try {return plan.sourceObjectId === d.inputBindings[0]!.objectId && same(plan.fingerprint, d.source.fingerprint)
    && plan.namespaceRooms.length === d.namespaceRequirements.length && plan.namespaceRooms.every((entry, index) => {
      const authority = d.namespaceRequirements[index]!.authority;
      return authority.namespaceId === entry.namespaceId && authority.roomId === entry.roomId;
    });}
  finally {plan.fingerprint.fill(0); plan.sourceManifestHash.fill(0);}
}

/** Preparation owns the policy fence as well as the complete product Room union. */
export async function withPostgresReflectionAuthoritySourcePlan<Value>(input: Readonly<{
  db: DirectDatabase; restricted: PostgresJsBridgeConnection; crypto: LatticeCrypto; serverScope: string;
  coordinates: ReflectionAuthorityPlanCoordinates;
  namespaceReadinessRequested?(coordinate: Readonly<{roomId: string; namespaceId: string}>): Promise<void>;
  use(input: Readonly<{plan: ReflectionAuthoritySourcePlan; namespaces: readonly BackgroundNamespaceAuthorityV2[];
    policyRevision: number; product: Pick<PostgresJsBridgeConnection, "query">}>): Promise<Value>;
}>): Promise<Value | null> {
  let missingNamespace: Readonly<{roomId: string; namespaceId: string}> | undefined;
  const result = await createPostgresJsCanonicalBridgeConnection(input.db).transaction(async (tx, product) => {
    const policy = await acquireEncryptionConsumptionFence(tx);
    if (policy.mode === "plaintext_only") return null;
    const plan = await readPostgresReflectionAuthoritySourcePlan({product, restricted: input.restricted,
      crypto: input.crypto, coordinates: input.coordinates, lock: true});
    if (plan === null) return null;
    const namespaces: BackgroundNamespaceAuthorityV2[] = [];
    try {
      const domains = new PostgresDomainKeyAuthorityRepository(input.restricted, input.crypto, input.serverScope);
      for (const coordinate of plan.namespaceRooms) {
        const current = await domains.inspectForegroundNamespaceAuthority({namespaceId: coordinate.namespaceId, keyClass: "ai"});
        if (current.status !== "ready") {
          missingNamespace = coordinate;
          return null;
        }
        namespaces.push({serverId: input.serverScope, roomId: coordinate.roomId, namespaceId: coordinate.namespaceId,
          namespaceAccessRevision: current.namespaceAccessRevision, namespaceKeyGeneration: current.namespaceKeyGeneration,
          namespaceHeadDigest: current.namespaceHeadDigest, domainId: current.domainId, domainKeyGeneration: current.domainKeyGeneration,
          domainAuthorizationRevision: current.domainAuthorizationRevision, domainHeadDigest: current.domainHeadDigest,
          bundleRevision: current.bundleRevision, bundleDigest: current.bundleDigest});
      }
      return await input.use({plan, namespaces, policyRevision: policy.revision, product});
    } finally {
      plan.fingerprint.fill(0); plan.sourceManifestHash.fill(0);
      for (const namespace of namespaces) {
        namespace.namespaceHeadDigest.fill(0); namespace.domainHeadDigest.fill(0); namespace.bundleDigest.fill(0);
      }
    }
  }, {isolationLevel: "read committed"});
  // Wake the existing admitted-device key owner only after releasing Room and
  // policy fences. This is a hint; provisioning still proves current authority.
  if (missingNamespace !== undefined) await input.namespaceReadinessRequested?.(missingNamespace);
  return result;
}
