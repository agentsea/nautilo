import { randomUUID } from "node:crypto";
import {
  and, eq, protectedTaskRunOutputBindings, tasks, taskRunResultCryptoRevisions,
  publishProtectedTaskCancellationProduct, getEncryptionTransitionPolicy,
  protectedTaskRunOutputBindingId, protectedTaskRunResultObjectId, protectedTaskRunResultOperationId,
  type DirectDatabase, type PostgresJsBridgeConnection,
  type ProtectedTaskCancellationOutputIntent, type TaskRunResultCryptoRevision,
} from "@nautilo/db";
import {
  deriveTaskContentCryptoObjectIdV1, fingerprintTaskContentAuthorityV1,
  sameTaskContentCoordinateV1, TaskCancellationPublicationPolicyUnavailableError, type TaskContentAuthorityV1,
  type TaskContentCoordinateV1,
  type TaskContentProductStorePort,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentRepositoryV1, PostgresHumanDeviceSignerHistory,
  PostgresTaskContentProductStore, hasTaskCancellationCryptoPublication,
  inspectStagedTaskCancellationPublication, reserveStagedTaskCancellationPublication,
  verifyCryptoPostgresHandle, verifyConversationProductPostgresHandle, withTaskContentNamespaceAuthority,
  type DurableTaskContentRepositoryV1,
  type VerifiedStagedTaskCancellationPublication,
  type VerifyStagedTaskCancellationPublication,
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

export type ProtectedTaskCancellationSettlementContext = Readonly<{
  db: Pick<DirectDatabase, "transaction">;
  restricted: PostgresJsBridgeConnection;
  deferRecipientCleanup(release: () => void): void;
}>;
type Settle = (coordinates: Coordinates, verifyStaged: VerifyStagedCancellationSettlement,
  context: ProtectedTaskCancellationSettlementContext) => Promise<boolean>;
type Coordinates = Readonly<{ taskId: string; taskRunId: string; currentPolicyRevision?: number }>;
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
  readPolicy: typeof getEncryptionTransitionPolicy;
  read(db: Pick<DirectDatabase, "select">, coordinates: Coordinates): Promise<Selection>;
  resolveHuman: typeof findActorByOwnerId;
  resolveRoom: ProtectedTaskRequesterPrivateRoomResolver;
  productContext: typeof createHumanProductTransactionContext;
  withAuthority: typeof withTaskContentNamespaceAuthority;
  validateIntent: typeof validateCurrentProtectedTaskCancellationIntent;
  cryptoHandle: typeof verifyCryptoPostgresHandle;
  productHandle: typeof verifyConversationProductPostgresHandle;
  authorizationRepository(connection: PostgresJsBridgeConnection): Promise<Pick<BackgroundAuthorizationRepository, "get">>;
  inspectStaged: typeof inspectStagedTaskCancellationPublication;
  hasCryptoPublication: typeof hasTaskCancellationCryptoPublication;
  reserveStaged: typeof reserveStagedTaskCancellationPublication;
  reservationProduct(input: Readonly<{
    product: Pick<Awaited<ReturnType<typeof createHumanProductTransactionContext>>, "handle">;
    resolveAuthority: ContentResolver;
    verifyStagedCancellation: VerifyStagedTaskCancellationPublication;
    assertReservationCurrent(coordinate: TaskContentCoordinateV1): void | Promise<void>;
  }>): Pick<TaskContentProductStorePort, "reserveRevision">;
  repository(input: Readonly<{
    reservation: Reservation;
    product: Pick<Awaited<ReturnType<typeof createHumanProductTransactionContext>>, "handle">;
    resolveAuthority: ContentResolver;
    verifyStagedCancellation: VerifyStagedTaskCancellationPublication;
  }>): Promise<Pick<DurableTaskContentRepositoryV1<unknown>, "reconcileCoordinate">>;
  publishProduct: typeof publishProtectedTaskCancellationProduct;
  settle: Settle;
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
  // An untouched execution binding is eligible for the canonical preparation
  // owner to replace. Existing cancellation crypto still fences this outcome.
  if (ledger === undefined && binding.taskRunId === coordinates.taskRunId
    && binding.bindingId === protectedTaskRunOutputBindingId(coordinates.taskRunId)
    && binding.resultRevision === 1
    && binding.resultOperationId === protectedTaskRunResultOperationId(coordinates.taskRunId)
    && binding.resultObjectId === protectedTaskRunResultObjectId(coordinates.taskId, coordinates.taskRunId)
    && Number.isSafeInteger(binding.acceptedPolicyRevision) && binding.acceptedPolicyRevision > 0
    && binding.resultTerminalAt === null && binding.resultAttachedAt === null
    && binding.messageId === null && binding.messagePublishedAt === null
    && binding.wakeJobId === null && binding.wakeScheduledAt === null
    && binding.completedAt === null) return { status: "missing", intent: null };
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
  settle: Settle;
  now?: () => number;
}>, overrides: Partial<Dependencies> = {}) {
  const read = overrides.read ?? readReservation;
  const readPolicy = overrides.readPolicy ?? getEncryptionTransitionPolicy;
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
      value.assertReservationCurrent, value.verifyStagedCancellation));
  const now = input.now ?? Date.now;
  const recover = async (coordinates: Coordinates): Promise<"missing" | "pending" | "mapped" | "quarantined"> => {
    const selected = await read(input.db, coordinates);
    const startingPolicy = await readPolicy(input.db);
    if (startingPolicy.mode === "plaintext_only") return "pending";
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
    const intent: ProtectedTaskCancellationOutputIntent = selectedIntent;
    if (startingPolicy.revision < intent.policyRevision
      || startingPolicy.mode !== (intent.representation === "dual"
        ? "shadow_encryption" : "encrypted_only")) return "pending";
    const [human, room] = await Promise.all([
      resolveHuman(intent.requesterUserId),
      resolveRoom(intent.requesterUserId, intent.agentId, intent.contentNamespaceId),
    ]);
    if (human === null || room?.namespaceId !== intent.contentNamespaceId) return "pending";
    if (selected.status === "found" && human.id !== selected.reservation.ledger.requesterHumanId) return "pending";
    const requesterHumanId = human.id;
    if (selected.status === "missing") {
      const handle = await cryptoHandleFor(input.restricted);
      if (!await hasCryptoPublication(handle, {
        requestId: protectedTaskCancellationRequestId(intent.taskRunId), objectId: intent.resultObjectId,
      })) return "missing";
    }
    const product = await (overrides.productContext ?? createHumanProductTransactionContext)(
      intent.requesterUserId, input.db);
    const coordinate = { kind: "run_result" as const, taskId: intent.taskId,
      taskRunId: intent.taskRunId, contentRevision: 2 };
    const inspect = async (handle: Awaited<ReturnType<typeof cryptoHandleFor>>,
      currentIntent: ProtectedTaskCancellationOutputIntent, authority: TaskContentAuthorityV1) => {
      const history = overrides.inspectStaged === undefined
        ? new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto }) : null;
      return inspectStaged({ handle, crypto: input.crypto, intent: currentIntent, authority,
        resolveHistoricalAgentSignerAuthority: history?.resolveAgentRuntimeSignerManager
          ?? (() => Promise.resolve(null)),
        resolveHistoricalHumanDeviceSigningPublicKey:
          history === null ? () => Promise.resolve(null)
            : createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle) });
    };
    type Held = Readonly<{
      authority: TaskContentAuthorityV1;
      transaction: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
      current: Selection;
      restricted: PostgresJsBridgeConnection;
      product: Pick<Awaited<ReturnType<typeof createHumanProductTransactionContext>>, "handle">;
      cryptoHandle: Awaited<ReturnType<typeof cryptoHandleFor>>;
      resolveAuthority: ContentResolver;
      verifyStagedCancellation: VerifyStagedTaskCancellationPublication;
    }>;
    async function withCurrent<Value>(expected: Selection, use: (held: Held) => Promise<Value>): Promise<Value | null> {
      const allowTerminalResultAttachment = expected.status === "found"
        && expected.reservation.ledger.disposition === "mapped"
        && expected.reservation.ledger.completion === "complete";
      const policy = await readPolicy(input.db);
      if (policy.revision < intent.policyRevision
        || policy.mode !== (intent.representation === "dual" ? "shadow_encryption" : "encrypted_only")) {
        throw new TaskCancellationPublicationPolicyUnavailableError();
      }
      const result = await withAuthority({
        runner: product.canonicalRunner, restricted: input.restricted, crypto: input.crypto,
        serverScope: input.serverScope, taskId: intent.taskId,
        requesterUserId: intent.requesterUserId, requesterHumanId,
        agentId: intent.agentId, contentNamespaceId: intent.contentNamespaceId,
        sourceRoomId: room!.roomId, expectedPolicyRevision: policy.revision,
        validateCurrentTaskRun: current => validateIntent({ product: current, intent,
          ...(allowTerminalResultAttachment ? { allowTerminalResultAttachment: true } : {}) }),
        use: async (held, borrowedProduct, transaction, restricted) => {
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
            || fact.expectedPolicyRevision !== policy.revision) return null;
          const authority: TaskContentAuthorityV1 = Object.freeze({
            authorityVersion: 1, kind: "requester_private_namespace", keyClass: "ai",
            requesterHumanId, namespaceId: fact.namespaceId,
            domainId: fact.domainId, expectedAccessRevision: fact.expectedAccessRevision,
            expectedPolicyRevision: fact.expectedPolicyRevision,
          });
          if (fresh.status === "found"
            && !equal(fingerprintTaskContentAuthorityV1({ ...authority, expectedPolicyRevision: intent.policyRevision }), fresh.reservation.ledger.authorityFingerprint)) return null;
          const scopedProduct = { handle: await (overrides.productHandle
            ?? verifyConversationProductPostgresHandle)(borrowedProduct) };
          const cryptoHandle = await cryptoHandleFor(restricted);
          let active = true;
          const resolveAuthority: ContentResolver = expected => Promise.resolve(active
            && expected.requesterHumanId === requesterHumanId
            && expected.namespaceId === intent.contentNamespaceId ? authority : null);
          const verifyStagedCancellation: VerifyStagedTaskCancellationPublication = async candidate => {
            if (!active || !sameTaskContentCoordinateV1(candidate.coordinate, coordinate)
              || candidate.operationId !== intent.resultOperationId
              || candidate.cryptoObjectId !== intent.resultObjectId
              || candidate.representation !== intent.representation
              || !equal(fingerprintTaskContentAuthorityV1(candidate.currentAuthority),
                fingerprintTaskContentAuthorityV1(authority))) return null;
            const staged = await inspect(cryptoHandle, intent, authority);
            return staged !== null && equal(staged.genesisManifestHash, candidate.requestDigest)
              && equal(staged.authorityFingerprint, candidate.authorityFingerprint) ? staged : null;
          };
          try {
            return await use({ authority, transaction, current: fresh, restricted,
              product: scopedProduct, cryptoHandle, resolveAuthority, verifyStagedCancellation });
          } finally { active = false; }
        },
      });
      if (result === null) {
        const latestPolicy = await readPolicy(input.db);
        if (latestPolicy.revision !== policy.revision || latestPolicy.mode !== policy.mode) {
          throw new TaskCancellationPublicationPolicyUnavailableError();
        }
      }
      return result;
    }
    async function proofIsCurrent(held: Held, reservation: Reservation): Promise<boolean> {
      let staged: VerifiedStagedTaskCancellationPublication | null;
      try { staged = await inspect(held.cryptoHandle, reservation.intent, held.authority); }
      catch { return false; }
      if (staged !== null) return stageMatchesReservation(staged, reservation);
      if (held.authority.expectedPolicyRevision !== intent.policyRevision) return false;
      const raw = await (await authorizationRepository(held.restricted))
        .get(protectedTaskCancellationRequestId(intent.taskRunId));
      const record = raw === null ? null : parseBackgroundAuthorizationRecord(raw);
      return exactPublicationRecord(record, { intent, requesterHumanId,
        authorityFingerprint: reservation.ledger.authorityFingerprint })
        && (record.snapshot.state === "completed"
          ? reservation.ledger.disposition === "mapped" && record.finishedAt === record.snapshot.updatedAt
          : record.finishedAt === null && ["running", "publication_reconciliation"].includes(record.snapshot.state));
    }
    // Phase one commits the mapped product before authorization can complete.
    // Every nested transaction below borrows these same authority-held connections.
    const publication = await withCurrent(selected, async held => {
      let current = held.current;
      if (current.status === "missing") {
        let staged: VerifiedStagedTaskCancellationPublication | null;
        try { staged = await inspect(held.cryptoHandle, intent, held.authority); }
        catch { return "pending" as const; }
        if (staged === null) return await hasCryptoPublication(held.cryptoHandle, {
          requestId: protectedTaskCancellationRequestId(intent.taskRunId), objectId: intent.resultObjectId,
        }) ? "pending" as const : "missing" as const;
        if (!sameIntent(staged.intent, intent)) return "pending" as const;
        const stagedProduct = reservationProduct({ product: held.product,
          resolveAuthority: held.resolveAuthority, verifyStagedCancellation: held.verifyStagedCancellation,
          assertReservationCurrent: async candidate => {
            const fresh = await inspect(held.cryptoHandle, intent, held.authority);
            if (!sameTaskContentCoordinateV1(candidate, coordinate) || fresh === null || !sameStage(staged, fresh)) {
              throw new Error("Cancellation staging receipt changed");
            }
          } });
        const adopted = await reserveStaged({ staged, authority: held.authority, product: stagedProduct });
        if (adopted.status !== "reserved" && adopted.status !== "replayed") return "pending" as const;
        current = await read(held.transaction, coordinates);
        if (current.status !== "found" || !exactReservation(current.reservation)
          || !stageMatchesReservation(staged, current.reservation)) return "pending" as const;
      }
      if (current.status !== "found" || !exactReservation(current.reservation)
        || !await proofIsCurrent(held, current.reservation)) return "pending" as const;
      const reservation = current.reservation;
      const ledger = reservation.ledger;
      const leaseToken = randomUUID();
      const repository = overrides.repository === undefined ? (() => {
        const handle = held.cryptoHandle;
        const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
        const unavailable = (): never => { throw new Error("Cancellation recovery cannot prepare or open content"); };
        return createPostgresTaskContentRepositoryV1({
          product: { handle: held.product.handle, resolveCurrentAuthority: held.resolveAuthority,
            verifyStagedCancellation: held.verifyStagedCancellation },
          crypto: { handle, crypto: input.crypto,
            resolveCurrentAuthority: candidate => sameTaskContentCoordinateV1(candidate, coordinate)
              ? held.resolveAuthority({ requesterHumanId, namespaceId: intent.contentNamespaceId }) : Promise.resolve(null),
            resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
            resolveHistoricalHumanDeviceSigningPublicKey: createProtectedTaskHistoricalHumanDeviceSigningKeyResolver(handle) },
          content: { prepareProtected: unavailable, publishProduct: unavailable,
            readOrdinary: unavailable, readProtected: unavailable },
        });
      })() : await overrides.repository({ reservation, product: held.product,
        resolveAuthority: held.resolveAuthority, verifyStagedCancellation: held.verifyStagedCancellation });
      const outcome = await repository.reconcileCoordinate({ coordinate,
        operationId: intent.resultOperationId, leaseToken,
        publishProduct: async () => {
          const fresh = await read(held.transaction, coordinates);
          if (fresh.status !== "found" || !sameReservation(reservation, fresh.reservation)
            || fresh.reservation.ledger.disposition !== "active" || fresh.reservation.ledger.leaseToken !== leaseToken
            || fresh.reservation.ledger.leaseExpiresAt === null || fresh.reservation.ledger.leaseExpiresAt.getTime() <= now()) {
            throw new Error("Cancellation recovery product authority changed");
          }
          const result = await (overrides.publishProduct ?? publishProtectedTaskCancellationProduct)({
            transaction: use => use(held.transaction),
          }, { intent, currentPolicyRevision: held.authority.expectedPolicyRevision, requestDigest: ledger.requestDigest,
            prepared: { operationId: intent.resultOperationId, resultRevision: 2,
              resultObjectId: intent.resultObjectId, requesterHumanId: ledger.requesterHumanId,
              authorityFingerprint: ledger.authorityFingerprint } }, () => Promise.resolve(fresh.reservation.ledger.leaseExpiresAt!.getTime() > now()));
          if (result.status === "rejected") throw new Error("Cancellation recovery product authority changed");
        },
      });
      if (outcome !== "mapped") return outcome === "quarantined" ? "quarantined" as const : "pending" as const;
      const mapped = await read(held.transaction, coordinates);
      return mapped.status === "found" && exactMappedSuccess(reservation, mapped.reservation)
        ? mapped : "pending" as const;
    });
    if (publication === null) return "pending";
    if (typeof publication === "string") return publication;
    // Phase two re-admits current authority. A concurrent archive can win here,
    // leaving the committed mapping pending without completing authorization.
    const settled = await withCurrent(publication, async held => {
      if (held.current.status !== "found" || !exactMappedSuccess(publication.reservation, held.current.reservation)
        || !await proofIsCurrent(held, held.current.reservation)) return null;
      const reservation = held.current.reservation;
      const ledger = reservation.ledger;
      const verifyStaged: VerifyStagedCancellationSettlement = async proof => {
        if (await held.resolveAuthority({ requesterHumanId, namespaceId: intent.contentNamespaceId }) === null
          || proof.currentPolicyRevision !== held.authority.expectedPolicyRevision
          || !sameIntent(proof.intent, reservation.intent) || proof.requesterHumanId !== requesterHumanId
          || proof.cryptoAccessRevision !== ledger.cryptoAccessRevision
          || !equal(proof.authorityFingerprint, ledger.authorityFingerprint)
          || !equal(proof.requiredNamespaceFingerprint, ledger.requiredNamespaceFingerprint)) return null;
        let staged: VerifiedStagedTaskCancellationPublication | null;
        try { staged = await inspect(held.cryptoHandle, reservation.intent, held.authority); }
        catch { return null; }
        return staged !== null && stageMatchesReservation(staged, reservation)
          ? { requestId: staged.requestId, recipientGeneration: staged.recipientGeneration } : null;
      };
      const cleanup: (() => void)[] = [];
      const success = await (overrides.settle ?? input.settle)({ ...coordinates,
        currentPolicyRevision: held.authority.expectedPolicyRevision }, verifyStaged, {
        db: { transaction: use => use(held.transaction) }, restricted: held.restricted,
        deferRecipientCleanup: release => { cleanup.push(release); },
      });
      return success ? cleanup : null;
    });
    if (settled === null) return "pending";
    for (const release of settled) release();
    return "mapped";

  };
  return async (coordinates: Coordinates): ReturnType<typeof recover> => {
    try {
      return await recover(coordinates);
    } catch (error) {
      if (error instanceof TaskCancellationPublicationPolicyUnavailableError) return "pending";
      throw error;
    }
  };
}
