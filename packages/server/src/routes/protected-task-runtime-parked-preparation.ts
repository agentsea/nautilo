import { createHash } from "node:crypto";
import {
  actors, and, asc, createPostgresJsBridgeConnection,
  discoverParkedProtectedTaskAdditionalAuthority, eq,
  getEncryptionTransitionPolicy, getProtectedTaskRunOutputBinding,
  getSharedDirectCryptoDb, inArray, isNull, roomMembers, rooms,
  sameParkedProtectedTaskAdditionalAuthority,
  type DirectDatabase, type ParkedProtectedTaskAdditionalAuthority,
} from "@nautilo/db";
import { LatticeCrypto, type TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  verifyCryptoPostgresHandle, withParkedTaskRuntimeNamespaceAuthority,
  type ParkedTaskRuntimeCurrentRoutingFacts,
} from "@nautilo/lattice-bridge/server";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  PostgresBackgroundAuthorizationRepository,
  prepareUnclaimedParkedTaskRuntimeAuthority,
  taskRuntimeStableIdempotencyKey,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence, type TaskRuntimeGrantStableIdentity,
} from "@nautilo/runtime";
import type { PolicyResolver } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { publishDomainKeyCatchUpRequested } from "../realtime/ws-publisher";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  canonicalProtectedTaskRuntimeAuthority,
  createParkedTaskRuntimeRoutingValidator,
  protectedTaskRuntimeNamespaceInventory,
  sameProtectedTaskRuntimeOccurrence,
} from "./protected-task-runtime-grant-plan";
import {
  createProtectedTaskRuntimeParkedMemoryPlanResolver,
  type ParkedProtectedTaskRuntimeMemoryPlan,
} from "./protected-task-runtime-parked-memory-plan";

type MemoryPlanResolver = ReturnType<typeof createProtectedTaskRuntimeParkedMemoryPlanResolver>;
type PrepareResult = Awaited<ReturnType<typeof prepareUnclaimedParkedTaskRuntimeAuthority>>
  | Readonly<{ status: "awaiting_readiness" }>;

type Dependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  recipients: TaskRuntimeRecipientRegistry;
  resolveMemory: MemoryPlanResolver;
  discover: typeof discoverParkedProtectedTaskAdditionalAuthority;
  readOutput: typeof getProtectedTaskRunOutputBinding;
  readPolicy: (db: DirectDatabase) => Promise<Pick<Awaited<ReturnType<
    typeof getEncryptionTransitionPolicy
  >>, "mode" | "shadowBehavior" | "revision">>;
  productContext: typeof createHumanProductTransactionContext;
  restricted: () => Parameters<typeof withParkedTaskRuntimeNamespaceAuthority>[0]["restricted"];
  withAuthority: typeof withParkedTaskRuntimeNamespaceAuthority;
  repository: (connection: Parameters<typeof verifyCryptoPostgresHandle>[0]) =>
    Promise<PostgresBackgroundAuthorizationRepository>;
  prepare: typeof prepareUnclaimedParkedTaskRuntimeAuthority;
  wake: (input: Readonly<{
    expected: ParkedProtectedTaskAdditionalAuthority;
    namespaceIds: readonly string[];
  }>) => Promise<void>;
  now: () => number;
}>;

function sameRoutingPlan(
  plan: ParkedProtectedTaskRuntimeMemoryPlan,
  current: ParkedTaskRuntimeCurrentRoutingFacts,
): boolean {
  const routing = plan.routing;
  return routing.taskId === current.taskId && routing.taskRunId === current.taskRunId
    && routing.requesterUserId === current.requestorId
    && routing.agentId === current.agentId
    && routing.sourceRoomId === current.sourceRoomId
    && routing.sourceNamespaceId === current.contentNamespaceId
    && routing.targetRoomId === current.targetRoomId
    && routing.memoryMode === current.memoryMode && routing.scopeId === current.scopeId
    && routing.wideBringBack === current.wideBringBack
    && routing.targetUserIds.length === current.targetUserIds.length
    && routing.targetUserIds.every((id, index) => id === current.targetUserIds[index]);
}

/** Union semantic operations with the freshly resolved base, never old grant inventory. */
function namespaceInventory(
  expected: ParkedProtectedTaskAdditionalAuthority,
  plan: ParkedProtectedTaskRuntimeMemoryPlan,
) {
  const base = protectedTaskRuntimeNamespaceInventory({
    occurrence: expected.occurrence,
    memory: plan.resolution,
  }, plan.routing.outputRoomId === null ? null : {
    roomId: plan.routing.outputRoomId,
    namespaceId: plan.routing.outputNamespaceId!,
  }, plan.scopeMemory);
  const operations = new Map<string, Set<"decrypt" | "encrypt">>();
  for (const namespaceId of base.namespaceIds) {
    operations.set(namespaceId, new Set(base.operations(namespaceId)));
  }
  for (const requirement of expected.proof.continuation.semanticAuthorityRequirements) {
    const current = operations.get(requirement.namespaceId) ?? new Set<"decrypt" | "encrypt">();
    for (const operation of requirement.operations) current.add(operation);
    operations.set(requirement.namespaceId, current);
  }
  return Object.freeze({
    namespaceIds: Object.freeze([...operations.keys()].sort()),
    operations: (namespaceId: string) => Object.freeze([
      ...(operations.get(namespaceId)?.has("decrypt") ? ["decrypt" as const] : []),
      ...(operations.get(namespaceId)?.has("encrypt") ? ["encrypt" as const] : []),
    ]),
  });
}

