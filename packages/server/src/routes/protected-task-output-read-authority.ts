import {
  actors, asc, roomMembers, findProjectionRoomByIdWith,
  protectedTaskSemanticAuthorityRequirementsDigest,
  createPostgresJsBridgeConnection, eq, getSharedDirectCryptoDb,
  protectedTaskRunMessageOperationId, protectedTaskRunOutputBindingId,
  protectedTaskRunWakeJobId, protectedTaskRunWakeOperationId, rooms,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { lockAtomicProjectionDestinationAuthority, fingerprintProjectionAudience } from "@nautilo/agent";
import { protectedTaskProjectionDestinationAuthorityDigest, type ProtectedTaskProjectionPlanDestination } from "./protected-task-memory-projection-plan";
import type { ForegroundMemoryProjectionDestination } from "./foreground-memory-repository";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  inspectTaskOutputNamespaceAuthority, withTaskOutputNamespaceAuthority, withTaskOutputRecipientAuthority,
  withTaskOutputProductAuthority, withCurrentTaskOutputRuntimeAuthority,
  withCurrentAcceptedTaskOutputRuntimeClaimAuthority,
  withPostgresTaskWakeLiveShadowAuthority,
  type PostgresTaskWakeLiveShadowAuthorityInput,
  type TaskWakeLiveShadowCurrentWriter,
  type AcceptedTaskRuntimeAuthorizationV3, type CurrentTaskRuntimeAuthority,
  type NativeProtectedTaskRunResultOccurrenceV1, type StenographerRequestAdmission,
  type TaskOutputNamespaceAuthority, type TaskOutputNamespaceAuthorityInput,
  type TaskOutputRecipientAuthority, type TaskRuntimeAuthoritySubject,
  type TaskRuntimeDomainAuthorityRequirement, type TaskRuntimeNamespaceAuthorityRequirement,
} from "@nautilo/lattice-bridge/server";
import { findActorByOwnerId, type CanonicalTranscriptTx } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  createProtectedTaskOutputReadProductProofLoader,
  createProtectedTaskWakeSettledProductProofLoader,
  createProtectedTaskWakeParkingProductProofLoader, createProtectedTaskWakeParkedProductProofLoader,
  type ProtectedTaskWakeCommittedPark,
  type ProtectedTaskWakeCommittedSettlement,
  type ProtectedTaskOutputReadProductProofLoader,
  type ProtectedTaskOutputReadIntent,
} from "./protected-task-output-read-product";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";

type PlanningSubject = Pick<TaskRuntimeAuthoritySubject, "userId" | "humanActorId">;

export type ProtectedTaskWakeForegroundInventory = Readonly<{
  namespaceIds: readonly string[];
}>;

/** Supplied by the canonical foreground owner, never inferred from the result grant. */
export type ProtectedTaskWakeForegroundAdmission = Readonly<{
  discover(input: Readonly<{ intent: ProtectedTaskOutputReadIntent; subject: PlanningSubject }>):
    Promise<ProtectedTaskWakeForegroundInventory | null>;
  /** Read current canonical foreground/Scope evidence and hold its mutation fences on this transaction. */
  readCurrent(input: Readonly<{
    intent: ProtectedTaskOutputReadIntent;
    subject: PlanningSubject;
    product: PostgresJsBridgeConnection;
    transaction: CanonicalTranscriptTx;
    expectedNamespaceIds: readonly string[];
    /** Internal accepted-grant restriction; every retained ID must remain canonically readable. */
    retainedNamespaceIds?: readonly string[];
  }>): Promise<ProtectedTaskWakeForegroundInventory | null>;
}>;

type Coordinates<Subject extends PlanningSubject = TaskRuntimeAuthoritySubject> = Readonly<{
  intent: ProtectedTaskOutputReadIntent;
  subject: Subject;
  restricted?: PostgresJsBridgeConnection;
  signal?: AbortSignal;
}>;
type OutputFacts = Readonly<{
  occurrence: NativeProtectedTaskRunResultOccurrenceV1;
  namespaceAuthority: TaskOutputNamespaceAuthority;
  resultNamespaceRequirement: TaskRuntimeNamespaceAuthorityRequirement;
  foregroundNamespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
}>;
export type ProtectedTaskOutputReadPlanningAuthority = Readonly<{
  namespaceAuthority: TaskOutputNamespaceAuthority;
  occurrence: NativeProtectedTaskRunResultOccurrenceV1;
}>;
export type ProtectedTaskOutputReadCurrentAuthority = CurrentTaskRuntimeAuthority & OutputFacts;
export type ProtectedTaskOutputReadDiscoveryAuthority = TaskOutputRecipientAuthority & OutputFacts &
  Readonly<{ restricted: PostgresJsBridgeConnection }>;

