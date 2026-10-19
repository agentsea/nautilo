import { bytesToHex } from "@noble/hashes/utils.js";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  ClassifiedDataOperationError, withProtectedTaskRunResultMessageSigner,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import {
  PostgresHumanDeviceSignerHistory, PostgresLatticeStorage,
  stageNativeTaskRunResultMessagePublication, verifyCryptoPostgresHandle,
  withNativeProtectedTaskRunResultMessageSourceV1,
  withNativeTaskRunResultMessageNamespaceSource,
  type NativeTaskRunResultMessageAllocation,
  type NativeTaskRunResultMessageCurrentAuthority,
  type NativeTaskRunResultMessageIntent,
} from "@nautilo/lattice-bridge/server";
import {
  assertAuthenticTaskRuntimeRunResultReadEvidence,
  hasTaskRuntimeTemporarySigner,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type { ProtectedTaskOutputReadAuthorityPort } from "./protected-task-output-read-authority";
import type { ProtectedTaskOutputReadPublication } from "./protected-task-output-read-claim";
import { createProtectedTaskOutputReadProductProofLoader } from "./protected-task-output-read-product";
import { withProtectedTaskResultSignerHistory } from "./protected-task-result-signer-history";
import { lockExactProtectedTaskRunResultMessageAllocation } from "./protected-task-run-result-message-allocation";
import { withProtectedTaskRunResultMessageProductStore } from "./protected-task-run-result-message-store";
import { acceptedTaskRuntimeRecord, destroyAcceptedTaskRuntimeRecord } from "./task-runtime-current-authority";

function unavailable(message: string): never {
  throw new ClassifiedDataOperationError("authority", message);
}
function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) wipe(child);
  }
}

