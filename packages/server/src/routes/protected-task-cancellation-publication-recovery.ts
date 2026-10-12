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
  type TaskContentCoordinateV1,
  type TaskContentProductStorePort,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentRepositoryV1, PostgresHumanDeviceSignerHistory,
  PostgresTaskContentProductStore, hasTaskCancellationCryptoPublication,
  inspectStagedTaskCancellationPublication, reserveStagedTaskCancellationPublication,
  verifyCryptoPostgresHandle, withTaskContentNamespaceAuthority,
  type DurableTaskContentRepositoryV1,
  type VerifiedStagedTaskCancellationPublication,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { parseBackgroundAuthorizationRecord, PostgresBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRepository } from "@nautilo/runtime";
import { findActorByOwnerId } from "@nautilo/trust";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import { validateCurrentProtectedTaskCancellationIntent } from "./protected-task-cancellation-authority";
import { protectedTaskCancellationRequestId } from "./protected-task-cancellation-plan";
import { exactPublicationRecord } from "./protected-task-cancellation-settlement";
import type { VerifyStagedCancellationSettlement } from "./protected-task-cancellation-settlement";
import { createProtectedTaskHistoricalHumanDeviceSigningKeyResolver } from
  "./protected-task-historical-human-device-signing-key";
import { createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";

type Coordinates = Readonly<{ taskId: string; taskRunId: string }>;
type Reservation = Readonly<{
  intent: ProtectedTaskCancellationOutputIntent;
  ledger: TaskRunResultCryptoRevision;
}>;
type Selection = Readonly<{ status: "invalid" }>
  | Readonly<{ status: "missing"; intent: ProtectedTaskCancellationOutputIntent | null }>
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
  cryptoHandle: typeof verifyCryptoPostgresHandle;
  authorizationRepository(connection: PostgresJsBridgeConnection): Promise<Pick<BackgroundAuthorizationRepository, "get">>;
  inspectStaged: typeof inspectStagedTaskCancellationPublication;
  hasCryptoPublication: typeof hasTaskCancellationCryptoPublication;
  reserveStaged: typeof reserveStagedTaskCancellationPublication;
  reservationProduct(input: Readonly<{
    product: Awaited<ReturnType<typeof createHumanProductTransactionContext>>;
    resolveAuthority: ContentResolver;
    assertReservationCurrent(coordinate: TaskContentCoordinateV1): void | Promise<void>;
  }>): Pick<TaskContentProductStorePort, "reserveRevision">;
  repository(input: Readonly<{
    reservation: Reservation;
    product: Awaited<ReturnType<typeof createHumanProductTransactionContext>>;
    resolveAuthority: ContentResolver;
  }>): Promise<Pick<DurableTaskContentRepositoryV1<unknown>, "reconcileCoordinate">>;
  publishProduct: typeof publishProtectedTaskCancellationProduct;
  settle(coordinates: Coordinates, verifyStaged?: VerifyStagedCancellationSettlement): Promise<boolean>;
}>;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Metadata only. A ledger's presence must suppress fresh preparation even if invalid. */
async function readReservation(db: Pick<DirectDatabase, "select">,
  coordinates: Coordinates): Promise<Selection> {
  const [task] = await db.select({ ownerId: tasks.ownerId, requestorId: tasks.requestorId,
    agentId: tasks.agentId, contentNamespaceId: tasks.contentNamespaceId,
    contentRepresentation: tasks.contentRepresentation, cancelledAt: tasks.cancelledAt,
    status: tasks.status,
  }).from(tasks).where(eq(tasks.id, coordinates.taskId)).limit(1);
  const [binding] = await db.select().from(protectedTaskRunOutputBindings)
    .where(eq(protectedTaskRunOutputBindings.taskRunId, coordinates.taskRunId)).limit(1);
  const [ledger] = await db.select().from(taskRunResultCryptoRevisions).where(and(
    eq(taskRunResultCryptoRevisions.taskRunId, coordinates.taskRunId),
    eq(taskRunResultCryptoRevisions.resultRevision, 2),
  )).limit(1);
  if (task === undefined || task.status !== "cancelled"
    || task.ownerId !== task.requestorId || task.agentId === null
    || task.contentNamespaceId === null || task.cancelledAt === null
    || (task.contentRepresentation !== "protected" && task.contentRepresentation !== "dual")) return { status: "invalid" };
  if (binding === undefined) return ledger === undefined ? { status: "missing", intent: null } : { status: "invalid" };
  if (binding.resultRevision !== 2 || binding.resultTerminalAt === null) return { status: "invalid" };
  const intent: ProtectedTaskCancellationOutputIntent = {
    ...coordinates, requesterUserId: task.requestorId, agentId: task.agentId,
    contentNamespaceId: task.contentNamespaceId, representation: task.contentRepresentation,
    resultRevision: 2, resultOperationId: binding.resultOperationId,
    resultObjectId: binding.resultObjectId, policyRevision: binding.acceptedPolicyRevision,
    taskStatus: "cancelled", runStatus: "cancelled", terminalAt: task.cancelledAt,
  };
  if (ledger === undefined) return { status: "missing", intent };
  return { status: "found", reservation: { intent, ledger } };
}

