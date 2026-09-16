import {createHash} from "node:crypto";
import {createPostgresJsBridgeConnection, type DirectDatabase} from "@nautilo/db";
import {
  createProtectedReflectionSemanticQuestions, prepareReflectionSemanticQuestion,
  PostgresProtectedOrganizerMetadata, type ProtectedOrganizerRecordMetadata, type ProtectedOrganizerMemoryMetadata,
  PostgresProtectedReflectionMessageMetadata, type ProtectedReflectionMessageMetadata,
  type ReflectionSemanticOperationPort, type ReflectionSemanticOperationRequest,
  type ProtectedReflectionSemanticQuestionValue, type PreparedReflectionSemanticQuestion,
} from "@nautilo/lattice-bridge/server";
import {decodeMemoryPayloadV1, decodeMessagePayloadV2} from "@nautilo/lattice-bridge";
import {CANDIDATE_POLICY_V1, runDependencyLossRewrite} from "@nautilo/reflection";
import {
  DURABLE_RECORD_PAGE_LIMIT_MAX, durableEnvelopeToRecordSnapshot, type DurableSourceDependency,
  type DurableRecordLifecycleMutation, type DurableRecordLifecycleMutationResult,
  type DurableSleepSemanticPort, type DurableSleepClaim, type DurableSleepOrganizerViewResult, type DurableSleepOrganizerView,
} from "@nautilo/reflection/durable";
import {
  DualModeRecordRepository, PostgresRecordProductStore, PostgresSemanticWorkStore,
  PostgresCurrentRecordPublicationBinding, PostgresAuthorityProjectionStore,
  PostgresRecordSearchProjectionStore, PostgresSameRoomOrganizerStore, PostgresSameRoomOrganizerNeighbors,
  PostgresCrossRoomOrganizerStore, SameRoomDurableSemanticComposition, ExactCrossRoomPublicationPlanner,
  OrganizerProposalPublisher, ExactGroundedDependencyLossResolver, ProjectedAuthorityEligibility, createHmacOrganizerPublicationIdentityPort, createHmacRecordRequestCommitmentPort,
  createHmacRecordSemanticCommitmentPort, createHmacRecordSearchCommitmentPort, decodeDurableRecordEnvelope, encodeDurableRecordEnvelope,
  selectSameRoomOrganizerCoordinates, crossRoomApplicationPlanToken, CROSS_ROOM_EXECUTION_PLAN_LIMITS, intersectSingleAuthorityAlternatives,
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresHandle, type RecordRepositorySelection, type ProtectedRecordPublicationPort,
  type RecordProductStorePort, type CrossRoomCandidatePlan, type DurableOrganizerModelPort,
  type SameRoomSemanticBinding, type CrossRoomPublicationPlan, type CrossRoomInputCoordinate,
  type CrossRoomOrganizerPartitionPort, type CrossRoomOrganizerDiscoveryResult,
  type RoomLocalMemoryCandidate, type CanonicalRecordSourceReadPort, type RecordSourceInvalidationPort,
  type RecordAccessAudiencePort, type CanonicalSourceAuthorityPort,
} from "@nautilo/reflection-bridge/server";
import {
  createCanonicalSameRoomBindingPorts, createCanonicalRecordAccessAudience,
  CanonicalRoomNamespaceSourceAuthority, REFLECTION_SEMANTIC_RUNTIME_POLICY_V1, createHmacOrdinarySourceFingerprintPort, reflectionMessageSourceFingerprint,
  type CanonicalRoomAuthorityQueries,
} from "@nautilo/runtime";

import {attachReflectionShadowSibling} from "./attach-shadow-sibling";

class ExpandedReflectionInputsRequired extends Error {}
class PendingReflectionInputsRequired extends Error {}

const unavailable = () => new Error("Protected Reflection exact question is unavailable");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rejectedView = {status: "unavailable", failureCode: "candidate_unavailable"} as const;

type CompleteOutput = Parameters<ProtectedReflectionSemanticQuestionValue["applyProposal"]>[1];
type Reservation = Parameters<RecordProductStorePort["reserveProtected"]>[0];

/** Adapts the existing selected repository's publication to its one already-running gate. */
export function createGateBoundReflectionRecordPublication(input: {
  readonly product: RecordProductStorePort;
  readonly outputObjectId: string;
  readonly open: ProtectedRecordPublicationPort["open"];
  readonly attachShadowSibling?: (input: Readonly<{product: RecordProductStorePort; publication: Reservation["publication"]; requestCommitment: Uint8Array; plaintext: Uint8Array}>) => Promise<void>;
}) {
  let reservation: Reservation | undefined;
  let complete: CompleteOutput | undefined;
  let lifecycle: DurableRecordLifecycleMutation | undefined;
  let lifecycleResult: DurableRecordLifecycleMutationResult | undefined;
  let used = false, disposed = false;
  const active = () => {if (disposed) throw unavailable();};
  const reserve = input.product.reserveProtected.bind(input.product);
  // This product instance belongs only to this question. The durable store and
  // its reservation/commitment rules remain the canonical publication owner.
  input.product.reserveProtected = async request => {
    active();
    if (reservation !== undefined) throw unavailable();
    const result = await reserve(request);
    if (result.status === "reserved" || result.status === "replayed") {
      const bound = await input.product.bindProtectedOutput({idempotencyKey: request.publication.idempotencyKey,
        recordId: request.publication.record.recordRef, cryptoObjectId: input.outputObjectId, requestCommitment: request.requestCommitment});
      if (bound === "blocked" || bound === "conflict") return {status: bound, recordId: request.publication.record.recordRef};
      reservation = {publication: structuredClone(request.publication), requestCommitment: request.requestCommitment.slice()};
    }
    return result;
  };
  const publication: ProtectedRecordPublicationPort = {
    open: request => {active(); return input.open(request);},
    verify: () => Promise.resolve("incomplete"),
    retire: () => Promise.reject(unavailable()),
    async publish(request) {
      active();
      if (complete === undefined || reservation === undefined || used || request.recordId !== reservation.publication.record.recordRef
        || request.representationGeneration !== 1 || request.publicationBindingRef !== reservation.publication.publicationBindingRef) throw unavailable();
      used = true;
      const completed = await complete({objectId: input.outputObjectId, plaintext: request.payloadBytes});
      return completed.status === "executed" ? {status: "created", objectId: input.outputObjectId}
        : {status: "unavailable", reason: "crypto_incomplete"};
    },
  };
  return {
    publication,
    validateOutput(value: {objectId: string; plaintext: Uint8Array}) {
      active();
      if (reservation === undefined || value.objectId !== input.outputObjectId) throw unavailable();
      const expected = encodeDurableRecordEnvelope(reservation.publication.record);
      try {if (!Buffer.from(expected).equals(value.plaintext)) throw unavailable();} finally {expected.fill(0);}
    },
    setCompletion(value: CompleteOutput) {active(); if (complete !== undefined) throw unavailable(); complete = value;},
    async transitionLifecycle(value: DurableRecordLifecycleMutation): Promise<DurableRecordLifecycleMutationResult> {
      active();
      if (complete === undefined || used) throw unavailable();
      used = true; lifecycle = value;
      const result = await complete(null);
      if (result.status !== "executed" || lifecycleResult === undefined) throw unavailable();
      return lifecycleResult;
    },
    async finishNoChange() {active(); if (!used) {if (complete === undefined) throw unavailable(); used = true; await complete(null);}},
    async attach(operation: Parameters<ReflectionSemanticOperationRequest["attach"]>[0], product: RecordProductStorePort) {
      active();
      await operation.authorizeCommit();
      active();
      if (operation.output === null) {
        if (reservation !== undefined) throw unavailable();
        if (lifecycle !== undefined) {
          lifecycleResult = await product.transitionLifecycle(lifecycle);
          if (lifecycleResult.status !== "transitioned") throw unavailable();
        }
        return;
      }
      if (reservation === undefined || lifecycle !== undefined || operation.output.objectId !== input.outputObjectId) throw unavailable();
      const {publication: value, requestCommitment} = reservation;
      const marked = await product.markProtectedCryptoComplete({idempotencyKey: value.idempotencyKey,
        recordId: value.record.recordRef, cryptoObjectId: input.outputObjectId});
      if (marked === "blocked" || marked === "conflict") throw unavailable();
      const attached = await product.attachProtected({publication: value, cryptoObjectId: input.outputObjectId, requestCommitment});
      if (attached === "blocked" || attached === "conflict") throw unavailable();
      if (operation.held.ordinarySiblingAllowed === true) {
        if (input.attachShadowSibling === undefined) throw unavailable();
        await input.attachShadowSibling({product, publication: value, requestCommitment, plaintext: operation.output.plaintext});
      }
      const completed = await product.completeProtected({idempotencyKey: value.idempotencyKey, recordId: value.record.recordRef});
      if (completed === "blocked" || completed === "conflict") throw unavailable();
    },
    dispose() {disposed = true; reservation?.requestCommitment.fill(0); reservation = undefined; complete = undefined; lifecycle = undefined; lifecycleResult = undefined;},
  };
}

