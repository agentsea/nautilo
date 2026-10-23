import {
  actors, and, eq, inArray, taskDefinitionCryptoRevisions, tasks,
  type DirectDatabase, type Task,
} from "@nautilo/db";
import {
  deriveTaskContentCryptoObjectIdV1,
  parseTaskHistoricalRepairProvenanceV1,
  taskContentRevisionObjectIdV1,
} from "@nautilo/lattice-bridge";

/** Metadata classification only; this proof cannot authorize opening content. */
export interface HistoricalTaskDefinitionSummaryProof {
  readonly taskId: string;
}
const proofs = new WeakMap<HistoricalTaskDefinitionSummaryProof, string>();
type Coordinates = Pick<Task, "id" | "ownerId" | "requestorId" | "contentRepresentation"
  | "contentNamespaceId" | "contentRevision" | "cryptoObjectId" | "cryptoAccessRevision"
  | "cryptoRequiredNamespaceFingerprint" | "cryptoMappingState">;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
function snapshot(task: Coordinates): string {
  return JSON.stringify([task.id, task.ownerId, task.requestorId, task.contentRepresentation,
    task.contentNamespaceId, task.contentRevision, task.cryptoObjectId, task.cryptoAccessRevision,
    task.cryptoRequiredNamespaceFingerprint === null ? null : hex(task.cryptoRequiredNamespaceFingerprint),
    task.cryptoMappingState]);
}
export function hasHistoricalTaskDefinitionSummaryProof(
  task: Coordinates,
  proof: HistoricalTaskDefinitionSummaryProof | undefined,
): boolean {
  return proof !== undefined && proofs.get(proof) === snapshot(task);
}

/** Batch the exact current product/immutable ledger join without selecting Task bodies. */
export async function readHistoricalTaskDefinitionSummaryProofs(
  db: Pick<DirectDatabase, "select">,
  ownerId: string,
  input: readonly Coordinates[],
): Promise<ReadonlyMap<string, HistoricalTaskDefinitionSummaryProof>> {
  const candidates = input.filter(task => task.ownerId === ownerId && task.requestorId === ownerId
    && task.contentRepresentation === "dual" && task.contentRevision === 1
    && task.contentNamespaceId !== null && task.cryptoMappingState === "verified"
    && Number.isSafeInteger(task.cryptoAccessRevision) && task.cryptoAccessRevision >= 0
    && task.cryptoRequiredNamespaceFingerprint?.length === 32
    && task.cryptoObjectId !== deriveTaskContentCryptoObjectIdV1({
      kind: "definition", taskId: task.id, contentRevision: task.contentRevision,
    }));
  const result = new Map<string, HistoricalTaskDefinitionSummaryProof>();
  if (candidates.length === 0) return result;
  const ledger = taskDefinitionCryptoRevisions;
  const rows = await db.select({
    taskId: tasks.id, ownerId: tasks.ownerId, requestorId: tasks.requestorId,
    representation: tasks.contentRepresentation, namespaceId: tasks.contentNamespaceId,
    revision: tasks.contentRevision, objectId: tasks.cryptoObjectId,
    accessRevision: tasks.cryptoAccessRevision, fingerprint: tasks.cryptoRequiredNamespaceFingerprint,
    mappingState: tasks.cryptoMappingState,
    ledgerRepresentation: ledger.representation, anchorNamespaceId: ledger.anchorNamespaceId,
    genesisAccessRevision: ledger.cryptoAccessRevision, payloadVersion: ledger.payloadVersion,
    completion: ledger.completion, disposition: ledger.disposition, failureCode: ledger.failureCode,
    completedAt: ledger.cryptoCompletedAt, requestDigest: ledger.requestDigest,
    historicalRepair: ledger.historicalRepair,
  }).from(tasks).innerJoin(ledger, and(
    eq(ledger.taskId, tasks.id), eq(ledger.contentRevision, tasks.contentRevision),
    eq(ledger.cryptoObjectId, tasks.cryptoObjectId), eq(ledger.contentNamespaceId, tasks.contentNamespaceId),
    eq(ledger.requiredNamespaceFingerprint, tasks.cryptoRequiredNamespaceFingerprint),
  )).innerJoin(actors, and(eq(actors.id, ledger.requesterHumanId),
    eq(actors.kind, "user"), eq(actors.ownerId, tasks.requestorId)))
    .where(and(inArray(tasks.id, candidates.map(task => task.id)), eq(tasks.ownerId, ownerId),
      eq(tasks.requestorId, ownerId)));
  for (const task of candidates) {
    const matches = rows.filter(row => row.taskId === task.id);
    if (matches.length !== 1) continue;
    const row = matches[0]!;
    if (snapshot(task) !== snapshot({ id: row.taskId, ownerId: row.ownerId, requestorId: row.requestorId,
      contentRepresentation: row.representation, contentNamespaceId: row.namespaceId,
      contentRevision: row.revision, cryptoObjectId: row.objectId, cryptoAccessRevision: row.accessRevision,
      cryptoRequiredNamespaceFingerprint: row.fingerprint, cryptoMappingState: row.mappingState })
      || row.ledgerRepresentation !== "dual" || row.anchorNamespaceId !== task.contentNamespaceId
      || row.genesisAccessRevision !== 0 || row.payloadVersion !== 1
      || row.completion !== "complete" || row.disposition !== "mapped"
      || row.failureCode !== null || row.completedAt === null || row.requestDigest.length !== 32) continue;
    try {
      const provenance = parseTaskHistoricalRepairProvenanceV1(row.historicalRepair);
      if (provenance.version !== 2 || provenance.signedRequestDigest !== hex(row.requestDigest)
        || taskContentRevisionObjectIdV1({ coordinate: {
          kind: "definition", taskId: task.id, contentRevision: task.contentRevision,
        }, namespaceId: task.contentNamespaceId, historicalRepair: provenance }) !== task.cryptoObjectId) continue;
      const proof = Object.freeze({ taskId: task.id });
      proofs.set(proof, snapshot(task));
      result.set(task.id, proof);
    } catch { /* Malformed historical provenance is an unavailable reference. */ }
  }
  return result;
}
