import { and, eq, namespaceDomainKeyHeads,
  type DirectDatabase, type PostgresJsBridgeConnection } from "@nautilo/db";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { inspectMappedTaskDefinitionAccessLineage, PostgresHumanDeviceSignerHistory,
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver, cryptoTypedDb,
  executeTypedCryptoQuery, verifyCryptoPostgresHandle,
  type CryptoPostgresHandle,
  type VerifiedTaskDefinitionAccessLineage } from "@nautilo/lattice-bridge/server";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import type { ProtectedTaskOccurrence } from "@nautilo/runtime";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";
import { createProtectedTaskHistoricalForegroundAuthorizationDeviceSigningKeyResolver } from
  "./protected-task-historical-human-device-signing-key";
import { createTaskDefinitionForegroundAuthorizationResolver } from
  "./task-definition-foreground-authorization";

/** Resolve retained Task proof through the stored executor's canonical private Room.
 * This authenticates old public evidence; current execution/read admission stays
 * with the calling Lattice owner. */
export async function createProtectedTaskDefinitionForegroundAuthorizationResolver(input: Readonly<{
  product: Pick<Awaited<ReturnType<typeof createHumanProductTransactionContext>>, "canonicalRunner" | "handle">;
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  requesterHumanId: string;
  task: Readonly<{
    id: string; ownerId: string; agentId: string; contentNamespaceId: string;
    cryptoObjectId: string; contentRevision: number;
  }>;
}>) {
  const { task } = input;
  const privateRoom = await input.product.canonicalRunner.transaction(
    transaction => createProtectedTaskRequesterPrivateRoomResolver(transaction)(
      task.ownerId, task.agentId, task.contentNamespaceId,
    ),
    { isolationLevel: "read committed" },
  );
  if (privateRoom === null) return null;
  const domains = await executeTypedCryptoQuery(input.handle, cryptoTypedDb.select({
    domainId: namespaceDomainKeyHeads.domainId,
  }).from(namespaceDomainKeyHeads).where(and(
    eq(namespaceDomainKeyHeads.namespaceId, task.contentNamespaceId),
    eq(namespaceDomainKeyHeads.keyClass, "ai"),
  )).limit(2));
  const domain = domains[0];
  if (domains.length !== 1 || domain === undefined) return null;
  return createTaskDefinitionForegroundAuthorizationResolver({
    crypto: input.crypto,
    expectedObjectId: task.cryptoObjectId,
    taskId: task.id,
    operation: task.contentRevision === 1 ? "create" : "update",
    targetContentRevision: task.contentRevision,
    privateRoomId: privateRoom.roomId,
    humanId: input.requesterHumanId,
    namespaceId: task.contentNamespaceId,
    domainId: domain.domain_id,
    resolveAcceptedExecutionEvidence:
      createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
        product: input.product.handle, crypto: input.crypto,
        rejectInvalidSelectedEvidence: true,
      }),
    resolveHistoricalDeviceSigningPublicKey:
      createProtectedTaskHistoricalForegroundAuthorizationDeviceSigningKeyResolver(input.handle),
  });
}

/** Detached signed history only; the parked owner subsequently locks and matches the exact Task head. */
export function createProtectedTaskRuntimeAccessLineageReader(input: Readonly<{
  db: DirectDatabase; crypto: LatticeCrypto; restricted(): PostgresJsBridgeConnection;
}>): (expected: Readonly<{ occurrence: Pick<ProtectedTaskOccurrence, "task"> }>, requesterHumanId: string) => Promise<VerifiedTaskDefinitionAccessLineage | null> {
  return async (expected, requesterHumanId) => {
    const { task } = expected.occurrence;
    const product = await createHumanProductTransactionContext(task.requestorId, input.db);
    const handle = await verifyCryptoPostgresHandle(input.restricted());
    const history = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
    const resolveTaskDefinitionForegroundAuthorization =
      await createProtectedTaskDefinitionForegroundAuthorizationResolver({
        product, handle, crypto: input.crypto, requesterHumanId, task,
      });
    if (resolveTaskDefinitionForegroundAuthorization === null) return null;
    const resolveAcceptedExecutionEvidence =
      createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
        product: product.handle,
        crypto: input.crypto,
        rejectInvalidSelectedEvidence: true,
      });
    return inspectMappedTaskDefinitionAccessLineage({ handle, crypto: input.crypto,
      coordinate: { kind: "definition", taskId: task.id, contentRevision: task.contentRevision },
      objectId: task.cryptoObjectId, namespaceId: task.contentNamespaceId, requesterHumanId,
      mappedAccessRevision: task.cryptoAccessRevision, expectedAgentId: task.agentId,
      resolveHistoricalAgentSignerAuthority: history.resolveAgentRuntimeSignerManager,
      resolveForegroundAgentAcceptedExecutionEvidence:
        resolveAcceptedExecutionEvidence,
      resolveTaskDefinitionForegroundAuthorization,
    });
  };
}