export type ProtectedTaskOutputReadAuthorityPort = Readonly<{
  withWakeProjectionDestination?<Value>(input: Coordinates & Readonly<{
    destination: ForegroundMemoryProjectionDestination;
    use(current: Readonly<{ destinationAuthorityDigest: Uint8Array }>,
      product: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx): Promise<Value>;
  }>): Promise<Value | null>;
  withWakeWriter?<Value>(input: Coordinates & Pick<PostgresTaskWakeLiveShadowAuthorityInput<Value>,
    "accepted" | "evidence" | "signer" | "resolveHistoricalSignerPublicationManager"
    | "validateBeforeCommit"> & Readonly<{
      projectionDestination?: ForegroundMemoryProjectionDestination;
      use(writer: TaskWakeLiveShadowCurrentWriter, current?: Pick<OutputFacts, "occurrence">): Promise<Value>;
    }>): Promise<Value | null>;
  withPlanning<Value>(input: Coordinates<PlanningSubject> & Readonly<{
    use(current: ProtectedTaskOutputReadPlanningAuthority, product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx, restricted: PostgresJsBridgeConnection): Value | Promise<Value>;
  }>): Promise<Value | null>;
  withDiscovery<Value>(input: Coordinates & Readonly<{
    use(current: ProtectedTaskOutputReadDiscoveryAuthority, product: PostgresJsBridgeConnection,
      transaction: CanonicalTranscriptTx): Value | Promise<Value>;
    validateBeforeCommit?(): void | Promise<void>;
  }>): Promise<Value | null>;
  withBound<Value>(input: Coordinates & Readonly<{
    request: TaskRuntimeBackgroundAuthorizationRequestV1;
    admission: StenographerRequestAdmission;
    namespaceRequirements: readonly TaskRuntimeNamespaceAuthorityRequirement[];
    domainRequirements: readonly TaskRuntimeDomainAuthorityRequirement[];
    use(current: ProtectedTaskOutputReadCurrentAuthority, product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection): Value | Promise<Value>;
  }>): Promise<Value | null>;
  withAccepted<Value>(input: Coordinates & Readonly<{
    settledReceipt?: ProtectedTaskWakeCommittedSettlement;
    parkedReceipt?: ProtectedTaskWakeCommittedPark;
    parkCapture?(loader: ProtectedTaskOutputReadProductProofLoader): void;
    settlementCapture?(loader: ProtectedTaskOutputReadProductProofLoader): void;
    accepted: AcceptedTaskRuntimeAuthorizationV3;
    use(current: ProtectedTaskOutputReadCurrentAuthority, product: PostgresJsBridgeConnection,
      restricted: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx): Value | Promise<Value>;
    validateBeforeCommit(): void | Promise<void>;
  }>): Promise<Value | null>;
}>;

export type ProtectedTaskOutputReadAuthorityDependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  restricted(): PostgresJsBridgeConnection;
  resolveRequesterHuman(userId: string): Promise<Readonly<{ id: string }> | null>;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  resolveDestinationNamespace(roomId: string): Promise<string | null>;
  createProductContext: typeof createHumanProductTransactionContext;
  createProofLoader: typeof createProtectedTaskOutputReadProductProofLoader;
  inspectAuthority: typeof inspectTaskOutputNamespaceAuthority;
  withNamespaceAuthority: typeof withTaskOutputNamespaceAuthority;
  withRecipientAuthority: typeof withTaskOutputRecipientAuthority;
  withProductAuthority: typeof withTaskOutputProductAuthority;
  withBoundAuthority: typeof withCurrentTaskOutputRuntimeAuthority;
  withAcceptedAuthority: typeof withCurrentAcceptedTaskOutputRuntimeClaimAuthority;
  withWakeWriterAuthority?: typeof withPostgresTaskWakeLiveShadowAuthority;
  lockProjectionDestination?: typeof lockAtomicProjectionDestinationAuthority;
  readProjectionDestination?(transaction: CanonicalTranscriptTx, roomId: string):
    Promise<ProtectedTaskProjectionPlanDestination | null>;
  canonicalWakeForegroundAdmission: ProtectedTaskWakeForegroundAdmission;
  now(): number;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