/** The read grant lends plaintext only until immutable Room ciphertext is staged. */
export function createProtectedTaskRunResultMessagePublication(input: Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  authority: ProtectedTaskOutputReadAuthorityPort;
  recover(coordinates: Readonly<{ taskId: string; taskRunId: string }>): Promise<"mapped" | "pending">;
}>): ProtectedTaskOutputReadPublication {
  return async publication => {
    const { plan, evidence, signal, partitions } = publication;
    const intent = plan.intent;
    if (intent.invocation.kind !== "raw" || intent.result.contentRevision !== 1
      || intent.result.terminalStatus === "cancelled" || evidence.messageWrite === null
      || publication.record.workKind !== "task.deliver_result") {
      unavailable("Task result Message requires an independently admitted raw read");
    }
    const accepted = acceptedTaskRuntimeRecord(publication.record);
    if (accepted === null) unavailable("Task result Message grant is unavailable");
    const subject = Object.freeze({ userId: intent.requesterUserId,
      humanActorId: accepted.issuingHumanId, deviceId: accepted.issuingDeviceId });
    const assertLive = async () => {
      signal.throwIfAborted();
      assertAuthenticTaskRuntimeRunResultReadEvidence(evidence);
      await publication.assertCurrentClaim();
      signal.throwIfAborted();
      assertAuthenticTaskRuntimeRunResultReadEvidence(evidence);
    };
    const withAccepted = <Value>(use: Parameters<ProtectedTaskOutputReadAuthorityPort["withAccepted"]>[0]["use"] &
      ((...args: Parameters<Parameters<ProtectedTaskOutputReadAuthorityPort["withAccepted"]>[0]["use"]>) => Promise<Value>)) =>
      input.authority.withAccepted({ intent, subject, accepted,
        restricted: input.restricted, signal, validateBeforeCommit: assertLive, use });
    try {
      await assertLive();
      const handle = await verifyCryptoPostgresHandle(input.restricted);
      const storage = new PostgresLatticeStorage(handle);
      const signerHistory = new PostgresHumanDeviceSignerHistory({ handle, crypto: input.crypto });
      const publish = async (representation: "protected" | "dual") => {
        if (intent.representation !== representation) unavailable("Task result Message policy changed");
        const opened = await withNativeProtectedTaskRunResultMessageSourceV1({
          restricted: input.restricted, crypto: input.crypto, serverScope: input.serverScope,
          evidence, domains: partitions.resultDomains, signal,
          resolveHistoricalAgentSignerAuthority: signerHistory.resolveAgentRuntimeSignerManager,
          loadCurrentResult: async () => {
            await assertLive();
            return withAccepted(current => Promise.resolve(current.occurrence));
          },
          execute: async source => {
            // Commit the stable product allocation before opening the isolated
            // crypto transaction. A retry may reuse only this exact allocation.
            const allocation = await withAccepted(async (current, product, _restricted, transaction) => {
              const destination = current.foregroundNamespaceRequirements[0];
              if (current.foregroundNamespaceRequirements.length !== 1 || destination === undefined
                || destination.namespaceId !== source.messageWrite.namespace.namespaceId) {
                unavailable("Task result Message destination changed");
              }
              const loader = createProtectedTaskOutputReadProductProofLoader(intent);
              const revalidate = async () => {
                if (!await loader.validateCurrentTaskRun(product, transaction)
                  || !await loader.validateCurrentForeground(product, transaction, {
                    destinationRoomId: intent.invocation.roomId,
                    destinationNamespaceId: destination.namespaceId,
                    foregroundNamespaceIds: plan.foregroundNamespaceIds,
                  })) return null;
                return loader.readCurrent();
              };
              await withProtectedTaskRunResultMessageProductStore({ product, transaction, intent,
                destinationNamespaceId: destination.namespaceId,
                publicationPolicyRevision: intent.expectedPolicyRevision,
                authorization: { kind: "source", source }, revalidate,
                use: store => store.appendAllocated(),
              });
              const exact = await lockExactProtectedTaskRunResultMessageAllocation({
                transaction, intent, destinationNamespaceId: destination.namespaceId,
                expectedPayloadDigest: source.payloadDigest, phase: "pristine",
              });
              if (exact === null) unavailable("Task result Message allocation is unavailable");
              return Object.freeze<NativeTaskRunResultMessageAllocation>({
                sessionId: exact.lifecycle.sessionId, messageId: exact.lifecycle.messageId,
                revision: 0, objectId: exact.lifecycle.cryptoObjectId, createdAt: exact.createdAt,
                mode: representation === "protected" ? "encrypted_only" : "shadow_encryption",
                acceptedPolicyRevision: intent.acceptedPolicyRevision,
                publicationPolicyRevision: intent.expectedPolicyRevision,
              });
            });
            if (allocation === null) unavailable("Task result Message allocation authority changed");
            const staged = await withAccepted(async (current, _product, restricted, transaction) => {
              const namespace = source.messageWrite.namespace;
              const domain = partitions.foregroundDomains.find(entry => entry.domainId === namespace.domainId);
              if (domain === undefined) unavailable("Task result Message Domain is unavailable");
              const verifyAllocation = async () => {
                await assertLive();
                if (await lockExactProtectedTaskRunResultMessageAllocation({ transaction, intent,
                  destinationNamespaceId: namespace.namespaceId, expectedPayloadDigest: source.payloadDigest,
                  phase: "pristine", expected: allocation }) === null) {
                  unavailable("Task result Message allocation changed");
                }
              };
              const delivery = (expected: NativeTaskRunResultMessageIntent): NativeTaskRunResultMessageCurrentAuthority | null => {
                const destination = current.foregroundNamespaceRequirements[0];
                const result = current.resultNamespaceRequirement;
                if (current.foregroundNamespaceRequirements.length !== 1 || destination === undefined
                  || expected.taskId !== intent.result.taskId || expected.taskRunId !== intent.result.taskRunId
                  || expected.bindingId !== intent.invocation.bindingId
                  || expected.messageOperationId !== intent.invocation.operationId
                  || expected.sessionId !== allocation.sessionId || expected.messageId !== allocation.messageId
                  || expected.objectId !== allocation.objectId || expected.createdAt !== allocation.createdAt
                  || expected.roomId !== intent.invocation.roomId || expected.namespaceId !== destination.namespaceId
                  || expected.domainId !== destination.domainId || expected.resultNamespaceId !== result.namespaceId
                  || expected.resultDomainId !== result.domainId
                  || expected.resultNamespaceAccessRevision !== result.expectedAccessRevision
                  || expected.payloadDigest !== bytesToHex(source.payloadDigest)) return null;
                return Object.freeze({ taskId: expected.taskId, taskRunId: expected.taskRunId,
                  bindingId: expected.bindingId, messageOperationId: expected.messageOperationId,
                  sessionId: expected.sessionId, messageId: expected.messageId, revision: 0,
                  objectId: expected.objectId, roomId: expected.roomId,
                  namespaceId: expected.namespaceId, domainId: expected.domainId, mode: expected.mode,
                  acceptedPolicyRevision: intent.acceptedPolicyRevision,
                  currentPolicyRevision: current.policyRevision,
                  namespaceAccessRevision: destination.expectedAccessRevision,
                  requesterHumanId: intent.requesterHumanId,
                  resultTerminalStatus: expected.resultTerminalStatus, resultContentRevision: 1,
                  resultObjectId: intent.result.objectId,
                  resultGenesisManifestHash: bytesToHex(intent.result.genesisManifestHash),
                  resultCryptoAccessRevision: intent.result.cryptoAccessRevision, resultNamespaceId: result.namespaceId,
                  resultDomainId: result.domainId, resultNamespaceAccessRevision: result.expectedAccessRevision,
                });
              };
              await verifyAllocation();
              const stageWithSigner = async (
                history: Parameters<Parameters<
                  typeof withProtectedTaskResultSignerHistory
                >[0]["use"]>[0],
                authorizationRevision: number,
              ) => withProtectedTaskRunResultMessageSigner({
                crypto: input.crypto, storage, evidence, domain,
                expectedAgentAuthorizationRevision: authorizationRevision,
                resolveHistoricalRuntimeCommitter:
                  history.resolveHistoricalRuntimeCommitter,
                resolveHistoricalSignerPublicationManager:
                  history.resolveHistoricalSignerPublicationManager,
                execute: signer => withNativeTaskRunResultMessageNamespaceSource({ restricted,
                  crypto: input.crypto, serverScope: input.serverScope, evidence,
                  domains: partitions.foregroundDomains, signal,
                  assertCurrentTaskAuthority: verifyAllocation,
                }, namespaceSource => stageNativeTaskRunResultMessagePublication({ restricted,
                  resolveHistoricalAgentSignerAuthority:
                    signerHistory.resolveAgentRuntimeSignerManager,
                  assertCurrentClaim: assertLive,
                  resolveCurrentDeliveryAuthority: async expected => {
                    await verifyAllocation();
                    return delivery(expected);
                  },
                  preparation: { crypto: input.crypto, evidence, source, allocation,
                    namespace: namespaceSource, runtime: signer.runtime,
                    signerPublication: signer.signerPublication,
                    ...(signer.temporarySigner === undefined ? {} : {
                      temporarySigner: signer.temporarySigner,
                    }),
                    agentAuthorizationRevision: signer.agentAuthorizationRevision,
                    resolveHistoricalSignerPublicationManager:
                      history.resolveHistoricalSignerPublicationManager,
                    signal, resolveCurrentAuthority: async expected => {
                      await verifyAllocation();
                      return delivery(expected) === null
                        ? null : Object.freeze({ ...expected });
                    },
                  },
                })),
              });
              if (hasTaskRuntimeTemporarySigner(evidence)) {
                const result = await stageWithSigner({
                  resolveHistoricalRuntimeCommitter: () => null,
                  resolveHistoricalSignerPublicationManager: () => null,
                }, 0);
                if (result.status !== "executed") {
                  unavailable("Task result Message signer is unavailable");
                }
                await verifyAllocation();
                return result.value;
              }
              const state = await storage.getAgentRuntimeAtomicState(intent.agentId);
              let authorizationRevision: number;
              let runtimeGeneration: number;
              try {
                if (state === null) unavailable("Task result Message Runtime is unavailable");
                authorizationRevision = state.runtime.authorizationRevision;
                runtimeGeneration = state.runtime.runtimeGeneration;
              } finally { wipe(state); }
              const result = await withProtectedTaskResultSignerHistory({ handle, crypto: input.crypto,
                agentId: intent.agentId, domainId: domain.domainId, domainEpoch: domain.domainKeyGeneration,
                expectedAgentAuthorizationRevision: authorizationRevision,
                expectedRuntimeGeneration: runtimeGeneration,
                use: history => stageWithSigner(history, authorizationRevision),
              });
              if (result.status !== "executed") unavailable("Task result Message signer is unavailable");
              await verifyAllocation();
              return result.value;
            });
            if (staged === null) unavailable("Task result Message publication authority changed");
          },
        });
        if (opened.status !== "available") unavailable("Task result Message body is unavailable");
        // Source custody is closed before product mapping; recovery uses only
        // immutable ciphertext and its public receipt, including after restart.
        if (await input.recover(intent.result) !== "mapped") {
          throw new ClassifiedDataOperationError("stale", "Task result Message requires publication reconciliation");
        }
      };
      await input.owner.runMutation({ protected: () => publish("protected"), dual: () => publish("dual") });
    } finally { destroyAcceptedTaskRuntimeRecord(accepted); }
  };
}