/** Typed Memory bodies borrowed only from this question's already-opened gate. */
export function createGateBoundReflectionMemorySources(input: {
  readonly commitmentKey: Uint8Array;
  readonly memories: ReadonlyMap<string, ProtectedOrganizerMemoryMetadata>;
  readonly payloads: ReadonlyMap<string, {readonly plaintext: Uint8Array}>;
  readonly scores: ReadonlyMap<string, number>;
  readonly roomBindings: ReadonlyMap<string, {readonly roomAnchorRef: string; readonly readBindingRef: string}>;
  readonly signal: AbortSignal;
  readonly resolveMemoryDependency: PostgresProtectedOrganizerMetadata["resolveMemoryDependency"];
}) {
  const fingerprints = createHmacOrdinarySourceFingerprintPort(input.commitmentKey);
  const memoryValues = new Map<string, RoomLocalMemoryCandidate>();
  for (const value of input.memories.values()) {
    const room = input.roomBindings.get(value.logicalSourceRef); if (room === undefined) throw unavailable();
    const openedMemory = input.payloads.get(value.inputBinding.objectId); if (openedMemory === undefined) throw unavailable();
    const payload = decodeMemoryPayloadV1(openedMemory.plaintext);
    // The canonical fingerprint commits id/revision/type/content; tier and
    // timestamp are deliberately absent from its bytes. Metadata fences tier.
    const fingerprint = fingerprints.memory({id: value.memoryRef, contentRevision: value.contentRevision,
      type: payload.type, content: payload.content});
    memoryValues.set(value.logicalSourceRef, {score: input.scores.get(value.logicalSourceRef) ?? 0,
      dependency: {sourceKind: "memory", logicalSourceRef: value.logicalSourceRef, observedRevision: String(value.contentRevision),
        observedContentFingerprint: fingerprint, terminalAuthorityLeafHandle: value.inputBinding.namespaceId, authorityBearing: true},
      snapshot: {recordRef: value.logicalSourceRef, observedContentFingerprint: fingerprint, posture: "authored", anchors: [room.roomAnchorRef],
        statement: payload.content, sourceRefs: [], childRecordRefs: [], structuralHeight: 0, lifecycle: "current", sourceOwnedKind: "memory",
        observedLogicalObjectRef: value.logicalSourceRef, observedRevision: String(value.contentRevision)}});
  }
  const validateMemory = async (dependency: DurableSourceDependency) => {
    input.signal.throwIfAborted();
    const match = /^memory:(.+)$/.exec(dependency.logicalSourceRef);
    if (dependency.sourceKind !== "memory" || match === null || !dependency.authorityBearing) throw unavailable();
    const current = await input.resolveMemoryDependency({memoryRef: match[1]!, namespaceId: dependency.terminalAuthorityLeafHandle,
      ...(dependency.observedRevision === undefined ? {} : {observedRevision: dependency.observedRevision}), signal: input.signal});
    input.signal.throwIfAborted();
    if (current.status === "waiting") throw new PendingReflectionInputsRequired();
    if (current.status === "missing") return "unavailable" as const;
    if (current.status === "unavailable") throw unavailable();
    if (current.status === "changed") return "changed" as const;
    if (current.status !== "available") throw unavailable();
    const expected = input.memories.get(dependency.logicalSourceRef), value = memoryValues.get(dependency.logicalSourceRef);
    // An available but undeclared body is never classified as lost or opened here.
    if (expected === undefined || value === undefined) throw unavailable();
    if (current.metadata.contentRevision !== expected.contentRevision || current.metadata.cryptoAccessRevision !== expected.cryptoAccessRevision
      || digest(current.metadata.inputBinding) !== digest(expected.inputBinding) || dependency.observedRevision !== value.dependency.observedRevision
      || dependency.observedContentFingerprint !== value.dependency.observedContentFingerprint
      || dependency.terminalAuthorityLeafHandle !== expected.inputBinding.namespaceId || !dependency.authorityBearing) return "changed" as const;
    return "current" as const;
  };
  const sources: CanonicalRecordSourceReadPort = {async readExact(request) {
    request.signal?.throwIfAborted();
    const status = await validateMemory(request.dependency);
    request.signal?.throwIfAborted(); input.signal.throwIfAborted();
    if (status !== "current") return {status};
    const content = memoryValues.get(request.dependency.logicalSourceRef)!.snapshot.statement;
    if (new TextEncoder().encode(content).byteLength > request.returnedBytesMaximum) throw unavailable();
    return {status: "available", kind: "memory", content};
  }};
  const dispose = () => {memoryValues.clear(); input.signal.removeEventListener("abort", dispose);};
  input.signal.addEventListener("abort", dispose, {once: true});
  return {memoryValues, validateMemory, sources, dispose};
}

