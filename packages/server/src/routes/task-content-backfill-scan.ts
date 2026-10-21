import { randomUUID } from "node:crypto";
import {
  acknowledgeTaskContentBackfill,
  and,
  claimTaskContentBackfill,
  discoverTaskContentBackfill,
  eq,
  isProtectedTaskPreset,
  readCurrentTaskContentBackfillClaim,
  readTaskContentBackfillProgress,
  releaseTaskContentBackfillLease,
  rooms,
  taskDefinitionCryptoRevisions,
  taskRunResultCryptoRevisions,
  taskRuns,
  tasks,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type TaskContentBackfillCandidate,
  type TaskContentBackfillClaim,
  type TaskContentBackfillDisposition,
  type TaskContentBackfillTransaction,
} from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import {
  PostgresDomainKeyAuthorityRepository,
  PostgresNamespaceProductAuthority,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  withCurrentTaskContentBackfillDevice,
  type TaskContentBackfillSubject,
} from "./task-content-backfill-authority";
import { createProtectedTaskRequesterPrivateRoomResolver } from
  "./protected-task-requester-private-room";
import { readTaskContentBackfillSource } from "./task-content-backfill-source";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

type CandidateState = "source" | "mapped";

type CandidateRouting = Readonly<{
  agentId: string;
  expectedNamespaceId?: string;
}>;

function sameDate(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

function borrow(
  transaction: Pick<PostgresJsBridgeConnection, "query">,
): PostgresJsBridgeConnection {
  const useBorrowed: PostgresJsBridgeConnection["transaction"] = use => use(transaction);
  return Object.freeze({
    query: transaction.query.bind(transaction),
    transaction: useBorrowed,
    transactionOnce: useBorrowed,
  });
}

async function readCandidateRouting(
  transaction: CanonicalTranscriptTx,
  candidate: TaskContentBackfillCandidate,
  requesterUserId: string,
  state: CandidateState,
): Promise<CandidateRouting | null> {
  const [task] = await transaction.select({
    id: tasks.id,
    ownerId: tasks.ownerId,
    requestorId: tasks.requestorId,
    agentId: tasks.agentId,
    preset: tasks.preset,
    parentTaskId: tasks.parentTaskId,
    depth: tasks.depth,
    status: tasks.status,
    createdAt: tasks.createdAt,
    updatedAt: tasks.updatedAt,
    representation: tasks.contentRepresentation,
    namespaceId: tasks.contentNamespaceId,
    revision: tasks.contentRevision,
    mappingState: tasks.cryptoMappingState,
  }).from(tasks).where(eq(tasks.id, candidate.taskId)).limit(2);
  if (task === undefined
    || task.ownerId !== requesterUserId
    || task.requestorId !== requesterUserId
    || !isProtectedTaskPreset(task.preset)
    || task.parentTaskId !== null
    || task.depth !== 0) return null;

  if (candidate.kind === "definition") {
    const exactSource = task.representation === "ordinary"
      && task.namespaceId === null
      && task.revision === candidate.sourceRevision
      && task.mappingState === "unmapped"
      && task.status === candidate.sourceStatus
      && sameDate(task.createdAt, candidate.sourceCreatedAt)
      && sameDate(task.updatedAt, candidate.sourceUpdatedAt);
    const exactMapped = (task.representation === "dual" || task.representation === "protected")
      && task.namespaceId !== null
      && task.revision === candidate.sourceRevision + 1
      && task.mappingState === "verified";
    if (state === "source" ? !exactSource : !exactMapped) return null;
    return Object.freeze({
      agentId: task.agentId,
      ...(task.namespaceId === null ? {} : { expectedNamespaceId: task.namespaceId }),
    });
  }

  if ((task.representation !== "dual" && task.representation !== "protected")
    || task.namespaceId === null
    || task.mappingState !== "verified"
    || !sameDate(task.updatedAt, candidate.sourceUpdatedAt)) return null;
  const [run] = await transaction.select({
    taskId: taskRuns.taskId,
    startedAt: taskRuns.startedAt,
    completedAt: taskRuns.completedAt,
    status: taskRuns.status,
    representation: taskRuns.resultRepresentation,
    namespaceId: taskRuns.resultContentNamespaceId,
    revision: taskRuns.resultRevision,
    mappingState: taskRuns.resultCryptoMappingState,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, candidate.taskRunId),
    eq(taskRuns.taskId, candidate.taskId),
  )).limit(2);
  if (run === undefined
    || run.taskId !== candidate.taskId
    || run.completedAt === null
    || run.status !== candidate.sourceStatus
    || !sameDate(run.startedAt, candidate.sourceStartedAt)
    || !sameDate(run.completedAt, candidate.sourceCompletedAt)) return null;
  const exactSource = run.representation === "ordinary"
    && run.namespaceId === null
    && run.revision === candidate.sourceRevision
    && run.mappingState === "unmapped";
  const exactMapped = (run.representation === "dual" || run.representation === "protected")
    && run.namespaceId === task.namespaceId
    && run.revision === candidate.sourceRevision + 1
    && run.mappingState === "verified";
  return state === "source" ? exactSource ? Object.freeze({
    agentId: task.agentId,
    expectedNamespaceId: task.namespaceId,
  }) : null : exactMapped ? Object.freeze({
    agentId: task.agentId,
    expectedNamespaceId: run.namespaceId!,
  }) : null;
}

