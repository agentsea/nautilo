import { randomUUID } from "node:crypto";
import {
  and, eq, protectedTaskRunOutputBindings, tasks, taskRunResultCryptoRevisions,
  publishProtectedTaskCancellationProduct,
  type DirectDatabase, type PostgresJsBridgeConnection,
  type ProtectedTaskCancellationOutputIntent, type TaskRunResultCryptoRevision,
} from "@nautilo/db";
import {
  deriveTaskContentCryptoObjectIdV1, fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1, type TaskContentAuthorityV1,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentRepositoryV1, PostgresHumanDeviceSignerHistory,
  verifyCryptoPostgresHandle, withTaskContentNamespaceAuthority,
  type DurableTaskContentRepositoryV1,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { parseBackgroundAuthorizationRecord, PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRepository } from "@nautilo/runtime";
import { findActorByOwnerId } from "@nautilo/trust";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { validateCurrentProtectedTaskCancellationIntent } from "./protected-task-cancellation-authority";
import { protectedTaskCancellationRequestId } from "./protected-task-cancellation-plan";
import { exactPublicationRecord } from "./protected-task-cancellation-settlement";
import { createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from
  "./protected-task-historical-human-device-signing-key";
import { createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";

type Coordinates = Readonly<{ taskId: string; taskRunId: string }>;
type Reservation = Readonly<{
  intent: ProtectedTaskCancellationOutputIntent;
  ledger: TaskRunResultCryptoRevision;
}>;
type Selection = Readonly<{ status: "missing" | "invalid" }>
  | Readonly<{ status: "found"; reservation: Reservation }>;
type ContentResolver = (expected: Readonly<{
  requesterHumanId: string; namespaceId: string;
}>) => Promise<TaskContentAuthorityV1 | null>;
type Dependencies = Readonly<{
  read(db: Pick<DirectDatabase, "select">, coordinates: Coordinates): Promise<Selection>;
  resolveHuman: typeof findActorByOwnerId;
  resolveRoom: ProtectedTaskRequesterPrivateRoomResolver;
  productContext: typeof createHumanProductTransactionContext;
  withAuthority: typeof withTaskContentNamespaceAuthority;
  validateIntent: typeof validateCurrentProtectedTaskCancellationIntent;
  authorizationRepository(connection: PostgresJsBridgeConnection): Promise<Pick<BackgroundAuthorizationRepository, "get">>;
  repository(input: Readonly<{
    reservation: Reservation;
    product: Awaited<ReturnType<typeof createHumanProductTransactionContext>>;
    resolveAuthority: ContentResolver;
  }>): Promise<Pick<DurableTaskContentRepositoryV1<unknown>, "reconcileCoordinate">>;
  publishProduct: typeof publishProtectedTaskCancellationProduct;
  settle(coordinates: Coordinates): Promise<boolean>;
}>;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Metadata only. A ledger's presence must suppress fresh preparation even if invalid. */
async function readReservation(db: Pick<DirectDatabase, "select">,
  coordinates: Coordinates): Promise<Selection> {
  const [ledger] = await db.select().from(taskRunResultCryptoRevisions).where(and(
    eq(taskRunResultCryptoRevisions.taskRunId, coordinates.taskRunId),
    eq(taskRunResultCryptoRevisions.resultRevision, 2),
  )).limit(1);
  if (ledger === undefined) return { status: "missing" };
  const [task] = await db.select({ ownerId: tasks.ownerId, requestorId: tasks.requestorId,
    agentId: tasks.agentId, contentNamespaceId: tasks.contentNamespaceId,
    contentRepresentation: tasks.contentRepresentation, cancelledAt: tasks.cancelledAt,
    status: tasks.status,
  }).from(tasks).where(eq(tasks.id, coordinates.taskId)).limit(1);
  const [binding] = await db.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, coordinates.taskRunId)).limit(1);
  if (task === undefined || binding === undefined || task.status !== "cancelled"
    || task.ownerId !== task.requestorId || task.agentId === null
    || task.contentNamespaceId === null || task.cancelledAt === null
    || (task.contentRepresentation !== "protected" && task.contentRepresentation !== "dual")
    || binding.resultRevision !== 2 || binding.resultTerminalAt === null) return { status: "invalid" };
  const intent: ProtectedTaskCancellationOutputIntent = {
    ...coordinates, requesterUserId: task.requestorId, agentId: task.agentId,
    contentNamespaceId: task.contentNamespaceId, representation: task.contentRepresentation,
    resultRevision: 2, resultOperationId: binding.resultOperationId,
    resultObjectId: binding.resultObjectId, policyRevision: binding.acceptedPolicyRevision,
    taskStatus: "cancelled", runStatus: "cancelled", terminalAt: task.cancelledAt,
  };
  return { status: "found", reservation: { intent, ledger } };
}

function exactReservation({ intent, ledger }: Reservation): boolean {
  return intent.resultRevision === 2
    && intent.resultOperationId === `task-run-cancelled-result:${intent.taskRunId}`
    && intent.resultObjectId === deriveTaskContentCryptoObjectIdV1({
      kind: "run_result", taskId: intent.taskId, taskRunId: intent.taskRunId, contentRevision: 2,
    })
    && ledger.taskId === intent.taskId && ledger.taskRunId === intent.taskRunId
    && ledger.resultRevision === 2 && ledger.operationId === intent.resultOperationId
    && ledger.cryptoObjectId === intent.resultObjectId
    && ledger.contentNamespaceId === intent.contentNamespaceId
    && ledger.anchorNamespaceId === intent.contentNamespaceId
    && ledger.representation === intent.representation && ledger.payloadVersion === 1
    && ledger.cryptoAccessRevision === 0 && ledger.requestDigest.length === 32
    && ledger.authorityFingerprint.length === 32
    && (ledger.disposition === "active" || ledger.disposition === "mapped" && ledger.completion === "complete");
}

function sameReservation(left: Reservation, right: Reservation): boolean {
  return exactReservation(right)
    && left.intent.taskId === right.intent.taskId
    && left.intent.taskRunId === right.intent.taskRunId
    && left.intent.contentNamespaceId === right.intent.contentNamespaceId
    && left.intent.representation === right.intent.representation
    && left.intent.resultRevision === right.intent.resultRevision
    && left.intent.resultOperationId === right.intent.resultOperationId
    && left.intent.resultObjectId === right.intent.resultObjectId
    && left.intent.taskStatus === right.intent.taskStatus
    && left.intent.runStatus === right.intent.runStatus
    && left.intent.requesterUserId === right.intent.requesterUserId
    && left.intent.agentId === right.intent.agentId
    && left.intent.policyRevision === right.intent.policyRevision
    && left.intent.terminalAt.getTime() === right.intent.terminalAt.getTime()
    && left.ledger.sequence === right.ledger.sequence
    && left.ledger.disposition === right.ledger.disposition
    && (left.ledger.completion === right.ledger.completion
      || left.ledger.completion === "pending" && right.ledger.completion === "complete")
    && left.ledger.requesterHumanId === right.ledger.requesterHumanId
    && equal(left.ledger.requestDigest, right.ledger.requestDigest)
    && equal(left.ledger.authorityFingerprint, right.ledger.authorityFingerprint)
    && equal(left.ledger.requiredNamespaceFingerprint, right.ledger.requiredNamespaceFingerprint);
}

/** Recover immutable cancellation bytes; this owner never prepares or opens content. */
export function createProtectedTaskCancellationPublicationRecovery(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  settle(coordinates: Coordinates): Promise<boolean>;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const read = overrides.read ?? readReservation;
  const resolveHuman = overrides.resolveHuman ?? findActorByOwnerId;
  const resolveRoom = overrides.resolveRoom ?? createProtectedTaskRequesterPrivateRoomResolver(input.db);
  const withAuthority = overrides.withAuthority ?? withTaskContentNamespaceAuthority;
  const validateIntent = overrides.validateIntent ?? validateCurrentProtectedTaskCancellationIntent;
  const authorizationRepository = overrides.authorizationRepository ?? (async connection =>
    new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection)));
  const now = input.now ?? Date.now;
  return async (coordinates: Coordinates): Promise<"missing" | "pending" | "mapped" | "quarantined"> => {
    const selected = await read(input.db, coordinates);
    if (selected.status === "missing") return "missing";
    if (selected.status !== "found" || !exactReservation(selected.reservation)) return "pending";
    const reservation = selected.reservation;
    const { intent, ledger } = reservation;
    const [human, room] = await Promise.all([
      resolveHuman(intent.requesterUserId),
      resolveRoom(intent.requesterUserId, intent.agentId, intent.contentNamespaceId),
    ]);
    if (human?.id !== ledger.requesterHumanId || room?.namespaceId !== intent.contentNamespaceId) return "pending";
    const product = await (overrides.productContext ?? createHumanProductTransactionContext)(
      intent.requesterUserId, input.db);
    const coordinate = { kind: "run_result" as const, taskId: intent.taskId,
      taskRunId: intent.taskRunId, contentRevision: 2 };
    const leaseToken = randomUUID();
    async function withProof<Value>(use: (authority: TaskContentAuthorityV1,
      transaction: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
      current: Reservation) => Promise<Value>): Promise<Value | null> {
      return withAuthority({
        runner: product.canonicalRunner, restricted: input.restricted, crypto: input.crypto,
        serverScope: input.serverScope, taskId: intent.taskId,
        requesterUserId: intent.requesterUserId, requesterHumanId: ledger.requesterHumanId,
        agentId: intent.agentId, contentNamespaceId: intent.contentNamespaceId,
        sourceRoomId: room!.roomId, expectedPolicyRevision: intent.policyRevision,
        validateCurrentTaskRun: current => validateIntent({ product: current, intent }),
        use: async (held, _product, transaction, restricted) => {
          // Immutable receipt reads do not acquire a second ledger lock.
          // Reconciliation resolves this authority before claiming its lease.
          const fresh = await read(transaction, coordinates);
          if (fresh.status !== "found" || !sameReservation(reservation, fresh.reservation)) return null;
          const fact = held.facts[0];
          if (held.facts.length !== 1 || fact?.namespaceId !== intent.contentNamespaceId
            || fact.expectedPolicyRevision !== intent.policyRevision) return null;
          const authority: TaskContentAuthorityV1 = {
            authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
            requesterHumanId: ledger.requesterHumanId, namespaceId: fact.namespaceId,
            domainId: fact.domainId, expectedAccessRevision: fact.expectedAccessRevision,
            expectedPolicyRevision: fact.expectedPolicyRevision,
          };
          if (!equal(fingerprintTaskContentAuthorityV1(authority), ledger.authorityFingerprint)) return null;
          const raw = await (await authorizationRepository(restricted)).get(protectedTaskCancellationRequestId(intent.taskRunId));
          const record = raw === null ? null : parseBackgroundAuthorizationRecord(raw);
          if (!exactPublicationRecord(record, { intent, requesterHumanId: ledger.requesterHumanId,
            authorityFingerprint: ledger.authorityFingerprint })
            || (record.snapshot.state === "completed"
              ? fresh.reservation.ledger.disposition !== "mapped"
                || record.finishedAt !== record.snapshot.updatedAt
              : record.finishedAt !== null
                || !["running", "publication_reconciliation"].includes(record.snapshot.state))) return null;
          return use(authority, transaction, fresh.reservation);
        },
      });
    }
    const resolveAuthority: ContentResolver = async expected => {
      if (expected.requesterHumanId !== ledger.requesterHumanId
        || expected.namespaceId !== intent.contentNamespaceId) return null;
      return withProof(authority => Promise.resolve(authority));
    };
    if (await resolveAuthority({ requesterHumanId: ledger.requesterHumanId,
      namespaceId: intent.contentNamespaceId }) === null) return "pending";
    const repository = overrides.repository === undefined ? await (async () => {
      const handle = await verifyCryptoPostgresHandle(input.restricted);
      const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
      const unavailable = (): never => { throw new Error("Cancellation recovery cannot prepare or open content"); };
      return createPostgresTaskContentRepositoryV1({
        product: { handle: product.handle, resolveCurrentAuthority: resolveAuthority },
        crypto: { handle, crypto: input.crypto,
          resolveCurrentAuthority: candidate => sameTaskContentCoordinateV1(candidate, coordinate)
            ? resolveAuthority({ requesterHumanId: ledger.requesterHumanId, namespaceId: intent.contentNamespaceId })
            : Promise.resolve(null),
          resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
          resolveHistoricalHumanDeviceSigningPublicKey: createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle) },
        content: { prepareProtected: unavailable, publishProduct: unavailable,
          readOrdinary: unavailable, readProtected: unavailable },
      });
    })() : await overrides.repository({ reservation, product, resolveAuthority });
    // Reconciliation owns its transactions. Never enclose it in withProof:
    // crypto verification and the product callback independently re-enter authority.
    const outcome = await repository.reconcileCoordinate({ coordinate,
      operationId: intent.resultOperationId, leaseToken,
      publishProduct: async () => {
        const published = await withProof(async (_authority, transaction, current) => {
          if (current.ledger.disposition !== "active" || current.ledger.leaseToken !== leaseToken
            || current.ledger.leaseExpiresAt === null || current.ledger.leaseExpiresAt.getTime() <= now()) return false;
          const result = await (overrides.publishProduct ?? publishProtectedTaskCancellationProduct)({
            transaction: use => use(transaction),
          }, { intent, requestDigest: ledger.requestDigest,
            prepared: { operationId: intent.resultOperationId, resultRevision: 2,
              resultObjectId: intent.resultObjectId, requesterHumanId: ledger.requesterHumanId,
              authorityFingerprint: ledger.authorityFingerprint } }, () => Promise.resolve(current.ledger.leaseExpiresAt!.getTime() > now()));
          return result.status !== "rejected";
        });
        if (published !== true) throw new Error("Cancellation recovery product authority changed");
      },
    });
    if (outcome === "mapped") return await (overrides.settle ?? input.settle)(coordinates) ? "mapped" : "pending";
    return outcome === "quarantined" ? "quarantined" : "pending";
  };
}