function snapshotIntent(intent: ProtectedTaskOutputReadIntent): ProtectedTaskOutputReadIntent {
  return Object.freeze({ ...intent,
    ...(intent.continuation === undefined ? {} : { continuation: structuredClone(intent.continuation) }), result: Object.freeze({ ...intent.result,
      genesisManifestHash: Uint8Array.from(intent.result.genesisManifestHash) }),
  invocation: Object.freeze(intent.invocation.kind === "raw" ? { ...intent.invocation }
    : { ...intent.invocation, reference: Object.freeze({ ...intent.invocation.reference }) }) });
}
function copyNamespaces(values: readonly TaskRuntimeNamespaceAuthorityRequirement[]) {
  return Object.freeze(values.map(value => Object.freeze({ ...value, operations: Object.freeze([...value.operations]) })));
}
function inventoryIds(inventory: ProtectedTaskWakeForegroundInventory | null): readonly string[] | null {
  const ids: readonly string[] | undefined = inventory?.namespaceIds;
  if (ids === undefined || !Array.isArray(inventory?.namespaceIds) || ids.length === 0
    || ids.some((id, index) => !UUID.test(id)
      || index > 0 && ids[index - 1]! >= id)) return null;
  return Object.freeze([...ids]);
}
function retainedForeground(intent: ProtectedTaskOutputReadIntent, current: readonly string[] | null,
  acceptedIds?: readonly string[]): readonly string[] | null {
  const values = intent.continuation?.retainedSourceNamespaceIds ?? acceptedIds;
  if (current === null || values === undefined) return current;
  const retained = inventoryIds({ namespaceIds: values });
  return retained !== null && retained.every(id => current.includes(id)) ? retained : null;
}
function identity(intent: ProtectedTaskOutputReadIntent) {
  const wake = intent.invocation.kind === "wake";
  const workId = wake ? protectedTaskRunWakeJobId(intent.result.taskRunId) : intent.result.taskRunId;
  return Object.freeze({ workId, workKind: wake ? "task.delivery_wake" as const : "task.deliver_result" as const,
    requestId: wake ? `task-wake-authorization:${workId}` : `task-run-delivery-result-authorization:${workId}` });
}
function mutationDestination(intent: ProtectedTaskOutputReadIntent, foreground: readonly string[]) {
  const receipt = intent.continuation;
  if (receipt === undefined) return undefined;
  if (intent.invocation.kind !== "wake" || intent.expectedPolicyRevision < receipt.initialPolicyRevision
    || !UUID.test(receipt.destinationRoomId)
    || !UUID.test(receipt.destinationNamespaceId)
    || receipt.destinationNamespaceId === intent.contentNamespaceId
    || foreground.includes(receipt.destinationNamespaceId)
    || receipt.requiredAuthorityDigest.length !== 32 || receipt.destinationAuthorityDigest.length !== 32
    || receipt.sourceEnvelopeDigest.length !== 32
    || !sameIds(receipt.retainedSourceNamespaceIds, foreground)
    || receipt.retainedSourceNamespaceIds.length === 0
    || receipt.retainedSourceNamespaceIds.some((id, index, all) => !UUID.test(id)
      || index > 0 && all[index - 1]! >= id || !foreground.includes(id))) return null;
  try {
    const digest = protectedTaskSemanticAuthorityRequirementsDigest(receipt.semanticAuthorityRequirements);
    if (!Buffer.from(digest).equals(Buffer.from(receipt.requiredAuthorityDigest))) return null;
  } catch { return null; }
  if (!receipt.semanticAuthorityRequirements.some(n => n.namespaceId === receipt.destinationNamespaceId
    && sameIds(n.operations, ["encrypt"]))
    || receipt.semanticAuthorityRequirements.some(n => n.operations.some(operation =>
      operation === "decrypt" ? !receipt.retainedSourceNamespaceIds.includes(n.namespaceId)
        || !foreground.includes(n.namespaceId)
        : operation !== "encrypt" || n.namespaceId !== receipt.destinationNamespaceId))) return null;
  return Object.freeze({ roomId: receipt.destinationRoomId, namespaceId: receipt.destinationNamespaceId,
    semanticDigest: Buffer.from(receipt.requiredAuthorityDigest).toString("hex") });
}
function operations(intent: ProtectedTaskOutputReadIntent, foreground: readonly string[], namespaceId: string) {
  const visible = foreground.includes(namespaceId);
  return Object.freeze([
    ...(namespaceId === intent.contentNamespaceId || visible && intent.invocation.kind === "wake" ? ["decrypt" as const] : []),
    ...(visible || namespaceId === intent.continuation?.destinationNamespaceId ? ["encrypt" as const] : []),
  ]);
}
function exactRequirements(intent: ProtectedTaskOutputReadIntent, foreground: readonly string[],
  namespaces: readonly TaskRuntimeNamespaceAuthorityRequirement[], domains: readonly TaskRuntimeDomainAuthorityRequirement[]): boolean {
  const mutation = mutationDestination(intent, foreground);
  if (mutation === null) return false;
  const ids = [...new Set([intent.contentNamespaceId, ...foreground,
    ...(mutation === undefined ? [] : [mutation.namespaceId])])].sort();
  return namespaces.length === ids.length && namespaces.every((n, i) => n.ordinal === i && n.namespaceId === ids[i]
    && n.expectedPolicyRevision === intent.expectedPolicyRevision
    && sameIds(n.operations, operations(intent, foreground, n.namespaceId))
    && domains.some(d => d.domainId === n.domainId))
    && domains.length > 0 && domains.every((d, i) => d.ordinal === i
      && (i === 0 || domains[i - 1]!.domainId < d.domainId) && namespaces.some(n => n.domainId === d.domainId));
}