/** Reuses the existing Organizer merge after the complete question gate opened its inputs. */
export function createPreparedReflectionCrossRoomPartition(input: {
  readonly discovery: Extract<CrossRoomOrganizerDiscoveryResult, {status: "available"}>;
  readonly records: ReadonlyMap<string, ReturnType<typeof decodeDurableRecordEnvelope>>;
  readonly memories: ReadonlyMap<string, RoomLocalMemoryCandidate>;
  readonly assertCurrent: () => Promise<void>;
  readonly publicationPlan: () => CrossRoomPublicationPlan;
}): CrossRoomOrganizerPartitionPort {
  return {
    async augment() {
      await input.assertCurrent();
      const candidates: DurableSleepOrganizerView["candidates"][number][] = [];
      const existingParents: DurableSleepOrganizerView["existingParents"][number][] = [];
      for (const candidate of input.discovery.candidates) {
        if (candidate.kind === "record") {
          const record = input.records.get(candidate.recordRef);
          if (record === undefined || record.lifecycle !== "current"
            || record.processingGeneration !== candidate.recordProcessingGeneration) throw unavailable();
          const entry = {handle: "unused", snapshot: durableEnvelopeToRecordSnapshot(record),
            dependency: {kind: "record" as const, recordRef: candidate.recordRef}};
          (candidate.structuralHeight > 0 ? existingParents : candidates).push(entry);
        } else {
          const memory = input.memories.get(candidate.logicalSourceRef);
          if (memory === undefined || memory.dependency.observedRevision !== String(candidate.contentRevision)) throw unavailable();
          candidates.push({handle: "unused", snapshot: memory.snapshot, dependency: {kind: "source", dependency: memory.dependency}});
        }
      }
      return {status: "available", candidates, existingParents,
        applicationPlanToken: crossRoomApplicationPlanToken("protected-prepared-question"),
        unsupportedAuthorityShapes: input.discovery.metrics.unsupportedAuthorityShapes,
        authorityParentsResolved: input.discovery.metrics.authorityParentsResolved,
        authorityParentsSkipped: input.discovery.metrics.authorityParentsSkipped, protectedExecutionUnavailable: 0};
    },
    planPublication: () => Promise.resolve({status: "planned", plan: input.publicationPlan()}),
    planDependencyLoss: () => Promise.resolve({status: "planned", plan: input.publicationPlan()}),
  };
}

/** Exact Message support for dependency repair, borrowed from the question gate. */
export function createGateBoundReflectionMessageSources(input: {
  readonly messages: ReadonlyMap<string, ProtectedReflectionMessageMetadata>;
  readonly payloads: ReadonlyMap<string, {readonly plaintext: Uint8Array}>;
  readonly roomAnchorRef: string;
  readonly signal: AbortSignal;
  readonly resolveMessage: PostgresProtectedReflectionMessageMetadata["resolveMessage"];
}) {
  const messageValues = new Map<string, RoomLocalMemoryCandidate>();
  for (const metadata of input.messages.values()) {
    const bytes = input.payloads.get(metadata.inputBinding.objectId);
    if (bytes === undefined) throw unavailable();
    const payload = decodeMessagePayloadV2(bytes.plaintext);
    if (payload.role !== metadata.role) throw unavailable();
    const fingerprint = reflectionMessageSourceFingerprint({id: metadata.messageId, editRevision: metadata.editRevision, content: payload.content});
    messageValues.set(metadata.logicalSourceRef, {score: 0,
      dependency: {sourceKind: "message", logicalSourceRef: metadata.logicalSourceRef, observedRevision: String(metadata.editRevision),
        observedContentFingerprint: fingerprint, terminalAuthorityLeafHandle: metadata.inputBinding.namespaceId, authorityBearing: true},
      snapshot: {recordRef: metadata.logicalSourceRef, observedContentFingerprint: fingerprint, posture: "authored",
        anchors: [metadata.roomId], statement: payload.content, sourceRefs: [], childRecordRefs: [], structuralHeight: 0,
        lifecycle: "current", sourceOwnedKind: "message", observedLogicalObjectRef: metadata.logicalSourceRef,
        observedRevision: String(metadata.editRevision)}});
  }
  const sources: CanonicalRecordSourceReadPort = {async readExact(request) {
    request.signal?.throwIfAborted(); input.signal.throwIfAborted();
    const dependency = request.dependency;
    const match = /^message:([1-9][0-9]*)$/.exec(dependency.logicalSourceRef);
    if (dependency.sourceKind !== "message" || match === null || !dependency.authorityBearing) return {status: "unavailable"};
    const messageId = Number(match[1]);
    if (!Number.isSafeInteger(messageId)) return {status: "unavailable"};
    const current = await input.resolveMessage({messageId, roomId: input.roomAnchorRef,
      namespaceId: dependency.terminalAuthorityLeafHandle,
      ...(dependency.observedRevision === undefined ? {} : {observedRevision: dependency.observedRevision}), signal: input.signal});
    if (current.status === "waiting") throw new PendingReflectionInputsRequired();
    if (current.status === "missing") return {status: "unavailable"};
    if (current.status === "unavailable") throw unavailable();
    if (current.status === "changed") return {status: "changed"};
    if (current.status !== "available") throw unavailable();
    const expected = input.messages.get(dependency.logicalSourceRef), value = messageValues.get(dependency.logicalSourceRef);
    // An available but undeclared body is never classified as lost or opened here.
    if (expected === undefined || value === undefined || digest(current.metadata) !== digest(expected)) throw unavailable();
    if (dependency.observedRevision !== value.dependency.observedRevision
      || dependency.observedContentFingerprint !== value.dependency.observedContentFingerprint) return {status: "changed"};
    const content = value.snapshot.statement;
    if (new TextEncoder().encode(content).byteLength > request.returnedBytesMaximum) throw unavailable();
    request.signal?.throwIfAborted(); input.signal.throwIfAborted();
    return {status: "available", kind: "message", content};
  }};
  const dispose = () => {messageValues.clear(); input.signal.removeEventListener("abort", dispose);};
  input.signal.addEventListener("abort", dispose, {once: true});
  return {messageValues, sources, dispose};
}

/** Exact protected Message coordinate bound to the Message's own Namespace. */
export function createProtectedReflectionMessageCoordinate(input: Readonly<{
  message: ProtectedReflectionMessageMetadata;
  selection: RecordRepositorySelection;
}>): CrossRoomInputCoordinate {
  if (input.selection.selectedRepresentation !== "protected"
    || !Number.isSafeInteger(input.selection.migrationGeneration)
    || input.selection.migrationGeneration < 1) throw unavailable();
  const namespaceRef = input.message.inputBinding.namespaceId;
  return {
    kind: "source", role: "candidate", sourceKind: "message",
    logicalSourceRef: input.message.logicalSourceRef,
    contentGeneration: input.message.editRevision,
    representationGeneration: input.message.editRevision + 1,
    authorityGeneration: input.message.namespaceAccessRevision + 1,
    read: {namespaceRef,
      bindingRef: `journal:namespace:${namespaceRef}:protected:v${input.selection.migrationGeneration}`},
  };
}