/** Existing key catch-up transport only; the observer's durable park supplies retries. */
function createReadinessWake(db: DirectDatabase): Dependencies["wake"] {
  return async ({ expected, namespaceIds }) => {
    const current = await discoverParkedProtectedTaskAdditionalAuthority(db, {
      taskRunId: expected.occurrence.run.id,
    });
    if (current === null || !sameParkedProtectedTaskAdditionalAuthority(current, expected)) return;
    const participants = await db.select({
      roomId: rooms.id, namespaceId: rooms.namespaceId, userId: actors.ownerId,
    }).from(rooms).innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
      .innerJoin(actors, eq(actors.id, roomMembers.actorId))
      .where(and(inArray(rooms.namespaceId, [...namespaceIds]),
        isNull(rooms.parentRoomId), isNull(rooms.archivedAt), eq(actors.kind, "user")))
      .orderBy(asc(rooms.id), asc(actors.id));
    const byRoom = new Map<string, { namespaceId: string; userIds: string[] }>();
    for (const participant of participants) {
      if (participant.userId === null) continue;
      const room = byRoom.get(participant.roomId)
        ?? { namespaceId: participant.namespaceId, userIds: [] };
      room.userIds.push(participant.userId);
      byRoom.set(participant.roomId, room);
    }
    for (const [roomId, room] of byRoom) publishDomainKeyCatchUpRequested({
      roomId, namespaceId: room.namespaceId, keyClass: "ai", recipientUserIds: room.userIds,
    });
  };
}

