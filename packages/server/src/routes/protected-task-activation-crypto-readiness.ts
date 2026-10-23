import {
  and,
  eq,
  inArray,
  isNotNull,
  protectedTaskRunOutputBindings,
  sessionMessageCryptoRevisions,
  sessionMessages,
  taskDefinitionCryptoRevisions,
  taskRunMessageAssociations,
  taskRunResultCryptoRevisions,
} from "@nautilo/db";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import {
  assertVerifiedCryptoPostgresHandle,
  readTaskContentCryptoObjectPage,
  readTaskContentCryptoStagingPage,
  type TaskContentCryptoInventoryRow,
  type TaskContentCryptoStagingKind,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

const DEFINITION_PREFIX = "task-definition:v1:";
const RESULT_PREFIX = "task-run-result:v1:";
const HISTORICAL_PREFIX = "task-historical:v1:";

type ObjectKind = "definition" | "result" | "historical";
type StagingKind = TaskContentCryptoStagingKind;
type ProductState = "mapped" | "pending" | "complete_unmapped"
  | "quarantined" | "stale_mapping" | "invalid" | "missing";

type ProductLedgerRow = Readonly<{
  objectId: string;
  completion: "pending" | "complete";
  disposition: "active" | "mapped" | "quarantined" | "stale_mapping"
    | "blocked" | "superseded" | "hard_delete";
  failureCode: string | null;
  bound?: boolean;
}>;

type CryptoObjectPageRow = TaskContentCryptoInventoryRow;

export type ProtectedTaskActivationCryptoReadinessCounts = Readonly<{
  total: bigint;
  mapped: bigint;
  blockers: Readonly<{
    missingProductReceipt: bigint;
    pendingProductReceipt: bigint;
    completeUnmappedProductReceipt: bigint;
    quarantinedProductReceipt: bigint;
    staleMappingProductReceipt: bigint;
    invalidProductReceipt: bigint;
  }>;
}>;

type Counts = {
  -readonly [Key in keyof ProtectedTaskActivationCryptoReadinessCounts]:
    Key extends "blockers"
      ? { -readonly [Blocker in keyof ProtectedTaskActivationCryptoReadinessCounts["blockers"]]: bigint }
      : bigint;
};

export type ProtectedTaskActivationCryptoReadiness = Readonly<{
  observedAt: Date;
  objects: Readonly<Record<ObjectKind, ProtectedTaskActivationCryptoReadinessCounts>>;
  staging: Readonly<Record<StagingKind, ProtectedTaskActivationCryptoReadinessCounts>>;
}>;

type Dependencies = Readonly<{
  assertCryptoHandle(handle: CryptoPostgresHandle): void;
  readCryptoObjects(handle: CryptoPostgresHandle, after: string | null):
    Promise<readonly CryptoObjectPageRow[]>;
  readStaging(handle: CryptoPostgresHandle, kind: StagingKind, after: string | null):
    Promise<readonly CryptoObjectPageRow[]>;
  readObjectProductRows(transaction: CanonicalTranscriptTx, objectIds: readonly string[]):
    Promise<readonly ProductLedgerRow[]>;
  readStagingProductRows(transaction: CanonicalTranscriptTx, kind: StagingKind,
    objectIds: readonly string[]): Promise<readonly ProductLedgerRow[]>;
}>;

function emptyCounts(): Counts {
  return {
    total: 0n,
    mapped: 0n,
    blockers: {
      missingProductReceipt: 0n,
      pendingProductReceipt: 0n,
      completeUnmappedProductReceipt: 0n,
      quarantinedProductReceipt: 0n,
      staleMappingProductReceipt: 0n,
      invalidProductReceipt: 0n,
    },
  };
}

function objectKind(objectId: string): ObjectKind {
  if (objectId.startsWith(DEFINITION_PREFIX)) return "definition";
  if (objectId.startsWith(RESULT_PREFIX)) return "result";
  if (objectId.startsWith(HISTORICAL_PREFIX)) return "historical";
  throw new Error("Task crypto inventory returned an out-of-scope object");
}

function classify(rows: readonly ProductLedgerRow[]): ProductState {
  if (rows.length === 0) return "missing";
  if (rows.length !== 1) return "invalid";
  const [row] = rows;
  if (row === undefined || row.bound === false) return "invalid";
  if (row.completion === "pending") {
    return row.disposition === "quarantined" ? "quarantined" : "pending";
  }
  if (row.completion !== "complete") return "invalid";
  if (row.disposition === "mapped" && row.failureCode === null) return "mapped";
  if (row.disposition === "active" && row.failureCode === null) return "complete_unmapped";
  if (row.disposition === "quarantined") return "quarantined";
  if (row.disposition === "stale_mapping") return "stale_mapping";
  return "invalid";
}

function add(counts: Counts, state: ProductState): void {
  counts.total += 1n;
  if (state === "mapped") counts.mapped += 1n;
  else if (state === "missing") counts.blockers.missingProductReceipt += 1n;
  else if (state === "pending") counts.blockers.pendingProductReceipt += 1n;
  else if (state === "complete_unmapped") counts.blockers.completeUnmappedProductReceipt += 1n;
  else if (state === "quarantined") counts.blockers.quarantinedProductReceipt += 1n;
  else if (state === "stale_mapping") counts.blockers.staleMappingProductReceipt += 1n;
  else counts.blockers.invalidProductReceipt += 1n;
}

function group(rows: readonly ProductLedgerRow[]): ReadonlyMap<string, readonly ProductLedgerRow[]> {
  const grouped = new Map<string, ProductLedgerRow[]>();
  for (const row of rows) {
    const values = grouped.get(row.objectId) ?? [];
    values.push(row);
    grouped.set(row.objectId, values);
  }
  return grouped;
}

function freezeCounts(value: Counts): Readonly<Counts> {
  return Object.freeze({
    total: value.total,
    mapped: value.mapped,
    blockers: Object.freeze({ ...value.blockers }),
  });
}

async function readObjectProductRows(
  transaction: CanonicalTranscriptTx,
  objectIds: readonly string[],
): Promise<readonly ProductLedgerRow[]> {
  if (objectIds.length === 0) return [];
  const definitions = await transaction.select({
    objectId: taskDefinitionCryptoRevisions.cryptoObjectId,
    completion: taskDefinitionCryptoRevisions.completion,
    disposition: taskDefinitionCryptoRevisions.disposition,
    failureCode: taskDefinitionCryptoRevisions.failureCode,
  }).from(taskDefinitionCryptoRevisions).where(inArray(
    taskDefinitionCryptoRevisions.cryptoObjectId,
    [...objectIds],
  ));
  const results = await transaction.select({
    objectId: taskRunResultCryptoRevisions.cryptoObjectId,
    completion: taskRunResultCryptoRevisions.completion,
    disposition: taskRunResultCryptoRevisions.disposition,
    failureCode: taskRunResultCryptoRevisions.failureCode,
  }).from(taskRunResultCryptoRevisions).where(inArray(
    taskRunResultCryptoRevisions.cryptoObjectId,
    [...objectIds],
  ));
  return [...definitions, ...results];
}

async function readStagingProductRows(
  transaction: CanonicalTranscriptTx,
  kind: StagingKind,
  objectIds: readonly string[],
): Promise<readonly ProductLedgerRow[]> {
  if (objectIds.length === 0) return [];
  if (kind === "historical") {
    return readObjectProductRows(transaction, objectIds);
  }
  if (kind === "cancellation") {
    const ledgers = await transaction.select({
      objectId: taskRunResultCryptoRevisions.cryptoObjectId,
      completion: taskRunResultCryptoRevisions.completion,
      disposition: taskRunResultCryptoRevisions.disposition,
      failureCode: taskRunResultCryptoRevisions.failureCode,
    }).from(taskRunResultCryptoRevisions).where(inArray(
      taskRunResultCryptoRevisions.cryptoObjectId,
      [...objectIds],
    ));
    const bindings = await transaction.select({
      objectId: protectedTaskRunOutputBindings.resultObjectId,
    }).from(protectedTaskRunOutputBindings).where(and(
      inArray(protectedTaskRunOutputBindings.resultObjectId, [...objectIds]),
      isNotNull(protectedTaskRunOutputBindings.resultAttachedAt),
    ));
    const bound = new Set(bindings.map(row => row.objectId));
    return ledgers.map(row => ({ ...row, bound: bound.has(row.objectId) }));
  }
  const revisions = await transaction.select({
    objectId: sessionMessageCryptoRevisions.cryptoObjectId,
    sessionId: sessionMessageCryptoRevisions.sessionId,
    messageId: sessionMessageCryptoRevisions.messageId,
    editRevision: sessionMessageCryptoRevisions.editRevision,
    completion: sessionMessageCryptoRevisions.completion,
    disposition: sessionMessageCryptoRevisions.disposition,
    failureCode: sessionMessageCryptoRevisions.failureCode,
  }).from(sessionMessageCryptoRevisions).where(inArray(
    sessionMessageCryptoRevisions.cryptoObjectId,
    [...objectIds],
  ));
  const messageIds = revisions.map(row => row.messageId);
  if (messageIds.length === 0) return [];
  const messages = await transaction.select({
    objectId: sessionMessages.cryptoObjectId,
    sessionId: sessionMessages.sessionId,
    messageId: sessionMessages.id,
    editRevision: sessionMessages.editRevision,
  }).from(sessionMessages).where(inArray(sessionMessages.id, messageIds));
  const associations = await transaction.select({
    sessionId: taskRunMessageAssociations.sessionId,
    messageId: taskRunMessageAssociations.messageId,
    publishedRevision: taskRunMessageAssociations.publishedRevision,
    taskRunId: taskRunMessageAssociations.taskRunId,
    publicationKey: taskRunMessageAssociations.publicationKey,
  }).from(taskRunMessageAssociations).where(and(
    inArray(taskRunMessageAssociations.messageId, messageIds),
    eq(taskRunMessageAssociations.kind, "raw_delivery"),
  ));
  const bindings = await transaction.select({
    taskRunId: protectedTaskRunOutputBindings.taskRunId,
    messageId: protectedTaskRunOutputBindings.messageId,
    messageOperationId: protectedTaskRunOutputBindings.messageOperationId,
  }).from(protectedTaskRunOutputBindings).where(and(
    inArray(protectedTaskRunOutputBindings.messageId, messageIds),
    isNotNull(protectedTaskRunOutputBindings.messagePublishedAt),
  ));
  const messageKeys = new Set(messages.map(row =>
    `${row.sessionId}:${row.messageId}:${row.editRevision}:${row.objectId ?? ""}`));
  const associationKeys = new Set(associations.map(row =>
    `${row.sessionId}:${row.messageId}:${row.publishedRevision}`));
  const bindingKeys = new Set(bindings.map(row =>
    `${row.taskRunId}:${row.messageId ?? ""}:${row.messageOperationId ?? ""}`));
  const associationByMessage = new Map(associations.map(row => [
    `${row.sessionId}:${row.messageId}:${row.publishedRevision}`,
    row,
  ]));
  return revisions.map(row => {
    const messageKey = `${row.sessionId}:${row.messageId}:${row.editRevision}:${row.objectId}`;
    const associationKey = `${row.sessionId}:${row.messageId}:${row.editRevision}`;
    const association = associationByMessage.get(associationKey);
    return {
      objectId: row.objectId,
      completion: row.completion,
      disposition: row.disposition,
      failureCode: row.failureCode,
      bound: messageKeys.has(messageKey)
        && associationKeys.has(associationKey)
        && association !== undefined
        && bindingKeys.has(`${association.taskRunId}:${row.messageId}:${association.publicationKey}`),
    };
  });
}

const productionDependencies: Dependencies = Object.freeze({
  assertCryptoHandle: assertVerifiedCryptoPostgresHandle,
  readCryptoObjects: readTaskContentCryptoObjectPage,
  readStaging: readTaskContentCryptoStagingPage,
  readObjectProductRows,
  readStagingProductRows,
});

export function createProtectedTaskActivationCryptoReadinessReader(
  dependencies: Partial<Dependencies> = {},
) {
  const ports: Dependencies = Object.freeze({
    ...productionDependencies,
    ...dependencies,
  });
  return async (input: Readonly<{
    transaction: CanonicalTranscriptTx;
    restricted: CryptoPostgresHandle;
    now: Date;
  }>): Promise<ProtectedTaskActivationCryptoReadiness> => {
    if (!Number.isFinite(input.now.getTime())) {
      throw new TypeError("Protected Task crypto readiness time is invalid");
    }
    ports.assertCryptoHandle(input.restricted);
    const objects: Record<ObjectKind, Counts> = {
      definition: emptyCounts(), result: emptyCounts(), historical: emptyCounts(),
    };
    let cursor: string | null = null;
    do {
      const page = await ports.readCryptoObjects(input.restricted, cursor);
      if (page.length > LATTICE_LIMITS.batchItems) throw new Error("Task crypto inventory page exceeded its bound");
      const ids = page.map(row => row.objectId);
      const byObject = group(await ports.readObjectProductRows(input.transaction, ids));
      for (const row of page) add(objects[objectKind(row.objectId)], classify(byObject.get(row.objectId) ?? []));
      cursor = page.length === LATTICE_LIMITS.batchItems ? page.at(-1)?.cursor ?? null : null;
    } while (cursor !== null);

    const staging: Record<StagingKind, Counts> = {
      cancellation: emptyCounts(), result_message: emptyCounts(),
      terminal_message: emptyCounts(), historical: emptyCounts(),
    };
    for (const kind of [
      "cancellation", "result_message", "terminal_message", "historical",
    ] as const) {
      let after: string | null = null;
      do {
        const page = await ports.readStaging(input.restricted, kind, after);
        if (page.length > LATTICE_LIMITS.batchItems) throw new Error("Task staging inventory page exceeded its bound");
        const ids = page.map(row => row.objectId);
        const byObject = group(await ports.readStagingProductRows(input.transaction, kind, ids));
        for (const row of page) add(staging[kind], classify(byObject.get(row.objectId) ?? []));
        after = page.length === LATTICE_LIMITS.batchItems ? page.at(-1)?.cursor ?? null : null;
      } while (after !== null);
    }
    return Object.freeze({
      observedAt: new Date(input.now),
      objects: Object.freeze({
        definition: freezeCounts(objects.definition),
        result: freezeCounts(objects.result),
        historical: freezeCounts(objects.historical),
      }),
      staging: Object.freeze({
        cancellation: freezeCounts(staging.cancellation),
        result_message: freezeCounts(staging.result_message),
        terminal_message: freezeCounts(staging.terminal_message),
        historical: freezeCounts(staging.historical),
      }),
    });
  };
}

export const readProtectedTaskActivationCryptoReadiness =
  createProtectedTaskActivationCryptoReadinessReader();
