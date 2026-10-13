import type { DirectDatabase, PostgresJsBridgeConnection } from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { inspectMappedTaskDefinitionAccessLineage, PostgresHumanDeviceSignerHistory,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver, verifyCryptoPostgresHandle, type VerifiedTaskDefinitionAccessLineage } from "@nautilo/lattice-bridge/server";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import type { ProtectedTaskOccurrence } from "@nautilo/runtime";

/** Detached signed history only; the parked owner subsequently locks and matches the exact Task head. */
export function createProtectedTaskRuntimeAccessLineageReader(input: Readonly<{
  db: DirectDatabase; crypto: LatticeCrypto; restricted(): PostgresJsBridgeConnection;
}>): (expected: Readonly<{ occurrence: Pick<ProtectedTaskOccurrence, "task"> }>, requesterHumanId: string) => Promise<VerifiedTaskDefinitionAccessLineage | null> {
  return async (expected, requesterHumanId) => {
    const { task } = expected.occurrence;
    const product = await createHumanProductTransactionContext(task.requestorId, input.db);
    const handle = await verifyCryptoPostgresHandle(input.restricted());
    const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
    return inspectMappedTaskDefinitionAccessLineage({ handle, crypto: input.crypto,
      coordinate: { kind: "definition", taskId: task.id, contentRevision: task.contentRevision },
      objectId: task.cryptoObjectId, namespaceId: task.contentNamespaceId, requesterHumanId,
      mappedAccessRevision: task.cryptoAccessRevision, expectedAgentId: task.agentId,
      resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
      resolveForegroundAgentAcceptedExecutionEvidence: createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
        product: product.handle, crypto: input.crypto, rejectInvalidSelectedEvidence: true }),
    });
  };
}