/** Materialize the audience of all declared inputs before requesting any plaintext. */
export async function resolveProtectedReflectionOutputAudience(input: {
  readonly inputBindings: ReflectionSemanticOperationRequest["coordinates"]["inputBindings"];
  readonly accessAudiences: RecordAccessAudiencePort;
  readonly sourceAuthority: CanonicalSourceAuthorityPort;
  readonly signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const recordNamespaces = [...new Set(input.inputBindings.filter(value => value.objectType === "nautilo.reflection.record.v1")
    .map(value => value.namespaceId))].sort();
  const memoryNamespaces = [...new Set(input.inputBindings.filter(value => value.objectType !== "nautilo.reflection.record.v1")
    .map(value => value.namespaceId))].sort();
  const alternatives: import("@nautilo/reflection/authority").EffectiveAudienceAlternative[][] = [];
  if (recordNamespaces.length > 0) {
    const current = await input.accessAudiences.readExactSet(recordNamespaces);
    if (current.status !== "available" || current.audiences.length !== recordNamespaces.length) return null;
    // This helper selects only the membership set. The signed source plan and
    // post-open publication planner retain each Record's public-boundary fact.
    alternatives.push(...current.audiences.map(humanRefs => [{humanRefs, includesPublicBoundary: false}]));
  }
  for (const namespace of memoryNamespaces) {
    const current = await input.sourceAuthority.resolve(namespace);
    if (current.status !== "available") return null;
    alternatives.push([...current.leaf.alternatives]);
  }
  if (alternatives.length === 0) return null;
  let intersection = intersectSingleAuthorityAlternatives([alternatives[0]!]);
  for (const next of alternatives.slice(1)) {
    if (intersection.status !== "available") return null;
    // Exact graph inventories may exceed the model candidate limit. Reuse the
    // same associative intersection without applying that unrelated item cap.
    intersection = intersectSingleAuthorityAlternatives([[intersection.alternative], next]);
  }
  input.signal?.throwIfAborted();
  return intersection.status === "available" ? input.accessAudiences.resolveOrCreateExact(intersection.alternative.humanRefs) : null;
}

export interface ProductionProtectedReflectionSemanticsInput {
  readonly db: DirectDatabase;
  readonly productHandle: RecordProductPostgresHandle;
  readonly selection: RecordRepositorySelection;
  readonly commitmentKey: Uint8Array;
  readonly operation: ReflectionSemanticOperationPort;
  readonly readiness: Pick<DurableSleepSemanticPort, "ensureAuthority" | "ensureSearchProjection">;
  readonly model: DurableOrganizerModelPort;
  readonly resolveParentConflict: DurableSleepSemanticPort["resolveParentConflict"];
  readonly sourceInvalidation: RecordSourceInvalidationPort;
  readonly nextRetryAt: () => number;
  readonly roomQueries?: CanonicalRoomAuthorityQueries;
}

/** One production semantic port for the existing worker; owns no scheduler or durable queue. */
export function createProductionProtectedReflectionSemantics(input: ProductionProtectedReflectionSemanticsInput): DurableSleepSemanticPort {
  if (input.selection.selectedRepresentation !== "protected") throw unavailable();
  const selection = input.selection;
  const semanticCommitments = createHmacRecordSemanticCommitmentPort(input.commitmentKey);
  const work = new PostgresSemanticWorkStore({handle: input.productHandle, commitments: semanticCommitments});
  const product = new PostgresRecordProductStore(input.productHandle, work);
  const publications = new PostgresCurrentRecordPublicationBinding(input.productHandle, selection);
  const bindings = createCanonicalSameRoomBindingPorts({selection, publications,
    searchCommitments: createHmacRecordSearchCommitmentPort(input.commitmentKey),
    ...(input.roomQueries === undefined ? {} : {roomQueries: input.roomQueries})});
  const accessAudiences = createCanonicalRecordAccessAudience({db: input.db});
  const messageMetadata = new PostgresProtectedReflectionMessageMetadata(input.productHandle);
  const metadata = new PostgresProtectedOrganizerMetadata({product: createPostgresJsBridgeConnection(input.db), rooms: bindings.evidence});
  const projections = new PostgresRecordSearchProjectionStore(input.productHandle);
  const store = new PostgresSameRoomOrganizerStore(input.productHandle);
  const readBinding = async (recordRef: string) => {
    const current = await publications.read(recordRef);
    if (current === null || current.currentAccessBindingRefs.length !== 1) return null;
    const bindingRef = current.currentAccessBindingRefs[0]!;
    const room = await bindings.evidence.resolve(bindingRef);
    return room === null ? null : {bindingRef, ...room};
  };
  const denied: ProtectedRecordPublicationPort = {open: () => Promise.resolve({status: "unavailable", reason: "unauthorized"}),
    publish: () => Promise.reject(unavailable()), verify: () => Promise.resolve("incomplete"), retire: () => Promise.reject(unavailable())};
  const metadataRepository = new DualModeRecordRepository({selection, product, commitment: createHmacRecordRequestCommitmentPort(input.commitmentKey), protectedPublication: denied});
  const crossRoomStore = new PostgresCrossRoomOrganizerStore(input.productHandle);
  const discovery = new PostgresSameRoomOrganizerNeighbors({selection, projections, store, repository: metadataRepository});
  type FamilyValue = ProtectedReflectionSemanticQuestionValue & {
    resolveDependencyLoss(application: Parameters<DurableSleepSemanticPort["resolveDependencyLoss"]>[0], complete: CompleteOutput,
      assertCurrent: () => Promise<void>): ReturnType<DurableSleepSemanticPort["resolveDependencyLoss"]>;
  };
  const prepareQuestion = async (claim: DurableSleepClaim, signal?: AbortSignal, dependencyMode = false): Promise<
    PreparedReflectionSemanticQuestion<FamilyValue> | Exclude<DurableSleepOrganizerViewResult, {status: "ready"}>> => {
      if (dependencyMode && claim.changeReason !== "dependency_lost") throw unavailable();
      const workKind = dependencyMode ? "reflection.dependency_rewrite" as const : "reflection.organization" as const;
      const current = await readBinding(claim.recordRef), initial = await bindings.semantic.resolveWork(claim.recordRef);
      const origin = await bindings.invocation.resolve(claim.recordRef);
      const originPublication = await publications.readOrigin(claim.recordRef);
      if (current === null || initial === null || origin === null || originPublication === null) return rejectedView;
      const changed = await metadata.resolveRecord({recordRef: claim.recordRef, namespaceId: current.namespaceId, ...(dependencyMode ? {allowStale: true} : {}), ...(signal === undefined ? {} : {signal})});
      if (changed === null) return rejectedView;
      const binding: SameRoomSemanticBinding = {roomAnchorRef: origin.roomId, readBindingRef: initial.readBindingRef,
        searchBindingRef: initial.readBindingRef, publicationBindingRef: originPublication, invocationAudience: initial.invocationAudience};
      const discovered = dependencyMode ? undefined : await discovery.discover({changed: {recordRef: claim.recordRef, processingGeneration: changed.processingGeneration}, binding,
        intent: claim.changeReason === "scheduled_review" ? "promotion" : "attachment", ...(signal === undefined ? {} : {signal})});
      if (discovered !== undefined && discovered.status !== "available") return {status: "unavailable", failureCode: "candidate_unavailable", failureDetail: discovered.reason};
      if (discovered?.status === "available" && discovered.discovery.changedAlreadyParented) return {status: "no_change", reason: "already_covered"};
      const memories = discovered === undefined || claim.changeReason === "scheduled_review" ? {status: "available" as const, candidates: []}
        : await metadata.searchMemories({roomAnchorRef: origin.roomId, embedding: discovered.discovery.queryEmbedding,
          limit: CANDIDATE_POLICY_V1.sameRoomBound, ...(signal === undefined ? {} : {signal})});
      if (memories.status !== "available") return rejectedView;
      const selected = discovered === undefined ? [] : selectSameRoomOrganizerCoordinates({records: discovered.discovery.candidateCoordinates,
        authorityParentRecords: discovered.discovery.authorityParentCandidateCoordinates,
        memories: memories.candidates.map(value => ({sourceKind: "memory", logicalSourceRef: value.logicalSourceRef, score: value.score}))});
      const crossRoom = discovered === undefined ? undefined : await crossRoomStore.discover({
        embedding: discovered.discovery.queryEmbedding, invocationAudience: binding.invocationAudience, selection,
        changedRecordRef: claim.recordRef, changedPublicationBindingRef: originPublication,
        authorityParentSeeds: [...selected.flatMap(value => value.kind === "authority_parent" ? [value.coordinate] : []),
          ...discovered.discovery.authorityParentTargetCoordinates].map(value => ({recordRef: value.recordRef, score: value.score}))});
      if (crossRoom !== undefined && crossRoom.status !== "available") return rejectedView;
      const assertCrossRoomCurrent = async () => {
        signal?.throwIfAborted();
        if (crossRoom !== undefined && (await crossRoomStore.fence({selection, changed: crossRoom.changed,
          candidates: crossRoom.candidates})).status !== "current") throw unavailable();
        signal?.throwIfAborted();
      };
      await assertCrossRoomCurrent();
      const coordinates = [...selected.flatMap(value => value.kind === "record" ? [value.coordinate] : []),
        ...(discovered?.discovery.parentTargetCoordinates ?? []),
        ...(crossRoom?.candidates.flatMap(value => value.kind === "record" ? [{...value, projectionGeneration: value.searchProjectionGeneration}] : []) ?? [])];
      const exactMemories = new Map<string, ProtectedOrganizerMemoryMetadata>();
      const exactMessages = new Map<string, ProtectedReflectionMessageMetadata>();
      for (const coordinate of selected) {
        if (coordinate.kind !== "source") continue;
        const value = memories.candidates.find(candidate => candidate.logicalSourceRef === coordinate.logicalSourceRef);
        if (value === undefined) return rejectedView;
        exactMemories.set(value.logicalSourceRef, value);
      }
      for (const candidate of crossRoom?.candidates ?? []) {
        if (candidate.kind !== "memory") continue;
        const value = await metadata.resolveMemory({memoryRef: candidate.memoryRef, namespaceId: candidate.readNamespaceRef,
          ...(signal === undefined ? {} : {signal})});
        if (value === null || value.contentRevision !== candidate.contentRevision
          || value.inputBinding.objectId !== candidate.protectedCryptoObjectId
          || value.cryptoAccessRevision !== candidate.protectedCryptoAccessRevision) return rejectedView;
        exactMemories.set(value.logicalSourceRef, value);
      }
      const previousInputs = await input.operation.readPendingInputBindings?.({workKind,
        recordRef: claim.recordRef, claimGeneration: claim.generation, ...(signal === undefined ? {} : {signal})}) ?? [];
      for (const previous of previousInputs) {
        if (dependencyMode && previous.objectType === "nautilo-message-v2") {
          const value = await messageMetadata.resolveMessageObject({objectId: previous.objectId, namespaceId: previous.namespaceId,
            ...(signal === undefined ? {} : {signal})});
          if (value !== null && value.roomId === origin.roomId) exactMessages.set(value.logicalSourceRef, value);
          continue;
        }
        if (previous.objectType !== "nautilo-memory-v1") continue;
        const value = await metadata.resolveMemoryObject({objectId: previous.objectId, namespaceId: previous.namespaceId,
          ...(signal === undefined ? {} : {signal})});
        if (value !== null) exactMemories.set(value.logicalSourceRef, value);
      }
      const exact = new Map<string, {metadata: ProtectedOrganizerRecordMetadata; bindingRef: string}>();
      exact.set(changed.recordRef, {metadata: changed, bindingRef: current.bindingRef});
      const pending = [...new Set([claim.recordRef, ...coordinates.map(value => value.recordRef)])];
      const queued = new Set(pending);
      for (let cursor = 0; cursor < pending.length; cursor++) {
        signal?.throwIfAborted();
        const recordRef = pending[cursor]!;
        if (!exact.has(recordRef)) {
          const access = await readBinding(recordRef); if (access === null) {if (dependencyMode) continue; return rejectedView;}
          const expected = coordinates.find(value => value.recordRef === recordRef);
          const value = await metadata.resolveRecord({recordRef, namespaceId: access.namespaceId,
            ...(expected === undefined ? {} : {expected}), ...(signal === undefined ? {} : {signal})});
          if (value === null) {
            if (!dependencyMode) return rejectedView;
            const successors = await product.readGraphPage({recordId: recordRef, direction: "successors", limit: 2});
            if (successors.continuation === undefined && successors.items.length === 1) {
              const edge = successors.items[0]!;
              if (typeof edge !== "string" && !queued.has(edge.successorRecordRef)) {
                queued.add(edge.successorRecordRef); pending.push(edge.successorRecordRef);
                if (pending.length > REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.hierarchy.maxVisitedRecords) return rejectedView;
              }
            }
            continue;
          }
          exact.set(recordRef, {metadata: value, bindingRef: access.bindingRef});
        }
        let continuation: string | undefined;
        do {
          const page = await product.readGraphPage({recordId: recordRef, direction: "dependencies", limit: DURABLE_RECORD_PAGE_LIMIT_MAX,
            ...(continuation === undefined ? {} : {continuation})});
          for (const child of page.items) {
            if (typeof child !== "string") throw unavailable();
            if (!queued.has(child)) {queued.add(child); pending.push(child);}
            if (pending.length > REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.hierarchy.maxVisitedRecords) return rejectedView;
          }
          if (page.continuation === continuation && continuation !== undefined) throw unavailable();
          continuation = page.continuation;
        } while (continuation !== undefined);
      }
      // A granted Record may disclose another exact Memory dependency. Close that
      // attempt and declare the additional object through the existing request owner.
      for (;;) {
      const exactInputs = [...[...exact.values()].map(value => value.metadata.inputBinding), ...[...exactMemories.values()].map(value => value.inputBinding), ...[...exactMessages.values()].map(value => value.inputBinding)]
        .sort((left, right) => left.objectId.localeCompare(right.objectId) || left.namespaceId.localeCompare(right.namespaceId));
      const memoryBindings = new Map<string, {roomAnchorRef: string; readBindingRef: string}>();
      for (const value of exactMemories.values()) {
        const readBindingRef = `journal:namespace:${value.inputBinding.namespaceId}:protected:v${selection.migrationGeneration}`;
        const room = await bindings.evidence.resolve(readBindingRef);
        if (room === null || room.namespaceId !== value.inputBinding.namespaceId) return rejectedView;
        memoryBindings.set(value.logicalSourceRef, {roomAnchorRef: room.roomId, readBindingRef});
      }
      await assertCrossRoomCurrent();
      const output = await resolveProtectedReflectionOutputAudience({inputBindings: exactInputs, accessAudiences,
        sourceAuthority: new CanonicalRoomNamespaceSourceAuthority(), ...(signal === undefined ? {} : {signal})});
      if (output === null) return rejectedView;
      let publication: ReturnType<typeof createGateBoundReflectionRecordPublication> | undefined;
      let memorySources: ReturnType<typeof createGateBoundReflectionMemorySources> | undefined;
      let messageSources: ReturnType<typeof createGateBoundReflectionMessageSources> | undefined;
      try {
      const prepared = await prepareReflectionSemanticQuestion({operation: input.operation,
        request: {workKind, coordinates: {recordRef: claim.recordRef, claimGeneration: claim.generation,
          inputBindings: exactInputs, outputNamespaceIds: [output.accessNamespaceId]}, ...(signal === undefined ? {} : {signal}),
          validateInput: value => {
            if (value.objectType === "nautilo-message-v2") {
              const expected = [...exactMessages.values()].find(entry => entry.inputBinding.objectId === value.objectId && entry.inputBinding.namespaceId === value.namespaceId);
              if (expected === undefined || decodeMessagePayloadV2(value.plaintext).role !== expected.role) throw unavailable();
              return Promise.resolve();
            }
            if (value.objectType === "nautilo-memory-v1") {
              if (![...exactMemories.values()].some(entry => entry.inputBinding.objectId === value.objectId && entry.inputBinding.namespaceId === value.namespaceId)) throw unavailable();
              decodeMemoryPayloadV1(value.plaintext); return Promise.resolve();
            }
            const expected = [...exact.values()].find(entry => entry.metadata.inputBinding.objectId === value.objectId && entry.metadata.inputBinding.namespaceId === value.namespaceId);
            if (expected === undefined || value.objectType !== "nautilo.reflection.record.v1") throw unavailable();
            const decoded = decodeDurableRecordEnvelope({...expected.metadata, payloadBytes: value.plaintext});
            if (decoded.semantic.producer.policyVersion !== expected.metadata.producerPolicyVersion) throw unavailable();
            return Promise.resolve();
          },
          validateOutput: value => {if (publication === undefined) throw unavailable(); publication.validateOutput(value); return Promise.resolve();},
          attach: async operation => {
            await assertCrossRoomCurrent();
            if (publication === undefined || operation.held.product === undefined) throw unavailable();
            const held = operation.held.product;
            const handle = await verifyRecordProductPostgresHandle({query: held.query.bind(held), transaction: use => use(held)});
            const fencedWork = new PostgresSemanticWorkStore({handle, commitments: semanticCommitments});
            const result = await fencedWork.withClaimPublicationFence(claim, async () => {
              await publication!.attach({...operation, authorizeCommit: async () => {
                const authorizedAt = await operation.authorizeCommit();
                if (crossRoom !== undefined && (await crossRoomStore.fence({selection, changed: crossRoom.changed,
                  candidates: crossRoom.candidates}, handle)).status !== "current") throw unavailable();
                return authorizedAt;
              }}, new PostgresRecordProductStore(handle, fencedWork));
              // The product effect and source acknowledgement commit together;
              // neither a lost reply nor process death may re-run this question.
              await fencedWork.completeVerifiedGeneration({recordRef: claim.recordRef, generation: claim.generation});
            });
            if (result.status !== "current") throw unavailable();
          }},
        prepare: async (opened, outputObjectId, executionSignal) => {
          executionSignal.throwIfAborted(); await assertCrossRoomCurrent();
          if (outputObjectId === undefined) throw unavailable();
          const payloads = new Map(opened.map(value => [value.objectId, value]));
          let expanded = false;
          for (const entry of exact.values()) {
            const payload = payloads.get(entry.metadata.inputBinding.objectId);
            if (payload === undefined) throw unavailable();
            const record = decodeDurableRecordEnvelope({...entry.metadata, payloadBytes: payload.plaintext});
            // A Record child's current statement/authority stands on its own.
            // Only possible predecessors need inherited direct-source bodies;
            // dependency rewriting reads the anchor's direct sources only.
            if (dependencyMode ? record.recordRef !== claim.recordRef
              : record.recordRef !== claim.recordRef && !coordinates.some(value => value.recordRef === record.recordRef)) continue;
            for (const dependency of record.semantic.sourceDependencies) {
              if (dependencyMode && dependency.sourceKind === "message") {
                if (exactMessages.has(dependency.logicalSourceRef)) continue;
                const match = /^message:([1-9][0-9]*)$/.exec(dependency.logicalSourceRef);
                if (match === null || !Number.isSafeInteger(Number(match[1]))) throw unavailable();
                const message = await messageMetadata.resolveMessage({messageId: Number(match[1]), roomId: origin.roomId,
                  namespaceId: dependency.terminalAuthorityLeafHandle,
                  ...(dependency.observedRevision === undefined ? {} : {observedRevision: dependency.observedRevision}), signal: executionSignal});
                if (message.status === "waiting") throw new PendingReflectionInputsRequired();
                if (message.status === "unavailable") throw unavailable();
                if (message.status !== "available") continue;
                if (exact.size + exactMemories.size + exactMessages.size >= REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.hierarchy.maxVisitedRecords) throw unavailable();
                exactMessages.set(message.metadata.logicalSourceRef, message.metadata); expanded = true;
                continue;
              }
              if (dependency.sourceKind !== "memory" || !dependency.logicalSourceRef.startsWith("memory:")) {
                if (dependencyMode) throw unavailable();
                continue;
              }
              if (exactMemories.has(dependency.logicalSourceRef)) continue;
              const memory = await metadata.resolveMemoryDependency({memoryRef: dependency.logicalSourceRef.slice(7),
                namespaceId: dependency.terminalAuthorityLeafHandle,
                ...(dependency.observedRevision === undefined ? {} : {observedRevision: dependency.observedRevision}), signal: executionSignal});
              if (memory.status === "waiting") throw new PendingReflectionInputsRequired();
              if (memory.status === "unavailable") throw unavailable();
              if (memory.status !== "available") {if (dependencyMode) continue; throw unavailable();}
              if (exact.size + exactMemories.size + exactMessages.size >= REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.budget.hierarchy.maxVisitedRecords) throw unavailable();
              exactMemories.set(memory.metadata.logicalSourceRef, memory.metadata); expanded = true;
            }
          }
          if (expanded) throw new ExpandedReflectionInputsRequired();
          memorySources = createGateBoundReflectionMemorySources({commitmentKey: input.commitmentKey,
            memories: exactMemories, payloads, scores: new Map(memories.candidates.map(value => [value.logicalSourceRef, value.score])),
            roomBindings: memoryBindings, signal: executionSignal,
            resolveMemoryDependency: value => metadata.resolveMemoryDependency(value)});
          const {memoryValues, validateMemory} = memorySources;
          messageSources = createGateBoundReflectionMessageSources({messages: exactMessages, payloads, roomAnchorRef: origin.roomId,
            signal: executionSignal, resolveMessage: value => messageMetadata.resolveMessage(value)});
          const {messageValues} = messageSources;
          const allSourceValues = new Map([...memoryValues, ...messageValues]);
          const sources: CanonicalRecordSourceReadPort = {readExact: request => request.dependency.sourceKind === "message"
            ? messageSources!.sources.readExact(request) : memorySources!.sources.readExact(request)};
          const questionProduct = new PostgresRecordProductStore(input.productHandle, work);
          publication = createGateBoundReflectionRecordPublication({product: questionProduct, outputObjectId,
            attachShadowSibling: async value => {
              if (!(value.product instanceof PostgresRecordProductStore)) throw unavailable();
              await attachReflectionShadowSibling({product: value.product, publication: value.publication,
                protectedRequestCommitment: value.requestCommitment, plaintext: value.plaintext, commitmentKey: input.commitmentKey});
            },
            open: request => {
              executionSignal.throwIfAborted();
              const expected = exact.get(request.recordId), value = payloads.get(request.objectId);
              if (expected === undefined || value === undefined || expected.metadata.inputBinding.objectId !== request.objectId
                || expected.metadata.representationGeneration !== request.representationGeneration || expected.bindingRef !== request.readBindingRef) {
                return Promise.resolve({status: "unavailable", reason: "unauthorized"});
              }
              return Promise.resolve({status: "available", payloadBytes: value.plaintext});
            }});
          const repository = new DualModeRecordRepository({selection, product: questionProduct,
            commitment: createHmacRecordRequestCommitmentPort(input.commitmentKey), protectedPublication: publication.publication});
          const questionNeighbors = new PostgresSameRoomOrganizerNeighbors({selection, projections, store, repository});
          let checkQuestionCurrent: (() => Promise<void>) | undefined;
          const composition = new SameRoomDurableSemanticComposition({repository, readiness: input.readiness, bindings: bindings.semantic,
            organizerNeighbors: {discover: () => discovered === undefined ? Promise.reject(unavailable()) : Promise.resolve(discovered), openSelected: value => questionNeighbors.openSelected(value)},
            memories: {async search() {
              const candidates: RoomLocalMemoryCandidate[] = [];
              for (const coordinate of selected) {
                if (coordinate.kind !== "source") continue;
                const candidate = memoryValues.get(coordinate.logicalSourceRef);
                if (candidate === undefined || await validateMemory(candidate.dependency) !== "current") return {status: "unavailable"};
                candidates.push(candidate);
              }
              return {status: "available", candidates};
            }}, model: input.model,
            proposals: {apply: application => {if (claim.changeReason === "parent_conflict") throw unavailable(); return publisher.apply({proposal: application.proposal, changedRecordRef: claim.recordRef,
              idempotencyKey: application.idempotencyKey, budget: application.budget, changeReason: claim.changeReason,
              publicationPlan: plan, signal: executionSignal});}},
            ...(dependencyMode ? {crossRoom: {augment: () => Promise.reject(unavailable()), planPublication: () => Promise.reject(unavailable()),
              planDependencyLoss: () => Promise.resolve({status: "planned" as const, plan})}}
              : crossRoom === undefined ? {} : {crossRoom: createPreparedReflectionCrossRoomPartition({discovery: crossRoom,
                records: new Map([...exact.values()].map(value => [value.metadata.recordRef, decodeDurableRecordEnvelope({...value.metadata,
                  payloadBytes: payloads.get(value.metadata.inputBinding.objectId)!.plaintext})])), memories: memoryValues,
                assertCurrent: async () => {executionSignal.throwIfAborted(); await assertCrossRoomCurrent();}, publicationPlan: () => plan})}),
            dependencyLoss: {resolve: loss => new ExactGroundedDependencyLossResolver({repository, recordBindings: publications,
              eligibility: new ProjectedAuthorityEligibility({projections: new PostgresAuthorityProjectionStore(input.productHandle, selection), accessAudiences}),
              source: sources, invalidation: input.sourceInvalidation, statements: {async rewrite(rewrite) {
                const result = await runDependencyLossRewrite({previousStatement: rewrite.previousStatement,
                  remainingSupportStatements: rewrite.remainingSupportStatements,
                  invoke: async (prompt, modelSignal) => {if (checkQuestionCurrent === undefined) throw unavailable(); await checkQuestionCurrent();
                    return input.model.invoke(claim, prompt, modelSignal);}, signal: executionSignal});
                return result.ok ? {status: "available", statement: result.statement, modelCalls: result.attempts} : {status: "unavailable"};
              }}}).resolve(loss)}});
          let view: DurableSleepOrganizerView;
          if (dependencyMode) {
            const records = [...exact.values()].map(value => decodeDurableRecordEnvelope({...value.metadata,
              payloadBytes: payloads.get(value.metadata.inputBinding.objectId)!.plaintext}));
            const anchor = records.find(value => value.recordRef === claim.recordRef); if (anchor === undefined) throw unavailable();
            view = {changed: {handle: "R1", snapshot: durableEnvelopeToRecordSnapshot(anchor), dependency: {kind: "record", recordRef: anchor.recordRef}},
              candidates: [...records.filter(value => value !== anchor).map((record, index) => ({handle: `R${index + 2}`,
                snapshot: durableEnvelopeToRecordSnapshot(record), dependency: {kind: "record" as const, recordRef: record.recordRef}})),
                ...[...allSourceValues.values()].map((value, index) => ({handle: `S${index + 1}`, snapshot: value.snapshot,
                  dependency: {kind: "source" as const, dependency: value.dependency}}))], existingParents: [], maxSelectedChildren: CANDIDATE_POLICY_V1.sameRoomBound};
          } else {
            const loaded = await composition.loadOrganizerView(claim, executionSignal);
            if (loaded.status !== "ready") throw unavailable(); view = loaded.view;
          }
          const visible = [view.changed, ...view.candidates, ...view.existingParents];
          const modelCoordinates: CrossRoomInputCoordinate[] = [];
          const seenVisible = new Set<string>();
          for (const entry of visible) {
            const identity = entry.dependency?.kind === "record" ? `record:${entry.dependency.recordRef}` : entry.dependency?.kind === "source" ? `source:${entry.dependency.dependency.logicalSourceRef}` : undefined;
            if (identity === undefined) throw unavailable();
            if (seenVisible.has(identity)) continue;
            seenVisible.add(identity);
            if (entry.dependency?.kind === "record") {
              const value = exact.get(entry.dependency.recordRef); if (value === undefined) throw unavailable();
              modelCoordinates.push({kind: "record", role: entry === view.changed ? "changed" : "candidate",
                recordRef: value.metadata.recordRef, processingGeneration: value.metadata.processingGeneration,
                representationGeneration: value.metadata.representationGeneration, authorityGeneration: value.metadata.authorityProjectionGeneration,
                read: {namespaceRef: value.metadata.inputBinding.namespaceId, bindingRef: value.bindingRef}});
            } else if (entry.dependency?.kind === "source") {
              const sourceRef = entry.dependency.dependency.logicalSourceRef;
              const message = exactMessages.get(sourceRef);
              if (message !== undefined) {
                modelCoordinates.push(createProtectedReflectionMessageCoordinate({message, selection}));
                continue;
              }
              const value = exactMemories.get(sourceRef); if (value === undefined) throw unavailable();
              const cross = crossRoom?.candidates.find(candidate => candidate.kind === "memory" && candidate.logicalSourceRef === sourceRef);
              modelCoordinates.push({kind: "source", role: "candidate", sourceKind: "memory", logicalSourceRef: value.logicalSourceRef,
                contentGeneration: value.contentRevision, representationGeneration: value.contentRevision + 1,
                authorityGeneration: value.cryptoAccessRevision + 1,
                ...(cross?.kind !== "memory" ? {} : {crossRoomFence: {memoryRef: cross.memoryRef,
                  embeddingRevision: cross.embeddingRevision, embeddingProvenance: cross.embeddingProvenance,
                  updatedAtCoordinate: cross.updatedAtCoordinate, authorityNamespaceRefs: cross.authorityNamespaceRefs,
                  audience: cross.audience, protectedObjectId: cross.protectedCryptoObjectId!,
                  protectedAccessRevision: cross.protectedCryptoAccessRevision!}}),
                read: {namespaceRef: value.inputBinding.namespaceId, bindingRef: memoryBindings.get(sourceRef)!.readBindingRef}});
            } else throw unavailable();
          }
          const coordinateKey = (value: CrossRoomInputCoordinate) => value.kind === "record" ? `record\0${value.recordRef}` : `source\0${value.sourceKind}\0${value.logicalSourceRef}`;
          modelCoordinates.sort((left, right) => left.role !== right.role ? left.role === "changed" ? -1 : 1
            : coordinateKey(left) < coordinateKey(right) ? -1 : coordinateKey(left) > coordinateKey(right) ? 1 : 0);
          const candidatePlan: CrossRoomCandidatePlan = {workRef: claim.logicalObjectRef, workGeneration: claim.generation,
            policyVersion: CANDIDATE_POLICY_V1.version, inputs: modelCoordinates,
            commitments: {authority: digest(modelCoordinates.map(value => [value.kind === "record" ? value.recordRef : value.logicalSourceRef, value.authorityGeneration])),
              representation: digest(modelCoordinates), search: digest(coordinates)},
            budget: {maxInputItems: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputItems, maxInputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes,
              maxModelCalls: 2, maxOutputItems: 1, maxOutputBytes: CROSS_ROOM_EXECUTION_PLAN_LIMITS.outputBytes},
            idempotencyKey: `sleep:${claim.logicalObjectRef}:${claim.generation}`};
          const planner = new ExactCrossRoomPublicationPlanner({selection, repository,
            authority: new PostgresAuthorityProjectionStore(input.productHandle, selection),
            sourceAuthority: new CanonicalRoomNamespaceSourceAuthority(), accessAudiences, recordBindings: publications,
            memoryFences: new PostgresCrossRoomOrganizerStore(input.productHandle)});
          const modelExposureDependencies = modelCoordinates.map(value => {
            if (value.kind === "source") return {kind: "source" as const, ...allSourceValues.get(value.logicalSourceRef)!.dependency};
            const metadata = exact.get(value.recordRef)!.metadata;
            const envelope = decodeDurableRecordEnvelope({...metadata, payloadBytes: payloads.get(metadata.inputBinding.objectId)!.plaintext});
            return {kind: "record" as const, recordRef: value.recordRef, observedProcessingGeneration: value.processingGeneration,
              terminalAuthorityLeafHandles: envelope.semantic.terminalAuthorityLeafHandles};
          });
          const fixed = await planner.planExposure({applicationPlanToken: crossRoomApplicationPlanToken(`protected.${digest(candidatePlan)}`),
            candidatePlan, modelExposureDependencies, signal: executionSignal});
          if (fixed.status !== "planned" || fixed.plan.output.accessNamespaceRef !== output.accessNamespaceId
            || fixed.plan.output.accessRoomRef !== output.accessRoomId) throw unavailable();
          const plan: CrossRoomPublicationPlan = fixed.plan;
          const gatePublication = publication;
          const publisher = new OrganizerProposalPublisher({repository: {
            read: value => repository.read(value), readCompletedPublication: value => repository.readCompletedPublication(value),
            publish: value => repository.publish(value), transitionLifecycle: value => gatePublication.transitionLifecycle(value)},
            sourceDependencies: {async validate(request) {const result = await sources.readExact({dependency: request.dependency, evidenceBindingRef: request.readBindingRef,
              ...(request.signal === undefined ? {} : {signal: request.signal}), returnedBytesMaximum: CROSS_ROOM_EXECUTION_PLAN_LIMITS.inputBytes}); return result.status === "available" ? "current" : "unavailable";}},
            identity: createHmacOrganizerPublicationIdentityPort(input.commitmentKey), crossRoomFences: planner, recordBindings: publications,
            preserveExactPlanInvocationOrigin: true,
            room: {roomAnchorRef: binding.roomAnchorRef, terminalAuthorityLeafHandle: current.namespaceId,
              readBindingRef: binding.readBindingRef, publicationBindingRef: binding.publicationBindingRef, producerPolicyVersion: CANDIDATE_POLICY_V1.version}});
          return {view, async applyProposal(application, complete) {
            gatePublication.setCompletion(complete);
            try {
              if (application.claim !== claim || application.claim.changeReason === "parent_conflict") throw unavailable();
              const result = await publisher.apply({proposal: application.proposal, changedRecordRef: claim.recordRef,
                idempotencyKey: application.idempotencyKey, budget: application.budget, changeReason: application.claim.changeReason,
                publicationPlan: plan, signal: executionSignal});
              if (result.status === "applied" && result.operation === "no_change") await gatePublication.finishNoChange();
              return result;
            } finally {gatePublication.dispose();}
          }, async resolveDependencyLoss(application, complete, assertCurrent) {
            gatePublication.setCompletion(complete); checkQuestionCurrent = assertCurrent;
            try {
              if (!dependencyMode || application.claim !== claim) throw unavailable();
              await assertCurrent();
              return await composition.resolveDependencyLoss({...application, signal: executionSignal,
                publication: {assertCurrent, publish: async use => {await assertCurrent(); return use();}}});
            } finally {checkQuestionCurrent = undefined; gatePublication.dispose();}
          }} satisfies FamilyValue;
        }});
      if (prepared.status !== "ready") return prepared.status === "waiting" ? {status: "waiting", retryAt: input.nextRetryAt()}
        : {status: "unavailable", failureCode: "publication_unavailable", failureDetail: "publication_incomplete"};
      return {status: "ready", get value() {return prepared.value;}, assertCurrent: async () => {await prepared.assertCurrent(); await assertCrossRoomCurrent();}, complete: value => prepared.complete(value),
        async close() {try {await prepared.close();} finally {publication?.dispose(); memorySources?.dispose(); messageSources?.dispose();}}};
      } catch (error) {
        publication?.dispose(); memorySources?.dispose(); messageSources?.dispose();
        if (error instanceof PendingReflectionInputsRequired && !signal?.aborted) return {status: "waiting", retryAt: input.nextRetryAt()};
        if (!(error instanceof ExpandedReflectionInputsRequired) || signal?.aborted) throw error;
      }
      }
  };
  return createProtectedReflectionSemanticQuestions({
    ...input.readiness, resolveParentConflict: input.resolveParentConflict,
    invokeOrganizer: (claim, prompt, signal) => input.model.invoke(claim, prompt, signal),
    invokeOrganizerBatch: (claims, prompt, signal) => input.model.invokeBatch(claims, prompt, signal),
    ...(input.model.readiness === undefined ? {} : {modelLaneReadiness: (signal?: AbortSignal) => input.model.readiness!(signal)}),
    async assertClaimCurrent(claim, signal) {signal?.throwIfAborted(); if (!await work.isClaimCurrent(claim)) throw unavailable(); signal?.throwIfAborted();},
    prepareQuestion,
    async resolveDependencyLoss(application) {
      const question = await prepareQuestion(application.claim, application.signal, true);
      if (question.status !== "ready") return question.status === "waiting" ? question : {status: "unavailable", failureCode: "candidate_unavailable"};
      try {
        let completed = false;
        const result = await question.value.resolveDependencyLoss(application, async output => {
          const result = await question.complete(output); completed = result.status === "executed"; return result;
        }, () => question.assertCurrent());
        if (result.status === "applied" && !completed) throw unavailable();
        return result;
      } catch (error) {
        if (error instanceof PendingReflectionInputsRequired && !application.signal?.aborted) return {status: "waiting", retryAt: input.nextRetryAt()};
        throw error;
      } finally {await question.close();}
    },
  });
}