async function readNamespace(transaction: CanonicalTranscriptTx, roomId: string) {
  const rows = await transaction.select({
    namespaceId: rooms.namespaceId,
    accessRevision: rooms.namespaceAccessRevision,
  }).from(rooms).where(eq(rooms.id, roomId)).limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

type CandidateAuthorityDependencies = Readonly<{
  context: typeof createHumanProductTransactionContext;
  readRouting: typeof readCandidateRouting;
  privateRoom: typeof createProtectedTaskRequesterPrivateRoomResolver;
  namespace(product: PostgresJsBridgeConnection):
    Pick<PostgresNamespaceProductAuthority, "withCurrentPrivateRoom">;
  readNamespace: typeof readNamespace;
  domain(restricted: PostgresJsBridgeConnection):
    Pick<PostgresDomainKeyAuthorityRepository, "inspectForegroundNamespaceAuthority">;
}>;

async function withCandidateAuthority<Value>(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  subject: TaskContentBackfillSubject;
  candidate: TaskContentBackfillCandidate;
  state: CandidateState;
  use(transaction: CanonicalTranscriptTx): Promise<Value>;
}>, overrides: Partial<CandidateAuthorityDependencies> = {}): Promise<Value | null> {
  const dependencies: CandidateAuthorityDependencies = {
    context: createHumanProductTransactionContext,
    readRouting: readCandidateRouting,
    privateRoom: createProtectedTaskRequesterPrivateRoomResolver,
    namespace: product => new PostgresNamespaceProductAuthority(product),
    readNamespace,
    domain: restricted => new PostgresDomainKeyAuthorityRepository(
      restricted, input.crypto, input.serverScope,
    ),
    ...overrides,
  };
  const context = await dependencies.context(input.subject.userId, input.db);
  return context.canonicalRunner.transaction(async (transaction, executor) => {
    const routing = await dependencies.readRouting(
      transaction, input.candidate, input.subject.userId, input.state,
    );
    if (routing === null) return null;
    const resolveRoom = dependencies.privateRoom(transaction);
    const room = await resolveRoom(
      input.subject.userId, routing.agentId, routing.expectedNamespaceId,
    );
    if (room === null) return null;
    return dependencies.namespace(borrow(executor)).withCurrentPrivateRoom({
      subjectUserId: input.subject.userId,
      subjectHumanId: input.subject.humanActorId,
      roomId: room.roomId,
      namespaceId: room.namespaceId,
      use: async () => {
        const exactRoom = await resolveRoom(
          input.subject.userId, routing.agentId, room.namespaceId,
        );
        if (exactRoom?.roomId !== room.roomId) return null;
        const namespace = await dependencies.domain(input.restricted)
          .inspectForegroundNamespaceAuthority({
            namespaceId: room.namespaceId,
            keyClass: "ai",
          });
        if (namespace.status !== "ready") return null;
        try {
          const product = await dependencies.readNamespace(transaction, room.roomId);
          if (product === null
            || product.namespaceId !== namespace.namespaceId
            || product.accessRevision !== namespace.namespaceAccessRevision) return null;
          return input.use(transaction);
        } finally {
          for (const value of Object.values(namespace)) {
            if (value instanceof Uint8Array) value.fill(0);
          }
        }
      },
    });
  }, { isolationLevel: "read committed" });
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function exactHistoricalV2(value: unknown): value is Readonly<{
  version: 2;
  claimId: string;
  publisherDeviceId: string;
  signedRequestDigest: string;
  sourceDigest: string;
  sourcePayloadHash: string;
  sourceRevision: 0;
  genesisManifestHash: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return exactKeys(row, [
    "version", "claimId", "publisherDeviceId", "signedRequestDigest",
    "sourceDigest", "sourcePayloadHash", "sourceRevision", "genesisManifestHash",
  ])
    && row["version"] === 2
    && typeof row["claimId"] === "string" && UUID.test(row["claimId"])
    && typeof row["publisherDeviceId"] === "string"
    && row["publisherDeviceId"].length <= 128 && PORTABLE_ID.test(row["publisherDeviceId"])
    && typeof row["signedRequestDigest"] === "string" && HEX_DIGEST.test(row["signedRequestDigest"])
    && typeof row["sourceDigest"] === "string" && HEX_DIGEST.test(row["sourceDigest"])
    && typeof row["sourcePayloadHash"] === "string" && HEX_DIGEST.test(row["sourcePayloadHash"])
    && row["sourceRevision"] === 0
    && typeof row["genesisManifestHash"] === "string" && HEX_DIGEST.test(row["genesisManifestHash"]);
}

function equalBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactMappedLedger(row: Readonly<{
  operationId: string;
  requestDigest: Uint8Array;
  authorityFingerprint: Uint8Array;
  requesterHumanId: string;
  contentNamespaceId: string;
  anchorNamespaceId: string;
  cryptoObjectId: string;
  representation: "protected" | "dual";
  payloadVersion: number;
  cryptoAccessRevision: number;
  requiredNamespaceFingerprint: Uint8Array;
  historicalRepair: Readonly<Record<string, unknown>> | null;
  completion: "pending" | "complete";
  disposition: "active" | "mapped" | "quarantined" | "stale_mapping";
  failureCode: string | null;
  cryptoCompletedAt: Date | null;
}>, claim: TaskContentBackfillClaim): boolean {
  if (!exactHistoricalV2(row.historicalRepair)) return false;
  const objectMatch = /^task-historical:v1:([0-9a-f]{64})$/u.exec(row.cryptoObjectId);
  return objectMatch !== null
    && row.operationId === `task-historical-publish:${objectMatch[1]!}`
    && row.requestDigest.length === 32
    && row.authorityFingerprint.length === 32
    && row.requiredNamespaceFingerprint.length === 32
    && row.requesterHumanId === claim.humanActorId
    && row.representation === "dual"
    && row.payloadVersion === 1
    && row.cryptoAccessRevision === 0
    && row.anchorNamespaceId === row.contentNamespaceId
    && row.completion === "complete"
    && row.disposition === "mapped"
    && row.failureCode === null
    && row.cryptoCompletedAt !== null
    && row.historicalRepair.signedRequestDigest === Buffer.from(row.requestDigest).toString("hex");
}

/** Verify the immutable v2 ledger and its current product mapping in the acknowledgement transaction. */
export async function assertMappedTaskContentBackfill(
  transaction: TaskContentBackfillTransaction,
  claim: TaskContentBackfillClaim,
): Promise<boolean> {
  const candidate = claim.candidate;
  if (candidate.sourceRevision !== 0) return false;
  if (candidate.kind === "definition") {
    const [ledger] = await transaction.select().from(taskDefinitionCryptoRevisions).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, candidate.taskId),
      eq(taskDefinitionCryptoRevisions.contentRevision, 1),
    )).limit(2);
    if (ledger === undefined || !exactMappedLedger(ledger, claim)) return false;
    const [task] = await transaction.select({
      ownerId: tasks.ownerId,
      requestorId: tasks.requestorId,
      namespaceId: tasks.contentNamespaceId,
      revision: tasks.contentRevision,
      objectId: tasks.cryptoObjectId,
      accessRevision: tasks.cryptoAccessRevision,
      fingerprint: tasks.cryptoRequiredNamespaceFingerprint,
      representation: tasks.contentRepresentation,
      mappingState: tasks.cryptoMappingState,
    }).from(tasks).where(eq(tasks.id, candidate.taskId)).limit(2);
    return task !== undefined
      && task.ownerId === claim.requesterUserId
      && task.requestorId === claim.requesterUserId
      && task.namespaceId === ledger.contentNamespaceId
      && task.revision === ledger.contentRevision
      && task.objectId === ledger.cryptoObjectId
      && task.accessRevision === ledger.cryptoAccessRevision
      && equalBytes(task.fingerprint, ledger.requiredNamespaceFingerprint)
      && task.representation === ledger.representation
      && task.mappingState === "verified";
  }

  const [ledger] = await transaction.select().from(taskRunResultCryptoRevisions).where(and(
    eq(taskRunResultCryptoRevisions.taskId, candidate.taskId),
    eq(taskRunResultCryptoRevisions.taskRunId, candidate.taskRunId),
    eq(taskRunResultCryptoRevisions.resultRevision, 1),
  )).limit(2);
  if (ledger === undefined || !exactMappedLedger(ledger, claim)) return false;
  const [task] = await transaction.select({
    ownerId: tasks.ownerId,
    requestorId: tasks.requestorId,
    namespaceId: tasks.contentNamespaceId,
    representation: tasks.contentRepresentation,
    mappingState: tasks.cryptoMappingState,
  }).from(tasks).where(eq(tasks.id, candidate.taskId)).limit(2);
  const [run] = await transaction.select({
    namespaceId: taskRuns.resultContentNamespaceId,
    revision: taskRuns.resultRevision,
    objectId: taskRuns.resultCryptoObjectId,
    accessRevision: taskRuns.resultCryptoAccessRevision,
    fingerprint: taskRuns.resultCryptoRequiredNamespaceFingerprint,
    representation: taskRuns.resultRepresentation,
    mappingState: taskRuns.resultCryptoMappingState,
  }).from(taskRuns).where(and(
    eq(taskRuns.id, candidate.taskRunId),
    eq(taskRuns.taskId, candidate.taskId),
  )).limit(2);
  return task !== undefined
    && run !== undefined
    && task.ownerId === claim.requesterUserId
    && task.requestorId === claim.requesterUserId
    && task.namespaceId === ledger.contentNamespaceId
    && (task.representation === "dual" || task.representation === "protected")
    && task.mappingState === "verified"
    && run.namespaceId === ledger.contentNamespaceId
    && run.revision === ledger.resultRevision
    && run.objectId === ledger.cryptoObjectId
    && run.accessRevision === ledger.cryptoAccessRevision
    && equalBytes(run.fingerprint, ledger.requiredNamespaceFingerprint)
    && run.representation === ledger.representation
    && run.mappingState === "verified";
}

