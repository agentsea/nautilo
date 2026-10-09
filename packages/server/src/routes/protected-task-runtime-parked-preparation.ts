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
  PostgresBackgroundAuthorizationRepository,
  prepareUnclaimedParkedTaskRuntimeAuthority, rotateExpiredTaskRuntimeRecipient,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import type { PolicyResolver } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { publishDomainKeyCatchUpRequested } from "../realtime/ws-publisher";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { createProtectedTaskRuntimeParkedMemoryPlanResolver } from "./protected-task-runtime-parked-memory-plan";
import {
  createParkedTaskRuntimeAuthorizationPlanResolver,
  createParkedTaskRuntimeAuthorizationRecord,
  type ParkedTaskRuntimePlanDependencies,
} from "./protected-task-runtime-parked-plan";

type PrepareResult = Awaited<ReturnType<typeof prepareUnclaimedParkedTaskRuntimeAuthority>>
  | Readonly<{ status: "awaiting_readiness" | "rotated" }>;

type Dependencies = ParkedTaskRuntimePlanDependencies & Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  recipients: TaskRuntimeRecipientRegistry;
  productContext: typeof createHumanProductTransactionContext;
  restricted: () => Parameters<typeof withParkedTaskRuntimeNamespaceAuthority>[0]["restricted"];
  withAuthority: typeof withParkedTaskRuntimeNamespaceAuthority;
  repository: (connection: Parameters<typeof verifyCryptoPostgresHandle>[0]) =>
    Promise<BackgroundAuthorizationTaskRuntimeReplacementRepository>;
  prepare: typeof prepareUnclaimedParkedTaskRuntimeAuthority;
  rotate: typeof rotateExpiredTaskRuntimeRecipient;
  wake: (input: Readonly<{
    expected: ParkedProtectedTaskAdditionalAuthority;
    namespaceIds: readonly string[];
  }>) => Promise<void>;
  now: () => number;
}>;

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
    rotate: overrides.rotate ?? rotateExpiredTaskRuntimeRecipient,
    wake: overrides.wake ?? createReadinessWake(db), now: overrides.now ?? Date.now,
  };
  const resolvePlan = createParkedTaskRuntimeAuthorizationPlanResolver(dependencies);
  return async observed => {
    if (observed.run.jobId === null) return { status: "inactive" };
    const resolved = await resolvePlan({ taskRunId: observed.run.id, occurrence: observed });
    if (resolved === null) return { status: "inactive" };
    const { expected, policy, memory: plan, inventory } = resolved;
    const occurrence = expected.occurrence;
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
        if (!resolved.validateCurrentRouting(facts)) return false;
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
        const { stableIdentity, initialRecord } = createParkedTaskRuntimeAuthorizationRecord(
          resolved, facts, current.facts, dependencies.now(),
        );
        const repository = await dependencies.repository(restricted);
        const prepared = await dependencies.prepare({ occurrence, stableIdentity, initialRecord,
          repository, recipients: dependencies.recipients, now: dependencies.now });
        if (prepared.status !== "exact_replay") return prepared;
        const selected = await repository.get(initialRecord.snapshot.requestId);
        if (selected === null || selected.snapshot.formatVersion !== 3) return { status: "stale" as const };
        if (!["awaiting_device", "grant_ready"].includes(selected.snapshot.state)) return prepared;
        const rotation = await dependencies.rotate({ occurrence,
          selected: selected as BackgroundAuthorizationTaskRuntimeRecordV3,
          initialRecord, repository, recipients: dependencies.recipients, now: dependencies.now });
        return rotation.status === "not_due" ? prepared : { status: rotation.status };
      },
    });
    if (result !== null) return result;
    if (routing === null || missingNamespaces.size === 0) return { status: "inactive" };
    // No product or crypto transaction survives this point.
    await dependencies.wake({ expected, namespaceIds: [...missingNamespaces].sort() });
    return { status: "awaiting_readiness" };
  };
}
