import { actors, and, eq, isNull, taskDefinitionCryptoRevisions, type PostgresJsBridgeConnection } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1, parseTaskHistoricalRepairProvenanceV1,
  taskContentRevisionObjectIdV1 } from "@nautilo/lattice-bridge";
import { conversationProductTypedDb, executeTypedConversationProductQuery } from "@nautilo/lattice-bridge/server";
import type { ProtectedTaskOccurrence } from "@nautilo/runtime";

/** Called under the exact Task/Run locks, before any restricted crypto authority is entered. */
export async function validateCurrentTaskDefinitionIdentity(input: Readonly<{
  product: PostgresJsBridgeConnection;
  task: ProtectedTaskOccurrence["task"];
}>): Promise<boolean> {
  const task = input.task;
  if (task.definitionHistoricalRepair == null) return task.cryptoObjectId === deriveTaskContentCryptoObjectIdV1({
    kind: "definition", taskId: task.id, contentRevision: task.contentRevision,
  });
  try {
    const provenance = parseTaskHistoricalRepairProvenanceV1(task.definitionHistoricalRepair);
    if (task.cryptoObjectId !== taskContentRevisionObjectIdV1({
      coordinate: { kind: "definition", taskId: task.id, contentRevision: task.contentRevision },
      namespaceId: task.contentNamespaceId, historicalRepair: provenance,
    })) return false;
    const rows = await executeTypedConversationProductQuery(input.product, conversationProductTypedDb.select({
      historicalRepair: taskDefinitionCryptoRevisions.historicalRepair,
      requestDigest: taskDefinitionCryptoRevisions.requestDigest,
    }).from(taskDefinitionCryptoRevisions).innerJoin(actors, and(
      eq(actors.id, taskDefinitionCryptoRevisions.requesterHumanId),
      eq(actors.ownerId, task.requestorId), eq(actors.kind, "user"),
    )).where(and(
      eq(taskDefinitionCryptoRevisions.taskId, task.id),
      eq(taskDefinitionCryptoRevisions.contentRevision, task.contentRevision),
      eq(taskDefinitionCryptoRevisions.contentNamespaceId, task.contentNamespaceId),
      eq(taskDefinitionCryptoRevisions.cryptoObjectId, task.cryptoObjectId),
      eq(taskDefinitionCryptoRevisions.cryptoAccessRevision, 0),
      eq(taskDefinitionCryptoRevisions.representation, task.contentRepresentation),
      eq(taskDefinitionCryptoRevisions.requiredNamespaceFingerprint, task.cryptoRequiredNamespaceFingerprint),
      eq(taskDefinitionCryptoRevisions.completion, "complete"),
      eq(taskDefinitionCryptoRevisions.disposition, "mapped"),
      isNull(taskDefinitionCryptoRevisions.failureCode),
    )).limit(2).for("share", { of: taskDefinitionCryptoRevisions }));
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || !(row.request_digest instanceof Uint8Array)
      || Buffer.from(row.request_digest).toString("hex") !== provenance.signedRequestDigest) return false;
    const retained = parseTaskHistoricalRepairProvenanceV1(row.historical_repair);
    return Object.keys(retained).every(key => Reflect.get(retained, key) === Reflect.get(provenance, key))
      && retained.version === provenance.version;
  } catch { return false; }
}