type Dependencies = Readonly<{
  withDevice: typeof withCurrentTaskContentBackfillDevice;
  withCandidateAuthority: typeof withCandidateAuthority;
  discover: typeof discoverTaskContentBackfill;
  claim: typeof claimTaskContentBackfill;
  readClaim: typeof readCurrentTaskContentBackfillClaim;
  progress: typeof readTaskContentBackfillProgress;
  release: typeof releaseTaskContentBackfillLease;
  acknowledge: typeof acknowledgeTaskContentBackfill;
  assertMapped: typeof assertMappedTaskContentBackfill;
  classifySource: typeof classifyCurrentTaskContentBackfillSource;
}>;

type CurrentSourceClassification =
  | "supported"
  | "unsupported"
  | "no_content"
  | "waiting_parent"
  | null;

/** Recompute the disposition from the exact held source; never trust the device's label. */
async function classifyCurrentTaskContentBackfillSource(
  transaction: CanonicalTranscriptTx,
  claim: TaskContentBackfillClaim,
): Promise<CurrentSourceClassification> {
  const source = await readTaskContentBackfillSource(transaction, claim);
  if (source === null) return null;
  const classification = source.classification;
  try {
    return classification.status;
  } finally {
    if (classification.status === "supported") {
      classification.operationalFieldsDigest.fill(0);
      classification.sourcePayloadHash.fill(0);
      classification.sourceDigest.fill(0);
    }
  }
}