function sameIntent(left: ProtectedTaskCancellationOutputIntent,
  right: ProtectedTaskCancellationOutputIntent): boolean {
  return left.taskId === right.taskId && left.taskRunId === right.taskRunId
    && left.requesterUserId === right.requesterUserId && left.agentId === right.agentId
    && left.contentNamespaceId === right.contentNamespaceId
    && left.representation === right.representation && left.resultRevision === right.resultRevision
    && left.resultOperationId === right.resultOperationId && left.resultObjectId === right.resultObjectId
    && left.policyRevision === right.policyRevision && left.taskStatus === right.taskStatus
    && left.runStatus === right.runStatus && left.terminalAt.getTime() === right.terminalAt.getTime();
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
  return sameReservationIdentity(left, right)
    && left.ledger.disposition === right.ledger.disposition
    && (left.ledger.completion === right.ledger.completion
      || left.ledger.completion === "pending" && right.ledger.completion === "complete")
}

function sameReservationIdentity(left: Reservation, right: Reservation): boolean {
  return exactReservation(right) && sameIntent(left.intent, right.intent)
    && left.ledger.sequence === right.ledger.sequence
    && left.ledger.requesterHumanId === right.ledger.requesterHumanId
    && equal(left.ledger.requestDigest, right.ledger.requestDigest)
    && equal(left.ledger.authorityFingerprint, right.ledger.authorityFingerprint)
    && equal(left.ledger.requiredNamespaceFingerprint, right.ledger.requiredNamespaceFingerprint);
}

function exactMappedSuccess(left: Reservation, right: Reservation): boolean {
  return sameReservationIdentity(left, right)
    && right.ledger.disposition === "mapped" && right.ledger.completion === "complete";
}

function sameStage(left: VerifiedStagedTaskCancellationPublication,
  right: VerifiedStagedTaskCancellationPublication): boolean {
  return sameIntent(left.intent, right.intent) && left.requestId === right.requestId
    && left.recipientGeneration === right.recipientGeneration && left.claimId === right.claimId
    && equal(left.authorizationDigest, right.authorizationDigest)
    && equal(left.genesisManifestHash, right.genesisManifestHash)
    && equal(left.authorityFingerprint, right.authorityFingerprint);
}

function stageMatchesReservation(staged: VerifiedStagedTaskCancellationPublication,
  reservation: Reservation): boolean {
  return sameIntent(staged.intent, reservation.intent)
    && staged.requestId === protectedTaskCancellationRequestId(reservation.intent.taskRunId)
    && equal(staged.genesisManifestHash, reservation.ledger.requestDigest)
    && equal(staged.authorityFingerprint, reservation.ledger.authorityFingerprint);
}

