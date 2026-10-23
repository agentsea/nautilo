import {
  and, asc, cryptoObjects, gt, ilike, isNotNull, isNull, or,
  taskCancellationCryptoStagingReceipts, taskHistoricalContentCryptoStagingReceipts,
  taskTerminalMessageCryptoStagingReceipts,
} from "@nautilo/db";
import { LATTICE_LIMITS } from "@nautilo/lattice-crypto";
import { cryptoTypedDb, executeTypedCryptoQuery, assertVerifiedCryptoPostgresHandle, type CryptoPostgresHandle } from "../storage/postgres-lattice-storage.ts";

export type TaskContentCryptoInventoryRow = Readonly<{ cursor: string; objectId: string }>;
export type TaskContentCryptoStagingKind = "cancellation" | "result_message" | "terminal_message" | "historical";

const DEFINITION_PREFIX = "task-definition:v1:";
const RESULT_PREFIX = "task-run-result:v1:";
const HISTORICAL_PREFIX = "task-historical:v1:";

/** Content-free inventory only; object presence never authorizes content or publication. */
export async function readTaskContentCryptoObjectPage(
  handle: CryptoPostgresHandle,
  after: string | null,
): Promise<readonly TaskContentCryptoInventoryRow[]> {
  assertVerifiedCryptoPostgresHandle(handle);
  const scope = or(
    ilike(cryptoObjects.objectId, `${DEFINITION_PREFIX}%`),
    ilike(cryptoObjects.objectId, `${RESULT_PREFIX}%`),
    ilike(cryptoObjects.objectId, `${HISTORICAL_PREFIX}%`),
  );
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    objectId: cryptoObjects.objectId,
  }).from(cryptoObjects).where(after === null ? scope : and(
    scope,
    gt(cryptoObjects.objectId, after),
  )).orderBy(asc(cryptoObjects.objectId)).limit(LATTICE_LIMITS.batchItems));
  return rows.map(row => ({ cursor: row.object_id, objectId: row.object_id }));
}

export async function readTaskContentCryptoStagingPage(
  handle: CryptoPostgresHandle,
  kind: TaskContentCryptoStagingKind,
  after: string | null,
): Promise<readonly TaskContentCryptoInventoryRow[]> {
  assertVerifiedCryptoPostgresHandle(handle);
  if (kind === "cancellation") {
    const table = taskCancellationCryptoStagingReceipts;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
      cursor: table.requestId, objectId: table.cryptoObjectId,
    }).from(table).where(after === null ? undefined : gt(table.requestId, after))
      .orderBy(asc(table.requestId)).limit(LATTICE_LIMITS.batchItems));
    return rows.map(row => ({ cursor: row.request_id, objectId: row.crypto_object_id }));
  }
  if (kind === "terminal_message" || kind === "result_message") {
    const table = taskTerminalMessageCryptoStagingReceipts;
    const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
      cursor: table.requestId, objectId: table.cryptoObjectId,
    }).from(table).where(and(
      kind === "result_message"
        ? isNotNull(table.rawResultMessageIntent)
        : isNull(table.rawResultMessageIntent),
      after === null ? undefined : gt(table.requestId, after),
    ))
      .orderBy(asc(table.requestId)).limit(LATTICE_LIMITS.batchItems));
    return rows.map(row => ({ cursor: row.request_id, objectId: row.crypto_object_id }));
  }
  const table = taskHistoricalContentCryptoStagingReceipts;
  const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({
    objectId: table.cryptoObjectId,
  }).from(table).where(after === null ? undefined : gt(table.cryptoObjectId, after))
    .orderBy(asc(table.cryptoObjectId)).limit(LATTICE_LIMITS.batchItems));
  return rows.map(row => ({ cursor: row.crypto_object_id, objectId: row.crypto_object_id }));
}