export type TaskContentBackfillScanServiceResult<Value> =
  | Readonly<{ status: "inactive" | "unauthorized" }>
  | Readonly<{ status: "ready"; value: Value }>;

/**
 * Process service for structural historical Task repair scanning. It never
 * returns Task content, key material, or authority inferred from a candidate.
 */
export function createTaskContentBackfillScanService(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  pageLimit: number;
  leaseDurationMs: number;
  sweepIntervalMs: number;
  now?: () => number;
  createId?: () => string;
}>, overrides: Partial<Dependencies> = {}) {
  if (!Number.isSafeInteger(input.pageLimit) || input.pageLimit < 1
    || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1
    || !Number.isSafeInteger(input.sweepIntervalMs) || input.sweepIntervalMs < 1) {
    throw new RangeError("Task content backfill scan bounds are invalid");
  }
  const now = input.now ?? Date.now;
  const createId = input.createId ?? randomUUID;
  const dependencies: Dependencies = {
    withDevice: withCurrentTaskContentBackfillDevice,
    withCandidateAuthority,
    discover: discoverTaskContentBackfill,
    claim: claimTaskContentBackfill,
    readClaim: readCurrentTaskContentBackfillClaim,
    progress: readTaskContentBackfillProgress,
    release: releaseTaskContentBackfillLease,
    acknowledge: acknowledgeTaskContentBackfill,
    assertMapped: assertMappedTaskContentBackfill,
    classifySource: classifyCurrentTaskContentBackfillSource,
    ...overrides,
  };
  const inactive = Object.freeze({ status: "inactive" as const });
  const protectedOperation = <Value>(
    use: () => Promise<TaskContentBackfillScanServiceResult<Value>>,
  ) => input.owner.runMutation({
    ordinary: () => Promise.resolve(inactive),
    protected: () => Promise.resolve(inactive),
    dual: use,
  });
  const withDevice = async <Value>(
    subject: TaskContentBackfillSubject,
    use: (restricted: PostgresJsBridgeConnection) => Promise<Value>,
  ): Promise<TaskContentBackfillScanServiceResult<Value>> => {
    const result = await dependencies.withDevice({
      restricted: input.restricted,
      crypto: input.crypto,
      subject,
      now,
      use: current => use(current.restricted),
    });
    return result === null
      ? Object.freeze({ status: "unauthorized" as const })
      : Object.freeze({ status: "ready" as const, value: result });
  };
  const exactClaim = async (
    subject: TaskContentBackfillSubject,
    claimId: string,
  ): Promise<TaskContentBackfillClaim | null> => {
    const claim = await dependencies.readClaim(input.db, {
      humanActorId: subject.humanActorId,
      deviceId: subject.admission.deviceId,
      claimId,
      now: new Date(now()),
    });
    return claim !== null
      && claim.humanActorId === subject.humanActorId
      && claim.requesterUserId === subject.userId
      && claim.deviceId === subject.admission.deviceId ? claim : null;
  };
  const authorize = <Value>(
    subject: TaskContentBackfillSubject,
    restricted: PostgresJsBridgeConnection,
    candidate: TaskContentBackfillCandidate,
    state: CandidateState,
    use: (transaction: CanonicalTranscriptTx) => Promise<Value>,
  ) => dependencies.withCandidateAuthority({
    db: input.db,
    restricted,
    crypto: input.crypto,
    serverScope: input.serverScope,
    subject,
    candidate,
    state,
    use,
  });

  return Object.freeze({
    discover(subject: TaskContentBackfillSubject) {
      return protectedOperation(() => withDevice(subject, () => {
        const observedAt = now();
        return dependencies.discover(input.db, {
          humanActorId: subject.humanActorId,
          deviceId: subject.admission.deviceId,
          now: new Date(observedAt),
          pageLimit: input.pageLimit,
          resumeAt: new Date(observedAt + input.sweepIntervalMs),
        });
      }));
    },

    claim(subject: TaskContentBackfillSubject, request: Readonly<{
      candidate: TaskContentBackfillCandidate;
      policyRevision: number;
    }>) {
      return protectedOperation(() => withDevice(subject, async restricted => {
        const observedAt = now();
        const expiresAt = Math.min(
          observedAt + input.leaseDurationMs,
          subject.admission.expiresAt,
        );
        if (expiresAt <= observedAt) return Object.freeze({ status: "disabled" as const });
        // A structural lease proves current source/scan ownership, without
        // reading any content. Namespace authority is required before exposing
        // the claim, but an unavailable Room must not monopolize the sweep.
        const claimed = await dependencies.claim(input.db, {
          humanActorId: subject.humanActorId,
          requesterUserId: subject.userId,
          deviceId: subject.admission.deviceId,
          claimId: createId(),
          policyRevision: request.policyRevision,
          candidate: request.candidate,
          now: new Date(observedAt),
          expiresAt: new Date(expiresAt),
        });
        if (claimed.status !== "claimed") return claimed;
        const authorized = await authorize(
          subject, restricted, claimed.claim.candidate, "source", () => Promise.resolve(true),
        );
        if (authorized === true) return claimed;
        const advanced = await dependencies.release(input.db, {
          claim: claimed.claim, now: new Date(now()), advance: true,
        });
        // Advancing only this sweep retains the row for the next sweep, when
        // Room/Domain authority may be available. No permanent failure is set.
        return Object.freeze({ status: advanced ? "deferred" as const : "stale" as const });
      }));
    },

    progress(subject: TaskContentBackfillSubject) {
      return protectedOperation(() => withDevice(subject, () =>
        dependencies.progress(input.db, {
          humanActorId: subject.humanActorId,
          now: new Date(now()),
        })));
    },

    release(subject: TaskContentBackfillSubject, claimId: string, advance: boolean) {
      return protectedOperation(() => withDevice(subject, async restricted => {
        const claim = await exactClaim(subject, claimId);
        if (claim === null) return false;
        const source = await authorize(
          subject, restricted, claim.candidate, "source", () => Promise.resolve(true),
        );
        const authorized = source === true || await authorize(
          subject, restricted, claim.candidate, "mapped", () => Promise.resolve(true),
        ) === true;
        return authorized && dependencies.release(input.db, {
          claim,
          now: new Date(now()),
          advance,
        });
      }));
    },

    acknowledge(
      subject: TaskContentBackfillSubject,
      claimId: string,
      outcome: TaskContentBackfillDisposition | "mapped",
    ) {
      return protectedOperation(() => withDevice(subject, async restricted => {
        const claim = await exactClaim(subject, claimId);
        if (claim === null) return "lease_lost" as const;
        const state: CandidateState = outcome === "mapped" ? "mapped" : "source";
        const authorized = outcome === "mapped"
          ? await authorize(
              subject, restricted, claim.candidate, state,
              () => Promise.resolve(true as const),
            )
          : await authorize(
              subject, restricted, claim.candidate, state,
              transaction => dependencies.classifySource(transaction, claim),
            );
        if (authorized !== outcome && !(outcome === "mapped" && authorized === true)) {
          return outcome === "mapped"
            ? "not_mapped" as const : "source_changed" as const;
        }
        return outcome === "mapped"
          ? dependencies.acknowledge(input.db, {
              claim,
              outcome,
              now: new Date(now()),
              assertMapped: dependencies.assertMapped,
            })
          : dependencies.acknowledge(input.db, {
              claim,
              outcome,
              now: new Date(now()),
            });
      }));
    },
  });
}