/** Recover immutable cancellation bytes; this owner never prepares or opens content. */
export function createProtectedTaskCancellationPublicationRecovery(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  settle(coordinates: Coordinates, verifyStaged?: VerifyStagedCancellationSettlement): Promise<boolean>;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const read = overrides.read ?? readReservation;
  const resolveHuman = overrides.resolveHuman ?? findActorByOwnerId;
  const resolveRoom = overrides.resolveRoom ?? createProtectedTaskRequesterPrivateRoomResolver(input.db);
  const withAuthority = overrides.withAuthority ?? withTaskContentNamespaceAuthority;
  const validateIntent = overrides.validateIntent ?? validateCurrentProtectedTaskCancellationIntent;
  const cryptoHandleFor = overrides.cryptoHandle ?? verifyCryptoPostgresHandle;
  const authorizationRepository = overrides.authorizationRepository ?? (async connection =>
    new PostgresBackgroundAuthorizationRepository(await cryptoHandleFor(connection)));
  const inspectStaged = overrides.inspectStaged ?? inspectStagedTaskCancellationPublication;
  const hasCryptoPublication = overrides.hasCryptoPublication ?? hasTaskCancellationCryptoPublication;
  const reserveStaged = overrides.reserveStaged ?? reserveStagedTaskCancellationPublication;
  const reservationProduct = overrides.reservationProduct ?? (value =>
    new PostgresTaskContentProductStore(value.product.handle, value.resolveAuthority,
      value.assertReservationCurrent));
  const now = input.now ?? Date.now;
  return async (coordinates: Coordinates): Promise<"missing" | "pending" | "mapped" | "quarantined"> => {
    let selected = await read(input.db, coordinates);
    if (selected.status === "invalid") return "pending";
    if (selected.status === "missing" && selected.intent === null) {
      const handle = await cryptoHandleFor(input.restricted);
      const objectId = deriveTaskContentCryptoObjectIdV1({ kind: "run_result",
        taskId: coordinates.taskId, taskRunId: coordinates.taskRunId, contentRevision: 2 });
      return await hasCryptoPublication(handle, {
        requestId: protectedTaskCancellationRequestId(coordinates.taskRunId), objectId,
      }) ? "pending" : "missing";
    }
    const selectedIntent = selected.status === "found" ? selected.reservation.intent : selected.intent;
    if (selectedIntent === null) return "pending";
    let intent: ProtectedTaskCancellationOutputIntent = selectedIntent;
    const [human, room] = await Promise.all([
      resolveHuman(intent.requesterUserId),
      resolveRoom(intent.requesterUserId, intent.agentId, intent.contentNamespaceId),
    ]);
    if (human === null || room?.namespaceId !== intent.contentNamespaceId) return "pending";
    if (selected.status === "found" && human.id !== selected.reservation.ledger.requesterHumanId) return "pending";
    const requesterHumanId = human.id;
    const product = await (overrides.productContext ?? createHumanProductTransactionContext)(
      intent.requesterUserId, input.db);
    const cryptoHandle = await cryptoHandleFor(input.restricted);
    const coordinate = { kind: "run_result" as const, taskId: intent.taskId,
      taskRunId: intent.taskRunId, contentRevision: 2 };
    const inspect = async (handle: typeof cryptoHandle, currentIntent: ProtectedTaskCancellationOutputIntent,
      authority: TaskContentAuthorityV1) => {
      const history = overrides.inspectStaged === undefined
        ? new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto }) : null;
      return inspectStaged({ handle, crypto: input.crypto, intent: currentIntent, authority,
        resolveHistoricalAgentSignerAuthority: history?.resolveAgentRuntimeSignerManager
          ?? (() => Promise.resolve(null)),
        resolveHistoricalHumanDeviceSigningPublicKey:
          history === null ? () => Promise.resolve(null)
            : createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle) });
    };
    async function withCurrent<Value>(expected: Selection, use: (authority: TaskContentAuthorityV1,
      transaction: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
      current: Selection, restricted: PostgresJsBridgeConnection) => Promise<Value>): Promise<Value | null> {
      const allowTerminalResultAttachment = expected.status === "found"
        && expected.reservation.ledger.disposition === "mapped"
        && expected.reservation.ledger.completion === "complete";
      return withAuthority({
        runner: product.canonicalRunner, restricted: input.restricted, crypto: input.crypto,
        serverScope: input.serverScope, taskId: intent.taskId,
        requesterUserId: intent.requesterUserId, requesterHumanId,
        agentId: intent.agentId, contentNamespaceId: intent.contentNamespaceId,
        sourceRoomId: room!.roomId, expectedPolicyRevision: intent.policyRevision,
        validateCurrentTaskRun: current => validateIntent({ product: current, intent,
          ...(allowTerminalResultAttachment ? { allowTerminalResultAttachment: true } : {}) }),
        use: async (held, _product, transaction, restricted) => {
          const fresh = await read(transaction, coordinates);
          if (expected.status === "invalid" || fresh.status === "invalid") return null;
          if (expected.status === "missing") {
            if (expected.intent === null || fresh.status !== "missing" || fresh.intent === null
              || !sameIntent(expected.intent, fresh.intent)) return null;
          } else if (fresh.status !== "found" || !sameReservation(expected.reservation, fresh.reservation)) {
            return null;
          }
          const fact = held.facts[0];
          if (held.facts.length !== 1 || fact?.namespaceId !== intent.contentNamespaceId
            || fact.expectedPolicyRevision !== intent.policyRevision) return null;
          const authority: TaskContentAuthorityV1 = {
            authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
            requesterHumanId, namespaceId: fact.namespaceId,
            domainId: fact.domainId, expectedAccessRevision: fact.expectedAccessRevision,
            expectedPolicyRevision: fact.expectedPolicyRevision,
          };
          if (fresh.status === "found"
            && !equal(fingerprintTaskContentAuthorityV1(authority), fresh.reservation.ledger.authorityFingerprint)) return null;
          return use(authority, transaction, fresh, restricted);
        },
      });
    }
    async function currentStage(expected: Selection): Promise<Readonly<{
      authority: TaskContentAuthorityV1;
      staged: VerifiedStagedTaskCancellationPublication | null;
    }> | null> {
      try {
        return await withCurrent(expected, async (authority, _transaction, fresh, restricted) => {
          const handle = await cryptoHandleFor(restricted);
          if (fresh.status === "invalid") return null;
          const currentIntent = fresh.status === "found" ? fresh.reservation.intent : fresh.intent;
          if (currentIntent === null) return null;
          const staged = await inspect(handle, currentIntent, authority);
          return { authority, staged };
        });
      } catch {
        // Conflicting or incomplete staged bytes fence fresh encryption and are retried as pending.
        return null;
      }
    }
    if (selected.status === "missing") {
      const proof = await currentStage(selected);
      if (proof === null) return "pending";
      if (proof.staged === null) {
        return await hasCryptoPublication(cryptoHandle, {
          requestId: protectedTaskCancellationRequestId(intent.taskRunId), objectId: intent.resultObjectId,
        }) ? "pending" : "missing";
      }
      if (!sameIntent(proof.staged.intent, intent)) return "pending";
      const detachedAuthority = Object.freeze({ ...proof.authority });
      const resolveDetached: ContentResolver = expected => Promise.resolve(
        expected.requesterHumanId === requesterHumanId && expected.namespaceId === intent.contentNamespaceId
          ? detachedAuthority : null);
      const stagedProduct = reservationProduct({ product, resolveAuthority: resolveDetached,
        assertReservationCurrent: async candidate => {
          if (!sameTaskContentCoordinateV1(candidate, coordinate)) {
            throw new Error("Cancellation staging coordinate changed");
          }
          // Product predecessor locks already prove the stopped Task/Run. Re-inspect only
          // immutable crypto custody here so this callback never recursively locks Task/Run.
          const current = await inspect(cryptoHandle, intent, detachedAuthority);
          if (current === null || !sameStage(proof.staged!, current)) {
            throw new Error("Cancellation staging receipt changed");
          }
        } });
      const adopted = await reserveStaged({ staged: proof.staged, authority: detachedAuthority,
        product: stagedProduct });
      if (adopted.status !== "reserved" && adopted.status !== "replayed") return "pending";
      selected = await read(input.db, coordinates);
      if (selected.status !== "found" || !exactReservation(selected.reservation)
        || !sameIntent(intent, selected.reservation.intent)
        || !stageMatchesReservation(proof.staged, selected.reservation)) return "pending";
      intent = selected.reservation.intent;
    }
    if (selected.status !== "found" || !exactReservation(selected.reservation)) return "pending";
    let reservation = selected.reservation;
    let ledger = reservation.ledger;
    const leaseToken = randomUUID();
    async function withProof<Value>(use: (authority: TaskContentAuthorityV1,
      transaction: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
      current: Reservation) => Promise<Value>): Promise<Value | null> {
      return withCurrent({ status: "found", reservation }, async (authority, transaction, fresh, restricted) => {
          if (fresh.status !== "found") return null;
          const handle = await cryptoHandleFor(restricted);
          let staged: VerifiedStagedTaskCancellationPublication | null;
          try {
            staged = await inspect(handle, fresh.reservation.intent, authority);
          } catch {
            return null;
          }
          if (staged !== null) {
            if (!stageMatchesReservation(staged, fresh.reservation)) return null;
          } else {
            const raw = await (await authorizationRepository(restricted))
              .get(protectedTaskCancellationRequestId(intent.taskRunId));
            const record = raw === null ? null : parseBackgroundAuthorizationRecord(raw);
            if (!exactPublicationRecord(record, { intent, requesterHumanId,
              authorityFingerprint: ledger.authorityFingerprint })
              || (record.snapshot.state === "completed"
                ? fresh.reservation.ledger.disposition !== "mapped"
                  || record.finishedAt !== record.snapshot.updatedAt
                : record.finishedAt !== null
                  || !["running", "publication_reconciliation"].includes(record.snapshot.state))) return null;
          }
          return use(authority, transaction, fresh.reservation);
        });
    }
    const resolveAuthority: ContentResolver = async expected => {
      if (expected.requesterHumanId !== requesterHumanId
        || expected.namespaceId !== intent.contentNamespaceId) return null;
      return withProof(authority => Promise.resolve(authority));
    };
    if (await resolveAuthority({ requesterHumanId,
      namespaceId: intent.contentNamespaceId }) === null) return "pending";
    const repository = overrides.repository === undefined ? await (async () => {
      const handle = await cryptoHandleFor(input.restricted);
      const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
      const unavailable = (): never => { throw new Error("Cancellation recovery cannot prepare or open content"); };
      return createPostgresTaskContentRepositoryV1({
        product: { handle: product.handle, resolveCurrentAuthority: resolveAuthority },
        crypto: { handle, crypto: input.crypto,
          resolveCurrentAuthority: candidate => sameTaskContentCoordinateV1(candidate, coordinate)
            ? resolveAuthority({ requesterHumanId, namespaceId: intent.contentNamespaceId })
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
    if (outcome === "mapped") {
      const mapped = await read(input.db, coordinates);
      if (mapped.status !== "found" || !exactMappedSuccess(reservation, mapped.reservation)) return "pending";
      reservation = mapped.reservation;
      ledger = reservation.ledger;
      const settlementAuthority = await resolveAuthority({ requesterHumanId,
        namespaceId: intent.contentNamespaceId });
      if (settlementAuthority === null) return "pending";
      const verifyStaged: VerifyStagedCancellationSettlement = async proof => {
        if (!sameIntent(proof.intent, reservation.intent) || proof.requesterHumanId !== requesterHumanId
          || proof.cryptoAccessRevision !== ledger.cryptoAccessRevision
          || !equal(proof.authorityFingerprint, ledger.authorityFingerprint)
          || !equal(proof.requiredNamespaceFingerprint, ledger.requiredNamespaceFingerprint)) return null;
        let staged: VerifiedStagedTaskCancellationPublication | null;
        try {
          staged = await inspect(cryptoHandle, reservation.intent, settlementAuthority);
        } catch {
          return null;
        }
        if (staged === null || !stageMatchesReservation(staged, reservation)
          || staged.requestId !== protectedTaskCancellationRequestId(intent.taskRunId)) return null;
        return { requestId: staged.requestId, recipientGeneration: staged.recipientGeneration };
      };
      return await (overrides.settle ?? input.settle)(coordinates, verifyStaged) ? "mapped" : "pending";
    }
    return outcome === "quarantined" ? "quarantined" : "pending";
  };
}