/** Prepare only: no device custody, authorization claim, Job creation or graph execution. */
export function createProtectedTaskRuntimeParkedPreparation(
  input: Readonly<{ resolver: PolicyResolver; recipients: TaskRuntimeRecipientRegistry }>,
  overrides: Partial<Dependencies> = {},
): (occurrence: ProtectedTaskOccurrence) => Promise<PrepareResult> {
  const db = overrides.db ?? getServerDirectDb();
  const dependencies: Dependencies = {
    db, crypto: overrides.crypto ?? new LatticeCrypto(),
    serverScope: overrides.serverScope
      ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001"),
    recipients: input.recipients,
    resolveMemory: overrides.resolveMemory
      ?? createProtectedTaskRuntimeParkedMemoryPlanResolver({ db, resolver: input.resolver }),
    discover: overrides.discover ?? discoverParkedProtectedTaskAdditionalAuthority,
    readOutput: overrides.readOutput ?? getProtectedTaskRunOutputBinding,
    readPolicy: overrides.readPolicy ?? getEncryptionTransitionPolicy,
    productContext: overrides.productContext ?? createHumanProductTransactionContext,
    restricted: overrides.restricted
      ?? (() => createPostgresJsBridgeConnection(getSharedDirectCryptoDb())),
    withAuthority: overrides.withAuthority ?? withParkedTaskRuntimeNamespaceAuthority,
    repository: overrides.repository ?? (async connection =>
      new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection))),
    prepare: overrides.prepare ?? prepareUnclaimedParkedTaskRuntimeAuthority,
    wake: overrides.wake ?? createReadinessWake(db), now: overrides.now ?? Date.now,
  };
  return async observed => {
    if (observed.run.jobId === null) return { status: "inactive" };
    const occurrence = structuredClone(observed);
    const discovered = await dependencies.discover(db, { taskRunId: occurrence.run.id });
    if (discovered === null
      || !sameProtectedTaskRuntimeOccurrence(occurrence, discovered.occurrence)) return { status: "inactive" };
    const expected = structuredClone(discovered);
    const policy = Object.freeze({ ...await dependencies.readPolicy(db) });
    if (policy.mode === "plaintext_only"
      || (policy.mode === "shadow_encryption"
        ? occurrence.task.contentRepresentation !== "dual"
        : occurrence.task.contentRepresentation !== "protected")) return { status: "inactive" };
    const loadedOutput = await dependencies.readOutput(db, occurrence.run.id);
    if (loadedOutput === undefined) return { status: "inactive" };
    const output = structuredClone(loadedOutput);
    const discoveredPlan = await dependencies.resolveMemory({ expected: structuredClone(expected), output: structuredClone(output) });
    if (discoveredPlan === null) return { status: "inactive" };
    const plan = structuredClone(discoveredPlan);
    const inventory = namespaceInventory(expected, plan);
    const validateRouting = createParkedTaskRuntimeRoutingValidator({
      expected, output, widePrivateNamespaceId: plan.routing.widePrivateNamespaceId,
    });
    const product = await dependencies.productContext(occurrence.task.requestorId, db);
    let routing: ParkedTaskRuntimeCurrentRoutingFacts | null = null;
    const missingNamespaces = new Set<string>();
    const result = await dependencies.withAuthority({
      runner: product.canonicalRunner, restricted: dependencies.restricted(),
      crypto: dependencies.crypto, serverScope: dependencies.serverScope,
      taskId: occurrence.task.id, requesterUserId: occurrence.task.requestorId,
      requesterHumanId: plan.routing.requesterHumanId, agentId: occurrence.task.agentId,
      contentNamespaceId: occurrence.task.contentNamespaceId,
      sourceRoomId: plan.routing.sourceRoomId, targetRoomId: plan.routing.targetRoomId,
      namespaceIds: inventory.namespaceIds, expectedPolicyRevision: policy.revision,
      ...(plan.scopeMemory === undefined ? {} : { scopeMemory: plan.scopeMemory }),
      ...(plan.expectedNamespaceParticipants === undefined ? {} : {
        expectedNamespaceParticipants: plan.expectedNamespaceParticipants,
      }),
      expected, authorizationRequestId: expected.authorizationRequestId,
      validateCurrentRouting: facts => {
        if (!sameRoutingPlan(plan, facts) || !validateRouting(facts)) return false;
        routing = structuredClone(facts);
        return true;
      },
      onNamespaceReadinessUnavailable: namespaceId => {
        if (!inventory.namespaceIds.includes(namespaceId)) {
          throw new TypeError("Parked Task readiness Namespace was substituted");
        }
        missingNamespaces.add(namespaceId);
      },
      use: async (current, restricted) => {
        const facts = routing;
        if (facts === null) throw new TypeError("Parked Task routing was not validated");
        const authority = canonicalProtectedTaskRuntimeAuthority({ occurrence, inventory, facts: current.facts });
        const content = authority.namespaces.find(value => value.namespaceId === occurrence.task.contentNamespaceId)!;
        const contentDomain = authority.domains.find(value => value.domainId === content.domainId)!;
        const stableIdentity: TaskRuntimeGrantStableIdentity = Object.freeze({
          ...facts, startedAt: facts.startedAt.getTime(),
          requiredNamespaceFingerprint: Buffer.from(facts.requiredNamespaceFingerprint).toString("base64url"),
          outputRoomId: output.destinationRoomId, outputNamespaceId: output.destinationNamespaceId,
          executionSegment: expected.nextExecutionSegment,
          resumeContinuationFingerprint: expected.continuationFingerprint,
        });
        const now = dependencies.now();
        const initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = Object.freeze({
          snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
            requestId: expected.authorizationRequestId, workId: occurrence.run.id,
            namespaceId: occurrence.task.contentNamespaceId, now,
          }),
          idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity),
          workIdentityHash: createHash("sha256").update(JSON.stringify({
            taskId: occurrence.task.id, taskRunId: occurrence.run.id,
            scheduleKind: occurrence.task.scheduleKind,
            sourceRoomId: facts.sourceRoomId, targetRoomId: facts.targetRoomId,
            outputRoomId: output.destinationRoomId, outputNamespaceId: output.destinationNamespaceId,
            targetUserIds: [...facts.targetUserIds], memoryMode: facts.memoryMode,
            scopeId: facts.scopeId, inputObjectId: occurrence.task.cryptoObjectId,
            contentRevision: occurrence.task.contentRevision,
            fingerprint: stableIdentity.requiredNamespaceFingerprint,
            policyRevision: authority.policyRevision,
            ...(plan.scopeMemory === undefined ? {} : { scopeMemory: plan.scopeMemory }),
            ...(facts.memoryMode === "wide" ? { widePrimaryWriteNamespaceId:
              facts.wideBringBack && output.destinationNamespaceId !== null
                ? output.destinationNamespaceId : plan.routing.widePrivateNamespaceId } : {}),
            namespaces: authority.namespaces, domains: authority.domains,
            executionSegment: expected.nextExecutionSegment,
            resumeContinuationFingerprint: expected.continuationFingerprint,
          })).digest(),
          workKind: "task.execute", purpose: "task.execute", domainId: content.domainId,
          processorAuthorizationRevision: null, expectedDomainEpoch: contentDomain.expectedEpoch,
          expectedNamespaceAccessRevision: content.expectedAccessRevision,
          expectedPolicyRevision: authority.policyRevision,
          descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
          authoritySet: Object.freeze({ namespaceRequirements: authority.namespaces,
            domainRequirements: authority.domains }),
        });
        return dependencies.prepare({ occurrence, stableIdentity, initialRecord,
          repository: await dependencies.repository(restricted),
          recipients: dependencies.recipients, now: dependencies.now });
      },
    });
    if (result !== null) return result;
    if (routing === null || missingNamespaces.size === 0) return { status: "inactive" };
    // No product or crypto transaction survives this point.
    await dependencies.wake({ expected, namespaceIds: [...missingNamespaces].sort() });
    return { status: "awaiting_readiness" };
  };
}
