import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { eq, protectedTaskRunOutputBindings, sessionMessageCryptoRevisions, type DirectDatabase,
  type PostgresJsBridgeConnection } from "@nautilo/db";
import type { EncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import {
  assertVerifiedStagedTaskRunResultMessagePublication,
  inspectStagedTaskRunResultMessagePublication,
  NativeTaskMessageCryptoCompletionConflictError,
  PostgresHumanDeviceSignerHistory, readStagedTaskRunResultMessageIntent,
  verifyCryptoPostgresHandle, withTaskOutputNamespaceAuthority,
  type NativeTaskRunResultMessageCurrentAuthority,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import {
  createProtectedTaskOutputReadRecoveryProductProofLoader,
  readProtectedTaskOutputReadClosedProof,
} from "./protected-task-output-read-product";
import { createProtectedTaskRequesterPrivateRoomResolver } from "./protected-task-requester-private-room";
import { lockExactProtectedTaskRunResultMessageAllocation } from "./protected-task-run-result-message-allocation";
import { withProtectedTaskRunResultMessageProductStore } from "./protected-task-run-result-message-store";

type Coordinates = Readonly<{ taskId: string; taskRunId: string }>;
export type ProtectedTaskRunResultMessageRecoveryOutcome = "missing" | "pending" | "mapped" | "quarantined";

/** Reconcile one retained raw Message without opening any read grant or model. */
export function createProtectedTaskRunResultMessageRecovery(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
}>) {
  const resolvePrivateRoom = createProtectedTaskRequesterPrivateRoomResolver(input.db);
  return async (coordinates: Coordinates): Promise<ProtectedTaskRunResultMessageRecoveryOutcome> => {
    const recover = async (representation: "protected" | "dual"): Promise<ProtectedTaskRunResultMessageRecoveryOutcome> => {
      const proof = await input.db.transaction(transaction => readProtectedTaskOutputReadClosedProof(
        transaction, { ...coordinates, kind: "raw" }));
      if (proof === null) return "missing";
      if (proof.representation !== representation || proof.invocation.kind !== "raw"
        || proof.result.contentRevision !== 1 || proof.result.terminalStatus === "cancelled") return "pending";
      const privateRoom = await resolvePrivateRoom(proof.requesterUserId, proof.agentId, proof.contentNamespaceId);
      if (privateRoom === null || privateRoom.namespaceId !== proof.contentNamespaceId) return "pending";
      const context = await createHumanProductTransactionContext(proof.requesterUserId, input.db);
      const destination = await input.db.select({ namespaceId: sessionMessageCryptoRevisions.namespaceIdAtAllocation })
        .from(sessionMessageCryptoRevisions).where(eq(sessionMessageCryptoRevisions.appendIdempotencyKey,
          proof.invocation.operationId)).limit(2);
      if (destination.length === 0) return "missing";
      if (destination.length !== 1 || destination[0] === undefined) return "quarantined";
      const destinationNamespaceId = destination[0].namespaceId;
      const foregroundNamespaceIds = Object.freeze([destinationNamespaceId]);
      const loader = createProtectedTaskOutputReadRecoveryProductProofLoader(proof);
      const outcome = await withTaskOutputNamespaceAuthority({
        runner: context.canonicalRunner, restricted: input.restricted,
        crypto: input.crypto, serverScope: input.serverScope,
        taskId: proof.result.taskId, taskRunId: proof.result.taskRunId,
        requesterUserId: proof.requesterUserId, requesterHumanId: proof.requesterHumanId,
        agentId: proof.agentId, contentNamespaceId: proof.contentNamespaceId,
        sourceRoomId: privateRoom.roomId, destinationRoomId: proof.invocation.roomId,
        destinationNamespaceId, foregroundNamespaceIds,
        workKind: "task.deliver_result", workId: proof.result.taskRunId,
        requestId: `task-run-delivery-result-authorization:${proof.result.taskRunId}`,
        episodeId: proof.invocation.sessionId, expectedPolicyRevision: proof.expectedPolicyRevision,
        validateCurrentTaskRun: loader.validateCurrentTaskRun,
        validateCurrentForeground: loader.validateCurrentForeground,
        use: async (authority, product, transaction, restricted): Promise<ProtectedTaskRunResultMessageRecoveryOutcome> => {
          const fresh = loader.readCurrent();
          const write = authority.foregroundFacts[0];
          if (fresh === null || authority.foregroundFacts.length !== 1 || write === undefined) return "pending";
          const rows = await transaction.select({
            digest: sessionMessageCryptoRevisions.allocationRequestDigest,
            objectId: sessionMessageCryptoRevisions.cryptoObjectId,
          }).from(sessionMessageCryptoRevisions).where(eq(sessionMessageCryptoRevisions.appendIdempotencyKey,
            proof.invocation.operationId)).limit(2);
          const row = rows[0];
          if (rows.length !== 1 || row === undefined) return "quarantined";
          const handle = await verifyCryptoPostgresHandle(restricted);
          // Retained intent is metadata, not authority. The inspector below must
          // authenticate it against immutable ciphertext and the staged receipt.
          const retained = await readStagedTaskRunResultMessageIntent(handle, {
            requestId: `task-run-delivery-result-authorization:${proof.result.taskRunId}`,
            objectId: row.objectId,
          });
          if (retained === null) return "missing";
          const digest = hexToBytes(retained.payloadDigest);
          if (bytesToHex(row.digest) !== retained.payloadDigest) return "quarantined";
          const allocation = await lockExactProtectedTaskRunResultMessageAllocation({
            transaction, intent: proof, destinationNamespaceId,
            expectedPayloadDigest: digest, phase: "staged_or_mapped",
            expected: { messageId: retained.messageId, revision: 0, objectId: retained.objectId,
              createdAt: retained.createdAt, publicationPolicyRevision: retained.publicationPolicyRevision },
          });
          if (allocation === null) return "quarantined";
          const source = authority.resultFact;
          const current: NativeTaskRunResultMessageCurrentAuthority = Object.freeze({
            taskId: proof.result.taskId, taskRunId: proof.result.taskRunId,
            bindingId: proof.invocation.bindingId, messageOperationId: proof.invocation.operationId,
            sessionId: proof.invocation.sessionId, messageId: allocation.lifecycle.messageId,
            revision: 0, objectId: allocation.lifecycle.cryptoObjectId,
            roomId: proof.invocation.roomId, namespaceId: write.namespaceId, domainId: write.domainId,
            mode: representation === "protected" ? "encrypted_only" : "shadow_encryption",
            acceptedPolicyRevision: proof.acceptedPolicyRevision,
            currentPolicyRevision: proof.expectedPolicyRevision,
            namespaceAccessRevision: write.expectedAccessRevision,
            requesterHumanId: proof.requesterHumanId,
            resultTerminalStatus: proof.result.terminalStatus as "completed" | "errored",
            resultContentRevision: 1, resultObjectId: proof.result.objectId,
            resultGenesisManifestHash: bytesToHex(proof.result.genesisManifestHash),
            resultCryptoAccessRevision: proof.result.cryptoAccessRevision, resultNamespaceId: source.namespaceId,
            resultDomainId: source.domainId, resultNamespaceAccessRevision: source.expectedAccessRevision,
          });
          const signerHistory = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
          const inspect = () => inspectStagedTaskRunResultMessagePublication({ handle, crypto: input.crypto,
            intent: retained, currentAuthority: current,
            resolveHistoricalAgentSignerAuthority: signerHistory.resolveAgentRuntimeSignerManager });
          const staged = await inspect();
          if (staged === null) return "missing";
          assertVerifiedStagedTaskRunResultMessagePublication(staged, current);
          const revalidate = async () => {
            if (!await loader.validateCurrentTaskRun(product, transaction)
              || !await loader.validateCurrentForeground(product, transaction, {
                destinationRoomId: proof.invocation.roomId, destinationNamespaceId, foregroundNamespaceIds,
              })) return null;
            const verified = await inspect();
            if (verified === null) return null;
            assertVerifiedStagedTaskRunResultMessagePublication(verified, current);
            return loader.readCurrent();
          };
          const [binding] = await transaction.select({
            messageId: protectedTaskRunOutputBindings.messageId,
            publishedAt: protectedTaskRunOutputBindings.messagePublishedAt,
          }).from(protectedTaskRunOutputBindings).where(eq(
            protectedTaskRunOutputBindings.taskRunId, proof.result.taskRunId,
          )).limit(2);
          if (binding?.messageId === allocation.lifecycle.messageId
            && binding.publishedAt !== null) {
            // The two-phase product loader proved the exact mapped association
            // and completed binding. Do not re-enter first-publication writes.
            return await revalidate() === null ? "pending" : "mapped";
          }
          return withProtectedTaskRunResultMessageProductStore({ product, transaction, intent: proof,
            destinationNamespaceId, publicationPolicyRevision: retained.publicationPolicyRevision,
            authorization: { kind: "staged", proof: staged, currentAuthority: current }, revalidate,
            use: async store => {
              const publicationPolicy = { expectedRevision: proof.expectedPolicyRevision,
                representation: representation === "protected" ? "protected_only" as const : "ordinary_and_protected" as const };
              const coordinate = { sessionId: retained.sessionId, messageId: retained.messageId,
                revision: 0, cryptoObjectId: retained.objectId, leaseToken: null, publicationPolicy };
              const completed = await store.markCryptoComplete({ ...coordinate,
                parityStatus: representation === "protected" ? "server_authenticated" : "server_verified" });
              if (completed !== "applied" && completed !== "duplicate") return "pending";
              const mapped = await store.compareAndSwapCryptoMapping({ ...coordinate, expectedNamespaceId: destinationNamespaceId });
              if (mapped !== "applied" && mapped !== "duplicate") return "pending";
              return "mapped";
            },
          });
        },
      });
      return outcome ?? "pending";
    };
    try {
      return await input.owner.runMutation({ protected: () => recover("protected"), dual: () => recover("dual") });
    } catch (error: unknown) {
      if (error instanceof NativeTaskMessageCryptoCompletionConflictError || error instanceof TypeError) return "quarantined";
      return "pending";
    }
  };
}