/** Fresh closed result reads; no execution grant or private-to-foreground projection is reused. */
export function createProtectedTaskOutputReadAuthorityPort(
  overrides: Partial<ProtectedTaskOutputReadAuthorityDependencies> = {},
): ProtectedTaskOutputReadAuthorityPort {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const serverScope = overrides.serverScope ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001");
  const restricted = overrides.restricted ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()));
  const resolveHuman = overrides.resolveRequesterHuman ?? findActorByOwnerId;
  const resolvePrivate = overrides.resolveRequesterPrivateRoom ?? createProtectedTaskRequesterPrivateRoomResolver(db);
  const resolveDestination = overrides.resolveDestinationNamespace ?? (async roomId => {
    const [room] = await db.select({ namespaceId: rooms.namespaceId }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
    return room?.namespaceId ?? null;
  });
  const context = overrides.createProductContext ?? createHumanProductTransactionContext;
  const createLoader = overrides.createProofLoader ?? createProtectedTaskOutputReadProductProofLoader;
  const inspect = overrides.inspectAuthority ?? inspectTaskOutputNamespaceAuthority;
  const namespaceAuthority = overrides.withNamespaceAuthority ?? withTaskOutputNamespaceAuthority;
  const recipient = overrides.withRecipientAuthority ?? withTaskOutputRecipientAuthority;
  const productAuthority = overrides.withProductAuthority ?? withTaskOutputProductAuthority;
  const bound = overrides.withBoundAuthority ?? withCurrentTaskOutputRuntimeAuthority;
  const accepted = overrides.withAcceptedAuthority ?? withCurrentAcceptedTaskOutputRuntimeClaimAuthority;
  const wakeWriter = overrides.withWakeWriterAuthority ?? withPostgresTaskWakeLiveShadowAuthority;
  const lockProjection = overrides.lockProjectionDestination ?? lockAtomicProjectionDestinationAuthority;
  const readProjection = overrides.readProjectionDestination ?? (async (tx: CanonicalTranscriptTx, roomId: string) => {
    const room = await findProjectionRoomByIdWith(tx, roomId);
    if (room === null || room.archivedAt !== null || room.namespaceId === null) return null;
    const members = await tx.select({ actorId: actors.id, actorKind: actors.kind, ownerId: actors.ownerId })
      .from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(eq(roomMembers.roomId, roomId)).orderBy(asc(actors.kind), asc(actors.ownerId), asc(actors.id));
    return { roomId, namespaceId: room.namespaceId, label: room.label, kind: room.kind,
      memberCount: members.length, audienceFingerprint: fingerprintProjectionAudience(roomId,
        members.map(member => `${member.actorKind}:${member.ownerId}:${member.actorId}`).join("\n")) };
  });
  const wakeAdmission = overrides.canonicalWakeForegroundAdmission;
  const now = overrides.now ?? Date.now;

  async function prepare<Subject extends PlanningSubject>(input: Coordinates<Subject>, requireDevice = true,
    acceptedNamespaces?: readonly TaskRuntimeNamespaceAuthorityRequirement[]) {
    input.signal?.throwIfAborted();
    const intent = snapshotIntent(input.intent);
    const subject = Object.freeze({ ...input.subject });
    const { invocation, result } = intent;
    if (subject.userId !== intent.requesterUserId || subject.humanActorId !== intent.requesterHumanId
      || requireDevice && (!("deviceId" in subject) || typeof subject.deviceId !== "string" || subject.deviceId.length === 0)
      || !UUID.test(invocation.sessionId)
      || !Number.isSafeInteger(intent.expectedPolicyRevision) || intent.expectedPolicyRevision < intent.acceptedPolicyRevision
      || intent.representation !== "protected" && intent.representation !== "dual"
      || invocation.bindingId !== protectedTaskRunOutputBindingId(result.taskRunId)
      || result.signerAgentId !== intent.agentId
      || (invocation.kind === "raw" ? invocation.operationId !== protectedTaskRunMessageOperationId(result.taskRunId)
        || intent.initialState !== "raw_unpublished"
        : invocation.kind !== "wake" || invocation.jobId !== protectedTaskRunWakeJobId(result.taskRunId)
          || invocation.operationId !== protectedTaskRunWakeOperationId(result.taskRunId)
          || intent.initialState !== "wake_queued" && intent.initialState !== "wake_running"
          || wakeAdmission === undefined)) return null;
    const [human, privateRoom, destinationNamespaceId] = await Promise.all([
      resolveHuman(subject.userId), resolvePrivate(subject.userId, intent.agentId, intent.contentNamespaceId),
      resolveDestination(invocation.roomId),
    ]);
    if (human?.id !== subject.humanActorId || privateRoom === null
      || privateRoom.namespaceId !== intent.contentNamespaceId || destinationNamespaceId === null) return null;
    const acceptedForegroundIds = invocation.kind !== "wake" || acceptedNamespaces === undefined ? undefined
      : Object.freeze(acceptedNamespaces.filter(n => sameIds(n.operations, ["decrypt", "encrypt"]))
        .map(n => n.namespaceId));
    const foregroundNamespaceIds = invocation.kind === "raw" ? Object.freeze([destinationNamespaceId])
      : retainedForeground(intent, inventoryIds(await wakeAdmission!.discover({ intent, subject })), acceptedForegroundIds);
    if (foregroundNamespaceIds === null || !foregroundNamespaceIds.includes(destinationNamespaceId)) return null;
    const additionalMutationDestination = mutationDestination(intent, foregroundNamespaceIds);
    if (additionalMutationDestination === null) return null;
    input.signal?.throwIfAborted();
    const product = await context(subject.userId, db);
    return { intent, subject, privateRoom, destinationNamespaceId, foregroundNamespaceIds,
      ...(acceptedForegroundIds === undefined ? {} : { acceptedForegroundIds }),
      ...(additionalMutationDestination === undefined ? {} : { additionalMutationDestination }),
      runner: product.canonicalRunner, restricted: input.restricted ?? restricted(),
      ...(input.signal === undefined ? {} : { signal: input.signal }) };
  }
  type Prepared = NonNullable<Awaited<ReturnType<typeof prepare>>>;
  type Loader = ReturnType<typeof createLoader>;
  function coordinates(current: Prepared, loader: Loader): TaskOutputNamespaceAuthorityInput {
    return { ...current, ...identity(current.intent), crypto, serverScope,
      taskId: current.intent.result.taskId, taskRunId: current.intent.result.taskRunId,
      requesterUserId: current.subject.userId, requesterHumanId: current.subject.humanActorId,
      agentId: current.intent.agentId, contentNamespaceId: current.intent.contentNamespaceId,
      sourceRoomId: current.privateRoom.roomId, destinationRoomId: current.intent.invocation.roomId,
      episodeId: current.intent.invocation.sessionId, expectedPolicyRevision: current.intent.expectedPolicyRevision,
      validateCurrentTaskRun: loader.validateCurrentTaskRun,
      ...(current.additionalMutationDestination === undefined ? {} : {
        additionalMutationDestination: current.additionalMutationDestination,
        validateCurrentAdditionalMutationDestination: async (_product: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx) => {
          const proof = loader.readCurrent();
          const continuation = proof?.continuation;
          const destination = current.additionalMutationDestination!;
          if (continuation === undefined || continuation.destinationRoomId !== destination.roomId
            || continuation.destinationNamespaceId !== destination.namespaceId
            || Buffer.from(continuation.requiredAuthorityDigest).toString("hex") !== destination.semanticDigest) return false;
          const actual = await readProjection(transaction, destination.roomId);
          return actual !== null && actual.namespaceId === destination.namespaceId
            && Buffer.from(protectedTaskProjectionDestinationAuthorityDigest(actual))
              .equals(Buffer.from(continuation.destinationAuthorityDigest))
            && await lockProjection(transaction, { roomId: actual.roomId, namespaceId: actual.namespaceId,
              roomLabel: actual.label, roomKind: actual.kind, audienceFingerprint: actual.audienceFingerprint,
              userId: current.subject.userId, requesterActorId: current.subject.humanActorId,
            }, { actorIdentityLock: "share" }) === null;
        },
      }),
      validateCurrentForeground: async (product, transaction, facts) => {
        if (!await loader.validateCurrentForeground(product, transaction, facts)) return false;
        if (current.intent.invocation.kind === "raw") return sameIds(facts.foregroundNamespaceIds, [current.destinationNamespaceId]);
        const fresh = retainedForeground(current.intent, inventoryIds(await wakeAdmission!.readCurrent({
          intent: current.intent,
          subject: current.subject,
          product,
          transaction,
          expectedNamespaceIds: facts.foregroundNamespaceIds,
          ...(current.intent.continuation !== undefined || current.acceptedForegroundIds !== undefined
            ? { retainedNamespaceIds: current.foregroundNamespaceIds } : {}),
        })), current.acceptedForegroundIds);
        return fresh !== null && sameIds(fresh, current.foregroundNamespaceIds);
      },
    };
  }
  function facts(current: Prepared, loader: Loader,
    authority: Pick<CurrentTaskRuntimeAuthority, "domains" | "namespaceRequirements" | "policyRevision">): OutputFacts {
    const proof = loader.readCurrent();
    const source = authority.namespaceRequirements.find(n => n.namespaceId === current.intent.contentNamespaceId);
    if (proof === null || source === undefined || !source.operations.includes("decrypt")
      || authority.policyRevision !== current.intent.expectedPolicyRevision) throw new Error("Task output proof is unavailable");
    const resultNamespaceRequirement = Object.freeze({ ...source, operations: Object.freeze(["decrypt"] as const) });
    const foregroundNamespaceRequirements = Object.freeze(authority.namespaceRequirements.filter(n => current.foregroundNamespaceIds.includes(n.namespaceId))
      .map(n => Object.freeze({ ...n, operations: Object.freeze(current.intent.invocation.kind === "raw"
        ? ["encrypt"] as const : ["decrypt", "encrypt"] as const) })));
    const all = Object.freeze(authority.namespaceRequirements.map(n => {
      const d = authority.domains.find(d => d.domainId === n.domainId);
      if (d === undefined) throw new Error("Task output Domain proof is unavailable");
      return Object.freeze({ namespaceId: n.namespaceId, domainId: n.domainId,
        expectedAccessRevision: n.expectedAccessRevision, expectedPolicyRevision: n.expectedPolicyRevision,
        expectedDomainEpoch: d.domainKeyGeneration, expectedAuthorizationRevision: d.authorizationRevision });
    }));
    const namespaceAuthority = Object.freeze({ sourceRoomId: current.intent.invocation.roomId,
      sourceNamespaceId: current.intent.contentNamespaceId, facts: all,
      resultFact: all.find(n => n.namespaceId === source.namespaceId)!,
      foregroundFacts: Object.freeze(all.filter(n => current.foregroundNamespaceIds.includes(n.namespaceId))),
      ...(current.additionalMutationDestination === undefined ? {} : { additionalMutationFact: Object.freeze({
        destination: current.additionalMutationDestination,
        namespace: all.find(n => n.namespaceId === current.additionalMutationDestination!.namespaceId)!,
      }) }) });
    return Object.freeze({ resultNamespaceRequirement, foregroundNamespaceRequirements, namespaceAuthority,
      occurrence: Object.freeze({ requesterHumanId: proof.requesterHumanId,
        result: Object.freeze({ ...proof.result, namespace: Object.freeze({ namespaceId: source.namespaceId,
          domainId: source.domainId, operations: Object.freeze(["decrypt"] as const),
          expectedAccessRevision: source.expectedAccessRevision, expectedPolicyRevision: source.expectedPolicyRevision }) }),
        invocation: proof.invocation }) });
  }
  function requestMatches(current: Prepared, request: Pick<TaskRuntimeBackgroundAuthorizationRequestV1,
    "requestId" | "workId" | "workKind" | "workPurpose" | "sourceRoomId" | "episodeId" | "recipientGeneration">): boolean {
    const expected = identity(current.intent);
    return request.requestId === expected.requestId && request.workId === expected.workId
      && request.workKind === expected.workKind && request.workPurpose === expected.workKind
      && request.sourceRoomId === current.intent.invocation.roomId && request.episodeId === current.intent.invocation.sessionId
      && (current.intent.continuation === undefined || request.recipientGeneration >= current.intent.continuation.segment);
  }

  return {
    async withWakeProjectionDestination(input) {
      const destination = Object.freeze({ ...input.destination });
      const current = await prepare(input, false);
      if (current === null || current.intent.invocation.kind !== "wake" || current.intent.initialState !== "wake_running") return null;
      const expectedDigest = protectedTaskProjectionDestinationAuthorityDigest(destination);
      const loader = createLoader(current.intent);
      try {
        return await productAuthority({ ...coordinates(current, loader),
          projectionPlanningOnly: true,
          projectionDestination: { roomId: destination.roomId, namespaceId: destination.namespaceId },
          validateCurrentProjectionDestination: async (_product, transaction) => {
            const actual = await readProjection(transaction, destination.roomId);
            return actual !== null && Buffer.from(protectedTaskProjectionDestinationAuthorityDigest(actual)).equals(Buffer.from(expectedDigest))
              && await lockProjection(transaction, { roomId: destination.roomId, namespaceId: destination.namespaceId,
                roomLabel: destination.label, roomKind: destination.kind, audienceFingerprint: destination.audienceFingerprint,
                userId: current.subject.userId, requesterActorId: current.subject.humanActorId,
              }, { actorIdentityLock: "share" }) === null;
          },
          use: async (_proof, product, transaction) => {
            if (loader.readCurrent() === null) throw new Error("Task wake projection product proof is unavailable");
            return input.use(Object.freeze({ destinationAuthorityDigest: Uint8Array.from(expectedDigest) }), product, transaction);
          },
        });
      } finally { loader.reset(); }
    },
    async withPlanning(input) {
      const current = await prepare(input, false); if (current === null) return null;
      const loader = createLoader(current.intent);
      try {
        return await namespaceAuthority({ ...coordinates(current, loader),
          use: async (authority, product, transaction, restricted) => {
            current.signal?.throwIfAborted();
            const proof = loader.readCurrent();
            const source = authority.resultFact;
            if (proof === null || source.namespaceId !== current.intent.contentNamespaceId
              || source.expectedPolicyRevision !== current.intent.expectedPolicyRevision) {
              throw new Error("Task output planning proof is unavailable");
            }
            const occurrence = Object.freeze({ requesterHumanId: proof.requesterHumanId,
              result: Object.freeze({ ...proof.result, namespace: Object.freeze({ namespaceId: source.namespaceId,
                domainId: source.domainId, operations: Object.freeze(["decrypt"] as const),
                expectedAccessRevision: source.expectedAccessRevision, expectedPolicyRevision: source.expectedPolicyRevision }) }),
              invocation: proof.invocation });
            const value = await input.use(Object.freeze({ namespaceAuthority: authority, occurrence }), product, transaction, restricted);
            current.signal?.throwIfAborted();
            return value;
          },
        });
      } finally { loader.reset(); }
    },
    async withDiscovery(input) {
      const current = await prepare(input); if (current === null) return null;
      const planningLoader = createLoader(current.intent);
      let planning: TaskOutputNamespaceAuthority | null;
      try { planning = await inspect(coordinates(current, planningLoader)); }
      finally { planningLoader.reset(); }
      if (planning === null) return null;
      const namespaces = planning.facts.map((f, ordinal) => Object.freeze({ ordinal, namespaceId: f.namespaceId,
        domainId: f.domainId, operations: operations(current.intent, current.foregroundNamespaceIds, f.namespaceId),
        expectedAccessRevision: f.expectedAccessRevision, expectedPolicyRevision: f.expectedPolicyRevision }));
      const byDomain = new Map<string, typeof planning.resultFact>();
      for (const fact of planning.facts) {
        const prior = byDomain.get(fact.domainId);
        if (prior !== undefined && (prior.expectedDomainEpoch !== fact.expectedDomainEpoch
          || prior.expectedAuthorizationRevision !== fact.expectedAuthorizationRevision)) return null;
        byDomain.set(fact.domainId, fact);
      }
      const domains = [...byDomain.values()].sort((a, b) => a.domainId.localeCompare(b.domainId))
        .map((f, ordinal) => Object.freeze({ ordinal, domainId: f.domainId,
          expectedEpoch: f.expectedDomainEpoch, expectedAuthorizationRevision: f.expectedAuthorizationRevision }));
      if (!exactRequirements(current.intent, current.foregroundNamespaceIds, namespaces, domains)) return null;
      const loader = createLoader(current.intent);
      try {
        return await recipient({ ...coordinates(current, loader), deviceId: current.subject.deviceId,
          namespaceRequirements: namespaces, domainRequirements: domains,
          ...(current.signal === undefined ? {} : { signal: current.signal }),
          ...(input.validateBeforeCommit === undefined ? {} : { validateBeforeCommit: input.validateBeforeCommit }),
          use: (authority, scoped, product, transaction) => input.use(Object.freeze({ ...authority,
            ...facts(current, loader, authority), restricted: scoped }), product, transaction),
        });
      } finally { loader.reset(); }
    },
    async withBound(input) {
      const encoded = encodeTaskRuntimeBackgroundAuthorizationRequestV1(input.request);
      const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(encoded); encoded.fill(0);
      if (request === null) return null;
      const admission = Object.freeze({ ...input.admission, headDigest: input.admission.headDigest.slice() });
      const namespaces = copyNamespaces(input.namespaceRequirements);
      const domains = Object.freeze(input.domainRequirements.map(d => Object.freeze({ ...d })));
      try {
        const current = await prepare(input);
        if (current === null || !requestMatches(current, request)
          || !exactRequirements(current.intent, current.foregroundNamespaceIds, namespaces, domains)) return null;
        const loader = createLoader(current.intent);
        try {
          return await productAuthority({ ...coordinates(current, loader), use: productAuthority => bound({
            productAuthority, crypto, serverScope, subject: current.subject, request, admission,
            namespaceRequirements: namespaces, domainRequirements: domains, now,
            ...(current.signal === undefined ? {} : { signal: current.signal }),
            use: async (authority, product, scoped) => input.use(Object.freeze({ ...authority,
              ...facts(current, loader, authority) }), product, scoped),
          }) });
        } finally { loader.reset(); }
      } finally { admission.headDigest.fill(0); destroyTaskRuntimeBackgroundAuthorizationRequestV1(request); }
    },
    async withWakeWriter(input) {
      const projection = input.projectionDestination === undefined ? undefined
        : Object.freeze({ ...input.projectionDestination });
      const record = Object.freeze({ ...input.accepted,
        descriptorBytes: input.accepted.descriptorBytes.slice(), authorizationBytes: input.accepted.authorizationBytes.slice(),
        issuerSigningPublicKeyHash: input.accepted.issuerSigningPublicKeyHash.slice(),
        namespaceRequirements: copyNamespaces(input.accepted.namespaceRequirements),
        domainRequirements: Object.freeze(input.accepted.domainRequirements.map(d => Object.freeze({ ...d }))) });
      try {
        const request = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
          crypto,
          record.descriptorBytes,
        );
        if (request === null) return null;
        let current: (Prepared & Readonly<{ subject: TaskRuntimeAuthoritySubject }>) | null;
        try {
          current = await prepare(input, true, record.namespaceRequirements);
          if (current === null || current.intent.invocation.kind !== "wake"
            || current.intent.initialState !== "wake_running" || !requestMatches(current, request) || record.requestId !== request.requestId
            || record.workId !== request.workId || record.workKind !== request.workKind || record.workPurpose !== request.workPurpose
            || record.expectedPolicyRevision !== current.intent.expectedPolicyRevision
            || typeof input.validateBeforeCommit !== "function"
            || !exactRequirements(current.intent, current.foregroundNamespaceIds, record.namespaceRequirements, record.domainRequirements)) return null;
        } finally { destroyTaskRuntimeBackgroundAuthorizationRequestV1(request); }
        const loader = createLoader(current.intent);
        try {
          if (projection !== undefined && !current.foregroundNamespaceIds.includes(projection.namespaceId)
            && (projection.namespaceId !== current.additionalMutationDestination?.namespaceId
              || projection.roomId !== current.additionalMutationDestination.roomId)) return null;
          return await productAuthority({ ...coordinates(current, loader),
            ...(projection === undefined ? {} : {
              projectionDestination: { roomId: projection.roomId, namespaceId: projection.namespaceId },
              validateCurrentProjectionDestination: async (_product: PostgresJsBridgeConnection, transaction: CanonicalTranscriptTx) =>
                await lockProjection(transaction, {
                  roomId: projection.roomId, namespaceId: projection.namespaceId,
                  roomLabel: projection.label, roomKind: projection.kind,
                  userId: current.subject.userId, requesterActorId: current.subject.humanActorId,
                  audienceFingerprint: projection.audienceFingerprint,
                }, { actorIdentityLock: "share" }) === null,
            }), use: productAuthority => wakeWriter({
            productAuthority, crypto, serverScope, subject: current.subject, accepted: record, now,
            ...(current.signal === undefined ? {} : { signal: current.signal }),
            validateCurrentProduct: () => loader.readCurrent() !== null,
            validateBeforeCommit: input.validateBeforeCommit,
            evidence: input.evidence,
            signer: input.signer,
            resolveHistoricalSignerPublicationManager: input.resolveHistoricalSignerPublicationManager,
            use: async writer => {
              await input.validateBeforeCommit();
              const proof = loader.readCurrent();
              const source = record.namespaceRequirements.find(value =>
                value.namespaceId === current.intent.contentNamespaceId);
              if (proof === null || source === undefined || !source.operations.includes("decrypt")
                || source.expectedPolicyRevision !== current.intent.expectedPolicyRevision) {
                throw new Error("Task wake current result proof is unavailable");
              }
              return input.use(writer, { occurrence: Object.freeze({
                requesterHumanId: proof.requesterHumanId,
                result: Object.freeze({ ...proof.result, namespace: Object.freeze({
                  namespaceId: source.namespaceId, domainId: source.domainId,
                  operations: Object.freeze(["decrypt"] as const),
                  expectedAccessRevision: source.expectedAccessRevision,
                  expectedPolicyRevision: source.expectedPolicyRevision,
                }) }),
                invocation: proof.invocation,
              }) });
            },
          }) });
        } finally { loader.reset(); }
      } finally { record.descriptorBytes.fill(0); record.authorizationBytes.fill(0); record.issuerSigningPublicKeyHash.fill(0); }
    },
    async withAccepted(input) {
      const record = Object.freeze({ ...input.accepted,
        descriptorBytes: input.accepted.descriptorBytes.slice(), authorizationBytes: input.accepted.authorizationBytes.slice(),
        issuerSigningPublicKeyHash: input.accepted.issuerSigningPublicKeyHash.slice(),
        namespaceRequirements: copyNamespaces(input.accepted.namespaceRequirements),
        domainRequirements: Object.freeze(input.accepted.domainRequirements.map(d => Object.freeze({ ...d }))) });
      try {
        const request = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
          crypto,
          record.descriptorBytes,
        );
        if (request === null) return null;
        let current: (Prepared & Readonly<{ subject: TaskRuntimeAuthoritySubject }>) | null;
        try {
          current = await prepare(input, true, record.namespaceRequirements);
          if (current === null || !requestMatches(current, request) || record.requestId !== request.requestId
            || record.workId !== request.workId || record.workKind !== request.workKind || record.workPurpose !== request.workPurpose
            || record.expectedPolicyRevision !== current.intent.expectedPolicyRevision
            || typeof input.validateBeforeCommit !== "function"
            || !exactRequirements(current.intent, current.foregroundNamespaceIds, record.namespaceRequirements, record.domainRequirements)) return null;
        } finally { destroyTaskRuntimeBackgroundAuthorizationRequestV1(request); }
        if ((input.settledReceipt !== undefined || input.settlementCapture !== undefined
          || input.parkedReceipt !== undefined || input.parkCapture !== undefined)
          && (current.intent.invocation.kind !== "wake" || current.intent.initialState !== "wake_running")) return null;
        if (Number(input.settledReceipt !== undefined) + Number(input.settlementCapture !== undefined)
          + Number(input.parkedReceipt !== undefined) + Number(input.parkCapture !== undefined) > 1) return null;
        const loader = input.parkedReceipt !== undefined
          ? createProtectedTaskWakeParkedProductProofLoader(current.intent, input.parkedReceipt)
          : input.parkCapture !== undefined ? createProtectedTaskWakeParkingProductProofLoader(current.intent)
          : input.settledReceipt === undefined ? createLoader(current.intent)
          : createProtectedTaskWakeSettledProductProofLoader(current.intent, input.settledReceipt);
        try {
          return await productAuthority({ ...coordinates(current, loader), use: productAuthority => accepted({
            productAuthority, crypto, serverScope, subject: current.subject, accepted: record, now,
            ...(current.signal === undefined ? {} : { signal: current.signal }),
            validateCurrentProduct: () => loader.readCurrent() !== null,
            validateBeforeCommit: input.validateBeforeCommit,
            use: async (authority, product, scoped, transaction) => {
              await input.validateBeforeCommit();
              const value = await input.use(Object.freeze({ ...authority, ...facts(current, loader, authority) }), product, scoped, transaction);
              if (input.settlementCapture !== undefined || input.parkCapture !== undefined) {
                const transition = input.parkCapture === undefined ? "settlement" : "park";
                if (!await loader.validateCurrentTaskRun(product, transaction)) {
                  throw new Error(`Task wake committed ${transition} product proof changed`);
                }
                if (!await loader.validateCurrentForeground(product, transaction, {
                  destinationRoomId: current.intent.invocation.roomId,
                  destinationNamespaceId: current.destinationNamespaceId,
                  foregroundNamespaceIds: current.foregroundNamespaceIds,
                })) throw new Error(`Task wake committed ${transition} invocation proof changed`);
                input.settlementCapture?.(loader);
                input.parkCapture?.(loader);
              }
              return value;
            },
          }) });
        } finally { loader.reset(); }
      } finally { record.descriptorBytes.fill(0); record.authorizationBytes.fill(0); record.issuerSigningPublicKeyHash.fill(0); }
    },
  };
}
